// Loads and validates the four hand-edited data files.
//
// These files belong to the user, not to the app: they are edited by hand and the
// app never writes to them. A typo in scenarios.json must therefore fail loudly at
// load time rather than quietly producing a wrong ranking further down.

const FILES = ["stops", "leg-times", "scenarios", "weights"];

export class DataError extends Error {
  constructor(problems) {
    super(`Datafel:\n  ${problems.join("\n  ")}`);
    this.name = "DataError";
    this.problems = problems;
  }
}

async function fetchJson(base, name) {
  const url = `${base}${name}.json`;
  let res;
  try {
    res = await fetch(url, { cache: "no-cache" });
  } catch (e) {
    throw new Error(`${url}: kunde inte hämtas (${e.message})`);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${url}: ogiltig JSON (${e.message})`);
  }
}

/** Index leg-times.json by "from>to" so lookups don't scan the array. */
function indexLegTimes(legTimes) {
  const index = new Map();
  for (const leg of legTimes.legs) index.set(`${leg.from}>${leg.to}`, leg);
  return index;
}

/** Look up a walk/bike leg. Legs are stored one way but are valid in both. */
function findLeg(index, from, to) {
  return index.get(`${from}>${to}`) || index.get(`${to}>${from}`) || null;
}

/**
 * Position of each stop along a line, plus which direction_code means "forward"
 * along that order.
 *
 * The order alone answers whether a run reaches a stop. The code is what lets a
 * leg reject services running the other way: line and mode alone match a 67
 * towards Blockhusudden just as happily as one towards Karlaplan, and those are
 * opposite journeys from the same stop.
 */
function indexLineSequences(stops) {
  const sequences = new Map();
  for (const [line, spec] of Object.entries(stops.line_sequences || {})) {
    const order = new Map();
    spec.stops.forEach((node, i) => order.set(node, i));
    sequences.set(line, { order, forwardDirectionCode: spec.forward_direction_code ?? null });
  }
  return sequences;
}

function validate(data, legIndex) {
  const problems = [];
  const { stops, scenarios, weights } = data;
  const nodeExists = (id) => Object.hasOwn(stops.nodes, id);

  for (const [id, node] of Object.entries(stops.nodes)) {
    if (node.type === "stop" && node.site_id != null && node.gid == null)
      problems.push(`stops.${id}: har site_id men saknar gid`);
    if (node.corridor && !Object.hasOwn(stops.corridors, node.corridor))
      problems.push(`stops.${id}: okänd korridor "${node.corridor}"`);
  }

  for (const [line, order] of Object.entries(stops.line_sequences || {}))
    for (const node of order.stops)
      if (!nodeExists(node)) problems.push(`line_sequences.${line}: okänd nod "${node}"`);

  for (const [name, node] of Object.entries(stops.destination_aliases || {}))
    if (name !== "note" && !nodeExists(node))
      problems.push(`destination_aliases["${name}"]: okänd nod "${node}"`);

  const destinationIds = new Set();
  for (const dest of scenarios.destinations) {
    destinationIds.add(dest.id);
    if (!nodeExists(dest.node)) problems.push(`destination ${dest.id}: okänd nod "${dest.node}"`);
  }

  const allowed = {
    SHIP: weights.hard_constraints.allowed_ship_lines,
    TRAM: weights.hard_constraints.allowed_tram_lines,
    BUS: weights.hard_constraints.allowed_bus_lines,
  };

  for (const scenario of scenarios.scenarios) {
    const where = `scenario ${scenario.id}`;
    for (const id of scenario.destinations)
      if (!destinationIds.has(id)) problems.push(`${where}: okänd destination "${id}"`);

    let transfers = 0;
    for (const [i, leg] of scenario.legs.entries()) {
      const at = `${where} ben ${i + 1}`;
      for (const end of ["from", "to"]) {
        const ref = leg[end];
        if (ref !== "$destination" && !nodeExists(ref))
          problems.push(`${at}: okänd nod "${ref}"`);
      }

      if (leg.type === "transit") {
        transfers++;
        if (weights.hard_constraints.blocked_modes.includes(leg.mode))
          problems.push(`${at}: trafikslaget ${leg.mode} är blockerat`);
        else if (allowed[leg.mode] && !allowed[leg.mode].includes(leg.line))
          problems.push(`${at}: linje ${leg.line} (${leg.mode}) saknas i allowed-listan`);

        // Boat legs get per-departure arrivals from boat-legs.json. Everything
        // else needs a ride time here, or the engine silently drops the leg.
        if (leg.mode !== "SHIP" && leg.to !== "$destination" && leg.from !== "$destination") {
          const ride = findLeg(legIndex, leg.from, leg.to);
          if (!ride || ride.transit == null)
            problems.push(
              `${at}: ingen "transit"-tid i leg-times för ${leg.from} -> ${leg.to} (${leg.mode} ${leg.line})`
            );
        }
      } else if (leg.type === "walk" || leg.type === "bike") {
        // $destination expands per destination, so those legs are checked below.
        if (leg.to !== "$destination" && leg.from !== "$destination") {
          const found = findLeg(legIndex, leg.from, leg.to);
          if (!found) problems.push(`${at}: ingen tid i leg-times för ${leg.from} -> ${leg.to}`);
          else if (found[leg.type] == null)
            problems.push(`${at}: leg-times saknar "${leg.type}" för ${leg.from} -> ${leg.to}`);
        }
      } else {
        problems.push(`${at}: okänd bentyp "${leg.type}"`);
      }
    }

    if (transfers - 1 > weights.hard_constraints.max_transfers)
      problems.push(`${where}: ${transfers - 1} byten överskrider max_transfers`);

    // Every destination the scenario claims to serve must have times for its legs.
    for (const destId of scenario.destinations) {
      const dest = scenarios.destinations.find((d) => d.id === destId);
      if (!dest) continue;
      for (const [i, leg] of scenario.legs.entries()) {
        if (leg.type !== "walk" && leg.type !== "bike") continue;
        const from = leg.from === "$destination" ? dest.node : leg.from;
        const to = leg.to === "$destination" ? dest.node : leg.to;
        if (from !== dest.node && to !== dest.node) continue;
        const found = findLeg(legIndex, from, to);
        if (!found)
          problems.push(`${where} ben ${i + 1}: ingen tid för ${from} -> ${to} (${destId})`);
        else if (found[leg.type] == null)
          problems.push(`${where} ben ${i + 1}: saknar "${leg.type}" för ${from} -> ${to} (${destId})`);
      }
    }
  }

  if (problems.length) throw new DataError(problems);
}

/**
 * Load the four data files. Throws DataError listing every problem found, so a
 * broken file reports all its faults at once rather than one per reload.
 */
export async function loadData(base = "data/") {
  const loaded = await Promise.all(FILES.map((name) => fetchJson(base, name)));
  const data = {
    stops: loaded[0],
    legTimes: loaded[1],
    scenarios: loaded[2],
    weights: loaded[3],
  };

  const legIndex = indexLegTimes(data.legTimes);
  validate(data, legIndex);

  const bySiteId = new Map();
  const byGid = new Map();
  for (const [id, node] of Object.entries(data.stops.nodes)) {
    if (node.site_id != null) bySiteId.set(node.site_id, id);
    if (node.gid) byGid.set(node.gid, id);
  }

  return {
    ...data,
    legIndex,
    lineSequences: indexLineSequences(data.stops),
    node: (id) => data.stops.nodes[id],
    nodeBySiteId: (siteId) => bySiteId.get(siteId),
    nodeByGid: (gid) => byGid.get(gid),
    nodeByDestination: (name) => data.stops.destination_aliases[name],
    legTime: (from, to, type) => {
      const leg = findLeg(legIndex, from, to);
      return leg ? leg[type] ?? null : null;
    },
    legIsCalibrated: (from, to) => {
      const leg = findLeg(legIndex, from, to);
      return leg ? leg.calibrated === true : false;
    },
  };
}

/** Pick the destination valid on `isoDate`; returns all matches so overlaps stay visible. */
export function destinationsFor(data, isoDate) {
  return data.scenarios.destinations.filter(
    (d) => (!d.valid_from || d.valid_from <= isoDate) && (!d.valid_to || isoDate <= d.valid_to)
  );
}
