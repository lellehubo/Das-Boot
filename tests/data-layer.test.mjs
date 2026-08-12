// Run with: node --test tests/
//
// The data layer is the only thing standing between a hand-edited JSON file and a
// silently wrong ranking, so these tests care most about what it *rejects*.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadData, destinationsFor, DataError } from "../js/data-layer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Serve data/*.json from disk, optionally with edits applied, via a stubbed fetch. */
function stubFetch(overrides = {}) {
  globalThis.fetch = async (url) => {
    const name = url.replace(/^data\//, "").replace(/\.json$/, "");
    if (Object.hasOwn(overrides, name)) {
      const value = overrides[name];
      if (value === null) return { ok: false, status: 404 };
      return { ok: true, json: async () => value };
    }
    const raw = readFileSync(join(ROOT, "data", `${name}.json`), "utf8");
    return { ok: true, json: async () => JSON.parse(raw) };
  };
}

function realData(name) {
  return JSON.parse(readFileSync(join(ROOT, "data", `${name}.json`), "utf8"));
}

test("laddar och validerar de riktiga datafilerna", async () => {
  stubFetch();
  const data = await loadData();
  assert.ok(data.node("saltsjoqvarn"), "saltsjoqvarn ska finnas");
  assert.equal(data.nodeBySiteId(1442), "saltsjoqvarn");
  assert.equal(data.nodeByGid("9091001000001442"), "saltsjoqvarn");
  assert.equal(data.nodeByDestination("Nacka Strand"), "nacka_strand");
  assert.equal(data.legTime("home", "saltsjoqvarn", "walk"), 3);
});

test("gångtider fungerar i båda riktningarna", async () => {
  stubFetch();
  const data = await loadData();
  assert.equal(data.legTime("saltsjoqvarn", "home", "walk"), 3, "omvänd riktning ska ge samma tid");
});

test("linjesekvensen avgör om en tur når en brygga", async () => {
  stubFetch();
  const data = await loadData();
  const order = data.lineSequences.get("80");
  // En tur mot Ropsten som vänder vid Nacka Strand passerar aldrig Frihamnen.
  assert.ok(order.get("nacka_strand") < order.get("frihamnen_pier"));
  assert.ok(order.get("saltsjoqvarn") < order.get("nacka_strand"));
});

test("destination väljs på datum, överlapp ger flera träffar", async () => {
  stubFetch();
  const data = await loadData();
  assert.deepEqual(destinationsFor(data, "2026-08-12").map((d) => d.id), ["tegeluddsvagen_3"]);
  assert.deepEqual(destinationsFor(data, "2026-11-01").map((d) => d.id), ["hangovagen_office"]);
});

test("avvisar scenario som pekar på okänd nod", async () => {
  const scenarios = realData("scenarios");
  scenarios.scenarios[0].legs[1].to = "atlantis";
  stubFetch({ scenarios });
  await assert.rejects(loadData(), (err) => {
    assert.ok(err instanceof DataError);
    assert.match(err.message, /okänd nod "atlantis"/);
    return true;
  });
});

test("avvisar gångben utan tid i leg-times", async () => {
  const scenarios = realData("scenarios");
  scenarios.scenarios[1].legs.push({ type: "walk", from: "ropsten", to: "karlaplan" });
  stubFetch({ scenarios });
  await assert.rejects(loadData(), (err) => {
    assert.match(err.message, /ingen tid i leg-times för ropsten -> karlaplan/);
    return true;
  });
});

test("avvisar blockerat trafikslag", async () => {
  const scenarios = realData("scenarios");
  scenarios.scenarios[2].legs[3].mode = "METRO";
  stubFetch({ scenarios });
  await assert.rejects(loadData(), (err) => {
    assert.match(err.message, /trafikslaget METRO är blockerat/);
    return true;
  });
});

test("avvisar busslinje utanför allowed_bus_lines", async () => {
  const scenarios = realData("scenarios");
  scenarios.scenarios[2].legs[3].line = "76"; // ligger i candidate, inte allowed
  stubFetch({ scenarios });
  await assert.rejects(loadData(), (err) => {
    assert.match(err.message, /linje 76 \(BUS\) saknas i allowed-listan/);
    return true;
  });
});

test("avvisar icke-båtben utan restid", async () => {
  // Regression: spårvagns- och bussben behöver en transit-tid i leg-times.
  // Utan den hittade motorn ingen kandidat och scenariot föll tyst bort.
  const legTimes = realData("leg-times");
  legTimes.legs = legTimes.legs.filter(
    (l) => !(l.from === "liljevalchs" && l.to === "djurgardsbron")
  );
  stubFetch({ "leg-times": legTimes });
  await assert.rejects(loadData(), (err) => {
    assert.match(err.message, /ingen "transit"-tid .* liljevalchs -> djurgardsbron \(TRAM 7\)/);
    return true;
  });
});

test("rapporterar alla fel samtidigt, inte ett i taget", async () => {
  const scenarios = realData("scenarios");
  scenarios.scenarios[0].legs[1].to = "atlantis";
  scenarios.scenarios[1].legs[3].line = "999";
  stubFetch({ scenarios });
  await assert.rejects(loadData(), (err) => {
    assert.ok(err.problems.length >= 2, `väntade flera fel, fick ${err.problems.length}`);
    return true;
  });
});

test("saknad fil ger tydligt fel", async () => {
  stubFetch({ weights: null });
  await assert.rejects(loadData(), /weights\.json: HTTP 404/);
});
