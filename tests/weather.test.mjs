// Run with: node --test "tests/*.test.mjs"
//
// The normalisation tests run against fixtures/smhi-snow1g.json, which is a real
// capture, so the interval maths is checked against SMHI's actual step widths
// rather than against an idealised hour.
//
// The scoring tests build their own hours instead. Grading needs specific
// weather at specific local times, and stating those directly keeps each test
// readable; the shapes come from the same normaliser the live path uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { _internals } from "../js/weather.js";
import {
  summariseWindow,
  verdictOf,
  verdictForPlan,
  verdictsFor,
  applyWeather,
  exposureOf,
  instantOf,
  CLEAR,
  CAUTION,
  AVOID,
} from "../js/weather-score.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const weather = read("data/weights.json").weather;
const DAY = "2026-08-18";

/** One forecast step over a local window, dry and calm unless overridden. */
function step(isoDate, fromMin, toMin, fields = {}) {
  return {
    startMs: instantOf(isoDate, fromMin),
    endMs: instantOf(isoDate, toMin),
    spanHours: (toMin - fromMin) / 60,
    temperature: 15,
    windSpeed: 3,
    windGust: 5,
    precipProbability: 0,
    precipMmPerH: 0,
    precipMinMmPerH: 0,
    precipMaxMmPerH: 0,
    frozenPart: 0,
    thunderProbability: 0,
    symbolCode: 1,
    ...fields,
  };
}

const forecastOf = (hours, source = "smhi") => ({ source, referenceTime: null, hours, stale: false });

/** Hourly steps across a local span, all sharing the same weather. */
function hours(isoDate, fromHour, toHour, fields = {}) {
  const out = [];
  for (let h = fromHour; h < toHour; h++) out.push(step(isoDate, h * 60, (h + 1) * 60, fields));
  return out;
}

const RAIN = { precipProbability: 75, precipMmPerH: 1.2, precipMinMmPerH: 1.0, precipMaxMmPerH: 1.4 };
const DRY = {};

function plan(id, legs, { arrive = 480, broken = null } = {}) {
  return {
    id,
    label: id,
    legs,
    leaveAt: legs[0].start,
    arrive,
    travelMinutes: arrive - legs[0].start,
    broken,
    requiresBike: legs.some((l) => l.type === "bike"),
  };
}

const leg = (type, start, minutes) => ({
  type,
  from: "a",
  to: "b",
  minutes,
  start,
  end: start + minutes,
});

// --- normalisation against the real capture -------------------------------

test("nederbörden normaliseras mot sitt eget intervall, inte mot en antagen timme", () => {
  const raw = read("fixtures/smhi-snow1g.json");
  const normalised = _internals.normaliseSmhi(raw);
  assert.ok(normalised.length > 0, "fixturen ska ge steg");

  const bySpan = new Map();
  for (const h of normalised) bySpan.set(h.spanHours, (bySpan.get(h.spanHours) || 0) + 1);
  assert.ok(bySpan.size > 1, "den riktiga fixturen har mer än en steglängd");

  // Every step, whatever its width, must report a rate rather than a total.
  for (const [i, h] of normalised.entries()) {
    const source = raw.timeSeries[i].data;
    const amount = source.precipitation_amount_median ?? source.precipitation_amount_mean;
    if (amount == null || h.precipMmPerH == null) continue;
    assert.ok(
      Math.abs(h.precipMmPerH - amount / h.spanHours) < 1e-9,
      `steg ${i}: ${amount} mm över ${h.spanHours} h ska bli ${amount / h.spanHours} mm/h`
    );
  }

  const wide = normalised.find((h) => h.spanHours >= 6);
  assert.ok(wide, "fixturen ska innehålla minst ett sextimmarssteg");
  assert.notEqual(wide.spanHours, 1, "sextimmarssteget får inte behandlas som en timme");
});

test("intervallets slutstämpel läses som ett intervall, inte som en tidpunkt", () => {
  // SMHI stamps 07:00-08:00 with time=08:00. A window of 07:00-08:00 must find
  // that step; matching on the stamp alone would miss it and read 08:00-09:00.
  const sevenToEight = step(DAY, 7 * 60, 8 * 60, RAIN);
  const eightToNine = step(DAY, 8 * 60, 9 * 60, DRY);
  const summary = summariseWindow(forecastOf([sevenToEight, eightToNine]), DAY, 7 * 60, 8 * 60);
  assert.equal(summary.steps, 1);
  assert.equal(summary.maxPrecipProbability, 75);
});

// --- timezone -------------------------------------------------------------

test("eftermiddagsfönstret träffar rätt UTC-timmar på båda sidor om tidsomställningen", () => {
  // EU switches on the last Sunday: 29 March and 25 October 2026.
  const utcHour = (iso) => new Date(instantOf(iso, 16 * 60)).getUTCHours();
  assert.equal(utcHour("2026-03-28"), 15, "vintertid: 16 lokal = 15Z");
  assert.equal(utcHour("2026-03-30"), 14, "sommartid: 16 lokal = 14Z");
  assert.equal(utcHour("2026-10-24"), 14, "sommartid: 16 lokal = 14Z");
  assert.equal(utcHour("2026-10-26"), 15, "vintertid: 16 lokal = 15Z");
});

// --- grading --------------------------------------------------------------

test("åska ger caution — fältet finns på sammanfattningen", () => {
  const summary = summariseWindow(
    forecastOf(hours(DAY, 7, 9, { thunderProbability: 35 })),
    DAY,
    7 * 60,
    9 * 60
  );
  assert.equal(summary.maxThunderProbability, 35);
  const verdict = verdictOf(summary, weather);
  assert.equal(verdict.level, CAUTION);
  assert.ok(verdict.reasons.some((r) => r.kind === "thunder"));
});

test("hög spridning skärper clear till caution och mjukar aldrig upp något", () => {
  // Scattered showers: the median is dry, the wet members are not.
  const scattered = {
    precipProbability: 15,
    precipMmPerH: 0.0,
    precipMinMmPerH: 0.0,
    precipMaxMmPerH: 0.9,
  };
  const summary = summariseWindow(forecastOf(hours(DAY, 7, 9, scattered)), DAY, 7 * 60, 9 * 60);
  assert.equal(summary.confidence, "low");
  assert.equal(verdictOf(summary, weather).level, CAUTION, "skurighet ska höja, inte sänka");

  // The same spread must never rescue a window that is genuinely wet.
  const wet = summariseWindow(
    forecastOf(hours(DAY, 7, 9, { ...RAIN, precipMinMmPerH: 0.0, precipMaxMmPerH: 3.0 })),
    DAY,
    7 * 60,
    9 * 60
  );
  assert.equal(wet.confidence, "low");
  assert.equal(verdictOf(wet, weather).level, AVOID, "avoid får inte mildras av spridning");
});

test("en grov prognos får inte avråda på sannolikhet allena", () => {
  // Four days out SMHI answers in twelve-hour blocks. "52 % chance of rain" over
  // half a day is not 52 % during a quarter-hour walk.
  const wide = [step(DAY, 0, 12 * 60, { precipProbability: 52, precipMmPerH: 0.017 })];
  const summary = summariseWindow(forecastOf(wide), DAY, 7 * 60, 8 * 60);
  assert.equal(summary.maxStepHours, 12);
  assert.equal(verdictOf(summary, weather).level, CAUTION, "grovt steg får inte ge avoid");

  // The same probability at hourly resolution is a real signal and must avoid.
  const hourly = summariseWindow(
    forecastOf(hours(DAY, 7, 8, { precipProbability: 52 })),
    DAY,
    7 * 60,
    8 * 60
  );
  assert.equal(verdictOf(hourly, weather).level, AVOID);

  // Coarse steps must not mute a genuinely heavy forecast either.
  const heavy = summariseWindow(
    forecastOf([step(DAY, 0, 12 * 60, { precipProbability: 52, precipMmPerH: 1.4 })]),
    DAY,
    7 * 60,
    8 * 60
  );
  assert.equal(verdictOf(heavy, weather).level, AVOID, "mängd gäller oavsett steglängd");
});

test("en källa utan ensemble ger unknown och skärper ingenting", () => {
  const noEnsemble = hours(DAY, 7, 9, { precipMinMmPerH: null, precipMaxMmPerH: null });
  const summary = summariseWindow(forecastOf(noEnsemble, "open-meteo"), DAY, 7 * 60, 9 * 60);
  assert.equal(summary.confidence, "unknown");
  assert.equal(verdictOf(summary, weather).level, CLEAR, "avsaknad av data är inte bevis för skurar");
});

// --- the inheritance rule -------------------------------------------------

const bikeCommute = plan("cykel", [leg("bike", 7 * 60 + 20, 15)], { arrive: 8 * 60 });

test("torr morgon plus blöt eftermiddag ger avoid på morgoncykeln, med inheritedFrom satt", () => {
  const verdict = verdictForPlan(bikeCommute, {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, DRY)),
    returnForecast: forecastOf(hours(DAY, 15, 19, RAIN)),
    direction: "to_work",
  });
  assert.equal(verdict.level, AVOID);
  assert.ok(verdict.inheritedFrom, "eftermiddagen ska pekas ut som orsak");
  assert.equal(verdict.inheritedFrom.fromMin, 16 * 60);
});

test("blöt morgon plus torr eftermiddag ger avoid på morgonen men clear på hemresan", () => {
  const morning = verdictForPlan(bikeCommute, {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, RAIN)),
    returnForecast: forecastOf(hours(DAY, 15, 19, DRY)),
    direction: "to_work",
  });
  assert.equal(morning.level, AVOID);
  assert.equal(morning.inheritedFrom, null, "morgonen avgjorde själv");

  const evening = verdictForPlan(plan("hem", [leg("bike", 16 * 60 + 30, 15)], { arrive: 17 * 60 }), {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 15, 19, DRY)),
    returnForecast: null,
    direction: "to_home",
  });
  assert.equal(evening.level, CLEAR);
});

test("promenaden ärver inte eftermiddagen — man lämnar inga skor på jobbet", () => {
  const walker = plan("gå", [leg("walk", 7 * 60 + 20, 25)], { arrive: 8 * 60 });
  const verdict = verdictForPlan(walker, {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, DRY)),
    returnForecast: forecastOf(hours(DAY, 15, 19, RAIN)),
    direction: "to_work",
  });
  assert.equal(verdict.level, CLEAR);
  assert.equal(verdict.inheritedFrom, null);
});

// --- windows and exposure -------------------------------------------------

test("ett fönster utan data ger null i stället för att kasta", () => {
  const onlyMorning = forecastOf(hours(DAY, 6, 10, DRY));
  assert.equal(summariseWindow(onlyMorning, DAY, 16 * 60, 18 * 60), null);
  assert.equal(summariseWindow(onlyMorning, DAY, 9 * 60, 9 * 60), null, "tomt fönster");
  assert.doesNotThrow(() =>
    verdictForPlan(bikeCommute, {
      weather,
      isoDate: DAY,
      forecast: forecastOf([]),
      returnForecast: null,
      direction: "to_work",
    })
  );
});

test("fönstret härleds ur benen, och båtben räknas inte som exponering", () => {
  const mixed = plan("blandad", [
    leg("walk", 7 * 60 + 10, 12),
    { type: "transit", mode: "SHIP", from: "a", to: "b", minutes: 38, start: 7 * 60 + 22, end: 8 * 60 },
    leg("walk", 8 * 60, 9),
  ]);
  const exposure = exposureOf(mixed, weather);
  assert.equal(exposure.minutes, 21, "bara gångbenen");
  assert.equal(exposure.fromMin, 7 * 60 + 10);
  assert.equal(exposure.toMin, 8 * 60 + 9);
});

test("för kort exponering ger ingen bedömning alls", () => {
  const quick = plan("kort", [leg("walk", 7 * 60 + 50, 5)], { arrive: 8 * 60 });
  const verdict = verdictForPlan(quick, {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, RAIN)),
    returnForecast: null,
    direction: "to_work",
  });
  assert.equal(verdict, null, "fem minuter i regn är under tröskeln");
});

// --- ranking --------------------------------------------------------------

test("applyWeather muterar inte sina argument", () => {
  const plans = [plan("a", [leg("walk", 7 * 60, 20)], { arrive: 8 * 60 })];
  const snapshot = structuredClone(plans);
  const verdicts = verdictsFor(plans, {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, RAIN)),
    returnForecast: null,
    direction: "to_work",
  });
  applyWeather(plans, verdicts, weather);
  assert.deepEqual(plans, snapshot, "originalet ska vara orört");
});

// ---- Vädret bestämmer inte ----

test("vädret ändrar inte ordningen — den är användarens egen rangordning", () => {
  // Tidigare sorterade det här om listan. Han bad uttryckligen om att få se
  // vädret och bestämma själv, så ordningen in är ordningen ut.
  const torr = plan("torr väg", [leg("walk", 7 * 60 + 15, 5)], { arrive: 8 * 60 });
  const blöt = plan("blöt väg", [leg("walk", 7 * 60, 30)], { arrive: 8 * 60 + 10 });
  const plans = [blöt, torr];
  const ctx = {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, RAIN)),
    returnForecast: null,
    direction: "to_work",
  };
  const ut = applyWeather(plans, verdictsFor(plans, ctx), weather);
  assert.deepEqual(ut.map((p) => p.id), ["blöt väg", "torr väg"], "samma ordning som in");
});

test("bedömningen följer ändå med, så vyn kan visa en ikon per väg", () => {
  const p = plan("cykel", [leg("bike", 7 * 60, 20)], { arrive: 8 * 60 });
  const ctx = {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, RAIN)),
    returnForecast: null,
    direction: "to_work",
  };
  const ut = applyWeather([p], verdictsFor([p], ctx), weather);
  assert.ok(ut[0].weather, "bedömningen ska finnas kvar på planen");
  assert.equal(ut[0].weather.level, AVOID);
  assert.ok(ut[0].weather.window, "fönstret följer med för ikonen");
});

test("inget alternativ försvinner, inte ens i hällregn", () => {
  const plans = [
    plan("a", [leg("bike", 7 * 60, 20)], { arrive: 8 * 60 }),
    plan("b", [leg("walk", 7 * 60, 30)], { arrive: 8 * 60 + 5 }),
  ];
  const ctx = {
    weather,
    isoDate: DAY,
    forecast: forecastOf(hours(DAY, 6, 10, RAIN)),
    returnForecast: null,
    direction: "to_work",
  };
  assert.equal(applyWeather(plans, verdictsFor(plans, ctx), weather).length, 2);
});
