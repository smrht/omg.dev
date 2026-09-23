# Desktop workspace

Issue: https://github.com/smrht/sites-beheer/issues/1024
Source repository: smrht/omg.dev, codex/chat-overview.

## Design contract

Approved combination of desktop options1 and2. Reference exec-7ddc00a6-3a69-4ece-8aeb-e5b3c4a9cabc.png. Narrow global rail, short integrated composer, broad conversation list and real selected-conversation preview. Existing theme tokens, system font, existing agent artwork and icon library are retained; no new image assets are needed.

Open gesprek navigates to the existing session. Returning with Gesprekken restores the same query, filters and scroll. Existing session lifecycle remains the owner; this is a frontend layout change.

Motion: short focus/selection color transitions communicate selection, no animated reordering of live rows; reduced-motion remains respected. Requested transitions-dev/transitions-polish skills were not installed at their listed paths. Modern-web-guidance scroll affordance guidance was reviewed; scrollbars remain available in Firefox/Safari, no dependency on unsupported scroll-state queries.

## Verification and publication

Root/web typechecks and 89 focused tests (235 assertions) passed, including shared overview, model picker and shortcut ownership. Production build passed with existing bundle/minifier advisories. Desktop Firefox 1619/1280/1024: real open/return, query/filter/scroll, draft retention, keyboard open and two-panel selection. Mobile Firefox 390×844 and 360×640: existing favorites, Flash, thinking, usage and draft flows pass. One initial 390px run timed out opening the all-agent usage overlay; a fresh full rerun and 360px run passed without code changes. Physical iPhone/Safari and multiple live Claude profiles are not claimed.

Published frontend-only layer: `06117-1024-desktop-20260923`, based on `06117-1023-picker-20260923`. Baseline and operational scripts: `/home/agent/.local/state/omg-update-backups/desktop-1024-publish/`. Activation changed 236 web files; guard verifies 6697 entries. Settings/configuration hashes, 69 routines, 20 baseline active session IDs and 3 Computer process identities were retained. OMG PID/start time unchanged; no restart.

Public Firefox acceptance passed at desktop 1619/1280/1024 and mobile 390×844/360×640. Desktop also verified Settings and Computer navigation. Evidence: live-check.log, mobile-live-retry.log, mobile-live-narrow.log and preservation-final.log. The first public mobile run was intercepted by the normal update toast; after the normal Reload action, the full test passed. Source hashes match the installed manifest (3/3). Evidence remains local and ignored because it includes conversation metadata.

## Repeatable deployment and rollback

1. Read current pointer and run its preserve.py against ~/omg; capture a fresh state.py baseline and service identity.
2. Build with Node/Vite. Stage changed source and dist without sourcemaps; normalize only compressed assets whose decoded bytes match the old asset.
3. Derive immutable release with the existing make_snapshot.py; include App.tsx, index.css and the new desktop-workspace.tsx.
4. Run activate.py with the expected old release; it locks publication, verifies hashes, writes assets before HTML and switches the pointer. It does not restart OMG or touch session data.
5. Run verify-publication.py against the fresh baseline, followed by public Firefox desktop/mobile QA.
6. If necessary run the reviewed rollback.py on Agentbox. It accepts only this exact release and restores the previous web layer while retaining current data and old/new assets for open tabs. A later release requires a new reviewed rollback.
