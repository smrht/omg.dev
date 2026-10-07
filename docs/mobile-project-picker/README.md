# Project kiezen in de mobiele modelkiezer — 7 oktober 2026

Sam wil op zijn telefoon het project direct in de modelkiezer kiezen. De mappenbalk in
elke lijstweergave (`mobile-folder-rail`) vond hij geen fijne route; die wijziging is
teruggedraaid (balk weer alleen in Projecten, zoals upstream).

Nu: bovenaan de compacte modelkiezer een rij "Project" met de huidige projectnaam. Tik opent
de bestaande `ComposerProjectSheet` (zoeken, Geen project, Alle projecten, map toevoegen).
De samenvattingsregel onder het invoerveld begint met de projectnaam.

Bron: `web/src/App.tsx` + `web/src/components/compact-model-picker-sheet.tsx` (+ test),
basis `54f244b1`. Levering: web-only snapshot via `make_snapshot.py`, activeren met
`activate.py <release> --expected <huidige laag>` onder de update-lock, geen herstart.

## Geactiveerd 7 oktober 2026

`activate.py` → `PROJECT_PICKER_LAYER_ACTIVATED 239 files; service unchanged`. Laag
`06176-project-picker-20261007` (12234 entries, PRIVATE_PRESERVATION_OK); rollback-lagen
`06176-folder-rail-20261007` en `06176-haiku55-20261007` blijven staan. Live entry
`index-B7rocDJS.js`. make_snapshot.py faalde op read-only bestanden in de kopie; opgelost met
`target.unlink()` vóór `copy2` (alleen in de scratchkopie van het script).

Bewijs: schone build (frozen install, prepare-test-builds, tsc + vite) EXIT=0; picker-tests
16/16. Live testbrowser 440px dark embed: Aandacht zonder mappenbalk; modelkiezer toont
"Project · No project"; tik opent Projects-sheet (All projects, No project, 126 projecten);
kies 2buyit → samenvatting "2buyit · Claude · Opus 5.5 · Normaal · Agentbox". Niets verstuurd.
