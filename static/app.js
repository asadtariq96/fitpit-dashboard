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

function initElements() {
  const ids = [
    "days", "location", "availableOnly", "refreshBtn",
    "lastUpdated", "statsGrid", "calendar", "loading",
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
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}

/** "14:30" -> "2:30 PM" */
function fmt12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${ap}`;
}

/** "14:30-15:30" -> "2:30-3:30 PM" (meridiem shown once when shared) */
function fmtRange(range) {
  const [a, b] = range.split("-");
  if (!b) return fmt12(a);
  const A = fmt12(a), B = fmt12(b);
  return A.slice(-2) === B.slice(-2) ? `${A.slice(0, -3)}-${B}` : `${A}-${B}`;
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

/** "Fri 21.8." */
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
    els.priceValue.textContent = `€${data.min_price_eur}`;
    if (els.priceLabel) els.priceLabel.textContent = "from / slot";
  }
}

function renderStats(data) {
  setHTML(
    els.statsGrid,
    data.locations
      .map((loc) => {
        const cls = LOC_CLASS[loc.location_id] || "";
        if (loc.error) {
          return `<div class="stat-card ${cls}"><div class="error-state">${loc.name}: ${loc.error}</div></div>`;
        }
        const s = loc.stats;
        const from = s.min_available_price_eur != null
          ? `<span class="stat-from">from €${s.min_available_price_eur}</span>`
          : "";
        const next = s.next_available
          ? `Next free <strong>${formatDayShort(s.next_available.date)} ${fmt12(s.next_available.time_start)}</strong>` +
            (s.next_available.price_eur != null ? ` · €${s.next_available.price_eur}` : "")
          : "No free slots in range";
        return `
          <div class="stat-card ${cls}">
            <div class="stat-card-header">
              <div>
                <h3>${loc.name}</h3>
                <div class="city">${loc.city}</div>
              </div>
              ${from}
            </div>
            <div class="stat-numbers">
              <div class="stat-item">
                <div class="stat-value green">${s.available}</div>
                <div class="stat-label">Available</div>
              </div>
              <div class="stat-item">
                <div class="stat-value red">${s.full}</div>
                <div class="stat-label">Unavailable</div>
              </div>
              <div class="stat-item">
                <div class="stat-value amber">${s.total_free_lanes}</div>
                <div class="stat-label">Free lanes</div>
              </div>
            </div>
            <div class="stat-next">${next}</div>
          </div>`;
      })
      .join("")
  );
}

function slotCard(slot, showLoc, bookingUrl) {
  const cls = slot.available ? "available" : "unavailable";
  const promo = slot.promotion ? " promo" : "";
  const locCls = LOC_CLASS[slot.location_id] || "";
  const prefix = showLoc ? `<span class="time-card-loc ${locCls}">${LOC_SHORT[slot.location_id] || "?"}</span>` : "";
  const detail = slot.available ? `×${slot.free}` : "×";
  const price = slot.available && slot.price_eur != null
    ? `<span class="time-card-price">€${slot.price_eur}</span>`
    : "";
  const dur = slot.duration_min ? ` · ${slot.duration_min}min` : "";
  const title = `${slot.locName} · ${fmtRange(slot.time_range)}${dur} · ${
    slot.available ? slot.free + " free · €" + slot.price_eur : "Full"
  }${slot.promotion ? " · campaign price" : ""}`;

  const inner = `${prefix}
    <span class="time-card-time">${fmtRange(slot.time_range)}</span>
    <span class="time-card-detail">${detail}</span>
    ${price}`;

  const locClass = showLoc ? " has-loc" : "";
  if (slot.available && bookingUrl) {
    return `<a class="time-card ${cls}${promo}${locClass}" href="${bookingUrl}" target="_blank" rel="noopener" title="${title}">${inner}</a>`;
  }
  return `<div class="time-card ${cls}${promo}${locClass}" title="${title}">${inner}</div>`;
}

function renderDayCell(cell, slotsByDate, today, showBoth, bookingUrl) {
  if (!cell.inRange) {
    return `<div class="cal-cell cal-cell--pad"><span class="cal-day-num muted">${cell.dayNum}</span></div>`;
  }

  const slots = slotsByDate[cell.date] || [];
  const isToday = cell.date === today;
  const anyPublished = cell.meta
    ? Object.values(cell.meta.locations || {}).some((l) => !l.unpublished)
    : false;

  let body;
  if (slots.length === 0) {
    body = anyPublished
      ? `<div class="cal-cell-empty">—</div>`
      : `<div class="cal-cell-empty unpublished">?</div>`;
  } else {
    body = `<div class="cal-cell-slots">${slots.map((s) => slotCard(s, showBoth, bookingUrl)).join("")}</div>`;
  }

  const avail = slots.filter((s) => s.available).length;

  return `
    <div class="cal-cell${isToday ? " cal-cell--today" : ""}${slots.length === 0 && !anyPublished ? " cal-cell--unpublished" : ""}">
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
    <div class="cal-month-label">${monthLabel}</div>
    <div class="cal-grid">
      <div class="cal-weekdays">${weekdayHeader}</div>
      <div class="cal-weeks">${weekRows}</div>
    </div>`;
}

function formatMonthLabel(calendarDays) {
  if (!calendarDays.length) return "";
  const first = parseDate(calendarDays[0].date);
  const last = parseDate(calendarDays[calendarDays.length - 1].date);
  const fmt = (d) => d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) {
    return fmt(first);
  }
  return `${first.toLocaleDateString("en-GB", { month: "short" })} – ${fmt(last)}`;
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

    sections.push(`
      <div class="ml-loc">
        <div class="ml-loc-head ${LOC_CLASS[loc.location_id] || ""}">
          <h3>${loc.name}</h3>
          <span class="ml-loc-sub">${loc.city} · ${loc.stats.available} available</span>
        </div>
        ${
          slots.length === 0
            ? `<div class="ml-empty">No slots in range${hideUnavailable ? " (available only)" : ""}</div>`
            : days
                .map((date) => `
                  <div class="ml-day">
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
  renderStats(lastData);
  setHTML(els.calendar, MOBILE_MQ.matches
    ? renderMobileList(lastData)
    : renderCalendarInner(lastData));
  if (els.lastUpdated) {
    els.lastUpdated.textContent = `Updated ${formatTime(lastData.fetched_at)}`;
  }
}

function showError(message) {
  if (els.statsGrid) els.statsGrid.innerHTML = `<div class="error-state">${message}</div>`;
  if (els.calendar) els.calendar.innerHTML = "";
}

async function load() {
  if (els.loading) els.loading.classList.remove("hidden");
  try {
    lastData = await fetchAvailability();
    render();
  } catch (err) {
    console.error(err);
    showError(`Failed to load: ${err.message}`);
  } finally {
    if (els.loading) els.loading.classList.add("hidden");
  }
}

function boot() {
  initElements();
  if (!els.statsGrid || !els.calendar) {
    showError("Dashboard failed to initialize — please hard-refresh (Cmd+Shift+R)");
    return;
  }

  els.days.addEventListener("change", load);
  els.location.addEventListener("change", load);
  els.availableOnly.addEventListener("change", () => render());
  els.refreshBtn.addEventListener("click", load);

  // Re-render on breakpoint crossings so mobile ↔ desktop stays correct.
  MOBILE_MQ.addEventListener("change", render);

  load();
  setInterval(load, 5 * 60 * 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
