"""FitPit lane rental availability dashboard API."""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

FITPIT_GROUPS_URL = "https://shop.fitpit.fi/fitpit/reservations2/apieventgroups"
SERVICE_ID = 11
GROUP_ID = 18  # Uimaradan vuokraus (lane rental)
CACHE_TTL_SECONDS = 120

# Deep-linkable booking page. FitPit's Angular route is
# reservations/:service_id/:location_ids/:group_ids/... — a location id in
# segment 2 pre-filters the shop to that venue (verified 2026-08). There is no
# date parameter in the route table.
BOOKING_URL_BASE = (
    "https://shop.fitpit.fi/fitpit/reservations2/reservations/{loc_placeholder}"
    "/-/18/-/-/-?lang=1"
)
BOOKING_URL_ALL = (
    "https://shop.fitpit.fi/fitpit/reservations2/reservations/11/-/18/-/-/-?lang=1"
)

LOCATIONS: dict[int, dict[str, str]] = {
    52: {
        "name": "Kilo",
        "full_name": "Kilon uimahalli",
        "city": "Espoo",
        "address": "Kutojantie 2 E, 02630 Espoo",
        "max_people": 7,
    },
    39: {
        "name": "Valkea talo",
        "full_name": "Valkea talo",
        "city": "Haaga, Helsinki",
        "address": "Ilkantie 4, 00400 Helsinki",
        "max_people": 6,
    },
}


def booking_url_for(location_id: int | None) -> str:
    """Shop URL pre-filtered to one location, or the all-locations page."""
    if location_id is None or location_id not in LOCATIONS:
        return BOOKING_URL_ALL
    return BOOKING_URL_BASE.format(loc_placeholder=str(location_id))


app = FastAPI(title="FitPit Lane Rental Dashboard")

_cache: dict[str, Any] = {
    "key": None,
    "groups": None,
    "fetched_at": 0.0,
    "last_good": None,  # last successful availability payload (stale fallback)
}


def fetch_event_groups(location_ids: list[int]) -> list[dict[str, Any]]:
    now = time.time()
    cache_key = ",".join(str(i) for i in sorted(location_ids))
    if (
        _cache.get("key") == cache_key
        and _cache.get("groups") is not None
        and now - _cache["fetched_at"] < CACHE_TTL_SECONDS
    ):
        return _cache["groups"]

    params = urllib.parse.urlencode(
        {
            "service_id": SERVICE_ID,
            "location_ids": ",".join(str(i) for i in location_ids),
            "group_ids": str(GROUP_ID),
            "instructor_ids": "",
        }
    )
    url = f"{FITPIT_GROUPS_URL}?{params}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; FitPit-Dashboard/1.1)",
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        groups = json.loads(resp.read())

    _cache["key"] = cache_key
    _cache["groups"] = groups
    _cache["fetched_at"] = now
    return groups


def _slot_price_eur(group: dict[str, Any]) -> float | None:
    """Cheapest fare product price (cents) -> euros."""
    fares = group.get("fare_products") or []
    prices = [f.get("price") for f in fares if isinstance(f.get("price"), (int, float))]
    if not prices:
        return None
    return round(min(prices) / 100, 2)


def flatten_lane_slots(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert apieventgroups payload into flat slot records.

    2026-08 API change: FitPit no longer populates ``reservation_events`` —
    each event group IS one bookable slot now, with start/end/capacity/
    reserved/free at the group level and pricing in ``fare_products``.
    """
    slots: list[dict[str, Any]] = []
    for group in groups:
        if group.get("reservation_group_id") != GROUP_ID:
            continue
        name = group.get("name") or group.get("reservation_group_name") or ""
        group_name = group.get("reservation_group_name") or ""
        if (
            "Uimaradan vuokraus" not in name
            and "Uimaradan vuokraus" not in group_name
        ):
            continue
        # Staff lifeguard-scheduling blocks: not bookable slots.
        if "valvonta" in name.lower():
            continue

        time_start = group.get("start")
        time_end = group.get("end")
        location_id = group.get("location_id")
        capacity = group.get("capacity", 0) or 0
        if not time_start or not time_end or location_id not in LOCATIONS:
            continue
        if capacity <= 0:
            continue

        dt_start = datetime.strptime(time_start, "%Y-%m-%d %H:%M:%S")
        dt_end = datetime.strptime(time_end, "%Y-%m-%d %H:%M:%S")
        free = group.get("free", 0) or 0
        price_eur = _slot_price_eur(group)
        duration_min = int((dt_end - dt_start).total_seconds() // 60)

        slots.append(
            {
                "event_id": group.get("reservation_event_group_id"),
                "location_id": location_id,
                "date": dt_start.date().isoformat(),
                "weekday": dt_start.strftime("%a"),
                "time_start": dt_start.strftime("%H:%M"),
                "time_end": dt_end.strftime("%H:%M"),
                "time_range": f"{dt_start.strftime('%H:%M')}-{dt_end.strftime('%H:%M')}",
                "duration_min": duration_min,
                "free": free,
                "capacity": capacity,
                "reserved": group.get("reserved", 0) or 0,
                "available": free > 0,
                "price_eur": price_eur,
                "promotion": "tarjous" in name.lower(),
                "name": name,
            }
        )

    slots.sort(key=lambda s: (s["date"], s["location_id"], s["time_start"]))
    return slots


def filter_slots(
    slots: list[dict[str, Any]],
    location_id: int,
    start: datetime,
    end: datetime,
    available_only: bool,
) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for slot in slots:
        if slot["location_id"] != location_id:
            continue
        dt = datetime.strptime(f"{slot['date']} {slot['time_start']}", "%Y-%m-%d %H:%M")
        if dt < start or dt >= end:
            continue
        if available_only and not slot["available"]:
            continue
        filtered.append(slot)
    return filtered


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/locations")
def get_locations() -> list[dict[str, Any]]:
    return [
        {"id": loc_id, **meta, "booking_url": booking_url_for(loc_id)}
        for loc_id, meta in LOCATIONS.items()
    ]


@app.get("/api/availability")
def get_availability(
    days: int = Query(default=15, ge=1, le=90),
    available_only: bool = Query(default=False),
    location_id: int | None = Query(default=None),
):
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=days)
    target_locations = (
        {location_id: LOCATIONS[location_id]}
        if location_id is not None and location_id in LOCATIONS
        else LOCATIONS
    )
    range_meta = {
        "start": start.date().isoformat(),
        "end": (end - timedelta(days=1)).date().isoformat(),
        "days": days,
    }

    try:
        all_groups = fetch_event_groups(list(LOCATIONS.keys()))
        all_slots = flatten_lane_slots(all_groups)
    except Exception as exc:
        # Upstream failed: serve the last good payload marked stale instead of
        # blanking the dashboard. Client distinguishes via HTTP status.
        stale = _cache.get("last_good")
        if isinstance(stale, dict) and stale.get("locations"):
            payload = dict(stale)
            payload["stale"] = True
            payload["fetched_at"] = datetime.now().isoformat(timespec="seconds")
            payload["error"] = f"upstream unavailable — showing cached data ({exc})"
            payload["date_range"] = range_meta
            return JSONResponse(
                status_code=503,
                content=payload,
                headers={"Cache-Control": "no-store"},
            )
        return JSONResponse(
            status_code=502,
            content={
                "fetched_at": datetime.now().isoformat(timespec="seconds"),
                "error": str(exc),
                "date_range": range_meta,
                "locations": [],
                "calendar": [],
            },
            headers={"Cache-Control": "no-store"},
        )

    max_published = max((s["date"] for s in all_slots), default=None)

    results: list[dict[str, Any]] = []
    daily_summary: dict[str, dict[str, Any]] = {}

    for loc_id, meta in target_locations.items():
        slots = filter_slots(all_slots, loc_id, start, end, available_only)
        available_count = sum(1 for s in slots if s["available"])
        full_count = sum(1 for s in slots if not s["available"])
        available_prices = [s["price_eur"] for s in slots if s["available"] and s["price_eur"]]
        next_available = next((s for s in slots if s["available"]), None)

        by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for slot in slots:
            by_date[slot["date"]].append(slot)
            key = f"{loc_id}:{slot['date']}"
            if key not in daily_summary:
                daily_summary[key] = {
                    "location_id": loc_id,
                    "location": meta["name"],
                    "date": slot["date"],
                    "weekday": slot["weekday"],
                    "available_slots": 0,
                    "full_slots": 0,
                    "total_free_lanes": 0,
                }
            if slot["available"]:
                daily_summary[key]["available_slots"] += 1
                daily_summary[key]["total_free_lanes"] += slot["free"]
            else:
                daily_summary[key]["full_slots"] += 1

        results.append(
            {
                "location_id": loc_id,
                **meta,
                "booking_url": booking_url_for(loc_id),
                "slots": slots,
                "by_date": dict(by_date),
                "stats": {
                    "total": len(slots),
                    "available": available_count,
                    "full": full_count,
                    "total_free_lanes": sum(s["free"] for s in slots if s["available"]),
                    "min_available_price_eur": min(available_prices) if available_prices else None,
                    "next_available": (
                        {
                            "date": next_available["date"],
                            "time_start": next_available["time_start"],
                            "price_eur": next_available["price_eur"],
                        }
                        if next_available
                        else None
                    ),
                },
            }
        )

    calendar_days: list[dict[str, Any]] = []
    for i in range(days):
        d = (start + timedelta(days=i)).date()
        iso = d.isoformat()
        day_entry: dict[str, Any] = {
            "date": iso,
            "weekday": d.strftime("%a"),
            "locations": {},
        }
        for loc_id, meta in target_locations.items():
            key = f"{loc_id}:{iso}"
            summary = daily_summary.get(key)
            unpublished = max_published is not None and iso > max_published
            day_entry["locations"][str(loc_id)] = summary or {
                "location_id": loc_id,
                "location": meta["name"],
                "date": iso,
                "weekday": d.strftime("%a"),
                "available_slots": 0,
                "full_slots": 0,
                "total_free_lanes": 0,
                "unpublished": unpublished,
            }
        calendar_days.append(day_entry)

    all_available_prices = [
        s["price_eur"] for s in all_slots if s["available"] and s["price_eur"]
    ]

    payload = {
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
        "date_range": range_meta,
        "max_published_date": max_published,
        "total_slots_in_api": len(all_slots),
        "min_price_eur": min(all_available_prices) if all_available_prices else None,
        "price_note": "Per-slot pricing — campaign (tarjous) slots are cheaper",
        "booking_url": BOOKING_URL_ALL,
        "locations": results,
        "calendar": calendar_days,
    }

    # Remember last successful full payload (both locations, unfiltered) so an
    # upstream outage can still be served as stale data.
    if len(target_locations) == len(LOCATIONS) and not available_only:
        _cache["last_good"] = payload

    return Response(
        content=json.dumps(payload),
        media_type="application/json",
        headers={
            "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
        },
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
