function $(sel) {
  return document.querySelector(sel);
}

function setHTML(el, html) {
  if (!el) throw new Error(`Missing element: ${selFor(el)}`);
  el.innerHTML = html;
}

function selFor(el) {
  return el?.id ? `#${el.id}` : el?.className || "unknown";
}

const els = {};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MOBILE_MQ = window.matchMedia("(max-width: 760px)");

const CONTROLS = ["days", "location", "availableOnly"];

/** #2: filters live in the URL (?days=30&loc=52&avail=1) so views are shareable. */
function applyUrlState() {
  const p = new URLSearchParams(location.search);
  const days = parseInt(p.get("days"), 10);
  if ([7, 15, 21, 30, 60, 90].includes(days)) els.days.value = String(days);
  const loc = p.get("loc");
  if (["", "52", "39"].includes(loc)) els.location.value = loc;
  if (p.get("avail") === "1") els.availableOnly.checked = true;
}

let urlSyncQueued = false;

function syncUrlState() {
  // Skip during initial load so we don't clobber a shared link before restore.
  if (!booted) return;
  if (urlSyncQueued) return;
  urlSyncQueued = true;
  requestAnimationFrame(() => {
    urlSyncQueued = false;
    const p = new URLSearchParams();
    if (els.days.value !== "15") p.set("days", els.days.value);
    if (els.location.value) p.set("loc", els.location.value);
    if (els.availableOnly.checked) p.set("avail", "1");
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  });
}

function initElements() {
  const ids = [
    "days", "location", "availableOnly", "refreshBtn",
    "lastUpdated", "calendar", "loading",
    "priceValue", "priceLabel",
  ];
  for (const id of ids) {
    els[id] = $(`#${id}`);
    if (!els[id] && !["priceValue", "priceLabel"].includes(id))
      console.error(`FitPit dashboard: missing #${id}`);
  }
}

const LOC_CLASS = { 52: "kilo", 39: "valkea" };
const LOC_SHORT = { 52: "K", 39: "V" };

async function fetchAvailability() {
  const params = new URLSearchParams({
    days: els.days.value,
    available_only: "false",
  });
  const loc = els.location.value;
  if (loc) params.set("location_id", loc);

  const res = await fetch(`/api/availability?${params}`);
  if (!res.ok && res.status !== 503) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  data.stale = res.status === 503 || Boolean(data.stale);
  return data;
}

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Fri 23/08" — en-GB day/month, matching EU date convention. */
function formatDayShort(iso) {
  return parseDate(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "numeric",
  });
}

/** Monday = 0 … Sunday = 6 */
function mondayIndex(d) {
  return (d.getDay() + 6) % 7;
}

/** #9/#10: 24h "07:30–08:30" — consistent with EU dates. */
function fmtRange(range) {
  return range.replace("-", "\u2013");
}

/** Relative age of fetched_at for the staleness indicator (#3). */
function relAge(isoFetched) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(isoFetched).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

function buildWeekGrid(calendarDays) {
  if (!calendarDays.length) return [];

  const first = parseDate(calendarDays[0].date);
  const last = parseDate(calendarDays[calendarDays.length - 1].date);

  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - mondayIndex(first));

  const gridEnd = new Date(last);
  gridEnd.setDate(last.getDate() + (6 - mondayIndex(last)));

  const dayMap = Object.fromEntries(calendarDays.map((d) => [d.date, d]));
  const inRange = new Set(calendarDays.map((d) => d.date));

  const cells = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    const iso = toISO(d);
    cells.push({
      date: iso,
      weekday: WEEKDAYS[mondayIndex(d)],
      dayNum: d.getDate(),
      inRange: inRange.has(iso),
      meta: dayMap[iso] || null,
    });
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

function renderPriceBadge(data) {
  if (!els.priceValue) return;
  if (data.min_price_eur != null) {
    els.priceValue.textContent = `€${Number.isInteger(data.min_price_eur) ? data.min_price_eur : data.min_price_eur.toFixed(2)}`;
    if (els.priceLabel) els.priceLabel.textContent = "from / slot";
  }
}

/**
 * #6: compact per-location "next free" line under the calendar header that
 * jumps to and flashes the day cell.
 */
function nextFreeStrip(data) {
  const parts = [];
  for (const loc of data.locations) {
    if (loc.error || !loc.stats.next_available) continue;
    const na = loc.stats.next_available;
    parts.push(`
      <button class="nextfree-chip ${LOC_CLASS[loc.location_id] || ""}" data-jump-date="${na.date}"
        title="Jump to ${formatDayShort(na.date)}">
        <span class="nextfree-label">${LOC_SHORT[loc.location_id] || "?"} next free</span>
        <span class="nextfree-value">${formatDayShort(na.date)} ${na.time_start}</span>
        ${na.price_eur != null ? `<span class="nextfree-price">€${Number.isInteger(na.price_eur) ? na.price_eur : na.price_eur.toFixed(2)}</span>` : ""}
      </button>`);
  }
  if (!parts.length) return "";
  return `<div class="nextfree-strip">${parts.join("")}</div>`;
}

function slotCard(slot, showLoc, bookingUrl) {
  const cls = slot.available ? "available" : "unavailable";
  const promo = slot.promotion ? " promo" : "";
  const locCls = LOC_CLASS[slot.location_id] || "";
  const prefix = showLoc
    ? `<span class="time-card-loc ${locCls}" aria-label="${slot.locName}">${LOC_SHORT[slot.location_id] || "?"}</span>`
    : "";
  // #9: slim chips — time + free count only. Price/promo live in the tooltip
  // and on the booking page.
  const detail = slot.available ? `×${slot.free}` : "";
  const dur = slot.duration_min ? ` · ${slot.duration_min}min` : "";
  const title = `${slot.locName} · ${fmtRange(slot.time_range)}${dur} · ${
    slot.available ? slot.free + " free · €" + slot.price_eur : "Full"
  }${slot.promotion ? " · campaign price" : ""}`;

  const inner = `${prefix}
    <span class="time-card-time">${fmtRange(slot.time_range)}</span>
    <span class="time-card-detail">${detail}</span>`;

  const locClass = showLoc ? " has-loc" : "";
  if (slot.available && bookingUrl) {
    return `<a class="time-card ${cls}${promo}${locClass}" href="${bookingUrl}" target="_blank" rel="noopener" title="${title}">${inner}</a>`;
  }
  return `<div class="time-card ${cls}${promo}${locClass}" title="${title}">${inner}</div>`;
}

/** #11: empty day cells say why they're empty. */
function emptyStateText(cell) {
  const locDays = cell.meta ? Object.values(cell.meta.locations || {}) : [];
  const anyPublished = locDays.some((l) => !l.unpublished);
  if (!anyPublished) return { text: "?", cls: " unpublished", tip: "Not published by FitPit yet" };
  // Venue open that day but every slot booked -> "Full"; no slots at all -> "Closed".
  const anyBookedOut = locDays.some((l) => (l.full_slots || 0) > 0);
  if (anyBookedOut) return { text: "Full", cls: "", tip: "Fully booked" };
  return { text: "Closed", cls: "", tip: "No slots scheduled this day" };
}

function renderDayCell(cell, slotsByDate, today, showBoth, bookingUrl) {
  if (!cell.inRange) {
    return `<div class="cal-cell cal-cell--pad"><span class="cal-day-num muted">${cell.dayNum}</span></div>`;
  }

  const slots = slotsByDate[cell.date] || [];
  const isToday = cell.date === today;
  const isPast = cell.date < today;
  const cellId = `day-${cell.date}`;

  let body;
  if (slots.length === 0) {
    const es = emptyStateText(cell);
    body = `<div class="cal-cell-empty${es.cls}" title="${es.tip}">${es.text}</div>`;
  } else {
    body = `<div class="cal-cell-slots">${slots.map((s) => slotCard(s, showBoth, bookingUrl)).join("")}</div>`;
  }

  const avail = slots.filter((s) => s.available).length;

  return `
    <div class="cal-cell${isToday ? " cal-cell--today" : ""}${isPast ? " cal-cell--past" : ""}${slots.length === 0 ? " cal-cell--emptyday" : ""}" id="${cellId}">
      <div class="cal-cell-head">
        <span class="cal-day-num">${cell.dayNum}</span>
        ${avail > 0 ? `<span class="cal-day-badge">${avail}</span>` : ""}
      </div>
      ${body}
    </div>`;
}

function renderCalendarInner(data) {
  const today = toISO(new Date());
  const hideUnavailable = els.availableOnly.checked;
  const showBoth = !els.location.value;

  const slotsByDate = {};
  for (const loc of data.locations) {
    if (loc.error) continue;
    for (const slot of loc.slots) {
      if (hideUnavailable && !slot.available) continue;
      const entry = { ...slot, location_id: loc.location_id, locName: loc.name };
      (slotsByDate[slot.date] ||= []).push(entry);
    }
  }

  for (const date of Object.keys(slotsByDate)) {
    slotsByDate[date].sort((a, b) => {
      const t = a.time_start.localeCompare(b.time_start);
      return t !== 0 ? t : a.locName.localeCompare(b.locName);
    });
  }

  const weeks = buildWeekGrid(data.calendar || []);
  const monthLabel = formatMonthLabel(data.calendar || []);

  const weekdayHeader = WEEKDAYS.map((d) => `<div class="cal-weekday">${d}</div>`).join("");
  const weekRows = weeks
    .map(
      (week) =>
        `<div class="cal-week">${week.map((cell) => renderDayCell(cell, slotsByDate, today, showBoth, data.booking_url)).join("")}</div>`
    )
    .join("");

  return `
    <div class="cal-month-label">${monthLabel}${nextFreeStrip(data)}</div>
    <div class="cal-grid">
      <div class="cal-weekdays">${weekdayHeader}</div>
      <div class="cal-weeks">${weekRows}</div>
    </div>`;
}

function formatMonthLabel(calendarDays) {
  if (!calendarDays.length) return "";
  const first = parseDate(calendarDays[0].date);
  const last = parseDate(calendarDays[calendarDays.length - 1].date);
  const fmtLong = (d) => d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) {
    return fmtLong(first);
  }
  // #10: consistent full month names on both sides of the dash
  return `${fmtLong(first)} – ${fmtLong(last)}`;
}

/** Phone layout: per-location day list instead of a squeezed calendar. */
function renderMobileList(data) {
  const hideUnavailable = els.availableOnly.checked;
  const showLoc = !els.location.value;
  const sections = [];

  for (const loc of data.locations) {
    if (loc.error) continue;
    const slots = loc.slots.filter((s) => !hideUnavailable || s.available);
    const days = [];
    const byDate = new Map();
    for (const s of slots) {
      if (!byDate.has(s.date)) { byDate.set(s.date, []); days.push(s.date); }
      byDate.get(s.date).push(s);
    }
    const na = loc.stats?.next_available;

    sections.push(`
      <div class="ml-loc">
        <div class="ml-loc-head ${LOC_CLASS[loc.location_id] || ""}">
          <h3>${loc.name}</h3>
          <span class="ml-loc-sub">${loc.city}</span>
        </div>
        ${
          na
            ? `<button class="nextfree-chip ${LOC_CLASS[loc.location_id] || ""}" data-jump-date="${na.date}">
                 <span class="nextfree-label">Next free</span>
                 <span class="nextfree-value">${formatDayShort(na.date)} ${na.time_start}</span>
               </button>`
            : ""
        }
        ${
          slots.length === 0
            ? `<div class="ml-empty">No slots in range${hideUnavailable ? " (available only)" : ""}</div>`
            : days
                .map((date) => `
                  <div class="ml-day" id="day-${date}">
                    <div class="ml-day-head">${formatDayShort(date)}</div>
                    <div class="ml-slots">${byDate.get(date).map((s) => slotCard(s, showLoc, data.booking_url)).join("")}</div>
                  </div>`)
                .join("")
        }
      </div>`);
  }
  return `<div class="mobile-list">${sections.join("")}</div>`;
}

let lastData = null;

function render() {
  if (!lastData) return;
  renderPriceBadge(lastData);
  setHTML(els.calendar, MOBILE_MQ.matches
    ? renderMobileList(lastData)
    : renderCalendarInner(lastData));
  updateStaleBadge();
}

/** #12: timestamp lives beside Refresh; turns amber when data goes stale (#3). */
function updateStaleBadge() {
  if (!els.lastUpdated || !lastData) return;
  const age = lastData.fetched_at ? relAge(lastData.fetched_at) : "";
  // Label the tz explicitly so it reads as the viewer's, not a venue's.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const tzLabel = tz ? `times in ${tz.split("/").pop().replace("_", " ")}` : "";
  els.lastUpdated.textContent =
    `Updated ${age}` +
    (lastData.stale ? " · cached (FitPit unreachable)" : "") +
    (tzLabel ? ` · ${tzLabel}` : "");
  els.lastUpdated.classList.toggle("stale", Boolean(lastData.stale));
}

/** #3: refresh every 5 min; on failure retry with exponential backoff. */
let pollTimer = null;
let backoffMs = 0;
let backoffTimer = null;

function scheduleNextLoad() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(load, 5 * 60 * 1000);
}

function scheduleBackoffRetry(err) {
  console.error(err);
  backoffMs = backoffMs === 0 ? 15_000 : Math.min(backoffMs * 2, 120_000);
  clearTimeout(backoffTimer);
  backoffTimer = setTimeout(load, backoffMs);
  if (els.lastUpdated)
    els.lastUpdated.textContent = `Fetch failed — retrying in ${Math.round(backoffMs / 1000)}s`;
}

async function load() {
  clearTimeout(pollTimer);
  clearTimeout(backoffTimer);
  if (els.loading) els.loading.classList.remove("hidden");
  try {
    lastData = await fetchAvailability();
    render();
    backoffMs = 0;
    scheduleNextLoad();
  } catch (err) {
    if (!lastData && els.calendar) {
      setHTML(els.calendar, `<div class="error-state">Failed to load availability (${err.message}) — retrying…</div>`);
    }
    scheduleBackoffRetry(err);
  } finally {
    if (els.loading) els.loading.classList.add("hidden");
  }
}

/** #6: "next free" chips scroll to + flash the target day. */
function jumpToDate(dateIso) {
  const target = document.getElementById(`day-${dateIso}`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("flash");
  void target.offsetWidth; // restart animation
  target.classList.add("flash");
}

let booted = false;

function boot() {
  initElements();
  applyUrlState();
  if (!els.calendar) {
    els.calendar = $("#calendar");
  }
  if (!els.calendar) {
    if (els.lastUpdated) els.lastUpdated.textContent = "Dashboard failed to initialize — hard-refresh";
    return;
  }
  booted = true;

  els.days.addEventListener("change", () => { syncUrlState(); load(); });
  els.location.addEventListener("change", () => { syncUrlState(); load(); });
  els.availableOnly.addEventListener("change", () => { syncUrlState(); render(); });
  els.refreshBtn.addEventListener("click", load);

  // Re-render on breakpoint crossings so mobile ↔ desktop stays correct.
  MOBILE_MQ.addEventListener("change", render);

  // Delegated handler survives innerHTML re-renders of the calendar.
  document.addEventListener("click", (ev) => {
    const chip = ev.target.closest("[data-jump-date]");
    if (chip) jumpToDate(chip.dataset.jumpDate);
  });

  // Keep the relative "updated X ago" label fresh between polls.
  setInterval(updateStaleBadge, 30_000);

  load();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
