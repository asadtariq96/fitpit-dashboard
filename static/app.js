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

function initElements() {
  const ids = [
    "days", "location", "availableOnly", "refreshBtn",
    "lastUpdated", "statsGrid", "calendar", "loading",
  ];
  for (const id of ids) {
    els[id] = $(`#${id}`);
    if (!els[id]) console.error(`FitPit dashboard: missing #${id}`);
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
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

function renderStats(data) {
  setHTML(
    els.statsGrid,
    data.locations
      .map((loc) => {
        const cls = LOC_CLASS[loc.location_id] || "";
        if (loc.error) {
          return `<div class="stat-card ${cls}"><div class="error-state">${loc.name}: ${loc.error}</div></div>`;
        }
        return `
          <div class="stat-card ${cls}">
            <div class="stat-card-header">
              <div>
                <h3>${loc.name}</h3>
                <div class="city">${loc.city}</div>
              </div>
            </div>
            <div class="stat-numbers">
              <div class="stat-item">
                <div class="stat-value green">${loc.stats.available}</div>
                <div class="stat-label">Available</div>
              </div>
              <div class="stat-item">
                <div class="stat-value red">${loc.stats.full}</div>
                <div class="stat-label">Unavailable</div>
              </div>
              <div class="stat-item">
                <div class="stat-value amber">${loc.stats.total_free_lanes}</div>
                <div class="stat-label">Free lanes</div>
              </div>
            </div>
          </div>`;
      })
      .join("")
  );
}

function slotCard(slot, showLoc) {
  const cls = slot.available ? "available" : "unavailable";
  const locCls = LOC_CLASS[slot.location_id] || "";
  const prefix = showLoc ? `<span class="time-card-loc ${locCls}">${LOC_SHORT[slot.location_id] || "?"}</span>` : "";
  const detail = slot.available ? slot.free : "×";
  const title = `${slot.locName} · ${slot.time_range} · ${slot.available ? slot.free + " lanes" : "Full"}`;

  return `
    <div class="time-card ${cls}" title="${title}">
      ${prefix}
      <span class="time-card-time">${slot.time_start.slice(0, 5)}</span>
      <span class="time-card-detail">${detail}</span>
    </div>`;
}

function renderDayCell(cell, slotsByDate, today, showBoth) {
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
    body = `<div class="cal-cell-slots">${slots.map((s) => slotCard(s, showBoth)).join("")}</div>`;
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

function renderCalendar(data) {
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
        `<div class="cal-week">${week.map((cell) => renderDayCell(cell, slotsByDate, today, showBoth)).join("")}</div>`
    )
    .join("");

  setHTML(
    els.calendar,
    `
    <div class="cal-month-label">${monthLabel}</div>
    <div class="cal-grid">
      <div class="cal-weekdays">${weekdayHeader}</div>
      <div class="cal-weeks">${weekRows}</div>
    </div>`
  );
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

function render(data) {
  renderStats(data);
  renderCalendar(data);
  if (els.lastUpdated) {
    els.lastUpdated.textContent = `Updated ${formatTime(data.fetched_at)}`;
  }
}

function showError(message) {
  if (els.statsGrid) els.statsGrid.innerHTML = `<div class="error-state">${message}</div>`;
  if (els.calendar) els.calendar.innerHTML = "";
}

async function load() {
  if (els.loading) els.loading.classList.remove("hidden");
  try {
    const data = await fetchAvailability();
    render(data);
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
  els.availableOnly.addEventListener("change", load);
  els.refreshBtn.addEventListener("click", load);

  load();
  setInterval(load, 5 * 60 * 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
