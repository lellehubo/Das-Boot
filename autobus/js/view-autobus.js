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
const [{ loadData, destinationsFor, DataError }, { departures, deviations }, engine, wx, wxScore, wxPhrase] =
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
// Service messages from SL: roadworks, diversions, cancelled runs. Separate from
// the per-departure delay, which rides along on each departure as expected minus
// scheduled and is already shown on the leg.
let alerts = [];
let rankOpen = false;
// Var man står. Avgör vilken hållplats som är närmast, vilket i sin tur avgör
// vilken väg som är rimlig: står man redan vid Henriksdal är promenaden till
// Danviken bortkastad.
let lastPos = null;
let nearestStopId = null;

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

/**
 * Disruptions for the stops we use.
 *
 * Buses only — the app plans nothing else, and a metro message would just be
 * noise. Like the weather, a failure here costs the alerts and nothing more.
 */
async function refreshAlerts() {
  if (!data) return;
  try {
    alerts = await deviations(requiredSites(), ["BUS"]);
  } catch (e) {
    console.warn(`avvikelser: ${e.message}`);
  }
}

const HOME_STOPS = ["danviken", "henriksdalsviadukten", "henriksdal"];

function haversine(a, b, c, d) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const x =
    Math.sin(rad(c - a) / 2) ** 2 +
    Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Closest of the three home stops to a position, with the distance. */
function nearestHomeStop(lat, lon) {
  let best = null;
  for (const id of HOME_STOPS) {
    const node = data.node(id);
    if (!node?.lat) continue;
    const m = haversine(lat, lon, node.lat, node.lon);
    if (!best || m < best.metres) best = { id, metres: m, label: node.label };
  }
  return best;
}

/**
 * Where we are, and which stop that makes closest.
 *
 * Silent by design: a refused or failed lookup leaves the app exactly as it was,
 * because every route still works without knowing where you stand. The position
 * only adds a hint, it never decides.
 */
function locate({ silent = true } = {}) {
  if (!navigator.geolocation || !data) return;
  const btn = el("aFindme");
  if (btn) btn.classList.add("loading");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) btn.classList.remove("loading");
      lastPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, ts: Date.now() };
      const near = nearestHomeStop(lastPos.lat, lastPos.lon);
      // Beyond a couple of kilometres you are not at any of them, and saying so
      // is better than pointing at the least wrong one.
      nearestStopId = near && near.metres < 2000 ? near.id : null;
      render(window.nowSE());
    },
    () => {
      if (btn) btn.classList.remove("loading");
      if (!silent && btn) btn.classList.add("unconfirmed");
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
}

/** The lines a plan actually rides, for matching a disruption against it. */
function planLines(plan) {
  return new Set(plan.legs.filter((l) => l.type === "transit" && l.line).map((l) => String(l.line)));
}

/** Disruptions touching a plan's own lines. A message with no line scope hits everything. */
function alertsFor(plan) {
  const lines = planLines(plan);
  return alerts.filter((a) => !a.lines.length || a.lines.some((l) => lines.has(String(l))));
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

/**
 * Disruptions that touch the route being shown.
 *
 * Only those on its own lines: from Henriksdal twenty lines run to Slussen, and
 * a message about one of the nineteen you are not taking is noise. A message
 * without a line scope hits the whole area and is always shown.
 */
function renderAlerts(plan) {
  const host = el("aAlerts");
  if (!host) return;
  const list = plan ? alertsFor(plan) : alerts;
  if (!list.length) {
    host.innerHTML = "";
    host.style.display = "none";
    return;
  }
  host.innerHTML = list
    .slice(0, 3)
    .map((a) => {
      const lines = a.lines.length ? `<span class="dev-lines">${esc(a.lines.slice(0, 6).join(", "))}</span>` : "";
      return (
        `<div class="dev${a.importance >= 7 ? " high" : ""}">` +
        `<span class="dev-ico">!</span><div>` +
        `<div>${lines}${esc(a.header)}</div>` +
        (a.details ? `<div class="dev-det">${esc(a.details)}</div>` : "") +
        `</div></div>`
      );
    })
    .join("");
  host.style.display = "";
}

/**
 * How late the bus already is, straight from realtime.
 *
 * Separate from a disruption message: this is the minutes SL has already put on
 * this particular run, and it is the number that moves your leave time.
 */
function delayChip(plan) {
  const late = plan.legs.filter((l) => l.type === "transit" && l.delay > 0);
  if (!late.length) return "";
  const worst = Math.max(...late.map((l) => l.delay));
  return `<span class="tag late">${esc(late[0].line)} ${worst} min sen</span>`;
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
    `<span class="tag wx-route${level}" title="${esc(said ? said.text : "")}">` +
    `${said ? wxPhrase.iconSvg(said.icon) : ""}${minutes != null ? `${Math.round(minutes)} min ute` : ""}</span>`
  );
}

/**
 * Next departure from each stop you would actually board at.
 *
 * Derived from the plans rather than read off the feed. The feed at Henriksdal
 * carries every bus in both directions, so picking the soonest gave a 55 towards
 * Henriksdalsberget as the way to Slussen — the right stop, the wrong way. The
 * engine has already resolved line, direction and reachability for each route,
 * so taking the boarding leg it settled on cannot point the wrong way.
 *
 * Which stops appear therefore follows the direction for free: going out these
 * are the stops near home, going home they are the ones at the destination.
 */
function stopCards(plans) {
  const byStop = new Map();
  for (const p of plans) {
    if (p.broken) continue;
    const ride = firstRide(p);
    if (!ride) continue;
    const cur = byStop.get(ride.from);
    if (!cur || ride.start < cur.start) byStop.set(ride.from, ride);
  }
  const cards = [...byStop.entries()].map(([id, ride]) => ({
    id,
    label: data.node(id)?.label ?? id,
    here: id === nearestStopId,
    ride,
  }));
  // Den man står vid först, annars den som går snarast.
  cards.sort((a, b) => (b.here ? 1 : 0) - (a.here ? 1 : 0) || a.ride.start - b.ride.start);
  return cards.slice(0, 2);
}

function renderStops(se, plans) {
  const host = el("aStops");
  if (!host) return;
  const cards = stopCards(plans);
  if (!cards.length) {
    host.innerHTML = `<div class="boatcard none"><div class="bdir">Ingen avgång</div>` +
                     `<div class="btime">–</div><div class="bcd">inget att stiga på just nu</div></div>`;
    return;
  }
  host.innerHTML = cards
    .map(({ label, here, ride }) => {
      const diff = ride.start - se.min;
      const soon = diff < 6 ? " soon" : "";
      const late = ride.delay > 0 ? ` <b>+${ride.delay}</b>` : "";
      return (
        `<div class="boatcard"><div class="bdir">${here ? "&#9679; " : ""}${esc(label)}</div>` +
        `<div class="btime">${toClock(ride.start)}</div>` +
        `<div class="bcd${soon}">${fmtCountdown(diff)} · ${esc(ride.line)}${late} mot ${esc(ride.destination)}</div></div>`
      );
    })
    .join("");
}

/** First transit leg of a plan — the departure "the next one" refers to. */
function firstRide(plan) {
  return plan.legs.find((l) => l.type === "transit") || null;
}

/**
 * The next couple of departures on the same route.
 *
 * Each one is found by replanning as if you had left a minute too late, which
 * rules out the departure just offered and lets the engine pick the following
 * one. Deriving them rather than reading further down the feed keeps every rule
 * that makes a plan valid — transfer buffers, direction, which runs reach the
 * target — and re-derives the leave time backwards from the later bus instead of
 * assuming the walk is unchanged.
 *
 * Stops early at the end of the day, or if a replan lands on the same departure.
 */
function laterDepartures(plan, destination, ctx, count = 2) {
  const scenario = data.scenarios.scenarios.find((s) => s.id === plan.id);
  if (!scenario || plan.leaveAt == null) return [];
  const out = [];
  let current = plan;
  for (let i = 0; i < count; i++) {
    const ride = firstRide(current);
    if (!ride) break;
    let later = null;
    try {
      later = engine.planScenario(scenario, destination, { ...ctx, now: current.leaveAt + 1 });
    } catch (e) {
      console.warn(`senare avgångar: ${e.message}`);
      break;
    }
    if (!later || later.broken || later.leaveAt == null) break;
    const laterRide = firstRide(later);
    if (!laterRide || laterRide.start <= ride.start) break;
    out.push(later);
    current = later;
  }
  return out;
}

/**
 * The follow-up departures, kept quiet under the card.
 *
 * Two of them, because one answers "can I make the next" and two answer "how
 * bad is it if I miss both" — which is the question you have when you are still
 * looking for your keys. Absent rather than empty when there is nothing later.
 *
 * Labelled by what is listed, not by what you do: the times are bus departures,
 * and calling the row "gå sedan" made it read as a second instruction rather
 * than a timetable.
 */
function laterRow(later) {
  if (!later.length) return "";
  const items = later
    .map((p) => {
      const ride = firstRide(p);
      const what = ride ? ` · ${esc(ride.line)} ${toClock(ride.start)}` : "";
      return (
        `<span class="later-item"><b>${toClock(p.leaveAt)}</b>${what}` +
        `<span class="later-arr">framme ${toClock(p.arrive)}</span></span>`
      );
    })
    .join("");
  return `<div class="later"><span class="later-lbl">Nästa bussar</span>${items}</div>`;
}

/** The chips under the card, in Das Boot's own row. */
function tags(plan) {
  const out = [delayChip(plan), weatherChip(plan)].filter(Boolean);
  return out.length ? `<div class="chip-row">${out.join("")}</div>` : "";
}

/** Each leg in order, so the card shows the whole trip and not just the bus. */
function summarise(plan) {
  return plan.legs
    .map((l) => {
      const to = esc(data.node(l.to)?.label ?? l.to);
      if (l.type === "walk") return `Gå ${l.minutes} min till ${to}`;
      const late = l.delay > 0 ? ` <b>+${l.delay}</b>` : "";
      const held = l.wait > 0 ? ` <span class="rank-sub">(${l.wait} min väntan)</span>` : "";
      const towards = l.destination ? ` <span class="rank-sub">mot ${esc(l.destination)}</span>` : "";
      return `<b>Buss ${esc(l.line)} ${toClock(l.start)}</b>${late}${towards} → ${to} ${toClock(l.end)}${held}`;
    })
    .join("<br>");
}

/** The verb depends on the first leg, which here is always the walk to the stop. */
function departVerb(plan) {
  const first = plan.legs.find((l) => l.type === "walk" || l.type === "transit");
  return first && first.type === "transit" ? "Åk" : "Gå";
}

function renderBest(se, plans, direction, later) {
  const host = el("aBest");
  const best = plans.find((p) => !p.broken);
  if (!best) {
    const reason = plans[0]?.broken?.reason || "Inga vägar kunde planeras";
    host.innerHTML =
      `<div class="leave"><div class="leave-lbl">Ingen buss fungerar nu</div>` +
      `<div class="leave-why">${esc(reason)}</div>` +
      `<div class="leave-meta">Pröva en annan destination, eller igen om en stund.</div></div>`;
    return;
  }
  const diff = best.leaveAt - se.min;
  const cls = diff <= 0.2 ? " now" : diff < 8 ? " soon" : "";
  const verb = departVerb(best);
  const where = direction === TO_HOME ? "från " + esc(currentDestination().label) : "hemifrån";

  host.innerHTML =
    `<div class="leave">` +
    `<div class="leave-lbl">${verb} ${where}</div>` +
    `<div class="leave-time">${toClock(best.leaveAt)}</div>` +
    `<div class="leave-cd${cls}">${diff <= 0.2 ? `${verb.toLowerCase()} nu` : fmtCountdown(diff)}</div>` +
    `<div class="leave-name">${esc(best.label)}</div>` +
    `<div class="leave-why">${summarise(best)}</div>` +
    `<div class="leave-meta">Framme <b>${toClock(best.arrive)}</b> · ${best.travelMinutes} min dörr till dörr` +
    (best.waiting ? ` · ${Math.round(best.waiting)} min väntan vid byte` : "") +
    `</div>` +
    `${tags(best)}` +
    laterRow(later || []) +
    `</div>`;
}

/**
 * The alternatives, in Das Boot's collapsible panel and with its row markup.
 *
 * Same shape as the boat app on purpose: two apps that behave differently for no
 * reason are two apps to learn.
 */
function renderRest(se, plans) {
  const body = el("aRankBody");
  const rest = plans.slice(1);
  if (!rest.length) {
    body.innerHTML = '<div class="rank"><div class="rank-name">Inga andra vägar.</div></div>';
    return;
  }
  body.innerHTML = rest
    .map((plan) => {
      if (plan.broken) {
        const pending = plan.broken.code === engine.PENDING;
        return (
          `<div class="rank broken"><div class="rank-l">` +
          `<div class="rank-name">${esc(plan.label)}</div>` +
          `<div class="rank-reason${pending ? " pending" : ""}">${esc(plan.broken.reason)}</div>` +
          `</div><div class="rank-r"><div class="rank-arr">${pending ? "snart" : "–"}</div></div></div>`
        );
      }
      const diff = plan.leaveAt - se.min;
      const bus = plan.legs.find((l) => l.type === "transit");
      return (
        `<div class="rank"><div class="rank-l">` +
        `<div class="rank-name">${rankWeather(plan)}${esc(plan.label)}</div>` +
        `<div class="rank-sub">${bus ? `buss ${esc(bus.line)} ${toClock(bus.start)} · ` : ""}` +
        `${plan.travelMinutes} min${rankExposure(plan)}</div>` +
        `</div><div class="rank-r">` +
        `<div class="rank-leave">${toClock(plan.leaveAt)}</div>` +
        `<div class="rank-arr">framme ${toClock(plan.arrive)} · ${fmtCountdown(diff)}</div>` +
        `</div></div>`
      );
    })
    .join("");
  if (rankOpen) body.style.maxHeight = body.scrollHeight + "px";
}

/** Same small symbol the card carries, so the list can be read down. */
function rankWeather(plan) {
  const summary = plan.weather?.window;
  if (!summary) return "";
  const said = wxPhrase.describeWindow(summary, { localMinutesOf: wxScore.localMinutesOf });
  if (!said) return "";
  return `<span class="rank-wx" title="${esc(said.text)}">${wxPhrase.iconSvg(said.icon)}</span>`;
}

function rankExposure(plan) {
  const minutes = plan.weather?.exposure?.minutes;
  return minutes == null ? "" : ` · ${Math.round(minutes)} min ute`;
}

function renderNearest() {
  const hint = el("aNearest");
  if (!hint) return;
  if (!lastPos) { hint.textContent = ""; return; }
  if (!nearestStopId) { hint.textContent = "Du verkar inte vara hemma."; return; }
  const near = nearestHomeStop(lastPos.lat, lastPos.lon);
  const min = Math.max(1, Math.round(near.metres / 80));
  hint.textContent = near.metres < 120
    ? `Du står vid ${near.label}.`
    : `Närmast ${near.label}, ~${min} min gång.`;
}

/**
 * The destination buttons, built once.
 *
 * Rebuilding them on every clock tick tore them out from under a finger
 * mid-press — Playwright reported the element detaching between resolve and
 * click, and a thumb would hit the same race. Only the active class moves after
 * the first build, which is what Das Boot's direction toggle does.
 */
function buildDestinations() {
  const host = el("aDest");
  if (!host || host.dataset.built === "1") return;
  host.innerHTML = data.scenarios.destinations
    .map((d) => `<button type="button" data-dest="${esc(d.id)}">${esc(d.label)}</button>`)
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
  host.dataset.built = "1";
}

function renderDestinations() {
  buildDestinations();
  const active = currentDestination();
  const badge = el("aDestText");
  if (badge) badge.textContent = active.label;
  for (const button of el("aDest").querySelectorAll("button"))
    button.classList.toggle("active", button.dataset.dest === active.id);
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
    el("aBest").innerHTML = `<div class="jobbet-err">${esc(loadError)}</div>`;
    return;
  }
  if (!data) {
    el("aBest").innerHTML = '<div class="leave"><div class="leave-lbl">Laddar…</div></div>';
    return;
  }

  const direction = currentDirection(se);
  const destination = currentDestination();
  renderDestinations();
  renderDirection(direction);
  renderWeather(se);

  // Namngiven, eftersom de senare avgångarna planeras om mot samma kontext.
  const planCtx = {
    data,
    weights: data.weights,
    boatLegs: null,
    dayType: window.dayType ? window.dayType(se) : "mtor",
    direction,
    now: se.min,
    departures: feeds,
  };
  const plans = planAll(destination, planCtx);

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

  renderStops(se, ranked);
  renderNearest();
  renderAlerts(ranked.find((p) => !p.broken));
  const best = ranked.find((p) => !p.broken);
  renderBest(se, ranked, direction, best ? laterDepartures(best, destination, planCtx) : []);
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
  await Promise.all([refresh(), refreshWeather(), refreshAlerts()]);
  render(window.nowSE());
  locate();
  setInterval(() => {
    refresh();
    refreshWeather();
    refreshAlerts();
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

el("aFindme").addEventListener("click", () => locate({ silent: false }));

document.addEventListener("visibilitychange", () => {
  // Ny position när appen kommer i förgrunden, men inte oftare än var tolfte
  // sekund — man hinner inte byta hållplats snabbare än så.
  if (!document.hidden && (!lastPos || Date.now() - lastPos.ts > 12000)) locate();
});

el("aRankHead").addEventListener("click", () => {
  rankOpen = !rankOpen;
  const body = el("aRankBody");
  el("aRank").classList.toggle("open", rankOpen);
  el("aRankHead").setAttribute("aria-expanded", rankOpen ? "true" : "false");
  body.style.maxHeight = rankOpen ? body.scrollHeight + "px" : "0";
});

window.autobus = { render };
boot();
