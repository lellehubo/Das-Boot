# Utgivarrummet (tillfällig placering)

Den här katalogen hör inte till Das Boot. Den ligger här tillfälligt tills ett privat repo för Utgivarrummet finns, eftersom molnsessionen bara kan pusha till detta repo.

- `kb/` är kunskapsbasen för en ny utgivarassistent för TV4 Nyheterna: lagtext med proveniens, paragrafregister, praxisregister, begrepp, checklistor och en körbar hämtpipeline. Läs `kb/README.md` och `kb/reports/KUNSKAPSBAS-RAPPORT.md`.
- Kopior av tredjepartssidor är gitignorerade och återskapas med `python3 kb/fetch_sources.py --all`.

Flytta hela katalogen till det nya repot och ta bort den härifrån.
