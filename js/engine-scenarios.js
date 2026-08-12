// Engine A: evaluate the hand-written scenarios against today's departures.
//
// This is the default engine. It does not search for routes — it walks a fixed
// list of ways the user already likes and works out which of them run right now
// and when he has to leave home to catch each one.
//
// The answer the app exists to give is the leave-home time, and that depends only
// on the first transit departure minus the walking legs before it. Arrival time
// only affects ranking.

export const NO_RUN = "no_run";
export const CANCELLED = "cancelled";
export const MISSED = "missed";

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function toClock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Minute difference, treating a large negative as tomorrow rather than the past. */
function forward(from, to) {
  const d = to - from;
  return d < -720 ? d + 1440 : d;
}

/**
 * Boat runs from `origin` that actually reach `target`.
 *
 * A run heading for Ropsten that turns at Nacka Strand never passes Frihamnen, so
 * matching on direction alone would keep boats that never arrive. The timetable's
 * departure->arrival pairs only contain runs that call at both stops, which makes
 * reachability fall out of the data instead of needing a rule.
 */
function boatRuns(ctx, direction, target) {
  const table = ctx.boatLegs?.[direction]?.[ctx.dayType] || {};
  return (scheduled) => {
    const arrival = table[scheduled]?.[target];
    return arrival ? toMinutes(arrival) : null;
  };
}

function transitCandidates(ctx, leg, notBefore, destinationNode, isTransfer) {
  const fromNode = ctx.data.node(leg.from);
  const feed = ctx.departures.get(fromNode.site_id);
  if (!feed) return { error: NO_RUN, reason: `Inga avgångar hämtade för ${fromNode.label}` };

  // Changing services needs slack; walking from home to the first boat does not.
  const buffer = isTransfer ? ctx.weights.hard_constraints.min_transfer_buffer_minutes : 0;
  const earliest = notBefore + buffer;

  const toId = leg.to === "$destination" ? destinationNode : leg.to;
  const isBoat = leg.mode === "SHIP";
  // Which timetable column to read depends on which way the boat is going.
  const direction = ctx.data.lineSequences.get(leg.line)
    ? sequenceDirection(ctx, leg.line, leg.from, toId)
    : null;
  const arrivalFor = isBoat ? boatRuns(ctx, direction, toId) : null;

  const out = [];
  let sawCancelled = false;

  for (const d of feed.departures) {
    if (d.line !== leg.line || d.mode !== leg.mode) continue;
    const scheduled = d.scheduled;
    if (!scheduled) continue;

    const departs = toMinutes(d.expected || scheduled);
    if (forward(earliest, departs) < 0) continue;

    const delay = toMinutes(d.expected || scheduled) - toMinutes(scheduled);
    let arrives;
    if (arrivalFor) {
      const fromTable = arrivalFor(scheduled);
      if (fromTable == null) continue; // this run does not reach the target
      // Realtime delay at the origin is assumed to carry through the leg.
      arrives = fromTable + delay;
    } else {
      const ride = ctx.data.legTime(leg.from, toId, "transit");
      if (ride == null) continue;
      arrives = departs + ride;
    }

    if (d.cancelled) {
      sawCancelled = true;
      continue;
    }

    out.push({
      departs,
      arrives,
      scheduled,
      expected: d.expected,
      delay,
      destination: d.destination,
      journeyId: d.journeyId,
      line: d.line,
      mode: d.mode,
    });
  }

  out.sort((a, b) => a.departs - b.departs);
  if (!out.length) {
    if (sawCancelled) return { error: CANCELLED, reason: "Turen är inställd" };
    const what = leg.mode === "SHIP" ? "båt" : leg.mode === "TRAM" ? "spårvagn" : "tur";
    return { error: NO_RUN, reason: `Ingen ${what} som når målet` };
  }
  return { candidates: out };
}

/** Which way along the line we are travelling, as a key into the leg table. */
function sequenceDirection(ctx, line, fromId, toId) {
  const order = ctx.data.lineSequences.get(line);
  if (!order) return null;
  const a = order.get(fromId);
  const b = order.get(toId);
  if (a == null || b == null) return null;
  return b > a ? "ropsten" : "nybroplan";
}

/**
 * Plan one scenario. Returns null when the scenario does not serve `destination`.
 * A scenario that cannot run today comes back with `broken` set and a reason, so
 * the UI can say why instead of silently dropping it.
 */
export function planScenario(scenario, destination, ctx) {
  if (!scenario.destinations.includes(destination.id)) return null;
  if (scenario.status === "dormant") return null;

  const legs = [];
  let clock = ctx.now;
  let leaveHome = null;
  let waiting = 0;
  let transfers = -1;
  let uncalibrated = false;

  for (const leg of scenario.legs) {
    const from = leg.from === "$destination" ? destination.node : leg.from;
    const to = leg.to === "$destination" ? destination.node : leg.to;

    if (leg.type === "walk" || leg.type === "bike") {
      const minutes = ctx.data.legTime(from, to, leg.type);
      if (minutes == null) {
        return broken(scenario, NO_RUN, `Ingen ${leg.type}-tid för ${from} → ${to}`);
      }
      if (!ctx.data.legIsCalibrated(from, to)) uncalibrated = true;
      legs.push({ type: leg.type, from, to, minutes, start: clock, end: clock + minutes });
      clock += minutes;
      continue;
    }

    transfers++;
    const result = transitCandidates(ctx, leg, clock, destination.node, transfers > 0);
    if (result.error) return broken(scenario, result.error, result.reason);

    const pick = result.candidates[0];
    const wait = pick.departs - clock;
    waiting += wait;
    legs.push({
      type: "transit",
      from,
      to,
      mode: leg.mode,
      line: leg.line,
      wait,
      start: pick.departs,
      end: pick.arrives,
      minutes: pick.arrives - pick.departs,
      scheduled: pick.scheduled,
      delay: pick.delay,
      destination: pick.destination,
    });

    // Leave-home time is fixed by the first transit leg: walk backwards from it.
    if (leaveHome === null) {
      const before = legs
        .filter((l) => l.type !== "transit")
        .reduce((sum, l) => sum + l.minutes, 0);
      leaveHome = pick.departs - before;
    }
    clock = pick.arrives;
  }

  return {
    id: scenario.id,
    label: scenario.label,
    requiresBike: scenario.requires_bike === true,
    untested: scenario.status === "untested",
    uncalibrated,
    legs,
    leaveHome,
    arrive: clock,
    travelMinutes: clock - (leaveHome ?? ctx.now),
    waiting,
    transfers: Math.max(0, transfers),
    broken: null,
  };
}

function broken(scenario, code, reason) {
  return {
    id: scenario.id,
    label: scenario.label,
    requiresBike: scenario.requires_bike === true,
    untested: scenario.status === "untested",
    legs: [],
    leaveHome: null,
    arrive: null,
    broken: { code, reason },
  };
}

/**
 * Plan every scenario for a destination.
 * Working ones sort by arrival time; broken ones fall to the bottom.
 * Scoring comes in phase 4 — this is arrival order only.
 */
export function planAll(destination, ctx) {
  const plans = ctx.data.scenarios.scenarios
    .map((s) => planScenario(s, destination, ctx))
    .filter(Boolean);

  const max = ctx.weights.hard_constraints.max_total_minutes;
  for (const plan of plans) {
    if (!plan.broken && plan.travelMinutes > max) {
      plan.broken = { code: NO_RUN, reason: `Längre än ${max} min` };
    }
  }

  return plans.sort((a, b) => {
    if (a.broken && !b.broken) return 1;
    if (!a.broken && b.broken) return -1;
    if (a.broken && b.broken) return 0;
    return a.arrive - b.arrive;
  });
}
