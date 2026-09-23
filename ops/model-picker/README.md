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

## Publication — live verified 2026-09-23

Active layer: `06117-1023-picker-20260923`, OMG0.6.117. Previous layer `06117-1022-overview-20260923` retained for rollback.238files published;6465manifest entries verified, applied0.327existing compressed assets retained after content equality checks. Existing assets remain available for open tabs.

Public URL: https://agentbox2.tailda028c.ts.net . Live browser verification repeated390×844,360×640 and desktop1440: `evidence/live-mobile-check.log`, `live-narrow-check.log`, `live-desktop-check.log`; all passed. Light/dark live screenshots inspected. No chat submitted or reset redeemed.

Fresh publication baseline: `/home/agent/.local/state/omg-update-backups/model-picker-1023-publish/`; earlier baseline remains in sibling `model-picker-1023/`. Between preparation and publication the last-agent/model preferences, an account-file hash and active session roster changed independently; these were recorded before any publication writes and the current state was preserved.

`verify-publication.py` passed:26settings,69routines,3Computerprocess identities/config hashes unchanged; all29baseline chats retained (28stilllive,1archived through existing app lifecycle with138transcript messages retained). This accounts for concurrent archiving rather than assuming an active-session roster is immutable. OMG MainPID249428/start time19:21:50CEST unchanged; no restart. See `evidence/preservation-final.log`.

`activate.py` publishes frontend assets before HTML with hash guards; `rollback.py` restores the previous software layer without reverting user data. Reviewed deploy/rollback/verification helpers are retained beside the publication baseline. Temporary staging and local viewport server removed after QA; private evidence and baselines retained.
