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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

FITPIT_GROUPS_URL = "https://shop.fitpit.fi/fitpit/reservations2/apieventgroups"
SERVICE_ID = 11
GROUP_ID = 18  # Uimaradan vuokraus (lane rental)
CACHE_TTL_SECONDS = 120

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

BOOKING_URL = (
    "https://shop.fitpit.fi/fitpit/reservations2/reservations/11/-/18/-/-/-?lang=1"
)

app = FastAPI(title="FitPit Lane Rental Dashboard")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_cache: dict[str, Any] = {"groups": None, "fetched_at": 0.0}


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
            "User-Agent": "FitPit-Dashboard/1.0",
            "Accept": "application/json",
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        groups = json.loads(resp.read())

    _cache["key"] = cache_key
    _cache["groups"] = groups
    _cache["fetched_at"] = now
    return groups


def flatten_lane_slots(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert apieventgroups payload into flat slot records."""
    slots: list[dict[str, Any]] = []
    for group in groups:
        if group.get("reservation_group_id") != GROUP_ID:
            continue
        name = group.get("name") or group.get("reservation_group_name") or ""
        if "Uimaradan vuokraus" not in name:
            continue

        for event in group.get("reservation_events") or []:
            time_start = event.get("time_start")
            time_end = event.get("time_end")
            location_id = event.get("location_id") or group.get("location_id")
            if not time_start or not time_end or location_id not in LOCATIONS:
                continue

            dt_start = datetime.strptime(time_start, "%Y-%m-%d %H:%M:%S")
            dt_end = datetime.strptime(time_end, "%Y-%m-%d %H:%M:%S")
            free = event.get("free", 0) or 0

            slots.append(
                {
                    "event_id": event.get("reservation_event_id"),
                    "location_id": location_id,
                    "date": dt_start.date().isoformat(),
                    "weekday": dt_start.strftime("%a"),
                    "time_start": dt_start.strftime("%H:%M"),
                    "time_end": dt_end.strftime("%H:%M"),
                    "time_range": f"{dt_start.strftime('%H:%M')}-{dt_end.strftime('%H:%M')}",
                    "free": free,
                    "capacity": event.get("capacity", 0) or 0,
                    "reserved": event.get("reserved", 0) or 0,
                    "available": free > 0,
                    "promotion": "Kesälomatarjous" in name,
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
        {"id": loc_id, **meta, "booking_url": BOOKING_URL}
        for loc_id, meta in LOCATIONS.items()
    ]


@app.get("/api/availability")
def get_availability(
    days: int = Query(default=15, ge=1, le=90),
    available_only: bool = Query(default=False),
    location_id: int | None = Query(default=None),
) -> dict[str, Any]:
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=days)
    target_locations = (
        {location_id: LOCATIONS[location_id]}
        if location_id is not None and location_id in LOCATIONS
        else LOCATIONS
    )

    try:
        all_groups = fetch_event_groups(list(LOCATIONS.keys()))
        all_slots = flatten_lane_slots(all_groups)
    except Exception as exc:
        return {
            "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "error": str(exc),
            "date_range": {
                "start": start.date().isoformat(),
                "end": (end - timedelta(days=1)).date().isoformat(),
                "days": days,
            },
            "locations": [],
            "calendar": [],
        }

    max_published = max((s["date"] for s in all_slots), default=None)

    results: list[dict[str, Any]] = []
    daily_summary: dict[str, dict[str, Any]] = {}

    for loc_id, meta in target_locations.items():
        slots = filter_slots(all_slots, loc_id, start, end, available_only)
        available_count = sum(1 for s in slots if s["available"])
        full_count = sum(1 for s in slots if not s["available"])

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
                "booking_url": BOOKING_URL,
                "slots": slots,
                "by_date": dict(by_date),
                "stats": {
                    "total": len(slots),
                    "available": available_count,
                    "full": full_count,
                    "total_free_lanes": sum(s["free"] for s in slots if s["available"]),
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

    return {
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
        "date_range": {
            "start": start.date().isoformat(),
            "end": (end - timedelta(days=1)).date().isoformat(),
            "days": days,
        },
        "max_published_date": max_published,
        "total_slots_in_api": len(all_slots),
        "price_eur": 22.0,
        "price_note": "Kesälomatarjous — 60 min lane rental",
        "booking_url": BOOKING_URL,
        "locations": results,
        "calendar": calendar_days,
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
