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

// Scenarier som bara finns här. Motorn ska testas mot en känd form, inte mot
// vilka vägar användaren råkar vilja ha just nu — när Frihamnen-vägarna togs
// bort ur scenarios.json föll 33 tester som egentligen inte handlade om dem.
const DIRECT = {
  id: "test_direct",
  label: "Båten hela vägen till Frihamnen",
  label_home: "Båten hela vägen från Frihamnen",
  destinations: ["tegeluddsvagen_3", "hangovagen_office"],
  requires_bike: false,
  legs: [
    { type: "walk", from: "home", to: "saltsjoqvarn" },
    { type: "transit", mode: "SHIP", line: "80", from: "saltsjoqvarn", to: "frihamnen_pier" },
    { type: "walk", from: "frihamnen_pier", to: "$destination" },
  ],
};
const DIRECT_BIKE = {
  ...DIRECT,
  id: "test_direct_bike",
  label: "Båten till Frihamnen, cykel sista biten",
  label_home: "Cykel till Frihamnen, båten hem",
  requires_bike: true,
  legs: [
    DIRECT.legs[0],
    DIRECT.legs[1],
    { type: "bike", from: "frihamnen_pier", to: "$destination" },
  ],
};
const DIRECT_UNTESTED = { ...DIRECT, id: "test_direct_untested", status: "untested" };

const byId = (id) => data.scenarios.scenarios.find((s) => s.id === id);

test("räknar gå hemifrån-tid baklänges från första båten", () => {
  const plan = planScenario(DIRECT, TEGEL, ctxAt("07:00"));
  // 3 min promenad hemifrån till bryggan, båten går 07:16
  assert.equal(toClock(plan.leaveAt), "07:13");
  assert.equal(toClock(plan.legs[1].start), "07:16");
  assert.equal(toClock(plan.legs[1].end), "07:54", "ankomst ur tidtabellen");
  // 26 min promenad Frihamnen -> Tegeluddsvägen
  assert.equal(toClock(plan.arrive), "08:20");
});

test("väljer nästa båt när den första redan gått", () => {
  const plan = planScenario(DIRECT, TEGEL, ctxAt("07:20"));
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
  const plan = planScenario(DIRECT, TEGEL, ctx);
  assert.ok(plan.broken, "ska vara brutet");
  assert.match(plan.broken.reason, /Ingen båt som når målet/);
});

test("en tur mot Nybroplan används inte för ett Frihamnen-ben", () => {
  const ctx = ctxAt("07:00", {
    sites: { 1442: [{ line: "80", mode: "SHIP", scheduled: "07:27", destination: "Nybroplan" }] },
  });
  assert.ok(planScenario(DIRECT, TEGEL, ctx).broken);
});

test("försening skjuter fram både avgång och ankomst", () => {
  const ctx = ctxAt("07:00", {
    sites: {
      1442: [
        { line: "80", mode: "SHIP", scheduled: "07:16", expected: "07:23", destination: "Ropsten" },
      ],
    },
  });
  const plan = planScenario(DIRECT, TEGEL, ctx);
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
  const plan = planScenario(DIRECT, TEGEL, ctx);
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
  const plan = planScenario(DIRECT, TEGEL, ctxAt("07:00"));
  assert.equal(plan.travelMinutes, plan.arrive - plan.leaveAt);
  assert.equal(plan.travelMinutes, 67, "07:13 till 08:20");
});

test("scenario som inte betjänar destinationen ger null", () => {
  const hangovagen = data.scenarios.destinations.find((d) => d.id === "hangovagen_office");
  const vilande = { ...DIRECT, id: "test_dormant", status: "dormant" };
  assert.equal(planScenario(vilande, hangovagen, ctxAt("07:00")), null, "vilande ska hoppas över");
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
  const plan = planScenario(DIRECT_UNTESTED, TEGEL, ctxAt("07:00"));
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
  // Bussarna hemvägarna byter till: 67 vid Karlaplan, 1 vid Gärdet.
  9222: [
    { line: "67", mode: "BUS", scheduled: "16:26" },
    { line: "67", mode: "BUS", scheduled: "16:36" },
    { line: "67", mode: "BUS", scheduled: "16:46" },
  ],
  9221: [
    { line: "1", mode: "BUS", scheduled: "16:12" },
    { line: "1", mode: "BUS", scheduled: "16:22" },
    { line: "1", mode: "BUS", scheduled: "16:32" },
  ],
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
  const plan = planScenario(DIRECT, TEGEL, homeCtx("16:00"));
  assert.ok(!plan.broken, `skulle planeras, men: ${plan.broken?.reason}`);
  assert.equal(plan.legs[0].from, "tegeluddsvagen_3", "börjar på jobbet");
  assert.equal(plan.legs.at(-1).to, "home", "slutar hemma");
  assert.equal(plan.legs[1].from, "frihamnen_pier");
  assert.equal(plan.legs[1].to, "saltsjoqvarn");
});

test("hemresan använder båten åt andra hållet", () => {
  const plan = planScenario(DIRECT, TEGEL, homeCtx("16:00"));
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
  const plan = planScenario(DIRECT, TEGEL, ctxAt("07:00"));
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
  const cykel = planScenario(DIRECT_BIKE, TEGEL, homeCtx("16:00"));
  assert.ok(!cykel.broken, `cykelvägen skulle planeras: ${cykel.broken?.reason}`);
  assert.equal(cykel.legs[0].type, "bike");

  const gang = planScenario(DIRECT, TEGEL, homeCtx("16:00"));
  assert.ok(!gang.broken, `gångvägen skulle planeras: ${gang.broken?.reason}`);
  assert.equal(gang.legs[0].type, "walk");

  // På morgonen börjar båda med promenaden till bryggan, så verbet skiljer sig
  // bara på hemvägen.
  assert.equal(planScenario(DIRECT_BIKE, TEGEL, ctxAt("07:00")).legs[0].type, "walk");
  assert.equal(planScenario(DIRECT, TEGEL, ctxAt("07:00")).legs[0].type, "walk");
});

test("nästa likadana resa fås genom att planera om en minut för sent", () => {
  // Så vyn får fram "missar du den"-raden: samma scenario, nu satt strax efter
  // den avgivna gå-tiden, vilket utesluter turen som just föreslagits.
  const first = planScenario(DIRECT, TEGEL, ctxAt("07:00"));
  assert.equal(toClock(first.leaveAt), "07:13");
  assert.equal(toClock(first.legs[1].start), "07:16");

  const next = planScenario(DIRECT, TEGEL, ctxAt(toClock(first.leaveAt + 1)));
  assert.ok(!next.broken, `nästa skulle planeras: ${next.broken?.reason}`);
  assert.equal(toClock(next.legs[1].start), "07:46", "nästa båt, inte samma igen");
  // Gå-tiden räknas om baklänges från den senare båten, inte som samma promenad
  // plus en minut.
  assert.equal(toClock(next.leaveAt), "07:43");
  assert.ok(next.arrive > first.arrive);
});

test("den senare resan behåller bytesreglerna, inte bara båttiden", () => {
  // Ett scenario med byte: gå-tiden ska härledas ur den senare kedjan i sin
  // helhet, så att bytesmarginalen fortfarande hålls.
  const first = planScenario(byId("boat_bus67_karlaplan"), TEGEL, ctxAt("07:00"));
  assert.ok(!first.broken, `första skulle planeras: ${first.broken?.reason}`);
  const next = planScenario(byId("boat_bus67_karlaplan"), TEGEL, ctxAt(toClock(first.leaveAt + 1)));
  if (!next.broken) {
    const buss = next.legs.find((l) => l.mode === "BUS");
    const bat = next.legs.find((l) => l.mode === "SHIP");
    assert.ok(buss.start >= bat.end, "bussen går inte före båten kommit fram");
  }
});

test("sista turen på dagen har ingen nästa, och det är inte ett fel", () => {
  // Bara en enda båt i flödet: omplaneringen hittar ingen senare tur.
  const bara = ctxAt("07:00", {
    sites: { 1442: [{ line: "80", mode: "SHIP", scheduled: "07:16", destination: "Ropsten" }] },
  });
  const first = planScenario(DIRECT, TEGEL, bara);
  assert.ok(!first.broken);
  const efter = ctxAt(toClock(first.leaveAt + 1), {
    sites: { 1442: [{ line: "80", mode: "SHIP", scheduled: "07:16", destination: "Ropsten" }] },
  });
  const next = planScenario(DIRECT, TEGEL, efter);
  assert.ok(next.broken, "ingen senare tur ska rapporteras som bruten, inte som samma tur igen");
});

test("listan följer användarens rangordning, inte ankomsttiden", () => {
  const plans = planAll(TEGEL, ctxAt("07:00")).filter((p) => !p.broken);
  const prios = plans.map((p) => p.priority);
  assert.deepEqual(prios, [...prios].sort((a, b) => a - b), `ordningen bröts: ${prios}`);
  // Cykel/båt via Allmänna gränd är förstahandsvalet och ska ligga överst så
  // länge den går, även om en annan väg kommer fram tidigare.
  assert.equal(plans[0].id, "boat_bike_djurgarden");
  const snabbast = plans.slice().sort((a, b) => a.arrive - b.arrive)[0];
  if (snabbast.id !== plans[0].id) {
    assert.ok(true, "en annan väg är snabbare men ligger ändå efter — det är meningen");
  }
});

test("scenariofilen bär en rangordning utan luckor eller dubbletter", () => {
  const prios = data.scenarios.scenarios.map((s) => s.priority);
  assert.ok(prios.every((p) => typeof p === "number"), "varje scenario behöver priority");
  assert.equal(new Set(prios).size, prios.length, "två scenarier får inte dela plats");
});

test("Frihamnen och Ropsten föreslås inte längre", () => {
  // Borttagna på användarens begäran 2026-08-21: han vill inte ha dem ens i regn.
  const nodes = new Set();
  for (const s of data.scenarios.scenarios)
    for (const l of s.legs) { nodes.add(l.from); nodes.add(l.to); }
  assert.ok(!nodes.has("frihamnen_pier"), "ingen väg får gå via Frihamnens brygga");
  assert.ok(!nodes.has("ropsten"), "ingen väg får gå via Ropsten");
});
