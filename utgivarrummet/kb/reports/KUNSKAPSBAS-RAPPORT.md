# Kunskapsbasen – täckningsrapport

Datum: 2026-09-06. Byggd i en molnmiljö utan utgående nät till källsajterna. Allt som krävde hämtning ligger i `fetch_sources.py` och körs lokalt (uppgift 4).

## 1. Vad som finns nu

| Katalog | Filer |
|---|---|
| sources/statutes | 13 |
| sources/eu | 6 |
| sources/self-regulation | 9 |
| sources/guidance | 14 |
| sources/notes | 15 |
| sources/cases/hd | 3 |
| sources/cases/echr | 0 |
| sources/cases/mo-men | 0 |
| sources/cases/grn | 0 |
| sources/cases/jk | 0 |
| sources/preparatory-works | 0 |

- **Paragrafregister** (`seed/provisions.json`): 469 bestämmelser med ordagrann text, 288,050 tecken, ur konsoliderad lagtext (riksdagen.se, snapshot från hubben, datum okänt).
- **MO/MEN-index** (`seed/mo_men_index.json`): 946 beslut 2002–2026 med datum, medium, utfall (270 klander, 147 friande, 529 oklara ur rubriken), ämnestaggar och URL. Fulltext saknas.
- **Praxisregister** (`seed/case_law.json`): 54 poster. Status: {'verified-from-source': 1, 'to-read': 1, 'secondary': 14, 'to-fetch': 32, 'legacy-unverified': 6}.
- **Begrepp** (`seed/concepts.md`, 19 avsnitt) och **checklistor** (`seed/checklists.md`, 13 listor) med paragrafhänvisningar.
- **Noteringar** (`sources/notes/`, 9 filer) från webbsökningar, alla märkta `secondary-unverified` med källänkar.

Bestämmelser per lag:

| Lag | Antal |
|---|---|
| Tryckfrihetsförordning (1949:105) | 111 |
| Yttrandefrihetsgrundlag (1991:1469) | 100 |
| Brottsbalk (1962:700) | 25 |
| Radio- och tv-lag (2010:696) | 124 |
| Lag (1960:729) om upphovsrätt till litterära och konstnärliga verk | 5 |
| Lag (2018:218) med kompletterande bestämmelser till EU:s dataskyddsförordning | 8 |
| Skadeståndslag (1972:207) | 3 |
| Kamerabevakningslag (2018:1200) | 11 |
| Rättegångsbalk (1942:740) | 7 |
| Offentlighets- och sekretesslag (2009:400) | 10 |
| Lag (2017:151) om meddelarskydd i vissa enskilda verksamheter | 6 |
| Lag (2016:319) om skydd för geografisk information | 16 |
| European Media Freedom Act (EMFA) | 9 |
| GDPR (fulltext) | 5 |
| Digital Services Act (DSA) | 5 |
| Audiovisuella medietjanstdirektivet (AVMSD) | 4 |
| Anti-SLAPP-direktivet | 11 |
| Lag (2018:1197) om Förenta nationernas konvention om barnets rättigheter | 9 |

## 2. Fynd som ändrar förutsättningarna för appen

1. **TV4 lämnade marknätet 2026-01-12.** Tillståndsvillkoren om saklighet, opartiskhet, genmäle och privatliv (RTVL 4 kap. 8–9 §§) föll bort; lagens innehållsregler (5–8 kap.) och Granskningsnämndens granskning av dem (16 kap. 2 §) består. Sakligheten prövas nu av MO/MEN. Den gamla kunskapsbasens GRN-fokus är delvis inaktuellt. (`notes/2026-tv4-lamnar-marknatet-granskningsnamnden.md`, sekundärkällor; lagtexten verifierad.)
2. **Preskriptionen för TV4 Play och tv4.se löper från borttagandet**, inte från publiceringen (YGL 7 kap. 3 § 2). Den gamla kunskapsbasens "6 månader från publicering" gäller bara själva sändningen.
3. **Olaga integritetsintrång (BrB 4 kap. 6 c §) finns inte i brottskatalogen (TF 7 kap.)** och kan därför inte lagföras mot innehåll i ett grundlagsskyddat medium; kränkande fotografering (6 a §) träffar själva upptagningen. Den gamla kunskapsbasen hade rätt i sak men utan källa.
4. **Direktsändningar av dagshändelser som andra anordnar** undantas från YGL:s brottsregler och anonymitetsskydd (YGL 1 kap. 16 §). Relevant för live.
5. **Rättelseplikten i RTVL 5 kap. 4 §** är "ska" för sändning på annat sätt än genom tråd (satellit) och "bör" för tråd (kabel, fiber).
6. **Anti-SLAPP-lagen (2026:241)** i kraft 2026-05-01 och **EMFA-lagen (2025:1242)** från 2026-01-01.
7. **Utlandsspioneri** är tryckfrihetsbrott sedan 2023 (TF 7 kap. 14 a §).
8. **MEN mot TV4 2025–2026:** genrebild i negativ kontext klandrad trots liten identifieringskrets; dokumentärserien om Joakim Lundell klandrad för uppgifter om mamman. (Sekundärkällor.)

## 3. Vad som är verifierat och vad som inte är det

- **Verifierat ur primärtext:** allt i `seed/provisions.json` (men snapshotdatum okänt; kör skriptet för färsk lydelse och hash). Publicitetsreglernas lydelse (MO:s sida, snapshot). HD:s referat av Vaccindokumentären.
- **Sekundärkällor, verifiera:** alla `notes/`, GRN- och MEN-referaten, JK:s åtalspolicy, Samnytt-målets HD-läge (motstridiga uppgifter), Europadomstolens svenska fall.
- **Legacy, overifierat:** sex Europadomstolssammanfattningar ärvda från den gamla kunskapsbasen (märkta i `case_law.json`).
- **Inte i kunskapsbasen alls:** MO/MEN-beslutens fulltext (946), Europadomstolens domar och faktablad, GRN:s praxissamlingar och beslut, JK:s beslut i sak, HD-domar i fulltext, tillämpningslagen (1991:1559), lag (2026:241), lag (2025:1242), EKMR-texten på svenska, förarbeten, IMYRS 2022:2, Sveriges Tidskrifters och Utgivarnas handböcker, TV4:s egna dokument.

## 4. Kända fel att rätta

- AV-direktivet i kb är 2010-texten; art. 6a och 28b saknas. Skriptet hämtar den konsoliderade versionen.
- Barnkonventionen finns bara som engelsk konventionstext i riksdagens fulltext; svensk översättning hämtas separat.
- RB 5 kap. 9 a–c §§ (fotografering i rättssal) och URL 7 kap. 53–54 §§ tolkades inte; lägg till i `tools/extract_provisions.py`.
- TF:s "instruktion" (motsvarigheten till YGL 1 kap. 15 §) har inte lokaliserats i paragrafregistret.
- Gammal och ny paragrafnumrering (före och efter 2019) saknar aliastabell.

## 5. Nästa steg, i ordning

1. **Nytt privat repo** och flytt av `kb/` dit (Das-Boot är publikt; tredjepartskopior är gitignorerade här).
2. **`python3 kb/fetch_sources.py --all`** lokalt. Provkör först: `--only statutes --limit 3`. Skriptet skriver `MANIFEST.json` och `sources/` med tidsstämplar och hash.
3. **Praxislagret:** läs och tagga MO/MEN-korpusen (946 beslut) och GRN:s beslut om TV4; fyll `case_law.json` med princip och lagrum per beslut; sätt `reviewed`.
4. **TV4-internt:** utgivarordning, policyer, registrering hos Mediemyndigheten, utgivningsbevis (uppgift 6).
5. **Juridisk läsning:** låt en medierättsjurist läsa `concepts.md` och `provisions.md` innan appen får citera dem.
