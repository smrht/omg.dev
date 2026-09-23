# Compact model picker

Issue: https://github.com/smrht/sites-beheer/issues/1023
Source repository: smrht/omg.dev, branch codex/chat-overview.

The mobile composer opens a compact picker with an agent dropdown, up to three favorite models, full searchable model catalog, explicit supported thinking levels and usage details. Favorites are per-agent browser-local state, synchronized between mounted pickers and tabs. More than three favorites stay in the full list; unavailable catalog models are retained in storage. Existing selection and launch handlers remain the source of truth. Desktop receives favorite stars in its existing picker. No backend or configuration migration.

## Verification

- `sh ops/model-picker/check-code.sh`: root/web typechecks, 34 tests and119 assertions passed.
- Node/Vite production build passed. Existing large-chunk advisory remains.
- `functional-qa.py --frame`: exact390×844 and360×640 responsive Firefox, light/dark, search, favorites add/remove/persistence/isolation, real Flash thinking options, keyboard/focus, usage and all-agent overview, draft/input controls. No session submitted.
- `desktop-qa.py --url http://127.0.0.1:5176/`: existing desktop1440 picker, agent/search/star/Flash selection and no overflow.
- `design-qa.md`: normalized combined source/render comparison passed. Larger than the generated concept to preserve44px touch targets.
- Multiple live Claude profiles were unavailable; their selection path is covered by render tests, not claimed live-proven. No physical iPhone/Safari test or exhaustive unrelated upstream suite.

Screenshots and browser logs stay under ignored `evidence/` because they contain real conversation metadata. Tests restore browser preferences and do not submit chats or redeem reset credits. Local preview uses a temporary390×844 iframe to avoid Firefox's500px minimum outer window, without changing app CSS. Node runs Vite because this installed Bun/Vite combination failed websocket proxying.

## Publication

Code-ready. Publication pending Tailscale SSH identity revalidation. No live changes yet.

Prepared layer: `06117-1023-picker-20260923`, based on `06117-1022-overview-20260923`. The existing immutable snapshot process retains all current customizations and old assets for open tabs. `activate.py` is frontend-only and hash-guarded, publishes assets before HTML and does not restart the service. `rollback.py` restores the previous layer without reverting user data. Baseline: `/home/agent/.local/state/omg-update-backups/model-picker-1023/` (26 settings,69 routines,21 session IDs,3 Computer PID/start-time identities and OMG service identity).
