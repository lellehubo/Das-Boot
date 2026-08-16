// Forecast clients for the Jobbet view: SMHI first, Open-Meteo as a fallback.
//
// The one thing to know before touching this file: SMHI's precipitation is an
// accumulation over intervalParametersStartTime -> time, not a rate. That span
// is one hour for roughly the first two days and then widens to six and twelve,
// so a raw amount means nothing until it is divided by its own interval.
// Everything leaving this module is already normalised to mm/h.
//
// The old pmp3g version 2 was withdrawn on 31 March 2026 and returns 404.
// snow1g has a flat timeSeries[].data{} and `time` where pmp3g had a parameters
// array and `validTime`. If an example suggests pmp3g it predates the cutover.
//
// Weather is an addition, never a dependency: nothing here throws outward. Every
// failure ends as a stale entry or null so the departure board keeps rendering.

const CACHE = new Map();
const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 2000;

/** Instantaneous fields are valid at `time`; accumulated ones cover the interval. */
function step(startMs, endMs, fields) {
  const spanHours = Math.max((endMs - startMs) / 3_600_000, 1 / 60);
  return { startMs, endMs, spanHours, ...fields };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * SNOW1gv1 -> normalised hours.
 *
 * Median rather than mean, because the ensemble mean smooths a shower away: a
 * step can read mean 0.1 while its own max is 0.9. Min and max are kept so the
 * scoring layer can see how far apart the members are.
 *
 * symbol_code is passed through unmapped on purpose. The official code table
 * lives at https://opendata.smhi.se/metfcst/snow1gv1/parameters and belongs in
 * the UI layer as an explicit mapping. Do not guess the meanings here.
 */
function normaliseSmhi(body) {
  const hours = [];
  for (const entry of body.timeSeries || []) {
    const endMs = Date.parse(entry.time);
    if (!Number.isFinite(endMs)) continue;
    const startedAt = entry.intervalParametersStartTime;
    const startMs = startedAt ? Date.parse(startedAt) : endMs - 3_600_000;
    const d = entry.data || {};

    const spanHours = Math.max((endMs - startMs) / 3_600_000, 1 / 60);
    const rate = (mm) => (num(mm) == null ? null : num(mm) / spanHours);
    // median is the headline figure; mean is only a stand-in for older captures.
    const median = num(d.precipitation_amount_median) ?? num(d.precipitation_amount_mean);

    hours.push(
      step(startMs, endMs, {
        temperature: num(d.air_temperature),
        windSpeed: num(d.wind_speed),
        windGust: num(d.wind_speed_of_gust),
        precipProbability: num(d.probability_of_precipitation),
        precipMmPerH: rate(median),
        precipMinMmPerH: rate(d.precipitation_amount_min),
        precipMaxMmPerH: rate(d.precipitation_amount_max),
        frozenPart: num(d.precipitation_frozen_part),
        thunderProbability: num(d.thunderstorm_probability),
        symbolCode: num(d.symbol_code),
      })
    );
  }
  hours.sort((a, b) => a.startMs - b.startMs);
  return hours;
}

/**
 * Open-Meteo -> normalised hours.
 *
 * `precipitation` is already mm for the preceding hour, so the rate is the value
 * itself. There is no ensemble here, which is why the scoring layer marks this
 * source `unknown` rather than inferring a confidence from a spread of zero.
 */
function normaliseOpenMeteo(body) {
  const h = body.hourly || {};
  const times = h.time || [];
  const hours = [];
  for (let i = 0; i < times.length; i++) {
    // timezone=UTC returns "2026-08-16T10:00" with no zone designator.
    const raw = String(times[i]);
    const endMs = Date.parse(raw.endsWith("Z") ? raw : `${raw}:00Z`.replace(/(:\d\d):00Z$/, "$1Z"));
    if (!Number.isFinite(endMs)) continue;
    hours.push(
      step(endMs - 3_600_000, endMs, {
        temperature: num(h.temperature_2m?.[i]),
        windSpeed: num(h.wind_speed_10m?.[i]),
        windGust: num(h.wind_gusts_10m?.[i]),
        precipProbability: num(h.precipitation_probability?.[i]),
        precipMmPerH: num(h.precipitation?.[i]),
        precipMinMmPerH: null,
        precipMaxMmPerH: null,
        frozenPart: null,
        thunderProbability: null,
        symbolCode: null,
      })
    );
  }
  hours.sort((a, b) => a.startMs - b.startMs);
  return hours;
}

function url(template, { lat, lon }) {
  // SMHI rejects more than six decimals and wants longitude before latitude;
  // the template carries the order, this only has to keep the precision.
  const fix = (n) => String(Number(n.toFixed(6)));
  return template.replace("{lat}", fix(lat)).replace("{lon}", fix(lon));
}

async function getJson(target) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target, { cache: "no-store", signal: control.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function cacheKey(source, point) {
  return `wx:${source}:${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
}

/** Age in ms of a cached forecast, or Infinity. Lets the UI show how old it is. */
export function ageOf(key) {
  const hit = CACHE.get(key);
  return hit ? Date.now() - hit.at : Infinity;
}

export function clearCache() {
  CACHE.clear();
}

/**
 * Forecast for one point, preferring SMHI.
 *
 * SMHI gets a second attempt after a short pause before Open-Meteo is tried,
 * because a single 5xx from opendata is common and switching source costs the
 * ensemble spread. When every source fails the last good answer is returned
 * with `stale` set; only a cold cache yields null, and the caller hides the
 * module rather than showing an error.
 */
export async function forecast(point, weather, { now = Date.now() } = {}) {
  const key = cacheKey("smhi", point);
  const ttl = (weather.cache_ttl_minutes ?? 30) * 60_000;
  const hit = CACHE.get(key);
  if (hit && now - hit.at < ttl) return hit.value;

  const attempts = [
    () => getJson(url(weather.endpoint, point)),
    async () => {
      await wait(RETRY_DELAY_MS);
      return getJson(url(weather.endpoint, point));
    },
  ];

  for (const attempt of attempts) {
    try {
      const body = await attempt();
      const hours = normaliseSmhi(body);
      if (!hours.length) throw new Error("tom timeSeries");
      return remember(key, {
        source: "smhi",
        referenceTime: body.referenceTime ?? null,
        point,
        hours,
      });
    } catch (e) {
      console.warn(`väder: SMHI misslyckades (${e.message})`);
    }
  }

  try {
    const body = await getJson(url(weather.fallback_endpoint, point));
    const hours = normaliseOpenMeteo(body);
    if (!hours.length) throw new Error("tom hourly");
    return remember(key, {
      source: "open-meteo",
      referenceTime: null,
      point,
      hours,
    });
  } catch (e) {
    console.warn(`väder: Open-Meteo misslyckades (${e.message})`);
  }

  // Both sources down. Stale data beats no data — the age is carried so the UI
  // can say how old it is instead of implying it is current.
  if (hit) {
    const staleAfter = (weather.stale_after_hours ?? 6) * 3_600_000;
    return { ...hit.value, stale: true, ageMs: now - hit.at, tooOld: now - hit.at > staleAfter };
  }
  return null;
}

function remember(key, value) {
  const stored = { ...value, stale: false, ageMs: 0, tooOld: false, fetchedAt: Date.now() };
  CACHE.set(key, { at: stored.fetchedAt, value: stored });
  return stored;
}

/** Seed the cache from a fixture, so tests and the console can skip the network. */
export function useFixture(point, body, { source = "smhi" } = {}) {
  const hours = source === "smhi" ? normaliseSmhi(body) : normaliseOpenMeteo(body);
  return remember(cacheKey("smhi", point), {
    source,
    referenceTime: body.referenceTime ?? null,
    point,
    hours,
  });
}

export const _internals = { normaliseSmhi, normaliseOpenMeteo, url };
