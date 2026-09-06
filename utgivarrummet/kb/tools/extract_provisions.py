#!/usr/bin/env python3
"""
extract_provisions.py — bygger seed/provisions.json ur lagtexterna i kb/sources.

Varje post innehåller den ORDAGRANNA texten ur källfilen plus källhänvisning (source_id,
locator). Egna kommentarer ligger i fältet au_relevans och är märkta som tolkning.
Körs utan nät:  python3 kb/tools/extract_provisions.py
"""
import json, re, sys, pathlib, datetime

KB = pathlib.Path(__file__).resolve().parents[1]
SRC = KB / "sources"
OUT = KB / "seed" / "provisions.json"
OUT_MD = KB / "seed" / "provisions.md"
TODAY = datetime.date.today().isoformat()

# ---------------------------------------------------------------------------
# Urval. "*" = alla paragrafer i kapitlet. None som kapitel = kapitellös lag.
# Kommentarerna (au_relevans) är tolkning, inte källtext.
# ---------------------------------------------------------------------------
SPEC = [
    # --- Tryckfrihetsförordningen
    ("sfs-1949-105-tryckfrihetsforordning", 1, "*", "Tryckfrihetens grunder: syfte, censurförbud, exklusivitet, meddelar- och anskaffarfrihet (1:7), instruktionen om att hellre fria än fälla (1:10 i ny numrering, kontrollera)."),
    ("sfs-1949-105-tryckfrihetsforordning", 3, "*", "Anonymitetsskydd: tystnadsplikt för utgivare och redaktion (3:3), efterforskningsförbud (3:4/3:5), repressalieförbud, undantag."),
    ("sfs-1949-105-tryckfrihetsforordning", 7, "*", "Brottskatalogen: vilka gärningar som alls kan vara tryckfrihetsbrott (förtal, förolämpning, hets mot folkgrupp, olaga hot, spioneri m.fl.) samt meddelar- och anskaffarbrott. YGL 5 kap. hänvisar hit."),
    ("sfs-1949-105-tryckfrihetsforordning", 8, "*", "Ansvarskedjan: utgivarens ensamansvar och när ansvaret går vidare."),
    ("sfs-1949-105-tryckfrihetsforordning", 9, "*", "Tillsyn och åtal: JK som ensam åklagare, åtalsfrister (preskription)."),
    ("sfs-1949-105-tryckfrihetsforordning", 11, "*", "Skadestånd på grund av tryckfrihetsbrott och vem som svarar."),
    ("sfs-1949-105-tryckfrihetsforordning", 12, "*", "Rättegången: jury, tryckfrihetsmål, instruktionen till domstolen."),
    ("sfs-1949-105-tryckfrihetsforordning", 14, "*", "Allmänna bestämmelser, bland annat definitioner och tillämpning."),
    # --- Yttrandefrihetsgrundlagen
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 1, "*", "Tillämpningsområde: tv, radio, databaser, utgivningsbevis, databasregeln, meddelar- och anskaffarfrihet i YGL, redaktionell självständighet."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 2, "*", "Anonymitetsskydd i YGL (motsvarar TF 3 kap.)."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 3, "*", "Sändningsfrihet, villkor för tillstånd, redaktionellt oberoende och genmäle/beriktigande i tillståndsvillkor."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 4, "*", "Utgivare: skyldighet att ha utgivare, utgivarens befogenheter, ställföreträdare."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 5, "*", "Yttrandefrihetsbrott (hänvisning till TF 7 kap.), meddelar- och anskaffarbrott."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 6, "*", "Ansvarighet: utgivarens ensamansvar för program och databaser."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 7, "*", "Tillsyn, åtal och särskilda tvångsmedel: JK, åtalsfrister."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 8, "*", "Skadestånd."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 9, "*", "Rättegången i yttrandefrihetsmål."),
    ("sfs-1991-1469-yttrandefrihetsgrundlag", 11, "*", "Allmänna bestämmelser."),
    # --- Brottsbalken
    ("sfs-1962-700-brottsbalk", 4, ["6 a", "6 b", "6 c", "6 d", "7", "9 a", "9 c", "11"], "Kränkande fotografering (6 a), olovlig identitetsanvändning (6 b), olaga integritetsintrång (6 c), grovt (6 d), ofredande (7), olovlig avlyssning (9 a), dataintrång (9 c), åtalsregler (11)."),
    ("sfs-1962-700-brottsbalk", 5, "*", "Ärekränkning: förtal (5:1), grovt förtal (5:2), förolämpning (5:3), förtal av avliden (5:4), åtalsregler (5:5)."),
    ("sfs-1962-700-brottsbalk", 16, ["8", "10 a", "10 c", "10 d"], "Hets mot folkgrupp (16:8), barnpornografibrott (16:10 a), olaga våldsskildring (16:10 c), otillåtet förfarande med pornografisk bild (16:10 d)."),
    ("sfs-1962-700-brottsbalk", 19, ["5", "6", "6 a", "6 b", "7", "8", "9"], "Spioneri, utlandsspioneri (i kraft 2023), obehörig befattning med hemlig uppgift, vårdslöshet med hemlig uppgift."),
    ("sfs-1962-700-brottsbalk", 20, ["3"], "Brott mot tystnadsplikt."),
    # --- Radio- och tv-lagen
    ("sfs-2010-696-radio-och-tv-lag", 1, "*", "Lagens innehåll och tillämpningsområde, svensk jurisdiktion."),
    ("sfs-2010-696-radio-och-tv-lag", 3, "*", "Definitioner: tv-sändning, beställ-tv, leverantör av medietjänster, reklam, sponsring, produktplacering."),
    ("sfs-2010-696-radio-och-tv-lag", 4, "*", "Tillstånd för tv: villkor (saklighet, opartiskhet, genmäle, beriktigande, mediets genomslagskraft). OBS: TV4 lämnade marknätet 2026-01-12, se notes."),
    ("sfs-2010-696-radio-och-tv-lag", 5, "*", "Innehållet i tv-sändningar: demokratiska värden och privatlivet (5:1), skydd av barn (5:2), beriktigande, genmäle, tillgänglighet."),
    ("sfs-2010-696-radio-och-tv-lag", 6, "*", "Produktplacering."),
    ("sfs-2010-696-radio-och-tv-lag", 7, "*", "Sponsring."),
    ("sfs-2010-696-radio-och-tv-lag", 8, "*", "Reklam och andra annonser: annonsmarkering, reklamtid, barnreklam, otillbörligt gynnande."),
    ("sfs-2010-696-radio-och-tv-lag", 16, "*", "Granskning och tillsyn: Granskningsnämnden, anmälningar, vad som granskas."),
    ("sfs-2010-696-radio-och-tv-lag", 17, "*", "Särskild avgift."),
    ("sfs-2010-696-radio-och-tv-lag", 18, "*", "Återkallelse av tillstånd och andra sanktioner."),
    # --- Upphovsrättslagen
    ("sfs-1960-729-lag", 1, ["1", "2", "3", "4", "9"], "Verkshöjd och skyddade verk, ekonomisk och ideell rätt, allmänna handlingar och författningar utan skydd (9 §)."),
    ("sfs-1960-729-lag", 2, ["11", "22", "23", "24", "25", "26", "26 a"], "Inskränkningar: citaträtt (22 §), konstverk i kritisk framställning (23 §), dagshändelser i tv (25 §), offentliga debatter m.m. (26 §)."),
    ("sfs-1960-729-lag", 5, ["48 a", "49", "49 a"], "Korta utdrag från evenemang (48 a §), fotografisk bild (49 a §)."),
    ("sfs-1960-729-lag", 7, ["53", "54"], "Intrång, straff och ersättning."),
    # --- Dataskyddslagen
    ("sfs-2018-218-lag", 1, "*", "Förhållandet till TF/YGL och undantaget för journalistiska ändamål (1 kap. 7 §)."),
    # --- Skadeståndslagen
    ("sfs-1972-207-skadestandslag", 2, ["3"], "Kränkningsersättning vid brott."),
    ("sfs-1972-207-skadestandslag", 3, ["4"], "Statens ansvar vid överträdelse av Europakonventionen (grunden i Vaccindokumentären, HD T 9218-24)."),
    ("sfs-1972-207-skadestandslag", 5, ["6"], "Bestämmande av kränkningsersättning."),
    # --- Kamerabevakningslagen
    ("sfs-2018-1200-kamerabevakningslag", None, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "15", "16"], "Tillämpningsområde och undantag (bl.a. journalistik), tillståndsplikt, upplysningsplikt."),
    # --- Rättegångsbalken
    ("sfs-1942-740-rattegangsbalk", 5, ["1", "9"], "Offentlighet vid domstolsförhandling, foto- och inspelningsförbud i rättssalen (5:9)."),
    ("sfs-1942-740-rattegangsbalk", 23, ["18", "21", "21 a"], "Insyn i förundersökningen, protokoll, offentliggörande."),
    ("sfs-1942-740-rattegangsbalk", 27, ["2"], "Beslagsförbud för handlingar som omfattas av tystnadsplikt enligt TF/YGL."),
    ("sfs-1942-740-rattegangsbalk", 36, ["5"], "Vittnesförbud: den som har tystnadsplikt enligt TF 3 kap. och YGL 2 kap."),
    # --- Offentlighets- och sekretesslagen (urval för publiceringsbeslut)
    ("sfs-2009-400-offentlighets-och-sekretesslag", 10, ["14"], "Förbehåll vid utlämnande."),
    ("sfs-2009-400-offentlighets-och-sekretesslag", 18, ["1"], "Förundersökningssekretess till skydd för det allmänna."),
    ("sfs-2009-400-offentlighets-och-sekretesslag", 21, ["1", "3", "7"], "Sekretess för hälsa och sexualliv, för förföljda personer, personuppgifter i strid med dataskydd."),
    ("sfs-2009-400-offentlighets-och-sekretesslag", 25, ["1"], "Hälso- och sjukvårdssekretess."),
    ("sfs-2009-400-offentlighets-och-sekretesslag", 26, ["1"], "Socialtjänstsekretess."),
    ("sfs-2009-400-offentlighets-och-sekretesslag", 35, ["1", "12", "13"], "Förundersökningssekretess till skydd för enskild, uppgifter om målsägande i sexualbrottsmål m.m."),
    # --- Meddelarskydd i vissa enskilda verksamheter
    ("sfs-2017-151-lag", None, "*", "Meddelarskydd för anställda i offentligt finansierad privat vård, skola och omsorg."),
    # --- Geografisk information (drönare)
    ("sfs-2016-319-lag", None, "*", "Spridningstillstånd för flygbilder och geografisk information (drönare)."),
]

EU_SPEC = [
    ("emfa-2024-1083", ["4", "5", "6", "7", "17", "18", "20", "22", "25"], "EMFA: medietjänstleverantörers rättigheter (4), källskydd och spionprogram (4/6), plattformars hantering av medieinnehåll (18), mediekoncentration (22), statlig annonsering (25)."),
    ("gdpr-2016-679", ["4", "6", "9", "17", "85"], "GDPR: definitioner, rättslig grund, känsliga uppgifter, radering, journalistikundantaget i art. 85."),
    ("dsa-2022-2065", ["14", "16", "17", "20", "23"], "DSA: villkor, anmälningsmekanismer, motivering vid borttagning, klagomål, missbruk."),
    ("avmsd-2010-13", ["6", "6a", "9", "10", "11", "28b"], "AV-direktivet: hets, skydd av minderåriga, reklam, sponsring, produktplacering, videodelningsplattformar."),
    ("antislapp-2024-1069", ["1", "2", "3", "4", "5", "11", "12", "13", "14", "15", "16"], "Anti-SLAPP-direktivet: tillämpningsområde, definitioner, avvisning av uppenbart ogrundade anspråk, skydd mot rättegångsmissbruk."),
]

CONVENTION_SPEC = [
    ("sfs-2018-1197-lag", ["3", "12", "13", "16", "17", "19", "34", "36", "40"], "Barnkonventionen: barnets bästa (3), rätt att bli hörd (12), yttrandefrihet (13), privatliv (16), massmedier (17), skydd (19, 34, 36), barn i rättsprocess (40)."),
]

# ---------------------------------------------------------------------------
def read_source(sid: str):
    for d in ("statutes", "eu"):
        p = SRC / d / f"{sid}.md"
        if p.exists():
            txt = p.read_text(encoding="utf-8")
            m = re.match(r"^---\n(.*?)\n---\n\n?", txt, re.S)
            fm = {}
            if m:
                for line in m.group(1).split("\n"):
                    if ":" in line:
                        k, v = line.split(":", 1); fm[k.strip()] = v.strip().strip('"')
                txt = txt[m.end():]
            return fm, txt.replace("\xa0", " ")
    raise FileNotFoundError(sid)

PAR_RE = re.compile(r"^(\d+ ?[a-z]?) §$")
KAP_RE = re.compile(r"^(\d+ ?[a-z]?) kap\.\s+([A-ZÅÄÖ][^§]*)$")   # rubrik, aldrig korshänvisning med §
AMEND_RE = re.compile(r"^(Lag|Förordning) \(\d{4}:\d+\)\.?$")

def parse_statute(body: str):
    """→ dict[(kap|None, par)] = {heading, text, amendment, kap_title}. kap är str ('5', '9 a') eller None."""
    lines = body.split("\n")
    stop = len(lines)
    for i, l in enumerate(lines):
        if l.strip() == "Övergångsbestämmelser":
            stop = i; break
    L = lines[:stop]; n = len(L)
    out, kap, kap_title, cur, heading, buf, pending = {}, None, "", None, "", [], ""
    def next_nonempty(i):
        j = i + 1
        while j < n and not L[j].strip(): j += 1
        return j
    def flush():
        if cur is not None:
            am = [x.strip() for x in buf if AMEND_RE.match(x.strip())]
            out[(kap, cur)] = {"heading": heading, "text": "\n".join(buf).strip(),
                               "amendment": am[-1] if am else "", "kap_title": kap_title}
    i = 0
    while i < n:
        s = L[i].strip()
        km = KAP_RE.match(s)
        if km:
            flush(); cur = None; buf = []
            kap, kap_title = km.group(1).replace("  ", " "), km.group(2).strip(); pending = ""
            i += 1; continue
        pm = PAR_RE.match(s)
        if pm:
            flush(); cur = pm.group(1); buf = []; heading = pending; pending = ""
            i += 1; continue
        j = next_nonempty(i)
        if (s and j < n and (PAR_RE.match(L[j].strip()) or KAP_RE.match(L[j].strip()))
                and len(s) < 90 and s[0].isupper() and not s.endswith((".", ",", ";", ":", ")"))
                and not AMEND_RE.match(s) and not re.match(r"^\d", s)):
            pending = s; i += 1; continue
        if cur is not None: buf.append(L[i])
        i += 1
    flush()
    if any(k[0] is None for k in out) and any(k[0] not in (None, "1") for k in out):
        out = {(("1" if k[0] is None else k[0]), k[1]): v for k, v in out.items()}
    for v in out.values():
        ls = v["text"].split("\n"); keep = []
        for idx, l in enumerate(ls):
            st = l.strip()
            if st == ".": continue
            if idx + 1 < len(ls) and 0 < len(st) < 5 and ls[idx+1].strip().startswith(st): continue
            keep.append(l)
        v["text"] = "\n".join(keep).strip()
    return out

def norm_par(p: str) -> str:
    return re.sub(r"\s+", " ", p.strip())

def parse_eu(body: str):
    lines = body.split("\n"); arts = {}; cur = None; buf = []; title = ""
    for l in lines:
        s = l.strip()
        m = re.match(r"^Artikel\s+(\d+[a-z]?)$", s)
        if m:
            if cur: arts[cur] = {"heading": title, "text": "\n".join(buf).strip()}
            cur = m.group(1); buf = []; title = ""; continue
        if cur and re.match(r"^(KAPITEL|AVSNITT|BILAGA)\b", s):
            arts[cur] = {"heading": title, "text": "\n".join(buf).strip()}; cur = None; continue
        if cur:
            if not title and s: title = s
            else: buf.append(l)
    if cur: arts[cur] = {"heading": title, "text": "\n".join(buf).strip()}
    return arts

def parse_convention(body: str):
    lines = body.split("\n"); arts = {}; cur = None; buf = []
    for l in lines:
        s = l.strip()
        m = re.match(r"^(?:Artikel|Article) (\d+)$", s)
        if m:
            if cur and cur not in arts: arts[cur] = "\n".join(buf).strip()
            cur = m.group(1); buf = []; continue
        if cur:
            if re.match(r"^(DEL|Del) [IVX]+", s) or s.startswith("Bilaga"):
                if cur not in arts: arts[cur] = "\n".join(buf).strip()
                cur = None; continue
            buf.append(l)
    if cur and cur not in arts: arts[cur] = "\n".join(buf).strip()
    return arts

# ---------------------------------------------------------------------------
records, problems = [], []
for sid, kap, pars, note in SPEC:
    fm, body = read_source(sid)
    parsed = parse_statute(body)
    kapk = None if kap is None else str(kap)
    keys = [k for k in parsed if k[0] == kapk] if pars == "*" else [(kapk, norm_par(p)) for p in pars]
    if not keys:
        problems.append(f"{sid}: inga paragrafer hittade för kap {kap}")
    for k in keys:
        if k not in parsed:
            problems.append(f"{sid}: {k[0]} kap. {k[1]} § saknas i källtexten"); continue
        e = parsed[k]
        locator = (f"{k[0]} kap. {k[1]} §" if k[0] else f"{k[1]} §")
        records.append({
            "id": f"{sid}::{locator.replace(' ', '')}",
            "source_id": sid, "statute": fm.get("title", sid), "sfs": fm.get("sfs", ""),
            "amended_through": fm.get("amended_through", ""), "locator": locator,
            "kap": (int(k[0]) if k[0] and k[0].isdigit() else k[0]), "kap_title": e["kap_title"], "par": k[1], "heading": e["heading"],
            "text": e["text"], "amendment": e["amendment"],
            "au_relevans": note, "verification_status": fm.get("verification_status", "unknown"),
            "extracted_at": TODAY,
        })

for sid, arts, note in EU_SPEC:
    fm, body = read_source(sid)
    parsed = parse_eu(body)
    for a in arts:
        if a not in parsed:
            problems.append(f"{sid}: artikel {a} saknas"); continue
        records.append({"id": f"{sid}::art{a}", "source_id": sid, "statute": fm.get("title", sid), "sfs": "",
                        "amended_through": "", "locator": f"artikel {a}", "kap": None, "kap_title": "", "par": a,
                        "heading": parsed[a]["heading"], "text": parsed[a]["text"], "amendment": "",
                        "au_relevans": note, "verification_status": fm.get("verification_status", "unknown"),
                        "extracted_at": TODAY})

for sid, arts, note in CONVENTION_SPEC:
    fm, body = read_source(sid)
    parsed = parse_convention(body)
    if not parsed:
        sample = [l for l in body.split("\n") if "rtikel 1" in l][:5]
        problems.append(f"{sid}: inga artiklar tolkade; exempelrader: {sample}")
    for a in arts:
        if a not in parsed:
            problems.append(f"{sid}: artikel {a} saknas"); continue
        records.append({"id": f"{sid}::art{a}", "source_id": sid, "statute": fm.get("title", sid), "sfs": fm.get("sfs", ""),
                        "amended_through": fm.get("amended_through", ""), "locator": f"artikel {a}", "kap": None,
                        "kap_title": "", "par": a, "heading": "", "text": parsed[a], "amendment": "",
                        "au_relevans": note, "verification_status": fm.get("verification_status", "unknown"),
                        "extracted_at": TODAY})

OUT.write_text(json.dumps(records, ensure_ascii=False, indent=1), encoding="utf-8")
with OUT_MD.open("w", encoding="utf-8") as f:
    f.write("# Paragrafregister (ordagrann text ur källfilerna)\n\nGenererat %s av tools/extract_provisions.py. Kommentaren under varje rubrik är tolkning, inte källtext.\n\n" % TODAY)
    last = None
    for r in records:
        if r["statute"] != last:
            f.write(f"\n## {r['statute']}\n\nKälla: `{r['source_id']}` ({r['amended_through'] or 'EU-text'}, status {r['verification_status']})\n\n")
            last = r["statute"]
        hd = f" {r['heading']}" if r["heading"] else ""
        f.write(f"### {r['locator']}{hd}\n\n> {r['au_relevans']}\n\n{r['text']}\n\n")
        if r["amendment"]: f.write(f"*{r['amendment']}*\n\n")

print(f"{len(records)} bestämmelser extraherade → {OUT.relative_to(KB)}")
tot = sum(len(r["text"]) for r in records); print(f"total text: {tot} tecken")
if problems:
    print("\nPROBLEM:"); [print(" -", p) for p in problems]
