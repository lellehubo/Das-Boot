// Turns a forecast into one verdict per plan: is this a way to travel right now.
//
// Everything meteorological stops here. The view gets a level, machine-readable
// reasons and the summary they came from, and never touches a threshold itself.
//
// Three things in this file are deliberate and easy to get wrong on a rewrite:
//
//   1. The window is derived, not configured. The engine already knows exactly
//      when each walk or ride happens, so asking for "07:00-09:00" would throw
//      away precision the app already has. The only fixed window left is the
//      return one, because at breakfast the afternoon boat has not been chosen.
//
//   2. Spread tightens the verdict, it never loosens it. A low median with a
//      high max is scattered showers, which is a reason to leave the bike, not
//      a reason to hedge. Treating spread as model uncertainty and relaxing the
//      threshold would make the app quietest exactly when it should speak up.
//
//   3. Times convert once, here, through the zone database. No fixed offsets:
//      the afternoon window has to survive the March and October switches.

export const CLEAR = "clear";
export const CAUTION = "caution";
export const AVOID = "avoid";

const SEVERITY = { [CLEAR]: 0, [CAUTION]: 1, [AVOID]: 2 };

const STOCKHOLM = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function localParts(ms) {
  const parts = {};
  for (const p of STOCKHOLM.formatToParts(ms)) parts[p.type] = p.value;
  return {
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Zone offset in effect at an instant, read from the zone rather than assumed. */
function offsetAt(ms) {
  const { iso, minutes } = localParts(ms);
  return Date.parse(`${iso}T00:00:00Z`) + minutes * 60_000 - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant a local wall-clock time falls on.
 *
 * Guessing the offset from the naive time and then re-reading it at the guess
 * settles the hour that DST adds or removes; a single pass lands an hour out on
 * the two switch days a year.
 */
export function instantOf(isoDate, minutes) {
  const naive = Date.parse(`${isoDate}T00:00:00Z`) + minutes * 60_000;
  const first = naive - offsetAt(naive);
  return naive - offsetAt(first);
}

/** Local minutes into the day for an instant. Exported for the view's labels. */
export function localMinutesOf(ms) {
  return localParts(ms).minutes;
}

/**
 * Summarise the forecast across one local window.
 *
 * A step counts when its interval overlaps the window at all, because SMHI's
 * accumulations are stamped with the interval's *end*: the 07:00-08:00 hour
 * arrives as time=08:00. Filtering on that stamp alone would read the wrong
 * hour at both edges.
 *
 * Returns null for a window with no data, which includes one wholly in the past.
 */
export function summariseWindow(forecast, isoDate, fromMin, toMin) {
  if (!forecast?.hours?.length || !(toMin > fromMin)) return null;
  const from = instantOf(isoDate, fromMin);
  const to = instantOf(isoDate, toMin);

  const steps = forecast.hours.filter((h) => h.endMs > from && h.startMs < to);
  if (!steps.length) return null;

  let maxPrecipProbability = 0;
  let maxPrecipMmPerH = 0;
  let totalPrecipMm = 0;
  let spreadMmPerH = 0;
  let maxGust = 0;
  let minTemperature = Infinity;
  let maxThunderProbability = 0;
  let anyFrozen = false;
  let sawSpread = false;
  let maxStepHours = 0;
  // Presentation needs a little more than scoring does: the warm end of the
  // range, which symbols occurred, and when the thunder peaks. Collected here
  // rather than re-walked in the view, but left uninterpreted — naming the
  // weather is the phrase layer's job, not this one's.
  let maxTemperature = -Infinity;
  const symbolCodes = [];
  let thunderPeakMs = null;

  for (const h of steps) {
    maxStepHours = Math.max(maxStepHours, h.spanHours);
    const overlapHours = (Math.min(h.endMs, to) - Math.max(h.startMs, from)) / 3_600_000;
    if (h.precipProbability != null)
      maxPrecipProbability = Math.max(maxPrecipProbability, h.precipProbability);
    if (h.precipMmPerH != null) {
      maxPrecipMmPerH = Math.max(maxPrecipMmPerH, h.precipMmPerH);
      totalPrecipMm += h.precipMmPerH * overlapHours;
    }
    if (h.precipMaxMmPerH != null && h.precipMinMmPerH != null) {
      sawSpread = true;
      spreadMmPerH = Math.max(spreadMmPerH, h.precipMaxMmPerH - h.precipMinMmPerH);
    }
    if (h.windGust != null) maxGust = Math.max(maxGust, h.windGust);
    if (h.temperature != null) {
      minTemperature = Math.min(minTemperature, h.temperature);
      maxTemperature = Math.max(maxTemperature, h.temperature);
    }
    if (h.thunderProbability != null) {
      if (h.thunderProbability > maxThunderProbability) thunderPeakMs = h.endMs;
      maxThunderProbability = Math.max(maxThunderProbability, h.thunderProbability);
    }
    if (h.frozenPart != null && h.frozenPart > 0) anyFrozen = true;
    if (h.symbolCode != null) symbolCodes.push(h.symbolCode);
  }

  return {
    isoDate,
    fromMin,
    toMin,
    steps: steps.length,
    maxPrecipProbability,
    maxPrecipMmPerH,
    totalPrecipMm,
    spreadMmPerH,
    maxGust,
    minTemperature: Number.isFinite(minTemperature) ? minTemperature : null,
    maxTemperature: Number.isFinite(maxTemperature) ? maxTemperature : null,
    maxThunderProbability,
    thunderPeakMs,
    symbolCodes,
    anyFrozen,
    maxStepHours,
    source: forecast.source,
    stale: forecast.stale === true,
    confidence: confidenceOf(spreadMmPerH, maxPrecipMmPerH, sawSpread),
  };
}

/**
 * How tightly the ensemble agrees, as a ratio of spread to peak rate.
 *
 * A source with no ensemble reports `unknown` rather than a flattering "high":
 * a spread of zero because nobody measured it is not agreement.
 */
export function confidenceOf(spread, peak, sawSpread, spreadCfg = {}) {
  if (!sawSpread) return "unknown";
  const ratio = spread / Math.max(peak, 0.1);
  if (ratio < (spreadCfg.medium_ratio ?? 0.5)) return "high";
  if (ratio < (spreadCfg.high_ratio ?? 1.5)) return "medium";
  return "low";
}

/**
 * Grade one window. Every satisfied rule is reported, and the view picks which
 * to say out loud — the logic does not decide what matters most.
 */
export function verdictOf(summary, weather) {
  if (!summary) return null;
  const t = weather.thresholds;
  const reasons = [];
  let level = CLEAR;

  const raise = (to, reason) => {
    reasons.push(reason);
    if (SEVERITY[to] > SEVERITY[level]) level = to;
  };

  // Beyond roughly two days SMHI's steps widen to six and twelve hours, and a
  // chance of rain across half a day says nothing about a quarter-hour walk.
  // Where the steps are that coarse the probability may still speak, but only
  // as far as caution. Amount, gust and ice are unaffected: they measure how
  // much weather there is, not the odds of it catching you.
  const coarse = summary.maxStepHours > (weather.max_trusted_step_hours ?? 3);
  const probAvoid = coarse ? Infinity : t.precip_probability_avoid;
  const probCaution = coarse ? t.precip_probability_avoid : t.precip_probability_caution;

  if (summary.maxPrecipProbability >= probAvoid)
    raise(AVOID, { kind: "precipitation", probability: summary.maxPrecipProbability, amount: summary.totalPrecipMm });
  else if (summary.maxPrecipProbability >= probCaution)
    raise(CAUTION, {
      kind: "precipitation",
      probability: summary.maxPrecipProbability,
      amount: summary.totalPrecipMm,
      coarse: coarse || undefined,
    });

  if (summary.maxPrecipMmPerH >= t.precip_mm_per_h_avoid)
    raise(AVOID, { kind: "precipitation", rate: summary.maxPrecipMmPerH, amount: summary.totalPrecipMm });
  else if (summary.maxPrecipMmPerH >= t.precip_mm_per_h_caution)
    raise(CAUTION, { kind: "precipitation", rate: summary.maxPrecipMmPerH, amount: summary.totalPrecipMm });

  if (summary.maxGust >= t.gust_avoid) raise(AVOID, { kind: "gust", speed: summary.maxGust });
  else if (summary.maxGust >= t.gust_caution) raise(CAUTION, { kind: "gust", speed: summary.maxGust });

  if (summary.anyFrozen && summary.minTemperature != null && summary.minTemperature <= t.ice_temp_max)
    raise(AVOID, { kind: "ice", temperature: summary.minTemperature });

  if (summary.maxThunderProbability >= t.thunder_probability_caution)
    raise(CAUTION, { kind: "thunder", probability: summary.maxThunderProbability });

  // Scattered showers: the members disagree because some of them are wet. That
  // lifts a clear window to caution, and stops there — advising against a ride
  // should still take an actual likelihood, not just disagreement.
  if (level === CLEAR && summary.confidence === "low" && weather.spread?.escalates_clear_to_caution)
    raise(CAUTION, { kind: "spread", spread: summary.spreadMmPerH, peak: summary.maxPrecipMmPerH });

  return { level, reasons, window: summary };
}

/**
 * When a plan puts you outdoors, and for how long.
 * Boat and bus legs are not exposure — you can sit inside.
 */
export function exposureOf(plan, weather) {
  if (!plan || plan.broken || !plan.legs?.length) return null;
  const types = weather.exposed_leg_types || [];
  const legs = plan.legs.filter((l) => types.includes(l.type));
  if (!legs.length) return null;
  return {
    minutes: legs.reduce((sum, l) => sum + l.minutes, 0),
    fromMin: Math.min(...legs.map((l) => l.start)),
    toMin: Math.max(...legs.map((l) => l.end)),
    types: [...new Set(legs.map((l) => l.type))],
  };
}

/**
 * The verdict for one plan, including the inheritance rule.
 *
 * Going to work on a bike, the morning is graded no better than the afternoon:
 * the bike stays at the office all day, so a dry departure that ends in a soaked
 * ride home is not a clear morning. `inheritedFrom` is set when the afternoon is
 * what decided it, so the view can say why without guessing.
 *
 * Walking does not inherit. You leave no shoes at work.
 */
export function verdictForPlan(plan, { weather, isoDate, forecast, returnForecast, direction }) {
  const exposure = exposureOf(plan, weather);
  if (!exposure) return null;
  if (exposure.minutes < (weather.min_exposed_minutes_to_apply ?? 0)) return null;

  const own = verdictOf(summariseWindow(forecast, isoDate, exposure.fromMin, exposure.toMin), weather);
  if (!own) return null;

  const result = {
    planId: plan.id,
    direction,
    level: own.level,
    reasons: own.reasons,
    window: own.window,
    exposure,
    inheritedFrom: null,
  };

  const inherits = (weather.inheritance?.applies_to_leg_types || []).some((t) =>
    exposure.types.includes(t)
  );
  if (!inherits || direction !== "to_work") return result;

  const back = weather.return_window_hours;
  if (!back || !returnForecast) return result;
  const evening = verdictOf(
    summariseWindow(returnForecast, isoDate, back.from * 60, back.to * 60),
    weather
  );
  if (!evening) return result;

  if (SEVERITY[evening.level] > SEVERITY[result.level]) {
    result.level = evening.level;
    result.reasons = evening.reasons;
    result.inheritedFrom = evening.window;
  }
  return result;
}

/**
 * Weather verdicts for every plan, keyed by plan id.
 * Broken plans are skipped: there is no point grading a boat that is cancelled.
 */
export function verdictsFor(plans, ctx) {
  const out = new Map();
  for (const plan of plans) {
    if (plan.broken) continue;
    const verdict = verdictForPlan(plan, ctx);
    if (verdict) out.set(plan.id, verdict);
  }
  return out;
}

/**
 * Re-rank plans with the weather taken into account.
 *
 * Weather can only reorder, never remove: choosing to ride in the rain is the
 * user's call to make. A disruption still outranks a wet ride, so the existing
 * broken/pending order is untouched and the penalty only separates plans that
 * are otherwise equally available.
 *
 * Three keys, in order. The verdict comes first, because avoid should never sort
 * above caution however brief it is. Then, and only when the weather is actually
 * against you, the exposed minutes: steady rain grades every route the same, so
 * without this the list never moved on exactly the day the advice was worth
 * having. Arrival time settles the rest, and remains the only key on a fine day
 * — twelve minutes in the sun is not better than thirty.
 *
 * Pure: the input array and its plans are not modified.
 */
const exposedMinutes = (p) => p.weather?.exposure?.minutes ?? 0;

export function applyWeather(plans, verdicts, weather) {
  const scale = weather.penalty || { avoid: 2, caution: 1, clear: 0 };
  const scored = plans.map((plan) => {
    const verdict = verdicts.get(plan.id) || null;
    return { ...plan, weather: verdict, weatherPenalty: verdict ? scale[verdict.level] ?? 0 : 0 };
  });

  const rank = (p) => (!p.broken ? 0 : p.broken.code === "pending" ? 1 : 2);
  return scored.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (rank(a) !== 0) return 0;
    const byWeather = a.weatherPenalty - b.weatherPenalty;
    if (byWeather !== 0) return byWeather;
    // Equal verdicts and a penalty to pay: least time outdoors wins.
    if (a.weatherPenalty > 0) {
      const byExposure = exposedMinutes(a) - exposedMinutes(b);
      if (byExposure !== 0) return byExposure;
    }
    return a.arrive - b.arrive;
  });
}

/**
 * Where to ask about the weather. Home is a fixed node; work is whichever
 * destination is valid today, which is not a constant — the office moves from
 * Tegeluddsvägen to Hangövägen on 1 October 2026, and a hard-coded coordinate
 * would go quietly wrong that morning.
 */
export function pointsFor(data, destination) {
  const at = (id) => {
    const node = data.node(id);
    return node && node.lat != null ? { lat: node.lat, lon: node.lon, label: node.label } : null;
  };
  return { home: at("home"), work: at(destination.node) };
}
