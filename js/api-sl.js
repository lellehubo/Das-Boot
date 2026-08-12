// SL Transport and Deviations clients.
//
// All SL endpoints are key-free and send Access-Control-Allow-Origin: *, so this
// runs straight from GitHub Pages with no proxy.
//
// Deliberately absent: the Journey Planner incl_mot_* parameters. They are
// documented but ignored by the API — incl_mot_2=false still returns Tunnelbana,
// and incl_mot_2=0 fails validation with "expected type Boolean". Filtering by
// mode or line must happen in client code. Do not reintroduce them.

const TRANSPORT = "https://transport.integration.sl.se/v1";
const DEVIATIONS = "https://deviations.integration.sl.se/v1";

const DEPARTURES_TTL = 20_000;
const DEVIATIONS_TTL = 60_000; // fair use allows one call per minute

const cache = new Map();

async function cached(key, ttl, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fetcher();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Age in ms of a cached entry, or Infinity. Used to mark stale data in the UI. */
export function ageOf(key) {
  const hit = cache.get(key);
  return hit ? Date.now() - hit.at : Infinity;
}

function hhmm(iso) {
  return iso ? String(iso).slice(11, 16) : null;
}

/**
 * Departures from one site.
 *
 * `forecast` is in minutes but the API also caps the result at roughly six
 * departures per line, so a larger window does not return more runs. That cap is
 * why arrival times come from the timetable rather than from matching journey ids
 * across two stops: for a 38-minute leg the two windows barely overlap.
 */
export async function departures(siteId, { forecast = 120 } = {}) {
  const key = `dep:${siteId}:${forecast}`;
  return cached(key, DEPARTURES_TTL, async () => {
    const res = await fetch(`${TRANSPORT}/sites/${siteId}/departures?forecast=${forecast}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`departures ${siteId}: HTTP ${res.status}`);
    const body = await res.json();
    return {
      departures: (body.departures || []).map((d) => ({
        journeyId: d.journey?.id,
        line: d.line?.designation,
        mode: d.line?.transport_mode,
        destination: d.destination || "",
        directionCode: d.direction_code,
        scheduled: hhmm(d.scheduled),
        expected: hhmm(d.expected),
        cancelled: d.state === "CANCELLED",
        state: d.state,
        deviations: d.deviations || [],
      })),
      stopDeviations: body.stop_deviations || [],
    };
  });
}

/**
 * Deviation messages for several sites in one call.
 * Fair use does not allow one request per stop.
 */
export async function deviations(siteIds, modes = ["SHIP", "BUS", "TRAM"]) {
  const params = [
    "future=false",
    ...siteIds.map((id) => `site=${id}`),
    ...modes.map((m) => `transport_mode=${m}`),
  ].join("&");
  const key = `dev:${params}`;
  return cached(key, DEVIATIONS_TTL, async () => {
    const res = await fetch(`${DEVIATIONS}/messages?${params}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`deviations: HTTP ${res.status}`);
    const now = Date.now();
    return (await res.json())
      .filter((m) => {
        const from = m.publish?.from ? Date.parse(m.publish.from) : -Infinity;
        const upto = m.publish?.upto ? Date.parse(m.publish.upto) : Infinity;
        return from <= now && now <= upto;
      })
      .map((m) => {
        const variant =
          (m.message_variants || []).find((v) => v.language === "sv") ||
          (m.message_variants || [])[0] ||
          {};
        return {
          id: m.deviation_case_id,
          // Only importance_level is meaningful for sorting; ignore the other two.
          importance: m.priority?.importance_level ?? 0,
          header: variant.header || "",
          details: variant.details || "",
          lines: (m.scope?.lines || []).map((l) => l.designation),
          stopAreas: (m.scope?.stop_areas || []).map((s) => s.id),
        };
      })
      .sort((a, b) => b.importance - a.importance);
  });
}

export const DEPARTURES_CACHE_KEY = (siteId, forecast = 120) => `dep:${siteId}:${forecast}`;
