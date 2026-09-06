# Konventioner för kunskapsbasen

Kunskapsbasen följer Insynsexperten-mönstret: **hämta, återge, hänvisa. Aldrig återge ur modellminne.**

## Lager

| Lager | Katalog | Innehåll | Får modellen citera? |
|---|---|---|---|
| 0 Primärkällor | `sources/statutes`, `sources/eu` | Konsoliderad lagtext, EU-förordningar, EKMR | Ja, ordagrant med paragraf |
| 1 Självreglering | `sources/self-regulation` | Publicitetsreglerna, MO:s instruktion, MEN:s stadgar, yrkesreglerna | Ja, ordagrant med regelnummer |
| 2 Praxis | `sources/cases/*` | MO/MEN, GRN, JK, HD/hovrätt, Europadomstolen, EU-domstolen | Ja, med beslutsnummer, datum och utfall |
| 3 Vägledning och förarbeten | `sources/guidance`, `sources/preparatory-works` | Myndighetsvägledningar, propositioner, SOU, Ds, handböcker | Ja, som "enligt X" |
| 4 Sekundärkällor | `sources/notes`, `sources/press` | Nyhetsartiklar, analyser, sökresultat | Endast som indikation, alltid märkt "verifiera" |
| Seed | `seed/` | Strukturerade register byggda ur lager 0–3: `provisions.json`, `mo_men_index.json`, `case_law.json`, `concepts.md`, `checklists.md` | Ja, men varje post pekar på sin källfil |

## Frontmatter (obligatorisk i varje källfil)

```yaml
id: sfs-1949-105-tryckfrihetsforordning      # stabilt id, används i seed-filer
type: statute | eu | self-regulation | guidance | preparatory-work | case | note | press
title: Tryckfrihetsförordning (1949:105)
source_url: https://...
fetched_at: 2026-09-06T14:02:11Z             # eller "okänt (...)" för äldre snapshots
fetched_by: kb/fetch_sources.py v1
sha256_16: 0f3a...                           # första 16 tecken av sha256 över brödtexten
verification_status: snapshot-unverified | fetched-unreviewed | reviewed
amended_through: t.o.m. SFS 2022:1524        # lagar
```

Statusar: `snapshot-unverified` = kopierad från hubbens gamla nedladdning, datum okänt. `fetched-unreviewed` = hämtad av skriptet med tidsstämpel, ingen människa har läst. `reviewed` = Lelle eller jurist har läst och godkänt.

## Proveniens i seed-filer

Varje post i `provisions.json` och `case_law.json` har `source_id` (frontmatter-id) och `locator` (paragraf, artikel eller beslutsnummer). Ordagrann text ligger i `text`. Egna sammanfattningar ligger i separata fält (`au_relevans`, `princip`) och märks som tolkning.

## Numrering

TF och YGL omnumrerades genom SFS 2018:1801 och 2018:1802 (i kraft 2019-01-01). Använd bara ny numrering. Äldre praxis och litteratur hänvisar till gamla paragrafer; en aliastabell läggs i `seed/provision_aliases.json` när praxislagret byggs.

## Vad som aldrig får hända

- Ett påstående om gällande rätt utan `source_id`.
- Ett beslutsnummer, ett målnummer eller ett årtal som inte finns i en källfil.
- Att en sekundärkälla (lager 4) presenteras som primärkälla.
- Att en text utan å, ä, ö går vidare till appen. Hela kunskapsbasen är skriven med korrekt svenska.
