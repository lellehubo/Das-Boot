// The "Jobbet" view: which of my ways to and from work runs right now, and when
// do I leave. It registers itself on window.jobbet because the rest of the app is
// a classic script and cannot import from a module.

// Dependencies load dynamically so they inherit this module's ?v= cache buster.
// With static imports the browser keeps serving the previously cached copies even
// when this file is refetched, which silently hides edits during development.
const VERSION = new URL(import.meta.url).search;
const [{ loadData, destinationsFor, DataError }, { departures }, engine, wx, wxScore, wxPhrase] =
  await Promise.all([
    import(`./data-layer.js${VERSION}`),
    import(`./api-sl.js${VERSION}`),
    import(`./engine-scenarios.js${VERSION}`),
    import(`./weather.js${VERSION}`),
    import(`./weather-score.js${VERSION}`),
    import(`./weather-phrase.js${VERSION}`),
  ]);
const { planAll, toClock, toMinutes, defaultDirection, TO_WORK, TO_HOME } = engine;

const HOME_PIER = "saltsjoqvarn";
const REFRESH_MS = 30_000;

let data = null;
let boatLegs = null;
let loadError = null;
let feeds = new Map();
let lastFetch = 0;
let fetching = false;
let rankOpen = false;

// Both ends of the commute, because the bike decision needs the afternoon at the
// office as well as the morning at home. Null until the first fetch lands, and
// null again is a perfectly good state: the board renders without it.
let forecasts = { home: null, work: null };

// null = följ klockan. Ett eget val gäller resten av dygnet, sedan tar
// klockan över igen — annars sitter gårdagens val kvar nästa morgon.
let chosenDirection = null;
let chosenOn = null;

function currentDirection(se) {
  return chosenDirection && chosenOn === se.iso ? chosenDirection : defaultDirection(se.min);
}

const el = (id) => document.getElementById(id);

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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/**
 * Which sites we need departures from, for the direction being shown.
 * Going home the boat is boarded where the morning trip left it, so the ends of
 * each transit leg swap round.
 */
function requiredSites(direction) {
  const ids = new Set();
  const end = direction === TO_HOME ? "to" : "from";
  for (const scenario of data.scenarios.scenarios) {
    if (scenario.status === "dormant") continue;
    for (const leg of scenario.legs) {
      if (leg.type !== "transit") continue;
      const node = data.node(leg[end]);
      if (node?.site_id != null) ids.add(node.site_id);
    }
  }
  return [...ids];
}

async function refresh(direction = TO_WORK) {
  if (fetching || !data) return;
  fetching = true;
  try {
    const sites = requiredSites(direction);
    const results = await Promise.all(
      sites.map((id) => departures(id).then((r) => [id, r]).catch(() => [id, null]))
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
 * Forecasts for both ends of the commute.
 *
 * Weather is an addition, never a dependency: this swallows every failure so a
 * dead SMHI cannot stop the departures from rendering. The client caches on its
 * own TTL, so calling this on the ordinary refresh tick costs nothing.
 */
async function refreshWeather() {
  if (!data) return;
  const se = window.nowSE();
  const destination = destinationsFor(data, se.iso)[0];
  if (!destination) return;
  const points = wxScore.pointsFor(data, destination);
  for (const which of ["home", "work"]) {
    if (!points[which]) continue;
    try {
      forecasts[which] = await wx.forecast(points[which], data.weights.weather);
    } catch (e) {
      console.warn(`väder (${which}): ${e.message}`);
    }
  }
}

/** Next line 80 departure from a pier, optionally limited to one sailing direction. */
function nextBoatFrom(nodeId, se, directionCode) {
  const node = data.node(nodeId);
  const feed = node && feeds.get(node.site_id);
  if (!feed) return null;

  let best = null;
  for (const d of feed.departures) {
    if (d.line !== "80" || d.mode !== "SHIP" || d.cancelled || !d.scheduled) continue;
    if (directionCode && d.directionCode !== directionCode) continue;
    const departs = toMinutes(d.expected || d.scheduled);
    const diff = departs - se.min;
    if (diff < -1) continue;
    if (!best || diff < best.diff)
      best = { diff, departs, destination: d.destination, delay: d.delay ?? 0 };
  }
  return best;
}

/**
 * The two boats worth knowing about right now.
 *
 * Going to work that is the next sailing each way from the home pier, since the
 * direction decides which family of scenarios is even possible. Going home it is
 * the next boat back from each pier the afternoon routes board at.
 */
function boatCards(se, direction) {
  if (direction === TO_HOME) {
    return [
      ["Från Allmänna gränd", nextBoatFrom("allmanna_grand", se, 1)],
      ["Från Frihamnen", nextBoatFrom("frihamnen_pier", se, 2)],
    ];
  }
  const home = nextBoatFrom(HOME_PIER, se);
  return [
    ["Mot stan", nextBoatFrom(HOME_PIER, se, 2)],
    ["Mot Ropsten", nextBoatFrom(HOME_PIER, se, 1)],
  ];
}

function renderBoats(se, direction) {
  el("jBoats").innerHTML = boatCards(se, direction)
    .map(([label, boat]) => {
      if (!boat)
        return `<div class="boatcard none"><div class="bdir">${label}</div><div class="btime">–</div><div class="bcd">ingen avgång</div></div>`;
      const soon = boat.diff < 12 ? " soon" : "";
      return (
        `<div class="boatcard"><div class="bdir">${label}</div>` +
        `<div class="btime">${toClock(boat.departs)}</div>` +
        `<div class="bcd${soon}">${fmtCountdown(boat.diff)} · ${esc(boat.destination)}</div></div>`
      );
    })
    .join("");
}

// Wording for the per-route warning lives in weather-phrase.js, next to the
// sentence it has to sit under without repeating it.

/** The route's own warning, coloured by how bad it is. */
function weatherTag(plan) {
  const warning = wxPhrase.warningFor(plan.weather);
  if (!warning) return "";
  return `<span class="tag wx-${warning.level}">${esc(warning.text)}</span>`;
}

/**
 * The weather in words, for the trips that are still ahead of you.
 *
 * In the morning that is both legs of the day: the one you are about to make,
 * and the one home, because the bike you take now has to come back. After noon
 * only the trip home is left, so a second line would be about a journey already
 * behind you.
 *
 * The outbound window is the one the plan actually derives; the return window is
 * the fixed afternoon one, since at breakfast the evening boat is not chosen.
 */
function weatherLines(se, direction, best) {
  const weather = data.weights.weather;
  const opts = { localMinutesOf: wxScore.localMinutesOf };
  const back = weather.return_window_hours;
  const out = [];

  const describe = (forecast, fromMin, toMin, label) => {
    if (!forecast) return;
    const summary = wxScore.summariseWindow(forecast, se.iso, fromMin, toMin);
    const said = wxPhrase.describeWindow(summary, opts);
    if (said) out.push({ label, ...said });
  };

  // Without a plan there is no derived window, so fall back to the next hour —
  // the question "what is it like out there" still has an answer.
  const exposure = best && wxScore.exposureOf(best, weather);
  const fromMin = exposure ? exposure.fromMin : se.min;
  const toMin = exposure ? exposure.toMin : se.min + 60;

  if (direction === TO_HOME) {
    describe(forecasts.work, fromMin, toMin, "Hem");
  } else {
    describe(forecasts.home, fromMin, toMin, "Till jobbet");
    if (back) describe(forecasts.work, back.from * 60, back.to * 60, "Hem i eftermiddag");
  }
  return out;
}

function renderWeather(se, direction, best) {
  const host = el("jWeather");
  if (!host) return;
  let lines = [];
  // Describing the weather must never cost the departure board, same rule as
  // the scoring call below.
  try {
    lines = weatherLines(se, direction, best);
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

function tags(plan) {
  const out = [];
  if (plan.requiresBike) out.push('<span class="tag bike">cykel · plats ej garanterad</span>');
  if (plan.untested) out.push('<span class="tag untested">oprövad</span>');
  if (plan.uncalibrated) out.push('<span class="tag">tider ej uppmätta</span>');
  const weather = weatherTag(plan);
  if (weather) out.push(weather);
  return out.length ? `<div class="chip-row">${out.join("")}</div>` : "";
}

/**
 * Every leg in order, so the card shows the whole journey rather than only the
 * transit parts. The final walk or ride is often the point of the scenario.
 */
function summarise(plan) {
  return plan.legs
    .map((l) => {
      const to = esc(data.node(l.to).label);
      if (l.type === "walk" || l.type === "bike") {
        const verb = l.type === "bike" ? "Cykla" : "Gå";
        return `${verb} ${l.minutes} min till ${to}`;
      }
      const what = l.mode === "SHIP" ? "Båt" : l.mode === "TRAM" ? "Spårvagn" : "Buss";
      const late = l.delay > 0 ? ` <b>+${l.delay}</b>` : "";
      const held = l.wait > 0 ? ` <span class="rank-sub">(${l.wait} min väntan)</span>` : "";
      return `<b>${what} ${l.line} ${toClock(l.start)}</b>${late} → ${to} ${toClock(l.end)}${held}`;
    })
    .join("<br>");
}

/**
 * How you actually set off, which is not always on foot.
 *
 * Every morning route starts with the walk to the pier, but mirrored for the
 * afternoon the bike routes start on the bike — so a direction-based verb told
 * you to walk from work and then to cycle 17 minutes. Reading the first leg
 * keeps the two in step whichever way the trip runs.
 */
function departVerb(plan) {
  const first = plan.legs.find((l) => l.type === "walk" || l.type === "bike" || l.type === "transit");
  if (!first) return "Gå";
  if (first.type === "bike") return "Cykla";
  if (first.type === "transit") return "Åk";
  return "Gå";
}

function renderBest(se, plans, direction) {
  const best = plans.find((p) => !p.broken);
  const host = el("jBest");

  if (!best) {
    const reason = plans[0]?.broken?.reason || "Inga scenarier kunde planeras";
    host.innerHTML =
      `<div class="leave"><div class="leave-lbl">Ingen väg fungerar nu</div>` +
      `<div class="leave-why">${esc(reason)}</div>` +
      `<div class="leave-meta">Titta i Stan-fliken för nästa båt, eller pröva igen senare.</div></div>`;
    return;
  }

  const diff = best.leaveAt - se.min;
  const cls = diff <= 0.2 ? " now" : diff < 8 ? " soon" : "";
  const verb = departVerb(best);
  const leaveLabel = `${verb} ${direction === TO_HOME ? "från jobbet" : "hemifrån"}`;

  host.innerHTML =
    `<div class="leave">` +
    `<div class="leave-lbl">${leaveLabel}</div>` +
    `<div class="leave-time">${toClock(best.leaveAt)}</div>` +
    `<div class="leave-cd${cls}">${diff <= 0.2 ? `${verb.toLowerCase()} nu` : fmtCountdown(diff)}</div>` +
    `<div class="leave-name">${esc(best.label)}</div>` +
    `<div class="leave-why">${summarise(best)}</div>` +
    `<div class="leave-meta">Framme <b>${toClock(best.arrive)}</b> · ${best.travelMinutes} min dörr till dörr` +
    (best.waiting ? ` · ${Math.round(best.waiting)} min väntan vid byte` : "") +
    `</div>` +
    tags(best) +
    `</div>`;
}

function renderRank(se, plans) {
  const rest = plans.slice(1);
  const body = el("jRankBody");
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
      return (
        `<div class="rank"><div class="rank-l">` +
        `<div class="rank-name">${esc(plan.label)}</div>` +
        `<div class="rank-sub">${plan.travelMinutes} min · ${plan.transfers} byte${plan.transfers === 1 ? "" : "n"}` +
        (plan.requiresBike ? " · cykel" : "") +
        `</div></div><div class="rank-r">` +
        `<div class="rank-leave">${toClock(plan.leaveAt)}</div>` +
        `<div class="rank-arr">framme ${toClock(plan.arrive)} · ${fmtCountdown(diff)}</div>` +
        `</div></div>`
      );
    })
    .join("");
  if (rankOpen) body.style.maxHeight = body.scrollHeight + "px";
}

function render(se) {
  el("jDate").textContent = window.WEEKDAYS
    ? `${window.WEEKDAYS[se.wd]} ${se.d} ${window.MONTHS[se.mo - 1]}`
    : se.iso;
  el("jClock").innerHTML =
    `${String(se.h).padStart(2, "0")}:${String(se.mi).padStart(2, "0")}` +
    `<span class="sec">:${String(se.s).padStart(2, "0")}</span>`;

  if (loadError) {
    el("jBest").innerHTML = `<div class="jobbet-err">${esc(loadError)}</div>`;
    el("jBoats").innerHTML = "";
    el("jNote").textContent = "Rätta datafilen och ladda om.";
    return;
  }
  if (!data) {
    el("jBest").innerHTML = '<div class="leave"><div class="leave-lbl">Laddar…</div></div>';
    return;
  }

  const direction = currentDirection(se);
  renderDirectionToggle(direction);

  const active = destinationsFor(data, se.iso);
  const destination = active[0];
  if (!destination) {
    el("jDestText").textContent = "ingen destination";
    el("jBest").innerHTML =
      '<div class="leave"><div class="leave-lbl">Ingen destination gäller idag</div>' +
      '<div class="leave-why">Lägg till en i scenarios.json.</div></div>';
    return;
  }
  // Badgen visar vart resan bär, inte var man är.
  el("jDestText").textContent =
    direction === TO_HOME ? data.node("home").label : destination.label;

  // Tidtabellen byter på datum, och dagtyperna skiljer sig mellan utgåvorna.
  const table =
    boatLegs.tables.find((t) => t.from <= se.iso && se.iso <= t.to) || boatLegs.tables.at(-1);

  const plans = planAll(destination, {
    data,
    weights: data.weights,
    boatLegs: table.legs,
    dayType: window.dayType(se),
    direction,
    now: se.min,
    departures: feeds,
  });

  // Grading happens against the end you set off from; the return window is
  // always read at the office, since that is where the bike would be waiting.
  const weatherCtx = {
    weather: data.weights.weather,
    isoDate: se.iso,
    forecast: direction === TO_HOME ? forecasts.work : forecasts.home,
    returnForecast: forecasts.work,
    direction,
  };
  // Scoring is an addition just like the fetch above it. A throw here must cost
  // the verdict, never the departure board, so unscored plans fall back to the
  // engine's own order rather than taking the whole view down with them.
  let ranked = plans;
  try {
    ranked = wxScore.applyWeather(
      plans,
      wxScore.verdictsFor(plans, weatherCtx),
      data.weights.weather
    );
  } catch (e) {
    console.warn(`väder: bedömningen misslyckades (${e.message})`);
  }

  renderBoats(se, direction);
  renderWeather(se, direction, ranked.find((p) => !p.broken));
  renderBest(se, ranked, direction);
  renderRank(se, ranked);

  const age = lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null;
  el("jNote").textContent =
    (age === null
      ? "Väntar på realtidsdata…"
      : age > 90
        ? `Realtiden är ${Math.round(age / 60)} min gammal.`
        : direction === TO_HOME
          ? "Hemresan är samma vägar baklänges. Säg till om någon eftermiddagsväg skiljer sig."
          : "Gångtiderna är uppskattade tills de mätts upp.") + weatherCredit();
}

/**
 * Source credit for the forecast. CC BY 4.0 makes this a licence condition, not
 * a nicety, so it renders whenever a forecast is actually in use.
 */
function weatherCredit() {
  const active = forecasts.home || forecasts.work;
  if (!active) return "";
  const credit = data.weights.weather.attribution?.[active.source] || active.source;
  const stale = active.stale ? ", senast kända" : "";
  return ` · Väder: ${credit}${stale}.`;
}

function renderDirectionToggle(direction) {
  for (const button of document.querySelectorAll("#jDirSeg button"))
    button.classList.toggle("active", button.dataset.dir === direction);
}

async function boot() {
  try {
    const [loaded, legs] = await Promise.all([
      loadData(),
      fetch("data/boat-legs.json").then((r) => {
        if (!r.ok) throw new Error(`boat-legs.json: HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    data = loaded;
    boatLegs = legs;
    if (!Array.isArray(boatLegs.tables) || !boatLegs.tables.length)
      throw new Error("boat-legs.json: saknar tables");
  } catch (e) {
    loadError = e instanceof DataError ? e.message : `Kunde inte läsa datafilerna:\n${e.message}`;
    console.error(e);
    return;
  }
  const forNow = () => {
    refreshWeather();
    return refresh(currentDirection(window.nowSE()));
  };
  await forNow();
  setInterval(forNow, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) forNow();
  });
}

for (const button of document.querySelectorAll("#jDirSeg button")) {
  button.addEventListener("click", () => {
    const se = window.nowSE();
    chosenDirection = button.dataset.dir;
    chosenOn = se.iso;
    rankOpen = false;
    el("jRankBody").style.maxHeight = "0";
    el("jRank").classList.remove("open");
    refresh(chosenDirection).then(() => render(window.nowSE()));
    render(se);
  });
}

el("jRankHead").addEventListener("click", () => {
  rankOpen = !rankOpen;
  const body = el("jRankBody");
  el("jRank").classList.toggle("open", rankOpen);
  el("jRankHead").setAttribute("aria-expanded", rankOpen ? "true" : "false");
  body.style.maxHeight = rankOpen ? body.scrollHeight + "px" : "0";
});

window.jobbet = {
  render,
  activate() {
    refresh(currentDirection(window.nowSE()));
  },
  /** Force a direction from the console or a test, bypassing the clock. */
  setDirection(direction) {
    chosenDirection = direction;
    chosenOn = window.nowSE().iso;
  },
  /**
   * Feed the engine a synthetic departure set instead of live data.
   * Used to exercise a morning while the real traffic is still on another
   * timetable, and to reproduce a reported ranking without waiting for it.
   * Pass null to go back to live data.
   */
  useFixture(sites) {
    if (!sites) {
      feeds = new Map();
      return refresh(currentDirection(window.nowSE()));
    }
    feeds = new Map(
      Object.entries(sites).map(([id, list]) => [
        Number(id),
        {
          departures: list.map((d) => ({
            line: d.line,
            mode: d.mode,
            scheduled: d.scheduled,
            expected: d.expected || d.scheduled,
            cancelled: d.cancelled === true,
            destination: d.destination || "",
            directionCode: d.directionCode,
            delay: d.expected ? toMinutes(d.expected) - toMinutes(d.scheduled) : 0,
          })),
          stopDeviations: [],
        },
      ])
    );
    lastFetch = Date.now();
  },
};

boot();
