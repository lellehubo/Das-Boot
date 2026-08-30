// The passport booth's proxy.
//
// One endpoint. It holds the API key, builds the prompt, calls Nano Banana Pro
// four times in parallel and hands the images back. It never stores an image,
// and it never logs one either — only statuses and reasons.
//
//   POST /passfoto   { "image": "<base64 jpeg, no prefix>" }
//   200              { "images": ["<base64 png>", ...] }
//   error            { "error": { "code": "...", "message": "..." } }
//
// Four separate calls rather than one call asking for four images: the results
// come out more even, and a single failure costs one frame instead of the strip.

const MODEL = "gemini-3-pro-image";
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SHOTS = 4;
const MAX_BYTES = 8 * 1024 * 1024;   // ~8 MB of base64
const HOURLY_CAP = 10;               // calls per IP per hour
const UPSTREAM_TIMEOUT = 90_000;

const PROMPT = [
  "Retuschera detta porträtt till ett passfoto taget i studio.",
  "Behåll personens ansikte exakt, samma drag, samma ålder, samma hudton,",
  "samma frisyr, samma glasögon om sådana finns. Ändra ingenting i ansiktet.",
  "Byt bakgrunden till en jämn ljusgrå yta utan struktur och utan slagskuggor.",
  "Belys ansiktet mjukt och jämnt framifrån, inga hårda skuggor under näsa eller",
  "haka, inga blanka reflexer. Huvudet rakt framifrån, axlarna raka, neutralt",
  "ansiktsuttryck, båda ögonen öppna och synliga. Beskär till stående",
  "passfotoformat med huvudet centrerat och ungefär tre fjärdedelar av",
  "bildhöjden från hakan till hjässan. Fotografisk skärpa, ingen skönhetsretusch,",
  "ingen utslätning av hud.",
].join(" ");

// One line apart, so the strip is something to choose from: two a touch warmer,
// two strictly neutral.
const VARIANTS = [
  "Ljuset får vara aningen varmare än neutralt.",
  "Ljuset får vara aningen varmare än neutralt.",
  "Vitbalansen ska vara strikt neutral.",
  "Vitbalansen ska vara strikt neutral.",
];

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://lellehubo.github.io")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ────────────────────────────────── cors ────────────────────────────────── */

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
  if (origin && ALLOWED.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;   // named, never a wildcard
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "content-type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function send(body: unknown, httpStatus: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function fail(httpStatus: number, code: string, message: string, origin: string | null) {
  return send({ error: { code, message } }, httpStatus, origin);
}

/* ─────────────────────────────── rate limit ─────────────────────────────── */
// Deliberately coarse: it lives in the isolate, not in a table, so it resets
// when the isolate does. That is enough to stop a thoughtless loop, and not
// meant to stop anyone determined.

const seen = new Map<string, number[]>();

function allow(ip: string): boolean {
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const times = (seen.get(ip) ?? []).filter((t) => t > hourAgo);
  if (times.length >= HOURLY_CAP) {
    seen.set(ip, times);
    return false;
  }
  times.push(now);
  seen.set(ip, times);
  if (seen.size > 5000) {
    for (const [key, t] of seen) if (!t.some((x) => x > hourAgo)) seen.delete(key);
  }
  return true;
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/* ──────────────────────────────── the model ──────────────────────────────── */

type Outcome = { image: string } | { error: string };

async function oneImage(key: string, image: string, variant: string): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: image } },
            { text: `${PROMPT} ${variant}` },
          ],
        }],
        generationConfig: { imageConfig: { aspectRatio: "3:4" } },
      }),
    });
  } catch (e) {
    console.error("upstream call failed:", (e as Error).name);
    return { error: "upstream" };
  }

  if (!res.ok) {
    console.error("upstream status", res.status, (await res.text()).slice(0, 400));
    return { error: res.status === 429 ? "upstream_rate" : "upstream" };
  }

  let data: any;
  try { data = await res.json(); }
  catch { return { error: "upstream" }; }

  if (data?.promptFeedback?.blockReason) {
    console.error("model blocked the prompt:", data.promptFeedback.blockReason);
    return { error: "refused" };
  }

  const candidate = data?.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline?.data) return { image: inline.data };
  }

  console.error("no image part in the answer, finishReason:", candidate?.finishReason);
  return { error: "refused" };
}

/* ──────────────────────────────── the run ──────────────────────────────── */

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return fail(405, "method_not_allowed", "Bara POST.", origin);
  }
  if (origin && !ALLOWED.includes(origin)) {
    return fail(403, "forbidden", "Ursprunget är inte tillåtet.", origin);
  }

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) {
    return fail(413, "too_large", "Bilden är för stor.", origin);
  }

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    console.error("GEMINI_API_KEY is not set");
    return fail(500, "misconfigured", "Proxyn saknar api-nyckel.", origin);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return fail(400, "bad_request", "Kroppen är inte json.", origin); }

  const image = typeof body?.image === "string" ? body.image.trim() : "";
  if (!image) return fail(400, "bad_request", "Fältet image saknas.", origin);
  if (image.length > MAX_BYTES) return fail(413, "too_large", "Bilden är för stor.", origin);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(image)) {
    return fail(400, "bad_request", "Fältet image är inte base64.", origin);
  }

  if (!allow(clientIp(req))) {
    return fail(429, "rate_limited", "För många anrop den här timmen.", origin);
  }

  const outcomes = await Promise.all(
    VARIANTS.slice(0, SHOTS).map((v) => oneImage(key, image, v)),
  );

  // A partly filled strip beats an empty one, so anything that came back wins.
  const images = outcomes.flatMap((o) => ("image" in o ? [o.image] : []));
  if (images.length > 0) return send({ images }, 200, origin);

  const first = outcomes.find((o) => "error" in o) as { error: string } | undefined;
  if (first?.error === "refused") {
    return fail(422, "refused", "Modellen framkallade inte bilden.", origin);
  }
  if (first?.error === "upstream_rate") {
    return fail(429, "rate_limited", "Modellen är överbelastad just nu.", origin);
  }
  return fail(502, "upstream", "Modellen svarade inte.", origin);
});
