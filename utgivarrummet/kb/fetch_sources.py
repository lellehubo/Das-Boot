#!/usr/bin/env python3
"""
fetch_sources.py — hämtpipeline för Utgivarrummets kunskapsbas.

Körs LOKALT på en dator med öppet nät (Claude Codes molnmiljö saknar utgående nät
till källsajterna). Återkörbar: varje källa får URL, hämtdatum, HTTP-status och
sha256 i kb/MANIFEST.json. En ändrad källa får ny hash och flaggas.

    python3 kb/fetch_sources.py --all
    python3 kb/fetch_sources.py --only statutes,self-regulation
    python3 kb/fetch_sources.py --only mo-men --limit 25      # provkör
    python3 kb/fetch_sources.py --list                        # visa alla källor

Krav: Python 3.9+. Valfritt men rekommenderat: pip install requests beautifulsoup4
      PDF-text: pdftotext (poppler) om det finns på PATH.

Kataloger (relativt kb/):
    sources-raw/<kategori>/   råfiler (html/pdf/json) exakt som hämtade
    sources/<kategori>/       markdown med frontmatter, extraherad text
    seed/mo_men_index.json    läses för att hämta alla MO/MEN-beslut
"""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, re, shutil, subprocess, sys, time, urllib.parse
from pathlib import Path

try:
    import requests  # type: ignore
    HAS_REQUESTS = True
except ImportError:
    import urllib.request, urllib.error
    HAS_REQUESTS = False
try:
    from bs4 import BeautifulSoup  # type: ignore
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

VERSION = "kb/fetch_sources.py v1 (2026-09-06)"
KB = Path(__file__).resolve().parent
RAW = KB / "sources-raw"
OUT = KB / "sources"
MANIFEST = KB / "MANIFEST.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36 Utgivarrummet-KB/1.0 (research; kontakt via TV4 Nyheterna)")
HEADERS = {"User-Agent": UA, "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.7",
           "Accept": "text/html,application/xhtml+xml,application/pdf,application/json;q=0.9,*/*;q=0.8"}
DELAY = 0.8          # sekunder mellan anrop mot samma värd
RETRIES = 3
TIMEOUT = 40

# ----------------------------------------------------------------------------
# KÄLLREGISTER. Varje post: (id, url, titel, typ). Typ styr textextraktion.
# Lägg till nya källor här; kör om skriptet.
# ----------------------------------------------------------------------------
RIKSDAGEN = "https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/"

SOURCES: dict[str, dict] = {
    "statutes": {
        "beskrivning": "Grundlagar och lagar, konsoliderad lydelse (riksdagen.se, lagen.nu som andra källa)",
        "items": [
            ("sfs-1949-105-tryckfrihetsforordning", RIKSDAGEN + "tryckfrihetsforordning-1949105_sfs-1949-105/", "Tryckfrihetsförordning (1949:105)", "statute"),
            ("sfs-1991-1469-yttrandefrihetsgrundlag", RIKSDAGEN + "yttrandefrihetsgrundlag-19911469_sfs-1991-1469/", "Yttrandefrihetsgrundlag (1991:1469)", "statute"),
            ("sfs-1991-1559-tillampningslagen", RIKSDAGEN + "lag-19911559-med-foreskrifter-pa_sfs-1991-1559/", "Lag (1991:1559) med föreskrifter på tryckfrihetsförordningens och yttrandefrihetsgrundlagens områden", "statute"),
            ("sfs-1962-700-brottsbalk", RIKSDAGEN + "brottsbalk-1962700_sfs-1962-700/", "Brottsbalk (1962:700)", "statute"),
            ("sfs-2010-696-radio-och-tv-lag", RIKSDAGEN + "radio-och-tv-lag-2010696_sfs-2010-696/", "Radio- och tv-lag (2010:696)", "statute"),
            ("sfs-1960-729-upphovsrattslag", RIKSDAGEN + "lag-1960729-om-upphovsratt-till-litterara-och_sfs-1960-729/", "Lag (1960:729) om upphovsrätt till litterära och konstnärliga verk", "statute"),
            ("sfs-2009-400-offentlighets-och-sekretesslag", RIKSDAGEN + "offentlighets-och-sekretesslag-2009400_sfs-2009-400/", "Offentlighets- och sekretesslag (2009:400)", "statute"),
            ("sfs-2018-218-dataskyddslag", RIKSDAGEN + "lag-2018218-med-kompletterande-bestammelser_sfs-2018-218/", "Lag (2018:218) med kompletterande bestämmelser till EU:s dataskyddsförordning", "statute"),
            ("sfs-2018-1200-kamerabevakningslag", RIKSDAGEN + "kamerabevakningslag-2018-1200_sfs-2018-1200/", "Kamerabevakningslag (2018:1200)", "statute"),
            ("sfs-2016-319-geografisk-information", RIKSDAGEN + "lag-2016319-om-skydd-for-geografisk-information_sfs-2016-319/", "Lag (2016:319) om skydd för geografisk information", "statute"),
            ("sfs-1942-740-rattegangsbalk", RIKSDAGEN + "rattegangsbalk-1942740_sfs-1942-740/", "Rättegångsbalk (1942:740)", "statute"),
            ("sfs-2025-1242-emfa-kompletteringslag", RIKSDAGEN + "lag-20251242-med-kompletterande-bestammelser_sfs-2025-1242/", "Lag (2025:1242) med kompletterande bestämmelser till EU:s mediefrihetsförordning", "statute"),
            ("sfs-2026-241-anti-slapp-lag", RIKSDAGEN + "lag-2026241-om-skydd-for-deltagande-i-den_sfs-2026-241/", "Lag (2026:241) om skydd för deltagande i den offentliga debatten vid tvister med gränsöverskridande följder", "statute"),
            ("sfs-2018-1197-barnkonventionen", RIKSDAGEN + "lag-2018-1197-om-forenta-nationernas-konvention_sfs-2018-1197/", "Lag (2018:1197) om Förenta nationernas konvention om barnets rättigheter", "statute"),
            ("sfs-2017-151-meddelarskydd-enskilda", RIKSDAGEN + "lag-2017151-om-meddelarskydd-i-vissa-enskilda_sfs-2017-151/", "Lag (2017:151) om meddelarskydd i vissa enskilda verksamheter", "statute"),
            ("sfs-1972-207-skadestandslag", RIKSDAGEN + "skadestandslag-1972207_sfs-1972-207/", "Skadeståndslag (1972:207)", "statute"),
            ("sfs-1994-1219-ekmr-lag", "https://lagen.nu/1994:1219", "Lag (1994:1219) om den europeiska konventionen angående skydd för de mänskliga rättigheterna (med konventionstexten)", "lagen-nu"),
            ("sfs-1998-112-bbs-lag", "https://lagen.nu/1998:112", "Lag (1998:112) om ansvar för elektroniska anslagstavlor", "lagen-nu"),
            ("sfs-2008-486-marknadsforingslag", "https://lagen.nu/2008:486", "Marknadsföringslag (2008:486)", "lagen-nu"),
            ("sfs-2010-1622-alkohollag", "https://lagen.nu/2010:1622", "Alkohollag (2010:1622), 7 kap. marknadsföring", "lagen-nu"),
            ("sfs-2018-2088-tobakslag", "https://lagen.nu/2018:2088", "Lag (2018:2088) om tobak och liknande produkter", "lagen-nu"),
            ("sfs-2018-1138-spellag", "https://lagen.nu/2018:1138", "Spellag (2018:1138), 15 kap. marknadsföring", "lagen-nu"),
            # lagen.nu-speglar av kärnlagarna (kommenterade, andra källa)
            ("lagennu-1949-105", "https://lagen.nu/1949:105", "TF på lagen.nu", "lagen-nu"),
            ("lagennu-1991-1469", "https://lagen.nu/1991:1469", "YGL på lagen.nu", "lagen-nu"),
            ("lagennu-1991-1559", "https://lagen.nu/1991:1559", "Tillämpningslagen på lagen.nu", "lagen-nu"),
            ("lagennu-2026-241", "https://lagen.nu/2026:241", "Anti-SLAPP-lagen på lagen.nu", "lagen-nu"),
            ("sfs-2026-241-original", "https://svenskforfattningssamling.se/doc/2026241.html", "SFS 2026:241 i originaltryck", "html"),
        ],
    },
    "eu": {
        "beskrivning": "EU-rätt och EKMR",
        "items": [
            ("emfa-2024-1083", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:32024R1083", "Europeiska mediefrihetsakten (EU) 2024/1083", "eurlex"),
            ("dsa-2022-2065", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:32022R2065", "Förordningen om digitala tjänster (EU) 2022/2065", "eurlex"),
            ("avmsd-2010-13", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:02010L0013-20181218", "AV-direktivet 2010/13/EU, konsoliderad", "eurlex"),
            ("antislapp-2024-1069", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:32024L1069", "Anti-SLAPP-direktivet (EU) 2024/1069", "eurlex"),
            ("gdpr-2016-679", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:32016R0679", "Dataskyddsförordningen (EU) 2016/679", "eurlex"),
            ("ekmr-konventionstext-sv", "https://www.echr.coe.int/documents/d/echr/convention_swe", "Europakonventionen, svensk text (PDF)", "pdf"),
            ("cjeu-c-73-07-satamedia", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:62007CJ0073", "EU-domstolen C-73/07 Satakunnan Markkinapörssi och Satamedia (journalistiska ändamål)", "eurlex"),
            ("cjeu-c-345-17-buivids", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:62017CJ0345", "EU-domstolen C-345/17 Buivids (video av polis, journalistiskt ändamål)", "eurlex"),
            ("cjeu-c-131-12-google-spain", "https://eur-lex.europa.eu/legal-content/SV/TXT/HTML/?uri=CELEX:62012CJ0131", "EU-domstolen C-131/12 Google Spain (rätten att bli glömd)", "eurlex"),
        ],
    },
    "self-regulation": {
        "beskrivning": "Det medieetiska systemet och yrkesetiken",
        "items": [
            ("mo-publicitetsreglerna", "https://medieombudsmannen.se/det-har-ar-medieombudsmannen/publicitetsreglerna-grunden-i-det-medieetiska-systemet/", "Publicitetsreglerna", "html"),
            ("mo-instruktion", "https://medieombudsmannen.se/instruktion-for-allmanhetens-medieombudsman/", "Instruktion för Allmänhetens Medieombudsman", "html"),
            ("men-stadgar", "https://medieombudsmannen.se/mediernas-etiknamnden/stadgar/", "Stadgar för Mediernas Etiknämnd", "html"),
            ("mo-arendegang", "https://medieombudsmannen.se/det-har-ar-medieombudsmannen/fran-anmalan-till-beslut-sa-gar-det-till/", "Från anmälan till beslut", "html"),
            ("mo-skillnad-grn", "https://medieombudsmannen.se/sa-har-gor-du-en-anmalan/skillnaden-mellan-granskningsnamnden-och-mo/", "Skillnaden mellan Granskningsnämnden och MO", "html"),
            ("mo-checklista-sjalvmord", "https://medieombudsmannen.se/checklista-for-rapportering-om-sjalvmord-framtagen/", "MO: checklista för rapportering om självmord", "html"),
            ("mo-vagledning-index", "https://medieombudsmannen.se/vagledning/", "MO: vägledning (index, kan ha flyttat)", "html"),
            ("mo-mefo-hansson", "https://medieombudsmannen.se/viveka-hansson-ny-ordforande-for-medieetikens-forvaltningsorgan/", "Viveka Hansson ny ordförande för Mefo", "html"),
            ("mo-sitemap", "https://medieombudsmannen.se/wp-sitemap.xml", "MO: WordPress-sitemap (för att upptäcka nya sidor)", "sitemap"),
            ("sjf-publicitetsregler", "https://www.sjf.se/yrkesfragor/yrkesetik/spelregler-press-radio-och-tv/publicitetsregler", "SJF: publicitetsregler", "html"),
            ("sjf-yrkesregler", "https://www.sjf.se/yrkesfragor/yrkesetik/yrkesetiska-regler", "SJF: yrkesetiska regler", "html"),
            ("sjf-yen", "https://www.sjf.se/yrkesfragor/yrkesetik/yrkesetiska-namnden/", "SJF: Yrkesetiska nämnden", "html"),
            ("sjf-ansvarig-utgivare", "https://www.sjf.se/yrkesfragor/yttrandefrihet/ansvarig-utgivare", "SJF: ansvarig utgivare", "html"),
            ("sjf-meddelarfrihet", "https://www.sjf.se/yrkesfragor/yttrandefrihet/meddelarfrihet", "SJF: meddelarfrihet", "html"),
            ("sjf-efterforskningsforbud", "https://www.sjf.se/yrkesfragor/yttrandefrihet/meddelarfrihet/efterforsknings-och-repressalieforbud", "SJF: efterforsknings- och repressalieförbud", "html"),
            ("sjf-gdpr", "https://www.sjf.se/yrkesfragor/yttrandefrihet/gdpr-och-journalistik", "SJF: GDPR och journalistik", "html"),
            ("sjf-upphovsratt", "https://www.sjf.se/yrkesfragor/upphovsratt/vad-innebar-upphovsratt", "SJF: upphovsrätt", "html"),
            ("utgivarna-utgivarskap", "https://utgivarna.se/utgivarskap/", "Utgivarna: utgivarskap (crawlas en nivå)", "crawl"),
            ("tidskrifter-ansvariga-utgivaren", "https://sverigestidskrifter.se/den-ansvariga-utgivaren/", "Sveriges Tidskrifter: Den ansvariga utgivaren (crawlas en nivå)", "crawl"),
            ("tu-juridik", "https://tu.se/juridik/", "TU: juridik (crawlas en nivå)", "crawl"),
            ("publicistklubben", "https://www.publicistklubben.se/", "Publicistklubben", "html"),
        ],
    },
    "mo-men": {
        "beskrivning": "Alla MO/MEN-beslut (och PON-beslut) enligt seed/mo_men_index.json",
        "items": [],  # fylls dynamiskt
    },
    "grn": {
        "beskrivning": "Granskningsnämnden och Mediemyndigheten",
        "items": [
            ("mm-praxissamlingar", "https://mediemyndigheten.se/anmala-program/granskningsnamndens-praxissamlingar/", "Granskningsnämndens praxissamlingar (crawlas en nivå)", "crawl"),
            ("mm-praxis-teman", "https://mediemyndigheten.se/anmala-program/granskningsnamndens-praxissamlingar/teman-och-amnen/", "Praxissamlingar: teman och ämnen (crawlas en nivå)", "crawl"),
            ("mm-granskat-klart-opartiskhet-2020", "https://mediemyndigheten.se/globalassets/dokument/publikationer/granskat-och-klart/granskat-och-klart---opartiskhet-2020.pdf", "Granskat och klart: opartiskhet 1994–2019", "pdf"),
            ("mm-anmala-program", "https://mediemyndigheten.se/anmala-program/", "Anmäla program (regler som prövas)", "html"),
            ("mm-ansvarig-utgivare", "https://mediemyndigheten.se/ansokan-och-registrering/regelverk/ansvarig-utgivare/", "Mediemyndigheten: ansvarig utgivare", "html"),
            ("mm-regler-villkor", "https://www.mediemyndigheten.se/regler-och-villkor/", "Regler och villkor (crawlas en nivå)", "crawl"),
            ("mm-marksand-tv-tillstand", "https://mediemyndigheten.se/globalassets/ansokan-och-registrering/tv/marksand-tv/marksand-tv---tillstand-att-sanda-tv.pdf", "Marksänd tv: tillstånd att sända tv (PDF)", "pdf"),
            ("mm-tv4-lamnar-marknatet", "https://mediemyndigheten.se/nyhetsrum/nyhetslista/2025/tv4-och-tv-finland-upphor-med-sandningar-i-marknatet/", "TV4 och TV Finland upphör med sändningar i marknätet", "html"),
            ("mm-vaccinkrigarna-beslut", "https://mediemyndigheten.se/nyhetsrum/nyhetslista/2023/uppmarksammad-dom--granskningsnamndens-beslut-om-vaccinkrigarna/", "Granskningsnämndens beslut om Vaccinkrigarna", "html"),
            ("mm-ps-internet", "https://mediemyndigheten.se/nyhetsrum/nyhetslista/2023/granskningsnamnden-granskar-public-service-innehall-pa-internet/", "GRN granskar public service på internet", "html"),
            ("mm-emfa", "https://mediemyndigheten.se/europeiska-regleringar/emfa-eus-mediefrihetsforordning/", "Mediemyndigheten om EMFA", "html"),
            ("mm-dsa", "https://mediemyndigheten.se/europeiska-regleringar/dsa-eus-forordning-om-en-inre-marknad-for-digitala-tjanster/", "Mediemyndigheten om DSA", "html"),
            ("mm-publicistguiden", "https://mediemyndigheten.se/globalassets/barn-och-pedagogik/pedagogiskt-material/upphovsratt/publicistguiden.pdf", "Publicistguiden (PDF)", "pdf"),
            ("mm-nyhetsrum-2025", "https://mediemyndigheten.se/nyhetsrum/nyhetslista/2025/", "Nyhetslista 2025 (crawlas för TV4/Granskningsnämnden)", "crawl"),
            ("mm-nyhetsrum-2026", "https://mediemyndigheten.se/nyhetsrum/nyhetslista/2026/", "Nyhetslista 2026 (crawlas)", "crawl"),
            # pressmeddelanden om beslut (via TT)
            ("tt-grn-3325280", "https://via.tt.se/pressmeddelande/3325280/granskningsnamnden-faller-ett-inslag-i-tv4-nyheterna?publisherId=3235838", "GRN fäller ett inslag i TV4 Nyheterna", "html"),
            ("tt-grn-3345703", "https://via.tt.se/pressmeddelande/3345703/granskningsnamndens-senaste-beslut?publisherId=3235838", "GRN: senaste beslut", "html"),
            ("tt-grn-3782690", "https://via.tt.se/pressmeddelande/3782690/fyra-fallningar-i-granskningsnamnden?publisherId=3235838&lang=sv", "Fyra fällningar i granskningsnämnden", "html"),
            ("tt-grn-4062870", "https://via.tt.se/pressmeddelande/4062870/fem-fallningar-i-granskningsnamnden?publisherId=3235838&lang=sv", "Fem fällningar i granskningsnämnden", "html"),
            ("tt-grn-4082541", "https://via.tt.se/pressmeddelande/4082541/tva-inslag-i-tv4s-nyhetsmorgon-falls?publisherId=3235838&lang=sv", "Två inslag i TV4:s Nyhetsmorgon fälls", "html"),
            ("tt-grn-4190342", "https://via.tt.se/pressmeddelande/4190342/granskningsnamnden-har-provat-mediers-bildinnehall?publisherId=3235838&lang=sv", "GRN har prövat mediers bildinnehåll", "html"),
            ("tt-grn-4445978", "https://via.tt.se/pressmeddelande/4445978/musikhjalpen-falls-for-krankande-uttalande-om-personer-med-funktionsnedsattning?publisherId=3235838&lang=sv", "Musikhjälpen fälls", "html"),
            ("tt-grn-3308739", "https://via.tt.se/pressmeddelande/3308739/granskningsnamndens-senaste-beslut", "GRN: senaste beslut (2024)", "html"),
            ("tt-grn-3712193", "https://via.tt.se/pressmeddelande/3712193/granskningsnamnden-faller-inslag-i-nyhetsmorgon?publisherId=3235838&lang=sv", "GRN fäller inslag i Nyhetsmorgon (Kalla fakta: Dödsgruvorna, 2024-03-14)", "html"),
            ("tt-grn-3626397", "https://via.tt.se/pressmeddelande/3626397/granskningsnamnden-friar-tv4s-program-kalla-fakta?publisherId=3235838&lang=sv", "GRN friar Kalla fakta", "html"),
            ("tt-grn-3604306", "https://via.tt.se/pressmeddelande/3604306/granskningsnamnden-friar-svt-och-tv4-gallande-innehall-av-skrammande-karaktar?publisherId=3235838&lang=sv", "GRN friar SVT och TV4, innehåll av skrämmande karaktär", "html"),
            ("tt-grn-4164061", "https://via.tt.se/pressmeddelande/4164061/tv4-och-viaplay-har-inte-uppfyllt-tillganglighetskraven?publisherId=3235838&lang=sv", "TV4 och Viaplay uppfyllde inte tillgänglighetskraven", "html"),
            ("tt-mm-pressrum", "https://via.tt.se/pressrum/mediemyndigheten?publisherId=3235838", "Mediemyndighetens pressrum (crawlas)", "crawl"),
        ],
    },
    "jk": {
        "beskrivning": "Justitiekanslern, tryck- och yttrandefrihet",
        "items": [
            ("jk-tryck-yttrandefrihet", "https://www.jk.se/tryck-och-yttrandefrihet/", "JK: tryck- och yttrandefrihet (crawlas en nivå)", "crawl"),
            ("jk-beslut-index", "https://www.jk.se/beslut-och-yttranden/", "JK: beslut och yttranden (index)", "html"),
            ("jk-6677-18-3-2", "https://www.jk.se/beslut-och-yttranden/2019/04/6677-18-32/", "JK 6677-18-3.2", "html"),
            ("jk-2672-17-4-3", "https://www.jk.se/beslut-och-yttranden/2018/06/2672-17-43/", "JK 2672-17-4.3 (åtalsfrågan vid förtal)", "html"),
            ("jk-8455-12-32", "https://www.jk.se/beslut-och-yttranden/2013/01/8455-12-32/", "JK 8455-12-32", "html"),
            ("jk-2024-6987", "https://www.jk.se/beslut-och-yttranden/2025/11/20246987/", "JK 2024/6987", "html"),
            ("jk-2024-7664", "https://www.jk.se/beslut-och-yttranden/2025/03/20247664/", "JK 2024/7664", "html"),
            ("lagennu-jk-2672-17", "https://lagen.nu/avg/jk/2672-17-4.3", "JK 2672-17-4.3 på lagen.nu", "lagen-nu"),
            ("lagennu-jk-6677-18", "https://lagen.nu/avg/jk/6677-18-3.2", "JK 6677-18-3.2 på lagen.nu", "lagen-nu"),
            ("lagennu-jk-8455-12", "https://lagen.nu/avg/jk/8455-12-32", "JK 8455-12-32 på lagen.nu", "lagen-nu"),
        ],
    },
    "hd": {
        "beskrivning": "Högsta domstolen, hovrätter, tingsrätter",
        "items": [
            ("hd-vaccindokumentaren-2025", "https://www.domstol.se/nyheter/2025/12/kritisk-granskning-av-vaccinmotstandare-stred-inte-mot-europakonventionen/", "HD T 9218-24 Vaccindokumentären (nyhet)", "html"),
            ("hd-vaccindokumentaren-pdf", "https://www.domstol.se/globalassets/filer/domstol/hogstadomstolen/avgoranden/2025/t-9218-24.pdf", "HD T 9218-24, domen (PDF, sökvägen kan behöva justeras)", "pdf"),
            ("tr-vaccin-2023", "https://www.domstol.se/nyheter/2023/03/dom-i-mal-om-dokumentar-och-europakonventionen/", "Stockholms tingsrätt 2023 om dokumentär och Europakonventionen", "html"),
            ("hd-avgoranden", "https://www.domstol.se/hogsta-domstolen/avgoranden/", "HD: avgöranden (ingång)", "html"),
            ("lagennu-nja-fortal-sok", "https://lagen.nu/search/?q=f%C3%B6rtal+tryckfrihetsbrott", "lagen.nu: sök förtal tryckfrihetsbrott", "html"),
            ("lagennu-nja-yttrandefrihetsbrott-sok", "https://lagen.nu/search/?q=yttrandefrihetsbrott", "lagen.nu: sök yttrandefrihetsbrott", "html"),
            ("lagennu-nja-integritetsintrang-sok", "https://lagen.nu/search/?q=olaga+integritetsintr%C3%A5ng", "lagen.nu: sök olaga integritetsintrång", "html"),
            ("lagennu-nja-2019-s279", "https://lagen.nu/dom/nja/2019s279", "NJA 2019 s. 279", "lagen-nu"),
            ("press-dagerlind-hovratten", "https://www.journalisten.se/nyheter/hovratten-dubblar-skadestandet-for-samnytts-utgivare/", "Journalisten: hovrätten dubblar skadeståndet (Samnytt)", "html"),
            ("press-dagerlind-hd", "https://www.journalisten.se/nyheter/hd-provar-fortalsdomen-mot-dagerlind/", "Journalisten: HD prövar förtalsdomen mot Dagerlind", "html"),
            ("press-dagerlind-dj", "https://www.dagensjuridik.se/nyheter/hd-domer-ansvarig-utgivare-for-grovt-fortal-av-dn-journalist/", "Dagens Juridik: HD dömer ansvarig utgivare (Samnytt)", "html"),
            ("press-dagerlind-nj", "https://www.nj.se/nyheter/fr%C3%A5getecken-om-f%C3%B6rtalsbrottet-kvarst%C3%A5r-trots-ny-hd-dom", "NJ: frågetecken om förtalsbrottet", "html"),
            ("press-dagerlind-svt", "https://www.svt.se/kultur/journalist-pekades-ut-som-jihadist-nu-tar-hd-upp-malet-samnytt-mats-dagerlind-fortal", "SVT: HD tar upp Samnytt-målet", "html"),
        ],
    },
    "echr": {
        "beskrivning": "Europadomstolen: faktablad och nyckeldomar via HUDOC:s API",
        "items": [
            ("echr-fs-reputation", "https://www.echr.coe.int/documents/d/echr/fs_reputation_eng", "Factsheet: Protection of reputation", "pdf"),
            ("echr-fs-sources", "https://www.echr.coe.int/documents/d/echr/fs_journalistic_sources_eng", "Factsheet: Protection of journalistic sources", "pdf"),
            ("echr-fs-own-image", "https://www.echr.coe.int/documents/d/echr/fs_own_image_eng", "Factsheet: Right to the protection of one's image", "pdf"),
            ("echr-fs-hate-speech", "https://www.echr.coe.int/documents/d/echr/fs_hate_speech_eng", "Factsheet: Hate speech", "pdf"),
            ("echr-fs-new-technologies", "https://www.echr.coe.int/documents/d/echr/fs_new_technologies_eng", "Factsheet: New technologies", "pdf"),
            ("echr-fs-personal-data", "https://www.echr.coe.int/documents/d/echr/fs_data_eng", "Factsheet: Personal data protection", "pdf"),
            ("echr-fs-children", "https://www.echr.coe.int/documents/d/echr/fs_childrens_eng", "Factsheet: Children's rights (namnet kan avvika)", "pdf"),
            ("echr-guide-art10", "https://ks.echr.coe.int/documents/d/echr-ks/guide_art_10_eng", "Guide on Article 10 (Case-law guide)", "pdf"),
            ("echr-guide-art8", "https://ks.echr.coe.int/documents/d/echr-ks/guide_art_8_eng", "Guide on Article 8 (Case-law guide)", "pdf"),
            ("regeringen-arlewin-2016", "https://www.regeringen.se/internationella-mr-granskningar-av-sverige/2016/03/europadomstolens-dom-2016-03-01-i-malet-arlewin-mot-sverige/", "Arlewin mot Sverige (regeringens referat)", "html"),
            ("regeringen-pihl-2017", "https://www.regeringen.se/internationella-mr-granskningar-av-sverige/2018/10/europadomstolens-beslut-2017-02-07-i-malet-pihl-mot-sverige/", "Pihl mot Sverige (regeringens referat)", "html"),
        ],
        # Nyckeldomar hämtas via HUDOC-API på ansökningsnummer (appno).
        "hudoc_cases": [
            ("von-hannover-1", "59320/00", "Von Hannover v. Germany (No. 1), 2004"),
            ("von-hannover-2", "40660/08", "Von Hannover v. Germany (No. 2) [GC], 2012"),
            ("axel-springer", "39954/08", "Axel Springer AG v. Germany [GC], 2012"),
            ("couderc", "40454/07", "Couderc and Hachette Filipacchi v. France [GC], 2015"),
            ("bedat", "56925/08", "Bédat v. Switzerland [GC], 2016"),
            ("haldimann", "21830/09", "Haldimann and Others v. Switzerland, 2015 (dold kamera)"),
            ("pedersen-baadsgaard", "49017/99", "Pedersen and Baadsgaard v. Denmark [GC], 2004"),
            ("satakunnan", "931/13", "Satakunnan Markkinapörssi Oy v. Finland [GC], 2017"),
            ("fuchsmann", "71233/13", "Fuchsmann v. Germany, 2017"),
            ("delfi", "64569/09", "Delfi AS v. Estonia [GC], 2015 (kommentarsfält)"),
            ("magyar-jeti", "11257/16", "Magyar Jeti Zrt v. Hungary, 2018 (hyperlänkar)"),
            ("jersild", "15890/89", "Jersild v. Denmark, 1994 (hets, intervju)"),
            ("bladet-tromso", "21980/93", "Bladet Tromsø and Stensaas v. Norway [GC], 1999"),
            ("egeland-hanseid", "34438/04", "Egeland and Hanseid v. Norway, 2009 (bilder på dömd)"),
            ("goodwin", "17488/90", "Goodwin v. United Kingdom [GC], 1996 (källskydd)"),
            ("sanoma", "38224/03", "Sanoma Uitgevers B.V. v. the Netherlands [GC], 2010 (källskydd)"),
            ("stoll", "69698/01", "Stoll v. Switzerland [GC], 2007 (hemliga handlingar)"),
            ("mosley", "48009/08", "Mosley v. United Kingdom, 2011 (förhandsinformation)"),
            ("lillo-stenberg", "13258/09", "Lillo-Stenberg and Sæther v. Norway, 2014 (bröllopsbilder)"),
            ("arlewin", "22302/10", "Arlewin v. Sweden, 2016 (förtal i tv, jurisdiktion, art. 6)"),
            ("pihl", "74742/14", "Pihl v. Sweden (dec.), 2017 (kommentar på blogg, art. 8)"),
            ("standard-verlags-2", "21277/05", "Standard Verlags GmbH v. Austria (No. 2), 2009 (privatliv, politiker)"),
            ("morice", "29369/10", "Morice v. France [GC], 2015 (värdeomdöme, sakpåstående)"),
            ("perincek", "27510/08", "Perinçek v. Switzerland [GC], 2015 (yttrandefrihetens gränser)"),
            ("diamant-salihu", "33628/15", "Diamant Salihu and Others v. Sweden (dec.), 2016 (Expressen-journalister, vapenköp)"),
            ("gillberg", "41723/06", "Gillberg v. Sweden [GC], 2012 (art. 10, forskningsmaterial)"),
        ],
    },
    "preparatory-works": {
        "beskrivning": "Propositioner, SOU, Ds och utskottsbetänkanden",
        "items": [
            ("prop-2016-17-222", "https://lagen.nu/prop/2016/17:222", "Prop. 2016/17:222 Ett starkt straffrättsligt skydd för den personliga integriteten", "lagen-nu"),
            ("prop-2012-13-69", "https://lagen.nu/prop/2012/13:69", "Prop. 2012/13:69 Kränkande fotografering", "lagen-nu"),
            ("prop-2013-14-47", "https://lagen.nu/prop/2013/14:47", "Prop. 2013/14:47 Några ändringar på tryck- och yttrandefrihetens område (åtalsregler förtal)", "lagen-nu"),
            ("prop-2017-18-49", "https://lagen.nu/prop/2017/18:49", "Prop. 2017/18:49 Ändrade mediegrundlagar", "lagen-nu"),
            ("prop-2021-22-59", "https://lagen.nu/prop/2021/22:59", "Prop. 2021/22:59 Ett ändamålsenligt skydd för tryck- och yttrandefriheten", "lagen-nu"),
            ("prop-2025-26-64", "https://www.regeringen.se/rattsliga-dokument/proposition/2025/10/prop.-20252664/", "Prop. 2025/26:64 Genomförande av anti-SLAPP-direktivet", "html"),
            ("ds-2025-5", "https://lagen.nu/ds/2025:5", "Ds 2025:5 Genomförande av anti-SLAPP-direktivet", "lagen-nu"),
            ("ds-2024-28-emfa", "https://regeringen.se/contentassets/cac6e6e18edf4e71a41978e6c13243fe/ds-kompletterande-bestammelser-till-eus-mediefrihetsforordning.pdf", "Ds 2024:28 Kompletterande bestämmelser till EMFA (PDF)", "pdf"),
            ("regeringen-emfa-prop", "https://regeringen.se/pressmeddelanden/2025/07/regeringen-beslutar-om-propositionen-kompletterande-bestammelser-till-eus-mediefrihetsforordning/", "Regeringen: proposition om EMFA-lag", "html"),
            ("bet-2025-26-juu23", "https://www.riksdagen.se/sv/dokument-och-lagar/dokument/betankande/genomforande-av-direktivet-om-skydd-for-personer_hd01juu23/", "Bet. 2025/26:JuU23 anti-SLAPP", "html"),
            ("bet-2024-25-ku24", "https://www.riksdagen.se/sv/dokument-och-lagar/dokument/betankande/tryck-och-yttrandefrihet-massmediefragor_hc01ku24/", "Bet. 2024/25:KU24 Tryck- och yttrandefrihet, massmediefrågor", "html"),
            ("bet-2022-23-ku27", "https://www.riksdagen.se/sv/dokument-och-lagar/dokument/betankande/tryck-och-yttrandefrihet-massmediefragor_ha01ku27/html/", "Bet. 2022/23:KU27", "html"),
            ("sou-2020-45", "https://www.regeringen.se/rattsliga-dokument/statens-offentliga-utredningar/2020/08/sou-202045/", "SOU 2020:45 Ett ändamålsenligt skydd för tryck- och yttrandefriheten", "html"),
            ("sou-2016-58", "https://www.regeringen.se/rattsliga-dokument/statens-offentliga-utredningar/2016/09/sou-201658/", "SOU 2016:58 Ändrade mediegrundlagar", "html"),
        ],
    },
    "guidance": {
        "beskrivning": "Myndighetsvägledningar och branschhandböcker",
        "items": [
            ("imyrs-2022-2", "https://www.imy.se/globalassets/dokument/rattsligt-stallningstagande/imyrs-2022-2-undantaget-for-journalistiska-andamal.pdf", "IMYRS 2022:2 Undantaget för journalistiska ändamål", "pdf"),
            ("imy-gdpr", "https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/", "IMY: det här gäller enligt GDPR", "html"),
            ("imy-kamerabevakning", "https://www.imy.se/lagar--regler/kamerabevakningslagen/", "IMY: kamerabevakningslagen", "html"),
            ("lantmateriet-spridningstillstand", "https://www.lantmateriet.se/spridningstillstand/", "Lantmäteriet: spridningstillstånd", "html"),
            ("transportstyrelsen-dronare", "https://www.transportstyrelsen.se/dronare", "Transportstyrelsen: drönare", "html"),
            ("who-suicide-media-2023", "https://www.who.int/publications/i/item/9789240076846", "WHO: Preventing suicide, a resource for media professionals (2023)", "html"),
            ("mind-media-sjalvmord", "https://mind.se/om-sjalvmord/media-sjalvmord/", "Mind: media och självmord", "html"),
            ("advokatsamfundet-fortal-2014", "https://www.advokatsamfundet.se/Nyhetsarkiv/2014/april/Lattare-vacka-atal-for-fortal/", "Advokatsamfundet: lättare väcka åtal för förtal (2014)", "html"),
            ("timedanowsky-antislapp", "https://www.timedanowsky.se/svensk-anti-slapp-lagstiftning-har-tratt-i-kraft/", "Timedanowsky: anti-SLAPP i kraft", "html"),
            ("timedanowsky-journalistiskt-andamal", "https://www.timedanowsky.se/vad-ar-ett-journalistiskt-andamal-enligt-gdpr-imy-publicerar-nytt-stallningstagande/", "Timedanowsky: journalistiskt ändamål enligt GDPR", "html"),
            ("svjt-brottsoffers-yttrandefrihet", "https://svjt.se/preprint/brottsoffers-yttrandefrihet-och-fortalsbrottet", "SvJT: Brottsoffers yttrandefrihet och förtalsbrottet", "html"),
            ("svjt-straffratt-2010-2018", "https://svjt.se/svjt/2019/1007", "SvJT: Svensk rättspraxis straffrätt 2010–2018", "html"),
        ],
    },
    "press": {
        "beskrivning": "Sekundärkällor: nyhetsartiklar om regelläget (lager 4, verifiera)",
        "items": [
            ("journalisten-tv4-grn-granskas", "https://www.journalisten.se/nyheter/tv4-vill-kunna-granskas-av-granskningsnamnden/", "Journalisten: TV4 vill kunna granskas av Granskningsnämnden", "html"),
            ("journalisten-tv4-lagg-ner-grn", "https://www.journalisten.se/nyheter/tv4-lagg-ner-granskningsnamnden/", "Journalisten: TV4: Lägg ner Granskningsnämnden", "html"),
            ("journalisten-mo-tv4-tidning", "https://www.journalisten.se/nyheter/mo-tv4-blir-en-tidning/", "Journalisten: Caspar Opitz: TV4 blir en tidning", "html"),
            ("journalisten-tv4-ko", "https://www.journalisten.se/nyheter/tv4-granskas-av-ko/", "Journalisten: TV4 granskas av KO", "html"),
            ("journalisten-tv4-antisemitiskt", "https://www.journalisten.se/nyheter/tv4-klandras-for-att-ha-kallat-dad-antisemitiskt/", "Journalisten: TV4 klandras för att ha kallat dåd antisemitiskt", "html"),
            ("sr-medierna-tv4-marknatet", "https://www.sverigesradio.se/avsnitt/tv4-lamnar-marknatet-ar-det-slutet-for-kommersiell-public-service", "SR Medierna: TV4 lämnar marknätet", "html"),
            ("svt-tv4-marknatet", "https://www.svt.se/kultur/tv4-forsvinner-fran-marknatet", "SVT: Nu är TV4 borta från marknätet", "html"),
            ("tv4-lundell-klandras", "https://www.tv4.se/artikel/95KeVpKeSmO1RRIChIUuo/dokumentaerserie-i-tv4-om-joakim-lundell-klandras-av-mediernas-etiknaemnd", "TV4: dokumentärserie om Joakim Lundell klandras", "html"),
            ("tv4-familj-klandras", "https://www.tv4.se/artikel/2THPemaEezGFD1djypJ6QE/tv4-klandras-foer-utpekande-bildpublicering-av-en-familj", "TV4: klandras för utpekande bildpublicering av en familj", "html"),
            ("svt-lundell-mamma", "https://www.svt.se/kultur/joakim-lundells-mamma-utpekad-tv4-klandras", "SVT: Joakim Lundells mamma utpekad", "html"),
            ("journalisten-tv4-genrebild", "https://www.journalisten.se/nyheter/tv4-klandras-for-genrebild-pa-familj-negativ-kontext/", "Journalisten: TV4 klandras för genrebild på familj", "html"),
            ("journalisten-tv4-lundell", "https://www.journalisten.se/nyheter/tv4-publicerade-mycket-skadliga-uppgifter-om-joakim-lundells-mamma/", "Journalisten: TV4 publicerade mycket skadliga uppgifter om Joakim Lundells mamma", "html"),
            ("journalisten-dagerlind-doms", "https://www.journalisten.se/nyheter/mats-dagerlind-doms-grovt-fortal-av-dn-journalist/", "Journalisten: Mats Dagerlind döms för grovt förtal", "html"),
            ("nj-dagerlind-faststalls", "https://www.nj.se/kortnyheter/grovt-f%C3%B6rtal-av-dn-journalist-domen-fastst%C3%A4lls", "NJ: grovt förtal av DN-journalist, domen fastställs", "html"),
        ],
    },
}

# ----------------------------------------------------------------------------
# Hjälpfunktioner
# ----------------------------------------------------------------------------
_last_hit: dict[str, float] = {}

def polite(url: str):
    host = urllib.parse.urlparse(url).netloc
    t = _last_hit.get(host, 0)
    wait = DELAY - (time.time() - t)
    if wait > 0: time.sleep(wait)
    _last_hit[host] = time.time()

def get(url: str) -> tuple[int, bytes, str]:
    """Returnerar (status, bytes, content_type). Kastar inte; status 0 = nätfel."""
    last_err = ""
    for attempt in range(RETRIES):
        polite(url)
        try:
            if HAS_REQUESTS:
                r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
                return r.status_code, r.content, r.headers.get("content-type", "")
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.status, resp.read(), resp.headers.get("content-type", "")
        except Exception as e:  # noqa
            last_err = str(e)
            if "404" in last_err or "403" in last_err:
                code = 404 if "404" in last_err else 403
                return code, b"", ""
            time.sleep(2 * (attempt + 1))
    print(f"    nätfel: {last_err[:120]}")
    return 0, b"", ""

def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def html_to_text(html: str) -> tuple[str, str]:
    """Returnerar (titel, text). Föredrar <article>/<main>."""
    if HAS_BS4:
        soup = BeautifulSoup(html, "html.parser")
        title = (soup.title.string or "").strip() if soup.title else ""
        for t in soup(["script", "style", "nav", "footer", "header", "noscript", "form", "aside", "svg"]):
            t.decompose()
        node = soup.find("article") or soup.find("main") or soup.find(class_=re.compile("entry-content|article|content", re.I)) or soup.body or soup
        text = node.get_text("\n", strip=True)
    else:
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
        title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
        body = re.sub(r"(?is)<(script|style|nav|footer|header|noscript|form|aside|svg).*?</\1>", " ", html)
        body = re.sub(r"(?s)<br\s*/?>|</p>|</div>|</li>|</h\d>|</tr>", "\n", body)
        text = re.sub(r"<[^>]+>", " ", body)
        text = re.sub(r"[ \t]+", " ", text)
        text = "\n".join(l.strip() for l in text.split("\n"))
    import html as _h
    text = _h.unescape(text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return title, text

def pdf_to_text(path: Path) -> str:
    if shutil.which("pdftotext"):
        try:
            out = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, timeout=120)
            return out.stdout.decode("utf-8", errors="replace")
        except Exception:
            return ""
    return ""

def frontmatter(d: dict) -> str:
    lines = ["---"]
    for k, v in d.items():
        if v is None or v == "": continue
        if isinstance(v, (list, dict)): v = json.dumps(v, ensure_ascii=False)
        elif isinstance(v, str) and re.search(r"[:#\"\n]|^\s|\s$", v): v = json.dumps(v, ensure_ascii=False)
        lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"

def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.load(open(MANIFEST, encoding="utf-8"))
    return {"generated_by": VERSION, "sources": {}}

def save_manifest(m: dict):
    m["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")

def same_host_links(html: str, base: str, prefix: str) -> list[str]:
    links = set()
    for href in re.findall(r'href="([^"#?]+)"', html):
        full = urllib.parse.urljoin(base, href)
        if full.startswith(prefix) and full.rstrip("/") != base.rstrip("/"):
            links.add(full.split("#")[0])
    return sorted(links)

# ----------------------------------------------------------------------------
# Hämtning av en post
# ----------------------------------------------------------------------------
def fetch_item(cat: str, item: tuple, manifest: dict, refresh: bool, extra_fm: dict | None = None) -> dict | None:
    sid, url, title, kind = item
    rec = manifest["sources"].get(sid, {})
    if rec.get("status") == 200 and not refresh and (OUT / cat / f"{sid}.md").exists():
        return rec
    print(f"  [{cat}] {sid}")
    status, data, ctype = get(url)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    rec = {"id": sid, "category": cat, "url": url, "title": title, "kind": kind, "status": status,
           "fetched_at": now, "bytes": len(data), "content_type": ctype}
    if status != 200 or not data:
        rec["error"] = f"HTTP {status}"
        manifest["sources"][sid] = rec
        print(f"    misslyckades: HTTP {status}")
        return rec
    rec["sha256"] = sha256(data)
    changed = rec["sha256"] != manifest["sources"].get(sid, {}).get("sha256")
    rawdir = RAW / cat; rawdir.mkdir(parents=True, exist_ok=True)
    is_pdf = kind == "pdf" or "pdf" in ctype or data[:4] == b"%PDF"
    ext = "pdf" if is_pdf else ("json" if "json" in ctype else ("xml" if kind == "sitemap" else "html"))
    rawpath = rawdir / f"{sid}.{ext}"
    rawpath.write_bytes(data)
    if is_pdf:
        text = pdf_to_text(rawpath); page_title = title
        if not text: text = "(PDF sparad i sources-raw; pdftotext saknas eller misslyckades)"
    elif ext == "json":
        text = data.decode("utf-8", errors="replace"); page_title = title
    else:
        page_title, text = html_to_text(data.decode("utf-8", errors="replace"))
    fm = {"id": sid, "type": {"statute": "statute", "lagen-nu": "statute-commentary", "eurlex": "eu", "pdf": cat,
                              "html": cat, "crawl": cat, "sitemap": "index"}.get(kind, cat),
          "title": title, "page_title": page_title, "source_url": url, "fetched_at": now,
          "fetched_by": VERSION, "http_status": status, "content_type": ctype, "sha256_16": rec["sha256"][:16],
          "verification_status": "fetched-unreviewed", "changed_since_last_fetch": changed}
    if extra_fm: fm.update(extra_fm)
    outdir = OUT / cat; outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"{sid}.md").write_text(frontmatter(fm) + text + "\n", encoding="utf-8")
    rec["out"] = str((outdir / f"{sid}.md").relative_to(KB))
    manifest["sources"][sid] = rec
    # crawl one level
    if kind == "crawl" and not is_pdf:
        prefix = url.rsplit("/", 1)[0] + "/" if not url.endswith("/") else url
        links = same_host_links(data.decode("utf-8", errors="replace"), url, prefix)[:60]
        for i, link in enumerate(links):
            sub_id = f"{sid}--{re.sub(r'[^a-z0-9]+', '-', urllib.parse.urlparse(link).path.lower()).strip('-')[:80]}"
            if sub_id not in manifest["sources"] or refresh:
                fetch_item(cat, (sub_id, link, f"{title} → {link}", "html"), manifest, refresh, {"crawled_from": sid})
    if kind == "sitemap":
        subs = re.findall(r"<loc>(.*?)</loc>", data.decode("utf-8", errors="replace"))
        rec["sitemap_entries"] = len(subs)
        (rawdir / f"{sid}-urls.txt").write_text("\n".join(subs), encoding="utf-8")
        # hämta undersitemaps och samla alla URL:er till en lista för manuell prioritering
        allurls = []
        for s in subs[:20]:
            st, d2, _ = get(s)
            if st == 200: allurls += re.findall(r"<loc>(.*?)</loc>", d2.decode("utf-8", errors="replace"))
        (rawdir / f"{sid}-all-urls.txt").write_text("\n".join(allurls), encoding="utf-8")
        print(f"    sitemap: {len(allurls)} URL:er sparade i {rawdir / (sid + '-all-urls.txt')}")
    return rec

# ----------------------------------------------------------------------------
# Specialfall: MO/MEN-beslut och HUDOC
# ----------------------------------------------------------------------------
def mo_men_items(limit: int | None) -> list[tuple]:
    idx = KB / "seed" / "mo_men_index.json"
    if not idx.exists():
        print("  seed/mo_men_index.json saknas"); return []
    rows = json.load(open(idx, encoding="utf-8"))
    items = [(r["id"], r["url"], r["title"], "html") for r in rows]
    return items[:limit] if limit else items

def fetch_mo_men_via_api(manifest: dict, limit: int | None) -> bool:
    """Försök WordPress REST API först: ger ren HTML per beslut. Returnerar True om det fungerade."""
    base = "https://medieombudsmannen.se/wp-json/wp/v2/"
    for ptype in ("beslut", "posts"):
        st, data, _ = get(f"{base}{ptype}?per_page=1")
        if st != 200: continue
        print(f"  WP REST API svarar för '{ptype}'. Hämtar sidvis (100/sida).")
        page, n = 1, 0
        outdir = OUT / "mo-men"; outdir.mkdir(parents=True, exist_ok=True)
        rawdir = RAW / "mo-men"; rawdir.mkdir(parents=True, exist_ok=True)
        while True:
            st, data, _ = get(f"{base}{ptype}?per_page=100&page={page}&_fields=id,date,slug,link,title,content,categories,tags")
            if st != 200: break
            posts = json.loads(data.decode("utf-8"))
            if not posts: break
            for p in posts:
                link = p.get("link", "")
                if "/beslut/" not in link: continue
                sid = "mo-men-" + p["date"][:10] + "-" + p["slug"][:60]
                _, text = html_to_text(p["content"]["rendered"])
                fm = {"id": sid, "type": "case", "body": "MO/MEN", "title": html_to_text(p["title"]["rendered"])[1],
                      "decision_date_published": p["date"][:10], "source_url": link,
                      "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                      "fetched_by": VERSION + " (wp-json)", "sha256_16": sha256(text.encode())[:16],
                      "verification_status": "fetched-unreviewed"}
                (outdir / f"{sid}.md").write_text(frontmatter(fm) + text + "\n", encoding="utf-8")
                (rawdir / f"{sid}.json").write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
                manifest["sources"][sid] = {"id": sid, "category": "mo-men", "url": link, "status": 200,
                                            "fetched_at": fm["fetched_at"], "sha256": sha256(text.encode()), "via": "wp-json"}
                n += 1
                if limit and n >= limit: return True
            page += 1
            save_manifest(manifest)
        print(f"  {n} beslut hämtade via API")
        return n > 0
    return False

def hudoc_fetch(case: tuple, manifest: dict, refresh: bool):
    cid, appno, title = case
    sid = f"echr-{cid}"
    if manifest["sources"].get(sid, {}).get("status") == 200 and not refresh: return
    q = urllib.parse.quote(f'contentsitename:ECHR AND appno:"{appno}" AND (doctype:"HEJUD" OR doctype:"HEDEC" OR doctype:"HFJUD" OR doctype:"HFDEC")')
    api = f"https://hudoc.echr.coe.int/app/query/results?query={q}&select=itemid,docname,appno,doctype,judgementdate,conclusion,languageisocode&sort=&start=0&length=10"
    print(f"  [echr] {sid} ({appno})")
    st, data, _ = get(api)
    if st != 200:
        manifest["sources"][sid] = {"id": sid, "category": "echr", "url": api, "status": st, "error": "HUDOC-API"}; return
    try:
        res = json.loads(data.decode("utf-8")).get("results", [])
    except Exception:
        res = []
    eng = [r["columns"] for r in res if r["columns"].get("languageisocode") == "ENG"] or [r["columns"] for r in res]
    if not eng:
        manifest["sources"][sid] = {"id": sid, "category": "echr", "url": api, "status": 404, "error": "inget träff i HUDOC"}; return
    col = eng[0]; itemid = col["itemid"]
    body_url = f"https://hudoc.echr.coe.int/app/conversion/docx/html/body?library=ECHR&id={itemid}&filename={itemid}.html"
    st2, body, _ = get(body_url)
    if st2 != 200 or not body:
        manifest["sources"][sid] = {"id": sid, "category": "echr", "url": body_url, "status": st2, "error": "body"}; return
    _, text = html_to_text(body.decode("utf-8", errors="replace"))
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    fm = {"id": sid, "type": "case", "body": "Europadomstolen", "title": title, "appno": appno, "hudoc_itemid": itemid,
          "docname": col.get("docname"), "judgment_date": col.get("judgementdate"), "conclusion": col.get("conclusion"),
          "source_url": f"https://hudoc.echr.coe.int/eng?i={itemid}", "fetched_at": now, "fetched_by": VERSION,
          "sha256_16": sha256(text.encode())[:16], "verification_status": "fetched-unreviewed"}
    outdir = OUT / "cases" / "echr"; outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"{sid}.md").write_text(frontmatter(fm) + text + "\n", encoding="utf-8")
    (RAW / "echr").mkdir(parents=True, exist_ok=True); (RAW / "echr" / f"{sid}.html").write_bytes(body)
    manifest["sources"][sid] = {"id": sid, "category": "echr", "url": fm["source_url"], "status": 200,
                                "fetched_at": now, "sha256": sha256(text.encode()), "itemid": itemid}

# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--only", help="kommaseparerade kategorier")
    ap.add_argument("--limit", type=int, help="max antal poster per kategori (provkörning)")
    ap.add_argument("--refresh", action="store_true", help="hämta om även redan hämtade")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--delay", type=float, default=DELAY)
    a = ap.parse_args()
    global DELAY; DELAY = a.delay
    if a.list:
        for cat, spec in SOURCES.items():
            n = len(spec["items"]) + len(spec.get("hudoc_cases", []))
            print(f"{cat:20s} {n:4d}  {spec['beskrivning']}")
        print(f"{'mo-men':20s} {len(mo_men_items(None)):4d}  beslut i seed/mo_men_index.json")
        return
    cats = list(SOURCES) if a.all else [c.strip() for c in (a.only or "").split(",") if c.strip()]
    if not cats:
        ap.print_help(); return
    manifest = load_manifest()
    for cat in cats:
        spec = SOURCES.get(cat)
        if spec is None: print(f"okänd kategori {cat}"); continue
        print(f"\n== {cat}: {spec['beskrivning']}")
        items = spec["items"]
        if cat == "mo-men":
            if not fetch_mo_men_via_api(manifest, a.limit):
                print("  API saknas, hämtar HTML-sidor från indexet")
                items = mo_men_items(a.limit)
                for it in items:
                    fetch_item("cases/mo-men", it, manifest, a.refresh, {"body": "MO/MEN eller PON"})
                    if len(manifest["sources"]) % 25 == 0: save_manifest(manifest)
            save_manifest(manifest); continue
        sub = "cases/" + cat if cat in ("jk", "hd", "echr") else cat
        for it in (items[:a.limit] if a.limit else items):
            fetch_item(sub, it, manifest, a.refresh)
        for case in spec.get("hudoc_cases", [])[: a.limit or None]:
            hudoc_fetch(case, manifest, a.refresh)
        save_manifest(manifest)
    ok = sum(1 for r in manifest["sources"].values() if r.get("status") == 200)
    bad = [r["id"] for r in manifest["sources"].values() if r.get("status") != 200]
    print(f"\nKlart. {ok} källor hämtade, {len(bad)} misslyckade.")
    if bad: print("Misslyckade:", ", ".join(bad[:60]), "..." if len(bad) > 60 else "")
    print(f"Manifest: {MANIFEST}")

if __name__ == "__main__":
    main()
