// Turns a window summary into one short Swedish sentence and a symbol.
//
// This is the only place that names the weather. weather-score.js decides
// whether a way is worth travelling; this decides how to say what it is like
// outside. Keeping them apart means the wording can be rewritten without
// touching a single threshold.
//
// The symbol table is SMHI's own Wsymb2, copied from
// https://opendata.smhi.se/metfcst/snow1gv1/parameters — 27 codes, not guessed.
// Open-Meteo carries no symbol, so everything here degrades to a description
// derived from amount, temperature and wind alone.

/**
 * Wsymb2, verbatim from SMHI, with the wording this app uses and how bad the
 * sky looks. `rank` only orders which symbol wins a window that spans several
 * kinds of weather; it is not a severity judgement about travelling, which is
 * what weather-score.js is for.
 */
export const SYMBOLS = {
  1:  { rank: 0,  icon: "sun",      lead: "Strålande sol" },
  2:  { rank: 1,  icon: "sun",      lead: "Nästan klart" },
  3:  { rank: 2,  icon: "partly",   lead: "Växlande molnighet" },
  4:  { rank: 3,  icon: "partly",   lead: "Halvklart" },
  5:  { rank: 4,  icon: "cloud",    lead: "Molnigt" },
  6:  { rank: 5,  icon: "cloud",    lead: "Mulet" },
  7:  { rank: 6,  icon: "fog",      lead: "Dimma" },
  8:  { rank: 10, icon: "showers",  lead: "Lätta regnskurar" },
  9:  { rank: 12, icon: "showers",  lead: "Regnskurar" },
  10: { rank: 14, icon: "showers",  lead: "Kraftiga regnskurar" },
  11: { rank: 20, icon: "thunder",  lead: "Åskväder" },
  12: { rank: 10, icon: "sleet",    lead: "Lätta snöblandade skurar" },
  13: { rank: 12, icon: "sleet",    lead: "Snöblandade skurar" },
  14: { rank: 14, icon: "sleet",    lead: "Kraftiga snöblandade skurar" },
  15: { rank: 10, icon: "snow",     lead: "Lätta snöbyar" },
  16: { rank: 12, icon: "snow",     lead: "Snöbyar" },
  17: { rank: 14, icon: "snow",     lead: "Kraftiga snöbyar" },
  18: { rank: 11, icon: "rain",     lead: "Lätt regn" },
  19: { rank: 13, icon: "rain",     lead: "Regn" },
  20: { rank: 15, icon: "rain",     lead: "Kraftigt regn" },
  21: { rank: 20, icon: "thunder",  lead: "Åska" },
  22: { rank: 11, icon: "sleet",    lead: "Lätt snöblandat regn" },
  23: { rank: 13, icon: "sleet",    lead: "Snöblandat regn" },
  24: { rank: 15, icon: "sleet",    lead: "Kraftigt snöblandat regn" },
  25: { rank: 11, icon: "snow",     lead: "Lätt snöfall" },
  26: { rank: 13, icon: "snow",     lead: "Snöfall" },
  27: { rank: 15, icon: "snow",     lead: "Kraftigt snöfall" },
};

/** Inline SVG, one per icon name above. Sized by the caller's font-size. */
const PATHS = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
  partly: '<circle cx="9" cy="9.5" r="3.4"/><path d="M9 2.9v1.8M2.4 9.5h1.8M4.3 4.8l1.3 1.3M13.7 4.8l-1.3 1.3"/><path d="M8.4 19.5h8.9a3.3 3.3 0 0 0 .3-6.6 4.6 4.6 0 0 0-8.8-1 2.9 2.9 0 0 0-.4 7.6z"/>',
  cloud: '<path d="M7.4 19.5h9.9a3.6 3.6 0 0 0 .3-7.2 5 5 0 0 0-9.6-1.1 3.2 3.2 0 0 0-.6 8.3z"/>',
  fog: '<path d="M7.6 14.4h9.5a3.4 3.4 0 0 0 .3-6.8 4.8 4.8 0 0 0-9.2-1 3 3 0 0 0-.6 7.8z"/><path d="M4.5 18h15M7 21.2h10"/>',
  rain: '<path d="M7.6 14.2h9.5a3.4 3.4 0 0 0 .3-6.8 4.8 4.8 0 0 0-9.2-1 3 3 0 0 0-.6 7.8z"/><path d="M9 17.4l-1.2 3.6M13 17.4l-1.2 3.6M17 17.4l-1.2 3.6"/>',
  showers: '<path d="M7.6 13.6h9.5a3.4 3.4 0 0 0 .3-6.8 4.8 4.8 0 0 0-9.2-1 3 3 0 0 0-.6 7.8z"/><path d="M9.2 16.6l-1 2.6M13.2 16.6l-1 2.6M11.2 20.2l-.7 1.8M15.2 20.2l-.7 1.8"/>',
  sleet: '<path d="M7.6 14.2h9.5a3.4 3.4 0 0 0 .3-6.8 4.8 4.8 0 0 0-9.2-1 3 3 0 0 0-.6 7.8z"/><path d="M9 17.4l-1.2 3.6M16.4 17.6v3.4M14.7 18.4l3.4 2M18.1 18.4l-3.4 2"/>',
  snow: '<path d="M7.6 14.2h9.5a3.4 3.4 0 0 0 .3-6.8 4.8 4.8 0 0 0-9.2-1 3 3 0 0 0-.6 7.8z"/><path d="M9.4 17.6v3.4M7.7 18.4l3.4 2M11.1 18.4l-3.4 2M16.4 17.6v3.4M14.7 18.4l3.4 2M18.1 18.4l-3.4 2"/>',
  thunder: '<path d="M7.6 13.8h9.5a3.4 3.4 0 0 0 .3-6.8 4.8 4.8 0 0 0-9.2-1 3 3 0 0 0-.6 7.8z"/><path d="M13 16l-3.2 4.2h3l-1.4 3.4"/>',
};

export function iconSvg(name) {
  const d = PATHS[name] || PATHS.cloud;
  return (
    `<svg class="wx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
  );
}

/** The symbol that best represents a window covering several kinds of weather. */
function dominantSymbol(codes) {
  let best = null;
  for (const code of codes || []) {
    const entry = SYMBOLS[code];
    if (entry && (!best || entry.rank > best.rank)) best = entry;
  }
  return best;
}

function clock(ms, localMinutesOf) {
  const m = localMinutesOf(ms);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const round = (n) => Math.round(n);

/** The temperature worth quoting: the warm end, since that is what you feel. */
function degrees(summary) {
  const t = summary.maxTemperature ?? summary.minTemperature;
  return t == null ? null : `${round(t)} grader`;
}

/**
 * A plain noun for what is falling. Taken from the symbol's family rather than
 * its full wording, because "liten risk för lätt regn, lätt" says light twice —
 * the likelihood and the intensity carry that already.
 */
function precipitationNoun(icon, anyFrozen) {
  if (icon === "snow") return "snö";
  if (icon === "sleet") return "snöblandat regn";
  if (icon === "rain" || icon === "showers") return "regn";
  return anyFrozen ? "snö" : "regn";
}

/**
 * How confident the forecast is that precipitation actually arrives.
 * Deliberately coarse: the user asked for "liten risk" and "mycket sannolikt",
 * not a percentage.
 */
function likelihood(probability) {
  if (probability >= 80) return "Nästan säkert";
  if (probability >= 60) return "Mycket sannolikt med";
  if (probability >= 35) return "Ganska sannolikt med";
  if (probability >= 15) return "Liten risk för";
  return null;
}

/** Amount, said the way a person would say it. */
function intensity(mmPerH) {
  if (mmPerH >= 2) return "kraftigt";
  if (mmPerH >= 0.5) return "ganska kraftigt";
  if (mmPerH >= 0.2) return "lätt";
  return null;
}

function windClause(gust) {
  if (gust == null) return null;
  if (gust >= 18) return "mycket blåsigt";
  if (gust >= 12) return "blåsigt";
  if (gust >= 9) return "friska byar";
  return null;
}

/**
 * One short sentence describing a window, plus the symbol to draw beside it.
 *
 * Thunder outranks everything and is given a time, because knowing it passes at
 * half ten is the difference between waiting twenty minutes and getting caught
 * in it. Otherwise the sentence leads with what the sky is doing, adds how
 * likely and how hard any precipitation is, then temperature and wind if they
 * are worth a word. Returns null when there is nothing to describe.
 */
export function describeWindow(summary, { localMinutesOf }) {
  if (!summary) return null;

  const symbol = dominantSymbol(summary.symbolCodes);
  const icon = symbol ? symbol.icon : fallbackIcon(summary);

  // Thunder outranks the rest and is the one thing worth a clock time.
  if (summary.maxThunderProbability >= 20) {
    const when =
      summary.thunderPeakMs != null ? ` kring ${clock(summary.thunderPeakMs, localMinutesOf)}` : "";
    return { icon: "thunder", text: `Åskväder${when}` };
  }

  const wet = summary.maxPrecipMmPerH > 0 || summary.maxPrecipProbability >= 15;
  let text;

  if (wet) {
    const chance = likelihood(summary.maxPrecipProbability);
    const how = intensity(summary.maxPrecipMmPerH);
    text = chance
      ? `${chance} ${precipitationNoun(icon, summary.anyFrozen)}`
      : symbol
        ? symbol.lead
        : "Nederbörd";
    if (how) text += `, ${how}`;
  } else {
    text = symbol ? symbol.lead : "Uppehåll";
    const t = degrees(summary);
    if (t) text += ` och ${t}`;
  }

  const wind = windClause(summary.maxGust);
  if (wind) text += `, men ${wind}`;
  return { icon, text };
}

/** Without a symbol code the sky is unknown, so lean on what we do have. */
function fallbackIcon(summary) {
  if (summary.maxThunderProbability >= 20) return "thunder";
  if (summary.anyFrozen) return "snow";
  if (summary.maxPrecipMmPerH >= 0.2 || summary.maxPrecipProbability >= 35) return "rain";
  if (summary.maxPrecipProbability >= 15) return "showers";
  return "cloud";
}
