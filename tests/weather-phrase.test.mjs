import { test } from "node:test";
import assert from "node:assert/strict";
import { describeWindow, describeBikeOutlook, iconSvg, SYMBOLS } from "../js/weather-phrase.js";

// The view passes the real zone-aware helper; a fixed one keeps these tests
// independent of where they run.
const utcMinutes = (ms) => {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const opts = { localMinutesOf: utcMinutes };

function summary(over = {}) {
  return {
    isoDate: "2026-08-17",
    fromMin: 480,
    toMin: 510,
    steps: 1,
    maxPrecipProbability: 0,
    maxPrecipMmPerH: 0,
    totalPrecipMm: 0,
    spreadMmPerH: 0,
    maxGust: 3,
    minTemperature: 15,
    maxTemperature: 15,
    maxThunderProbability: 0,
    thunderPeakMs: null,
    symbolCodes: [],
    anyFrozen: false,
    maxStepHours: 1,
    source: "smhi",
    stale: false,
    confidence: "medium",
    ...over,
  };
}

test("SMHI:s symboltabell är komplett, 1 till 27", () => {
  for (let code = 1; code <= 27; code++) {
    assert.ok(SYMBOLS[code], `kod ${code} saknas`);
    assert.ok(SYMBOLS[code].lead.length > 0);
    assert.ok(SYMBOLS[code].icon.length > 0);
  }
  assert.equal(Object.keys(SYMBOLS).length, 27, "inga påhittade koder utöver SMHI:s");
});

test("strålande sol med gradtal", () => {
  const d = describeWindow(summary({ symbolCodes: [1], maxTemperature: 22, minTemperature: 21 }), opts);
  assert.equal(d.text, "Strålande sol och 22 grader");
  assert.equal(d.icon, "sun");
});

test("liten risk för regn", () => {
  const d = describeWindow(summary({ symbolCodes: [18], maxPrecipProbability: 18, maxPrecipMmPerH: 0.05 }), opts);
  assert.equal(d.text, "Liten risk för regn");
});

test("mycket sannolikt med regn, ganska kraftigt", () => {
  const d = describeWindow(summary({ symbolCodes: [19], maxPrecipProbability: 70, maxPrecipMmPerH: 0.9 }), opts);
  assert.equal(d.text, "Mycket sannolikt med regn, ganska kraftigt");
  assert.equal(d.icon, "rain");
});

test("åska får en klockslagsangivelse och slår ut allt annat", () => {
  const at = Date.parse("2026-08-17T10:30:00Z");
  const d = describeWindow(
    summary({ maxThunderProbability: 45, thunderPeakMs: at, symbolCodes: [11], maxPrecipMmPerH: 2 }),
    opts
  );
  assert.equal(d.text, "Åskväder kring 10:30");
  assert.equal(d.icon, "thunder");
});

test("blåsigt läggs till, men bara när det är värt att nämna", () => {
  const lugnt = describeWindow(summary({ symbolCodes: [4], maxGust: 5 }), opts);
  assert.equal(lugnt.text, "Halvklart och 15 grader");

  const blasigt = describeWindow(summary({ symbolCodes: [4], maxGust: 13 }), opts);
  assert.equal(blasigt.text, "Halvklart och 15 grader, men blåsigt");
});

test("intensiteten upprepas inte när symbolen redan säger lätt", () => {
  const d = describeWindow(summary({ symbolCodes: [18], maxPrecipProbability: 40, maxPrecipMmPerH: 0.3 }), opts);
  assert.equal(d.text, "Ganska sannolikt med regn, lätt");
  assert.ok(!/lätt.*lätt/.test(d.text), "får inte säga lätt två gånger");
});

test("snö och snöblandat får rätt ord och ikon", () => {
  const sno = describeWindow(
    summary({ symbolCodes: [26], maxPrecipProbability: 70, maxPrecipMmPerH: 0.6, anyFrozen: true }),
    opts
  );
  assert.equal(sno.text, "Mycket sannolikt med snö, ganska kraftigt");
  assert.equal(sno.icon, "snow");

  const slask = describeWindow(
    summary({ symbolCodes: [23], maxPrecipProbability: 70, maxPrecipMmPerH: 0.6, anyFrozen: true }),
    opts
  );
  assert.equal(slask.text, "Mycket sannolikt med snöblandat regn, ganska kraftigt");
});

test("värsta symbolen vinner ett fönster med flera", () => {
  const d = describeWindow(
    summary({ symbolCodes: [1, 3, 20], maxPrecipProbability: 65, maxPrecipMmPerH: 2.5 }),
    opts
  );
  assert.equal(d.icon, "rain");
  assert.equal(d.text, "Mycket sannolikt med regn, kraftigt");
});

test("utan symbolkod härleds ikonen ur mängden — Open-Meteo har ingen", () => {
  const d = describeWindow(summary({ symbolCodes: [], maxPrecipProbability: 55, maxPrecipMmPerH: 0.4 }), opts);
  assert.equal(d.icon, "rain");
  assert.equal(d.text, "Ganska sannolikt med regn, lätt");
});

test("inget fönster ger ingen beskrivning i stället för att kasta", () => {
  assert.equal(describeWindow(null, opts), null);
});

test("ikonen är giltig svg och okänt namn faller tillbaka", () => {
  assert.match(iconSvg("sun"), /^<svg class="wx-icon"/);
  assert.match(iconSvg("finns-inte"), /^<svg class="wx-icon"/);
});

// --- the morning card about the ride home ---------------------------------

const outlook = (level, over = {}, extra = {}) => ({
  level,
  reasons: [],
  window: summary({ fromMin: 900, toMin: 1080, ...over }),
  fromMin: 900,
  toMin: 1080,
  turnsAtMin: null,
  ...extra,
});

test("rubriken säger hur vädret är, inte vad han ska göra", () => {
  const heads = ["clear", "caution", "avoid"].map(
    (l) => describeBikeOutlook(outlook(l), opts).headline
  );
  assert.deepEqual(heads, ["Bra cykelväder hem", "Tveksamt cykelväder hem", "Dåligt cykelväder hem"]);
  for (const h of heads) assert.doesNotMatch(h, /avråd|låt bli|ta inte/i);
});

test("dåligt väder från fyra säger tiden och fönstret", () => {
  const d = describeBikeOutlook(
    outlook("avoid", { maxPrecipProbability: 85, maxPrecipMmPerH: 2.4, symbolCodes: [20] }, { turnsAtMin: 960 }),
    opts
  );
  assert.equal(d.when, "15–18");
  assert.equal(d.text, "Nästan säkert regn, kraftigt");
  assert.deepEqual(d.notes, ["Uppehåll till ca 16"]);
  assert.equal(d.icon, "rain");
});

test("spretig prognos och halka sägs öppet", () => {
  const d = describeBikeOutlook(
    outlook("avoid", { confidence: "low" }, { reasons: [{ kind: "ice", temperature: 0 }] }),
    opts
  );
  assert.ok(d.notes.includes("Risk för halka"));
  assert.ok(d.notes.some((n) => n.startsWith("Prognosen spretar")));
});

test("ingen bedömning ger inget kort", () => {
  assert.equal(describeBikeOutlook(null, opts), null);
});
