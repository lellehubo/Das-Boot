# Passfotoautomaten

A photo booth in a browser tab: it looks like a Scandinavian booth from the
sixties, and it turns a selfie into four passport photos. The page is static and
lives on Pages at `/passfoto/`; a small proxy holds the API key and calls Nano
Banana Pro.

Everything the page does is in `index.html` — no build step, no framework, no
dependencies. The booth's materials are CSS: teak from three stacked
`repeating-linear-gradient` layers plus a vignette, steel from hard light stops
and an inset shadow, and one lamp bar whose brightness every other surface reads
from a single custom property. The lamp is the only thing that animates.

## Running it without a proxy

Open the page and it works as a camera: countdown, flash, capture, and the raw
shot handed back to download. That is step four of the build order, and it stays
useful — if the proxy is down or unset, you still get the picture you took.

## The proxy

`proxy/supabase/functions/passfoto/index.ts` is one endpoint. It rejects anything
but POST, caps the body at ~8 MB, answers CORS only for the origins you name, and
allows ten calls per IP per hour. The prompt lives here rather than in the page,
so it can be tuned without touching the site.

Deploy it from `passfoto/proxy/`:

    supabase functions deploy passfoto --no-verify-jwt
    supabase secrets set GEMINI_API_KEY=...
    supabase secrets set ALLOWED_ORIGINS=https://lellehubo.github.io

`ALLOWED_ORIGINS` is a comma-separated list and defaults to
`https://lellehubo.github.io`. There is no wildcard anywhere in the file, on
purpose. The rate limit lives in the isolate rather than in a table, so it resets
when the isolate does — enough to stop a thoughtless loop, not a determined one.

Test it against a saved photo before wiring up the page:

    base64 -w0 selfie.jpg > shot.b64
    printf '{"image":"%s"}' "$(cat shot.b64)" > body.json
    curl -sS -X POST "$FUNCTION_URL" \
      -H 'content-type: application/json' \
      -H "origin: https://lellehubo.github.io" \
      --data @body.json | head -c 300

Then point the page at it, either by filling in `BUILTIN_PROXY` in `index.html`
or, on your own phone, by opening the page once with
`?proxy=https://…/functions/v1/passfoto`. That address is kept in `localStorage`,
and only `https:` is accepted.

Four calls go out in parallel rather than one call asking for four images: the
results come out more even, and one failure costs a single frame instead of the
strip. Two variants ask for slightly warmer light, two for strictly neutral white
balance, so there is something to choose between.

## What comes back

The four frames land on a strip below the booth. Tapping one puts it beside the
original, which is the only way to catch the failure the app cannot detect for
you: image models move eye spacing, nose width and the line of the jaw, and for a
passport photo that is disqualifying. The arrow on each frame downloads it. On
iOS, Safari will not download a data URL, so the page says to press and hold
instead.

Google's image models carry SynthID in what they generate. It is invisible, it is
there, and it can be detected. Many authorities reject retouched or AI-processed
photos outright, and Swedish passports are photographed at the police station
anyway, so this is a tool for visa applications, membership cards and forms —
check the requirements for the document you are actually filling in.

## The three open questions, and what they were answered with

- **Does the strip survive a reload?** No. It lives in memory and goes when the
  page does. Nothing about a face is written to storage; the only thing kept is
  the proxy address.
- **A mode for children and pets?** No — strict passport photos only. The guide,
  the crop and the prompt all assume one adult head at 72 % of the frame.
- **Sound on the countdown?** Yes. Ticks and a shutter clack, synthesised in
  WebAudio so there is no file to load, and a `LJUD` switch on the pictogram
  plate to turn them off.

## The icon

`tools/passfoto-icon.py` draws `icon-192.png` and `icon-512.png` from the same
colour tokens the app uses. Re-run it after changing them; it needs nothing but
the standard library.
