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
// Realtime reaches far enough ahead for the app to plan this leg yet. Distinct
// from NO_RUN: the service runs, we just cannot see that far.
export const PENDING = "pending";

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
function boatRuns(ctx, direction, board, target) {
  const table = ctx.boatLegs?.[direction]?.[ctx.dayType]?.[board] || {};
  if (!Object.keys(table).length) return () => null;
  return (scheduled) => {
    const arrival = table[scheduled]?.[target];
    return arrival ? toMinutes(arrival) : null;
  };
}

function transitCandidates(ctx, leg, fromId, toId, notBefore, isTransfer) {
  const fromNode = ctx.data.node(fromId);
  if (!fromNode) return { error: NO_RUN, reason: `Okänd hållplats ${fromId}` };
  const feed = ctx.departures.get(fromNode.site_id);
  if (!feed) return { error: NO_RUN, reason: `Inga avgångar hämtade för ${fromNode.label}` };

  // Changing services needs slack; walking from home to the first boat does not.
  const buffer = isTransfer ? ctx.weights.hard_constraints.min_transfer_buffer_minutes : 0;
  const earliest = notBefore + buffer;

  const isBoat = leg.mode === "SHIP";
  // Which timetable column to read depends on which way the boat is going.
  const direction = ctx.data.lineSequences.get(leg.line)
    ? sequenceDirection(ctx, leg.line, fromId, toId)
    : null;
  const arrivalFor = isBoat ? boatRuns(ctx, direction, fromId, toId) : null;

  const out = [];
  let sawCancelled = false;
  // Latest departure that suited this leg in every way except being early
  // enough. If that is all we have, the feed simply does not reach far enough.
  let lastUsable = null;

  for (const d of feed.departures) {
    if (d.line !== leg.line || d.mode !== leg.mode) continue;
    const scheduled = d.scheduled;
    if (!scheduled) continue;

    const departs = toMinutes(d.expected || scheduled);
    const tooEarly = forward(earliest, departs) < 0;
    if (tooEarly && arrivalFor && arrivalFor(scheduled) == null) continue;
    if (tooEarly) {
      lastUsable = lastUsable == null ? departs : Math.max(lastUsable, departs);
      continue;
    }

    const delay = toMinutes(d.expected || scheduled) - toMinutes(scheduled);
    let arrives;
    if (arrivalFor) {
      const fromTable = arrivalFor(scheduled);
      if (fromTable == null) continue; // this run does not reach the target
      // Realtime delay at the origin is assumed to carry through the leg.
      arrives = fromTable + delay;
    } else {
      const ride = ctx.data.legTime(fromId, toId, "transit");
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

    // SL returns at most about six departures per line regardless of the
    // forecast window, which on a frequent line is only twenty minutes. A leg
    // reached after a long walk can therefore fall past the end of the feed.
    // Saying "no service" there would be wrong — we simply cannot see it yet.
    if (lastUsable != null) {
      return {
        error: PENDING,
        reason: `Realtiden räcker bara till ${toClock(lastUsable)} här`,
      };
    }

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

export const TO_WORK = "to_work";
export const TO_HOME = "to_home";

/**
 * The same scenario read backwards: legs in reverse order with their ends
 * swapped. Walking home from the boat is the same walk as walking to it, and the
 * boat simply sails the other way, which sequenceDirection works out on its own.
 *
 * Written as a transform rather than a second set of scenarios so there is one
 * list to maintain. If an afternoon route genuinely differs from its morning
 * mirror, give it its own scenario with `direction: "to_home"`.
 *
 * The label cannot be mirrored the way the legs can: "båten till Allmänna
 * gränd, cykel därifrån" describes the morning in the wrong order for the trip
 * home, where the bike comes first. So a scenario carries `label_home` for the
 * way back and falls back to the morning wording when it has none.
 */
function reverse(scenario) {
  return {
    ...scenario,
    label: scenario.label_home || scenario.label,
    legs: scenario.legs
      .slice()
      .reverse()
      .map((leg) => ({ ...leg, from: leg.to, to: leg.from })),
  };
}

/**
 * Plan one scenario. Returns null when the scenario does not serve `destination`
 * or does not apply in this direction. A scenario that cannot run comes back with
 * `broken` set and a reason, so the UI can say why instead of dropping it.
 *
 * `ctx.direction` is TO_WORK or TO_HOME. For TO_HOME the scenario is mirrored and
 * `$destination` marks where the journey starts rather than where it ends.
 */
export function planScenario(scenario, destination, ctx) {
  if (!scenario.destinations.includes(destination.id)) return null;
  if (scenario.status === "dormant") return null;

  const direction = ctx.direction || TO_WORK;
  if (scenario.direction && scenario.direction !== direction) return null;
  const plan_ = direction === TO_HOME ? reverse(scenario) : scenario;

  const legs = [];
  let clock = ctx.now;
  let leaveAt = null;
  let waiting = 0;
  let transfers = -1;
  let uncalibrated = false;

  for (const leg of plan_.legs) {
    const from = leg.from === "$destination" ? destination.node : leg.from;
    const to = leg.to === "$destination" ? destination.node : leg.to;

    if (leg.type === "walk" || leg.type === "bike") {
      const minutes = ctx.data.legTime(from, to, leg.type);
      if (minutes == null) {
        return broken(plan_, NO_RUN, `Ingen ${leg.type}-tid för ${from} → ${to}`);
      }
      if (!ctx.data.legIsCalibrated(from, to)) uncalibrated = true;
      legs.push({ type: leg.type, from, to, minutes, start: clock, end: clock + minutes });
      clock += minutes;
      continue;
    }

    transfers++;
    const result = transitCandidates(ctx, leg, from, to, clock, transfers > 0);
    if (result.error) return broken(plan_, result.error, result.reason);

    const pick = result.candidates[0];
    // Time between arriving at the stop and the service leaving. At the first
    // stop this is not waiting: the leave-home time is derived from this
    // departure, so you leave later instead of standing on the pier.
    const wait = pick.departs - clock;
    if (transfers > 0) waiting += wait;
    legs.push({
      type: "transit",
      from,
      to,
      mode: leg.mode,
      line: leg.line,
      wait: transfers > 0 ? wait : 0,
      start: pick.departs,
      end: pick.arrives,
      minutes: pick.arrives - pick.departs,
      scheduled: pick.scheduled,
      delay: pick.delay,
      destination: pick.destination,
    });

    // Leave-home time is fixed by the first transit leg: walk backwards from it.
    if (leaveAt === null) {
      const before = legs
        .filter((l) => l.type !== "transit")
        .reduce((sum, l) => sum + l.minutes, 0);
      leaveAt = pick.departs - before;
    }
    clock = pick.arrives;
  }

  return {
    id: scenario.id,
    label: plan_.label,
    requiresBike: scenario.requires_bike === true,
    untested: scenario.status === "untested",
    uncalibrated,
    legs,
    leaveAt,
    arrive: clock,
    travelMinutes: clock - (leaveAt ?? ctx.now),
    waiting,
    transfers: Math.max(0, transfers),
    broken: null,
  };
}

// Callers pass the direction-correct plan, so `scenario.label` here is already
// the return wording when the trip home is the one being planned.
function broken(scenario, code, reason) {
  return {
    id: scenario.id,
    label: scenario.label,
    requiresBike: scenario.requires_bike === true,
    untested: scenario.status === "untested",
    legs: [],
    leaveAt: null,
    arrive: null,
    broken: { code, reason },
  };
}

/**
 * Which way the commute runs at this time of day. Mornings start at home,
 * afternoons at work; the user can override in the UI.
 */
export function defaultDirection(minutesIntoDay) {
  return minutesIntoDay < 12 * 60 ? TO_WORK : TO_HOME;
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

  // Working plans first by arrival, then ones we cannot see far enough to plan,
  // then genuinely broken ones. A pending plan is not a failure, so it should not
  // sit among the cancellations.
  const rank = (p) => (!p.broken ? 0 : p.broken.code === PENDING ? 1 : 2);
  return plans.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return rank(a) === 0 ? a.arrive - b.arrive : 0;
  });
}
