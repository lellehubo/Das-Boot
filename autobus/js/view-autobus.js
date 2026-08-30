// Das Autobus: which bus gets us there, and when to leave.
//
// Shares the engine, the data layer, the SL client and the weather modules with
// Das Boot — one fix reaches both. What is its own: the data under
// autobus/data/, and this view.
//
// The shape differs from Das Boot in one way that matters. There, the
// destination follows the calendar, because there is only ever one place to go.
// Here there are four, chosen by hand, because a family goes to school and to
// town on the same morning.

const VERSION = new URL(import.meta.url).search;
// Two different bases are in play and they are easy to confuse. A module
// specifier resolves against *this file* (/autobus/js/), so reaching the shared
// engine at /js/ takes two steps up. The data layer's fetch resolves against the
// *document* (/autobus/), so its default "data/" already lands in our own data.
const BASE = "../../js/";
const [{ loadData, destinationsFor, DataError }, { departures }, engine, wx, wxScore, wxPhrase] =
  await Promise.all([
    import(`${BASE}data-layer.js${VERSION}`),
    import(`${BASE}api-sl.js${VERSION}`),
    import(`${BASE}engine-scenarios.js${VERSION}`),
    import(`${BASE}weather.js${VERSION}`),
    import(`${BASE}weather-score.js${VERSION}`),
    import(`${BASE}weather-phrase.js${VERSION}`),
  ]);
const { planAll, toClock, toMinutes, defaultDirection, TO_WORK, TO_HOME } = engine;

const REFRESH_MS = 30_000;
const STORE_KEY = "autobus-destination";

let data = null;
let loadError = null;
let feeds = new Map();
let lastFetch = 0;
let fetching = false;
let forecast = null;

let chosenDestination = null;
let chosenDirection = null;
let chosenOn = null;

const el = (id) => document.getElementById(id);

function currentDirection(se) {
  return chosenDirection && chosenOn === se.iso ? chosenDirection : defaultDirection(se.min);
}

/** The destination in play: the saved one if it still exists, else the first. */
function currentDestination() {
  const all = data.scenarios.destinations;
  return all.find((d) => d.id === chosenDestination) || all[0];
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function fmtCountdown(minutes) {
  const seconds = Math.round(minutes * 60);
  if (seconds <= 10) return "nu";
  if (seconds < 90) return `om ${seconds} s`;
  const m = Math.floor(minutes);
  if (m < 60) return `om ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `om ${h} h ${rest} min` : `om ${h} h`;
}

/**
 * Every stop any route boards at, in either direction.
 *
 * Fetched in one go rather than per destination: the three home stops serve all
 * four destinations between them, and switching destination should not have to
 * wait for a round trip.
 */
function requiredSites() {
  const ids = new Set();
  for (const scenario of data.scenarios.scenarios) {
    if (scenario.status === "dormant") continue;
    for (const leg of scenario.legs) {
      if (leg.type !== "transit") continue;
      for (const end of ["from", "to"]) {
        const node = data.node(leg[end]);
        if (node?.site_id != null) ids.add(node.site_id);
      }
    }
  }
  return [...ids];
}

async function refresh() {
  if (fetching || !data) return;
  fetching = true;
  try {
    const results = await Promise.all(
      requiredSites().map((id) => departures(id).then((r) => [id, r]).catch(() => [id, null]))
    );
    const next = new Map();
    for (const [id, result] of results) if (result) next.set(id, result);
    if (next.size) {
      feeds = next;
      lastFetch = Date.now();
    }
  } finally {
    fetching = false;
  }
}

/** Weather is an addition, never a dependency: failure costs the forecast only. */
async function refreshWeather() {
  if (!data) return;
  const home = data.node("home");
  if (!home?.lat) return;
  try {
    forecast = await wx.forecast({ lat: home.lat, lon: home.lon }, data.weights.weather);
  } catch (e) {
    console.warn(`väder: ${e.message}`);
  }
}

/** The day in two halves, the same fixed windows Das Boot settled on. */
function renderWeather(se) {
  const host = el("aWeather");
  if (!host) return;
  let lines = [];
  try {
    const windows = data.weights.weather.day_windows || {};
    const opts = { localMinutesOf: wxScore.localMinutesOf };
    for (const key of ["morning", "afternoon"]) {
      const win = windows[key];
      if (!win || !forecast) continue;
      const summary = wxScore.summariseWindow(forecast, se.iso, win.from * 60, win.to * 60);
      const said = wxPhrase.describeWindow(summary, opts);
      if (said) lines.push({ label: win.label, ...said });
    }
  } catch (e) {
    console.warn(`väder: beskrivningen misslyckades (${e.message})`);
  }
  host.innerHTML = lines
    .map(
      (l) =>
        `<div class="wx-line"><span class="wx-ico">${wxPhrase.iconSvg(l.icon)}</span>` +
        `<span class="wx-when">${esc(l.label)}</span>` +
        `<span class="wx-text">${esc(l.text)}</span></div>`
    )
    .join("");
  host.style.display = lines.length ? "" : "none";
}

/** The weather on a route: symbol and minutes outdoors, no verdict. */
function weatherChip(plan) {
  const verdict = plan.weather;
  if (!verdict) return "";
  const said = verdict.window
    ? wxPhrase.describeWindow(verdict.window, { localMinutesOf: wxScore.localMinutesOf })
    : null;
  const minutes = verdict.exposure?.minutes;
  if (!said && minutes == null) return "";
  const level = verdict.level === "clear" ? "" : ` wx-${verdict.level}`;
  return (
    `<span class="chip wx-route${level}" title="${esc(said ? said.text : "")}">` +
    `${said ? wxPhrase.iconSvg(said.icon) : ""}${minutes != null ? `${Math.round(minutes)} min ute` : ""}</span>`
  );
}

/** Each leg in order, so the card shows the whole trip and not just the bus. */
function summarise(plan) {
  return plan.legs
    .map((l) => {
      const to = esc(data.node(l.to)?.label ?? l.to);
      if (l.type === "walk") return `Gå ${l.minutes} min till ${to}`;
      const late = l.delay > 0 ? ` <b>+${l.delay}</b>` : "";
      const held = l.wait > 0 ? ` <span class="muted">(${l.wait} min väntan)</span>` : "";
      const towards = l.destination ? ` <span class="muted">mot ${esc(l.destination)}</span>` : "";
      return `<b>Buss ${esc(l.line)} ${toClock(l.start)}</b>${late}${towards} → ${to} ${toClock(l.end)}${held}`;
    })
    .join("<br>");
}

/** The verb depends on the first leg, which here is always the walk to the stop. */
function departVerb(plan) {
  const first = plan.legs.find((l) => l.type === "walk" || l.type === "transit");
  return first && first.type === "transit" ? "Åk" : "Gå";
}

function renderBest(se, plans, direction) {
  const host = el("aBest");
  const best = plans.find((p) => !p.broken);
  if (!best) {
    const reason = plans[0]?.broken?.reason || "Inga vägar kunde planeras";
    host.innerHTML =
      `<div class="card"><div class="lbl">Ingen buss fungerar nu</div>` +
      `<div class="why">${esc(reason)}</div>` +
      `<div class="meta">Pröva en annan destination, eller igen om en stund.</div></div>`;
    return;
  }
  const diff = best.leaveAt - se.min;
  const cls = diff <= 0.2 ? " now" : diff < 8 ? " soon" : "";
  const verb = departVerb(best);
  const where = direction === TO_HOME ? "från " + esc(currentDestination().label) : "hemifrån";

  host.innerHTML =
    `<div class="card">` +
    `<div class="lbl">${verb} ${where}</div>` +
    `<div class="time">${toClock(best.leaveAt)}</div>` +
    `<div class="cd${cls}">${diff <= 0.2 ? `${verb.toLowerCase()} nu` : fmtCountdown(diff)}</div>` +
    `<div class="name">${esc(best.label)}</div>` +
    `<div class="why">${summarise(best)}</div>` +
    `<div class="meta">Framme <b>${toClock(best.arrive)}</b> · ${best.travelMinutes} min dörr till dörr` +
    (best.waiting ? ` · ${Math.round(best.waiting)} min väntan vid byte` : "") +
    `</div>` +
    `<div class="chips">${weatherChip(best)}</div>` +
    `</div>`;
}

function renderRest(se, plans) {
  const host = el("aRest");
  const rest = plans.slice(1);
  if (!rest.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML =
    `<div class="rest-head">Övriga vägar</div>` +
    rest
      .map((plan) => {
        if (plan.broken) {
          const pending = plan.broken.code === engine.PENDING;
          return (
            `<div class="row broken"><div class="row-l">` +
            `<div class="row-name">${esc(plan.label)}</div>` +
            `<div class="row-why${pending ? " pending" : ""}">${esc(plan.broken.reason)}</div>` +
            `</div><div class="row-r">${pending ? "snart" : "–"}</div></div>`
          );
        }
        const bus = plan.legs.find((l) => l.type === "transit");
        return (
          `<div class="row"><div class="row-l">` +
          `<div class="row-name">${weatherChip(plan) ? "" : ""}${esc(plan.label)}</div>` +
          `<div class="row-why">${bus ? `buss ${esc(bus.line)} ${toClock(bus.start)}` : ""}` +
          ` · ${plan.travelMinutes} min</div>` +
          `</div><div class="row-r"><div class="row-time">${toClock(plan.leaveAt)}</div>` +
          `<div class="row-sub">framme ${toClock(plan.arrive)}</div></div></div>`
        );
      })
      .join("");
}

function renderDestinations() {
  const host = el("aDest");
  const active = currentDestination();
  host.innerHTML = data.scenarios.destinations
    .map(
      (d) =>
        `<button type="button" data-dest="${esc(d.id)}"` +
        `${d.id === active.id ? ' class="active"' : ""}>${esc(d.label)}</button>`
    )
    .join("");
  for (const button of host.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      chosenDestination = button.dataset.dest;
      try {
        localStorage.setItem(STORE_KEY, chosenDestination);
      } catch (e) {}
      render(window.nowSE());
    });
  }
}

function renderDirection(direction) {
  for (const button of document.querySelectorAll("#aDirSeg button"))
    button.classList.toggle("active", button.dataset.dir === direction);
}

function render(se) {
  el("aDate").textContent = window.WEEKDAYS
    ? `${window.WEEKDAYS[se.wd]} ${se.d} ${window.MONTHS[se.mo - 1]}`
    : se.iso;
  el("aClock").innerHTML =
    `${String(se.h).padStart(2, "0")}:${String(se.mi).padStart(2, "0")}` +
    `<span class="sec">:${String(se.s).padStart(2, "0")}</span>`;

  if (loadError) {
    el("aBest").innerHTML = `<div class="err">${esc(loadError)}</div>`;
    return;
  }
  if (!data) {
    el("aBest").innerHTML = '<div class="card"><div class="lbl">Laddar…</div></div>';
    return;
  }

  const direction = currentDirection(se);
  const destination = currentDestination();
  renderDestinations();
  renderDirection(direction);
  renderWeather(se);

  const plans = planAll(destination, {
    data,
    weights: data.weights,
    boatLegs: null,
    dayType: window.dayType ? window.dayType(se) : "mtor",
    direction,
    now: se.min,
    departures: feeds,
  });

  let ranked = plans;
  try {
    ranked = wxScore.applyWeather(
      plans,
      wxScore.verdictsFor(plans, {
        weather: data.weights.weather,
        isoDate: se.iso,
        forecast,
        returnForecast: forecast,
        direction,
      }),
      data.weights.weather
    );
  } catch (e) {
    console.warn(`väder: bedömningen misslyckades (${e.message})`);
  }

  renderBest(se, ranked, direction);
  renderRest(se, ranked);

  const age = lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null;
  el("aNote").textContent =
    age === null
      ? "Väntar på realtidsdata…"
      : age > 90
        ? `Realtiden är ${Math.round(age / 60)} min gammal.`
        : "Restiderna är uppskattade tills de mätts upp.";
}

async function boot() {
  try {
    data = await loadData();
    try {
      chosenDestination = localStorage.getItem(STORE_KEY);
    } catch (e) {}
  } catch (e) {
    loadError = e instanceof DataError ? e.message : `Kunde inte läsa datafilerna:\n${e.message}`;
    console.error(e);
    render(window.nowSE());
    return;
  }
  await Promise.all([refresh(), refreshWeather()]);
  render(window.nowSE());
  setInterval(() => {
    refresh();
    refreshWeather();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}

for (const button of document.querySelectorAll("#aDirSeg button")) {
  button.addEventListener("click", () => {
    const se = window.nowSE();
    chosenDirection = button.dataset.dir;
    chosenOn = se.iso;
    render(se);
  });
}

window.autobus = { render };
boot();
