// The "Jobbet" view: which of my ways to work runs right now, and when do I leave.
//
// Loaded only when the feature flag is on. It registers itself on window.jobbet
// because the rest of the app is a classic script and cannot import from a module.

// Dependencies load dynamically so they inherit this module's ?v= cache buster.
// With static imports the browser keeps serving the previously cached copies even
// when this file is refetched, which silently hides edits during development.
const VERSION = new URL(import.meta.url).search;
const [{ loadData, destinationsFor, DataError }, { departures }, engine] = await Promise.all([
  import(`./data-layer.js${VERSION}`),
  import(`./api-sl.js${VERSION}`),
  import(`./engine-scenarios.js${VERSION}`),
]);
const { planAll, toClock, toMinutes } = engine;

const HOME = "saltsjoqvarn";
const REFRESH_MS = 30_000;

let data = null;
let boatLegs = null;
let loadError = null;
let feeds = new Map();
let lastFetch = 0;
let fetching = false;
let rankOpen = false;

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

/** Which sites the current scenarios need departures from. */
function requiredSites() {
  const ids = new Set();
  for (const scenario of data.scenarios.scenarios) {
    if (scenario.status === "dormant") continue;
    for (const leg of scenario.legs) {
      if (leg.type !== "transit") continue;
      const node = data.node(leg.from);
      if (node?.site_id != null) ids.add(node.site_id);
    }
  }
  return [...ids];
}

async function refresh() {
  if (fetching || !data) return;
  fetching = true;
  try {
    const sites = requiredSites();
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

/** Next boat in each direction from home, which decides what is even possible. */
function nextBoats(se) {
  const home = data.node(HOME);
  const feed = feeds.get(home.site_id);
  const out = { nybroplan: null, ropsten: null };
  if (!feed) return out;

  for (const d of feed.departures) {
    if (d.line !== "80" || d.mode !== "SHIP" || d.cancelled || !d.scheduled) continue;
    const key = d.directionCode === 1 ? "ropsten" : "nybroplan";
    const departs = toMinutes(d.expected || d.scheduled);
    const diff = departs - se.min;
    if (diff < -1) continue;
    if (!out[key] || diff < out[key].diff) {
      out[key] = { diff, departs, destination: d.destination, delay: d.delay ?? 0 };
    }
  }
  return out;
}

function renderBoats(se) {
  const boats = nextBoats(se);
  const cards = [
    ["nybroplan", "Mot stan"],
    ["ropsten", "Mot Ropsten"],
  ].map(([key, label]) => {
    const boat = boats[key];
    if (!boat)
      return `<div class="boatcard none"><div class="bdir">${label}</div><div class="btime">–</div><div class="bcd">ingen avgång</div></div>`;
    const soon = boat.diff < 12 ? " soon" : "";
    return (
      `<div class="boatcard"><div class="bdir">${label}</div>` +
      `<div class="btime">${toClock(boat.departs)}</div>` +
      `<div class="bcd${soon}">${fmtCountdown(boat.diff)} · ${esc(boat.destination)}</div></div>`
    );
  });
  el("jBoats").innerHTML = cards.join("");
}

function tags(plan) {
  const out = [];
  if (plan.requiresBike) out.push('<span class="tag bike">cykel · plats ej garanterad</span>');
  if (plan.untested) out.push('<span class="tag untested">oprövad</span>');
  if (plan.uncalibrated) out.push('<span class="tag">tider ej uppmätta</span>');
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

function renderBest(se, plans) {
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

  const diff = best.leaveHome - se.min;
  const cls = diff <= 0.2 ? " now" : diff < 8 ? " soon" : "";
  const walkTime = best.legs[0]?.minutes ?? 0;

  host.innerHTML =
    `<div class="leave">` +
    `<div class="leave-lbl">Gå hemifrån</div>` +
    `<div class="leave-time">${toClock(best.leaveHome)}</div>` +
    `<div class="leave-cd${cls}">${diff <= 0.2 ? "gå nu" : fmtCountdown(diff)}</div>` +
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
        return (
          `<div class="rank broken"><div class="rank-l">` +
          `<div class="rank-name">${esc(plan.label)}</div>` +
          `<div class="rank-reason">${esc(plan.broken.reason)}</div>` +
          `</div><div class="rank-r"><div class="rank-arr">–</div></div></div>`
        );
      }
      const diff = plan.leaveHome - se.min;
      return (
        `<div class="rank"><div class="rank-l">` +
        `<div class="rank-name">${esc(plan.label)}</div>` +
        `<div class="rank-sub">${plan.travelMinutes} min · ${plan.transfers} byte${plan.transfers === 1 ? "" : "n"}` +
        (plan.requiresBike ? " · cykel" : "") +
        `</div></div><div class="rank-r">` +
        `<div class="rank-leave">${toClock(plan.leaveHome)}</div>` +
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

  const active = destinationsFor(data, se.iso);
  const destination = active[0];
  el("jDestText").textContent = destination ? destination.label : "ingen destination";
  if (!destination) {
    el("jBest").innerHTML =
      '<div class="leave"><div class="leave-lbl">Ingen destination gäller idag</div>' +
      '<div class="leave-why">Lägg till en i scenarios.json.</div></div>';
    return;
  }

  const plans = planAll(destination, {
    data,
    weights: data.weights,
    boatLegs,
    dayType: window.dayType ? window.dayType(se) : "mtor",
    now: se.min,
    departures: feeds,
  });

  renderBoats(se);
  renderBest(se, plans);
  renderRank(se, plans);

  const age = lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null;
  el("jNote").textContent =
    age === null
      ? "Väntar på realtidsdata…"
      : age > 90
        ? `Realtiden är ${Math.round(age / 60)} min gammal.`
        : "Bara morgonresan än så länge. Hemresan är inte byggd.";
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
  } catch (e) {
    loadError = e instanceof DataError ? e.message : `Kunde inte läsa datafilerna:\n${e.message}`;
    console.error(e);
    return;
  }
  await refresh();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
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
    refresh();
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
      return refresh();
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
