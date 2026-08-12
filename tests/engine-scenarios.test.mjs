// Run with: node --test "tests/*.test.mjs"
//
// Times here are a synthetic weekday morning so the tests stay deterministic.
// The boat times match the real autumn table: 07:16 from Saltsjoqvarn reaches
// Frihamnen at 07:54.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadData } from "../js/data-layer.js";
import { planScenario, planAll, toMinutes, toClock } from "../js/engine-scenarios.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => read(join("data", url.replace(/^data\//, ""))),
});

const data = await loadData();
const boatLegs = read("data/boat-legs.json");
const weights = data.weights;

const TEGEL = data.scenarios.destinations.find((d) => d.id === "tegeluddsvagen_3");

/** Build a departures feed keyed by site id. */
function feed(entries) {
  const map = new Map();
  for (const [siteId, list] of Object.entries(entries)) {
    map.set(Number(siteId), {
      departures: list.map((d) => ({
        line: d.line,
        mode: d.mode,
        scheduled: d.scheduled,
        expected: d.expected || d.scheduled,
        cancelled: d.cancelled === true,
        destination: d.destination || "",
        journeyId: d.journeyId || 1,
      })),
      stopDeviations: [],
    });
  }
  return map;
}

const BOATS = [
  { line: "80", mode: "SHIP", scheduled: "07:16", destination: "Ropsten" },
  { line: "80", mode: "SHIP", scheduled: "07:46", destination: "Ropsten" },
  { line: "80", mode: "SHIP", scheduled: "07:27", destination: "Nybroplan" },
  { line: "80", mode: "SHIP", scheduled: "07:37", destination: "Nybroplan" },
];

function ctxAt(clock, overrides = {}) {
  return {
    data,
    weights,
    boatLegs,
    dayType: "mtor",
    now: toMinutes(clock),
    departures: feed({
      1442: BOATS,
      1406: [
        { line: "7", mode: "TRAM", scheduled: "07:40" },
        { line: "67", mode: "BUS", scheduled: "07:44" },
      ],
      ...overrides.sites,
    }),
    ...overrides.ctx,
  };
}

const byId = (id) => data.scenarios.scenarios.find((s) => s.id === id);

test("räknar gå hemifrån-tid baklänges från första båten", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:00"));
  // 3 min promenad hemifrån till bryggan, båten går 07:16
  assert.equal(toClock(plan.leaveHome), "07:13");
  assert.equal(toClock(plan.legs[1].start), "07:16");
  assert.equal(toClock(plan.legs[1].end), "07:54", "ankomst ur tidtabellen");
  // 26 min promenad Frihamnen -> Tegeluddsvägen
  assert.equal(toClock(plan.arrive), "08:20");
});

test("väljer nästa båt när den första redan gått", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:20"));
  assert.equal(toClock(plan.legs[1].start), "07:46");
  assert.equal(toClock(plan.leaveHome), "07:43");
});

test("hoppar över turer som inte når målbryggan", () => {
  // Alla Ropsten-turer vänder vid Nacka Strand: ingen når Frihamnen.
  const ctx = ctxAt("07:00", {
    sites: {
      1442: [
        { line: "80", mode: "SHIP", scheduled: "07:06", destination: "Nacka Strand" },
        { line: "80", mode: "SHIP", scheduled: "07:36", destination: "Nacka Strand" },
      ],
    },
  });
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctx);
  assert.ok(plan.broken, "ska vara brutet");
  assert.match(plan.broken.reason, /Ingen båt som når målet/);
});

test("en tur mot Nybroplan används inte för ett Frihamnen-ben", () => {
  const ctx = ctxAt("07:00", {
    sites: { 1442: [{ line: "80", mode: "SHIP", scheduled: "07:27", destination: "Nybroplan" }] },
  });
  assert.ok(planScenario(byId("boat_direct_frihamnen"), TEGEL, ctx).broken);
});

test("försening skjuter fram både avgång och ankomst", () => {
  const ctx = ctxAt("07:00", {
    sites: {
      1442: [
        { line: "80", mode: "SHIP", scheduled: "07:16", expected: "07:23", destination: "Ropsten" },
      ],
    },
  });
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctx);
  assert.equal(toClock(plan.legs[1].start), "07:23");
  assert.equal(toClock(plan.legs[1].end), "08:01", "07:54 plus 7 min försening");
  assert.equal(plan.legs[1].delay, 7);
  assert.equal(toClock(plan.leaveHome), "07:20");
});

test("inställd tur bryter scenariot med orsak", () => {
  const ctx = ctxAt("07:00", {
    sites: {
      1442: [
        { line: "80", mode: "SHIP", scheduled: "07:16", destination: "Ropsten", cancelled: true },
      ],
    },
  });
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctx);
  assert.equal(plan.broken.code, "cancelled");
});

test("bytesmarginal respekteras vid byte men inte vid första påstigning", () => {
  // Båt 07:27 -> Allmänna gränd 07:36, 2 min promenad = 07:38.
  // Spårvagn 07:40 ligger 2 min senare, under marginalen på 4 min.
  const ctx = ctxAt("07:00", {
    sites: {
      1442: [{ line: "80", mode: "SHIP", scheduled: "07:27", destination: "Nybroplan" }],
      1406: [
        { line: "7", mode: "TRAM", scheduled: "07:40" },
        { line: "7", mode: "TRAM", scheduled: "07:50" },
      ],
    },
  });
  const plan = planScenario(byId("boat_tram_strandvagen"), TEGEL, ctx);
  assert.equal(toClock(plan.legs[3].start), "07:50", "ska välja spårvagnen efter marginalen");
});

test("scenario som inte betjänar destinationen ger null", () => {
  const hangovagen = data.scenarios.destinations.find((d) => d.id === "hangovagen_office");
  const vartan = byId("boat_direct_vartahamnen");
  assert.equal(planScenario(vartan, hangovagen, ctxAt("07:00")), null, "vilande ska hoppas över");
});

test("planAll sorterar på ankomst och lägger brutna sist", () => {
  const plans = planAll(TEGEL, ctxAt("07:00"));
  const working = plans.filter((p) => !p.broken);
  const broken = plans.filter((p) => p.broken);
  assert.ok(working.length >= 1, "minst ett scenario ska fungera");
  for (let i = 1; i < working.length; i++)
    assert.ok(working[i - 1].arrive <= working[i].arrive, "ankomst ska vara stigande");
  if (broken.length)
    assert.ok(plans.indexOf(broken[0]) > plans.indexOf(working.at(-1)), "brutna sist");
});

test("oprövat scenario är markerat", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:00"));
  assert.equal(plan.untested, true);
  assert.equal(plan.uncalibrated, true, "alla gångtider är ännu okalibrerade");
});
