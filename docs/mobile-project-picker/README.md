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
