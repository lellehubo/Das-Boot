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
import {
  planScenario,
  planAll,
  toMinutes,
  toClock,
  defaultDirection,
  TO_WORK,
  TO_HOME,
  PENDING,
} from "../js/engine-scenarios.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => read(join("data", url.replace(/^data\//, ""))),
});

const data = await loadData();
const weights = data.weights;

// Tabellen som gäller från 17 augusti 2026, med dagtyperna mtor/fre/helg.
const AUTUMN = "2026-08-18";
const boatTables = read("data/boat-legs.json").tables;
const tableFor = (iso) => boatTables.find((t) => t.from <= iso && iso <= t.to);
const boatLegs = tableFor(AUTUMN).legs;

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
  assert.equal(toClock(plan.leaveAt), "07:13");
  assert.equal(toClock(plan.legs[1].start), "07:16");
  assert.equal(toClock(plan.legs[1].end), "07:54", "ankomst ur tidtabellen");
  // 26 min promenad Frihamnen -> Tegeluddsvägen
  assert.equal(toClock(plan.arrive), "08:20");
});

test("väljer nästa båt när den första redan gått", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:20"));
  assert.equal(toClock(plan.legs[1].start), "07:46");
  assert.equal(toClock(plan.leaveAt), "07:43");
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
  assert.equal(toClock(plan.leaveAt), "07:20");
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

test("väntan räknas bara vid byten, inte på första bryggan", () => {
  // Båt 07:27 -> Allmänna gränd 07:36, 2 min promenad = 07:38, spårvagn 07:42.
  // Enda äkta väntan är de 4 minuterna vid Liljevalchs. Tiden fram till båten
  // är ingen väntan: gå hemifrån-tiden är härledd ur den avgången.
  const ctx = ctxAt("07:00", {
    sites: {
      1442: [{ line: "80", mode: "SHIP", scheduled: "07:27", destination: "Nybroplan" }],
      1406: [{ line: "7", mode: "TRAM", scheduled: "07:42" }],
    },
  });
  const plan = planScenario(byId("boat_tram_strandvagen"), TEGEL, ctx);
  assert.equal(plan.waiting, 4);
  assert.equal(plan.legs[1].wait, 0, "första båten ska inte räknas som väntan");
  assert.equal(toClock(plan.leaveAt), "07:24");
});

test("restid mäts dörr till dörr från gå hemifrån", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:00"));
  assert.equal(plan.travelMinutes, plan.arrive - plan.leaveAt);
  assert.equal(plan.travelMinutes, 67, "07:13 till 08:20");
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

test("tidtabellen växlar på datum, med olika dagtyper per utgåva", () => {
  const summer = tableFor("2026-08-12");
  const autumn = tableFor("2026-08-18");
  assert.notEqual(summer, autumn, "12 och 18 augusti ska ge olika tabeller");
  assert.deepEqual(Object.keys(summer.legs.ropsten).sort(), ["helg", "vardag"]);
  assert.deepEqual(Object.keys(autumn.legs.ropsten).sort(), ["fre", "helg", "mtor"]);
  // Skarven: 16 augusti är sista sommardagen, 17 augusti första höstdagen.
  assert.equal(tableFor("2026-08-16"), summer);
  assert.equal(tableFor("2026-08-17"), autumn);
});

test("sommartabellen planerar med sina egna dagtyper", () => {
  // Onsdag 12 augusti är "vardag" i sommartabellen; båt 07:32 mot Nybroplan.
  const ctx = {
    data,
    weights,
    boatLegs: tableFor("2026-08-12").legs,
    dayType: "vardag",
    now: toMinutes("07:00"),
    departures: feed({
      1442: [{ line: "80", mode: "SHIP", scheduled: "07:32", destination: "Nybroplan" }],
      1406: [{ line: "7", mode: "TRAM", scheduled: "07:50" }],
    }),
  };
  const plan = planScenario(byId("boat_bike_djurgarden"), TEGEL, ctx);
  assert.ok(!plan.broken, `skulle planeras, men: ${plan.broken?.reason}`);
  assert.equal(toClock(plan.leaveAt), "07:29");
});

test("oprövat scenario är markerat", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:00"));
  assert.equal(plan.untested, true);
  assert.equal(plan.uncalibrated, true, "alla gångtider är ännu okalibrerade");
});

// ---- Hemresan ----------------------------------------------------------
// Samma scenarier lästa baklänges. Eftermiddagsbåtarna nedan är verkliga
// hösttider: 16:31 från Frihamnen är framme vid Saltsjöqvarn 17:09.

const AFTERNOON = {
  1442: [],
  312: [
    { line: "80", mode: "SHIP", scheduled: "16:33", destination: "Ropsten" },
    { line: "80", mode: "SHIP", scheduled: "16:48", destination: "Ropsten" },
  ],
  1001: [
    { line: "80", mode: "SHIP", scheduled: "16:23", destination: "Nybroplan" },
    { line: "80", mode: "SHIP", scheduled: "16:53", destination: "Nybroplan" },
  ],
  1406: [{ line: "7", mode: "TRAM", scheduled: "16:20" }],
};

function homeCtx(clock, sites = {}) {
  return {
    data,
    weights,
    boatLegs,
    dayType: "mtor",
    direction: TO_HOME,
    now: toMinutes(clock),
    departures: feed({ ...AFTERNOON, ...sites }),
  };
}

test("riktningen gissas på tid: morgon till jobbet, eftermiddag hem", () => {
  assert.equal(defaultDirection(toMinutes("07:00")), TO_WORK);
  assert.equal(defaultDirection(toMinutes("11:59")), TO_WORK);
  assert.equal(defaultDirection(toMinutes("12:00")), TO_HOME);
  assert.equal(defaultDirection(toMinutes("17:30")), TO_HOME);
});

test("hemresan vänder benen: jobbet först, hemma sist", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, homeCtx("16:00"));
  assert.ok(!plan.broken, `skulle planeras, men: ${plan.broken?.reason}`);
  assert.equal(plan.legs[0].from, "tegeluddsvagen_3", "börjar på jobbet");
  assert.equal(plan.legs.at(-1).to, "home", "slutar hemma");
  assert.equal(plan.legs[1].from, "frihamnen_pier");
  assert.equal(plan.legs[1].to, "saltsjoqvarn");
});

test("hemresan använder båten åt andra hållet", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, homeCtx("16:00"));
  // 26 min promenad från Tegeluddsvägen till Frihamnen: tidigast 16:26,
  // så 16:23-båten är missad och 16:53 blir valet.
  assert.equal(toClock(plan.legs[1].start), "16:53");
  assert.equal(toClock(plan.legs[1].end), "17:32", "ankomst ur tidtabellen");
  // 3 min från bryggan hem
  assert.equal(toClock(plan.arrive), "17:35");
  assert.equal(toClock(plan.leaveAt), "16:27", "gå från jobbet");
});

test("hemresan via Allmänna gränd byter riktning på båten", () => {
  const plan = planScenario(byId("boat_bike_djurgarden"), TEGEL, homeCtx("16:00"));
  assert.ok(!plan.broken, `skulle planeras, men: ${plan.broken?.reason}`);
  assert.equal(plan.legs[1].from, "allmanna_grand");
  assert.equal(plan.legs[1].to, "saltsjoqvarn");
  assert.equal(plan.legs[1].minutes, 8, "Allmänna gränd till Saltsjöqvarn tar 8 min");
});

test("morgonriktningen är oförändrad", () => {
  const plan = planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:00"));
  assert.equal(plan.legs[0].from, "home");
  assert.equal(plan.legs.at(-1).to, "tegeluddsvagen_3");
  assert.equal(toClock(plan.leaveAt), "07:13");
});

test("planAll planerar hela hemresan", () => {
  const plans = planAll(TEGEL, homeCtx("16:00"));
  const working = plans.filter((p) => !p.broken);
  assert.ok(working.length >= 2, `minst två vägar hem, fick ${working.length}`);
  for (const p of working) {
    assert.equal(p.legs[0].from, "tegeluddsvagen_3");
    assert.equal(p.legs.at(-1).to, "home");
  }
  for (let i = 1; i < working.length; i++)
    assert.ok(working[i - 1].arrive <= working[i].arrive, "ankomst stigande");
});

test("kort realtidsfönster ger 'syns inte än', inte 'ingen tur'", () => {
  // SL ger som mest sex avgångar per linje. Efter 29 min promenad till
  // Djurgårdsbron ligger man bortom fönstret — trafiken går, vi ser den inte.
  const ctx = homeCtx("16:00", {
    1100: [
      { line: "7", mode: "TRAM", scheduled: "16:05" },
      { line: "7", mode: "TRAM", scheduled: "16:10" },
    ],
  });
  const plan = planScenario(byId("boat_tram_strandvagen"), TEGEL, ctx);
  assert.equal(plan.broken.code, PENDING);
  assert.match(plan.broken.reason, /Realtiden räcker bara till 16:10/);
});

test("tom avgångslista är fortfarande 'ingen tur'", () => {
  const ctx = homeCtx("16:00", { 1100: [] });
  const plan = planScenario(byId("boat_tram_strandvagen"), TEGEL, ctx);
  assert.equal(plan.broken.code, "no_run");
});

test("väntande scenarier sorteras före brutna", () => {
  const plans = planAll(TEGEL, homeCtx("16:00", { 1100: [] }));
  const codes = plans.map((p) => (p.broken ? p.broken.code : "ok"));
  const firstBroken = codes.indexOf("no_run");
  const lastPending = codes.lastIndexOf(PENDING);
  if (firstBroken !== -1 && lastPending !== -1)
    assert.ok(lastPending < firstBroken, "väntande ska ligga före brutna");
});

test("hemresan får sin egen rubrik — benen vänds men orden gör det inte", () => {
  const scenario = byId("boat_bike_djurgarden");
  const ut = planScenario(scenario, TEGEL, ctxAt("07:00"));
  const hem = planScenario(scenario, TEGEL, homeCtx("16:00"));

  assert.equal(ut.label, "Båten till Allmänna gränd, cykel därifrån");
  // Morgonens ordalydelse sätter båten först; hem kommer cykeln först, så att
  // återanvända den skulle beskriva resan baklänges.
  assert.equal(hem.label, "Cykel till Allmänna gränd, båten hem");

  // Och benen ligger verkligen i den ordningen, så rubriken matchar planen.
  assert.equal(hem.legs[0].type, "bike");
  assert.equal(hem.legs.at(-1).type, "walk");
  assert.equal(hem.legs.at(-1).to, "home");
});

test("varje scenario har en hemrubrik, så ingen väg beskrivs baklänges", () => {
  for (const s of data.scenarios.scenarios) {
    assert.ok(s.label_home, `${s.id} saknar label_home`);
    assert.notEqual(s.label_home, s.label, `${s.id} har samma rubrik båda hållen`);
  }
});

test("scenario utan label_home behåller morgonens rubrik", () => {
  const bare = {
    id: "utan_hemrubrik",
    label: "Enkel väg",
    destinations: [TEGEL.id],
    legs: [
      { type: "walk", from: "home", to: "saltsjoqvarn" },
      { type: "transit", mode: "SHIP", line: "80", from: "saltsjoqvarn", to: "allmanna_grand" },
      { type: "walk", from: "allmanna_grand", to: "$destination" },
    ],
  };
  assert.equal(planScenario(bare, TEGEL, homeCtx("16:00")).label, "Enkel väg");
});

test("en bruten hemresa rapporteras med hemrubriken, inte morgonens", () => {
  // Inga avgångar alls: planen bryts, och felmeddelandet ska ändå benämna
  // vägen så som den ser ut på hemvägen.
  const tomt = homeCtx("16:00");
  tomt.departures = new Map();
  const hem = planScenario(byId("boat_bike_djurgarden"), TEGEL, tomt);
  assert.ok(hem.broken, "skulle vara bruten");
  assert.equal(hem.label, "Cykel till Allmänna gränd, båten hem");
});

test("hemresan börjar på cykeln för cykelvägarna, gå för de andra", () => {
  // Underlaget för avfärdsverbet i vyn: "Gå från jobbet" vore fel när första
  // benet är cykel, och det är just vad spegelvändningen ger.
  const cykel = planScenario(byId("boat_direct_frihamnen_bike"), TEGEL, homeCtx("16:00"));
  assert.ok(!cykel.broken, `cykelvägen skulle planeras: ${cykel.broken?.reason}`);
  assert.equal(cykel.legs[0].type, "bike");

  const gang = planScenario(byId("boat_direct_frihamnen"), TEGEL, homeCtx("16:00"));
  assert.ok(!gang.broken, `gångvägen skulle planeras: ${gang.broken?.reason}`);
  assert.equal(gang.legs[0].type, "walk");

  // På morgonen börjar båda med promenaden till bryggan, så verbet skiljer sig
  // bara på hemvägen.
  assert.equal(planScenario(byId("boat_direct_frihamnen_bike"), TEGEL, ctxAt("07:00")).legs[0].type, "walk");
  assert.equal(planScenario(byId("boat_direct_frihamnen"), TEGEL, ctxAt("07:00")).legs[0].type, "walk");
});
