# Mappenbalk op mobiel in elke weergave — 7 oktober 2026

Sam kon op zijn telefoon geen map meer kiezen voor een nieuw gesprek. De mobiele
composer heeft geen eigen mapknop; de mappenbalk onder de header is de mapkiezer.
Die balk stond alleen in de lijstweergave "Projecten", terwijl "Aandacht" de standaard is.
Nu staat de balk in alle drie de weergaven (Aandacht, Alle chats, Projecten).
Desktop ongewijzigd.

Bron: `web/src/App.tsx`, basis `54f244b1` (chat-direct, = live App.tsx SHA256
16d445e9f479c8c3b8a00b04af77a6752468e6750cc7d5b82df3ca91ae1e41db).

Levering: web-only snapshot afgeleid van de actieve laag (`06176-haiku55-20261007`)
met `~/sites-beheer/omg-fork/0698/make_snapshot.py`, oude hashed assets blijven.
Activeren met `activate.py <release> --expected 06176-haiku55-20261007` onder de update-lock.
Geen serviceherstart. Terugdraaien: pointer terug naar de vorige laag en de gewijzigde
frontendbestanden uit die laag terugzetten; nooit gebruikersdata.

## Geactiveerd 7 oktober 2026

`activate.py` → `FOLDER_RAIL_LAYER_ACTIVATED 237 files; service unchanged`. Laag
`06176-folder-rail-20261007` (12000 entries, PRIVATE_PRESERVATION_OK); vorige laag
`06176-haiku55-20261007` blijft staan als rollback. Live entry `index-BWVxAMn4.js`.

Bewijs: build in schone map (`bun install --frozen-lockfile`, prepare-test-builds, web
`tsc --noEmit` + vite) via agentbox-run-heavy, EXIT=0. Tests: project-pill-rail 6/6;
project-filter + session-overview 6/8, dezelfde 2 failures op de basiscommit. Live,
geïsoleerde testbrowser 440px dark: weergave Aandacht toont de mappenbalk; tik op
`2buyit` zet `lfg_v2_project_filter=2buyit`. Niets verstuurd.
