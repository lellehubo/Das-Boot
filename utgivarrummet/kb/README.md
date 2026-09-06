# Kunskapsbas för Utgivarrummet

Kunskapsunderlag för en utgivarassistent på TV4 Nyheterna: medierätt, pressetik och praxis, samlat med proveniens så att appen kan visa varifrån varje påstående kommer.

## Innehåll

```
kb/
  CONVENTIONS.md        regler för lager, frontmatter och proveniens
  MANIFEST.json         alla källor med URL, hämtdatum, hash och status (skrivs av fetch_sources.py)
  fetch_sources.py      körbar hämtpipeline, körs lokalt: python3 kb/fetch_sources.py --all
  tools/                normalisering och extraktion (körs utan nät)
  sources/              källfiler i markdown med frontmatter, se CONVENTIONS.md
  seed/                 strukturerade register byggda ur källorna
  reports/              täckningsrapport, luckor, verifieringsstatus
```

## Arbetsordning

1. `python3 kb/fetch_sources.py --all` på en dator med öppet nät. Skriptet är återkörbart; en ändrad källa får ny hash och markeras i manifestet.
2. `python3 kb/tools/extract_provisions.py` bygger `seed/provisions.json` ur lagtexterna.
3. `python3 kb/tools/build_mo_men_corpus.py` bygger `seed/mo_men_index.json` med fulltext ur de hämtade besluten.
4. Praxislagret (`seed/case_law.json`) fylls därefter beslut för beslut, med källfil och beslutsnummer.

## Status 2026-09-06

Se `reports/KUNSKAPSBAS-RAPPORT.md`.
