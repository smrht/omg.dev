# Threads removal — 2 October 2026

Live runtime: Agentbox2 OMG 0.6.150. Scope: people-first Threads in the Agentbox server and responsive web client. Ordinary agent conversations, provider thread IDs, bots, routines and own-media remain.

Removed: web rail/overview entrypoints, pull gesture, composer and route; thread polling; three MCP tools; thread API and mention lookup; thread task/completion/push/media bridges; thread-only completion adapters and isolation mode; create/update thread persistence helpers. Historical data and shared protocol shapes remain readable. Native iOS application releases are outside this Agentbox deployment.

Verification:
- Root and web TypeScript checks: pass, repeated on the final candidate.
- 179 behavioral regressions: pass, 0 failures, across 12 files. Covers capabilities, historical envelope parsing, conversations, Daybreak, isolation, own-media, markdown/session links and desktop workspace/rail.
- Additional preservation test: tombstones replay idempotently, reject unknown drift, and remove only reviewed upstream content.
- Vite production build: pass. Existing CSS `::highlight` and large chunk warnings remain.
- Candidate and LIVE MCP tools/list: 58 tools, session tools present, all three thread tools absent.
- Safe updater preflight and apply: PASS. Five SQLite snapshots passed quick_check; software/config/data hashes verified before activation.
- Preserved: 26 settings, 88 routines (including timeout and quiet settings), 20 baseline session identities (normally completed sessions verified through durable history), three Computer PID/start identities. No new failed unit.
- Before reload, real browser showed New thread and old entry index-CFtARq8s.js. After reload: index-C2Hau_92.js; no thread controls, no /api/threads requests.
- Desktop 1440x1000 and mobile 390x844: no horizontal overflow; composer and conversation list present; screenshots visually inspected. Mobile normal session open/back succeeds. Desktop ordinary session selection succeeds.
- Browser resource 404s were /api/runtime-status (also referenced by the old bundle) and a repository favicon. No thread requests or uncaught application exception observed.
- Live /api/threads and /api/threads/new: 404.
- Private preservation manifest: 9923 entries, zero drift. New isolation startup transform is a no-op and passes --check. Current private and isolation pointers both end in 06150-no-threads-20261002.

Backup on Agentbox2:
`/home/agent/.local/state/omg-update-backups/remove-threads-20261002/20261002T173541Z-v0.6.150-2c2929fe`

Verified deployment scripts, exact plan, logs and screenshots:
`/home/agent/.cache/agent-tmp/threads-removal-20261002/`

The deployment applies only listed files to the current live tree. It preserves later live auto-runtime limits and Mac-first policy that postdate the source branch. Previously served hashed assets remain for already-open tabs; new clients cannot enter Threads. Refresh an old tab to load the new interface.

Recovery: review the saved plan and backup, then invoke the saved run-safe.sh --rollback with the exact backup directory name. The restart hook detects the restored source and restores BOTH old private and isolation pointers. It never restores old user data over new activity. This is a one-time deployment directory; do not replay staging or activation after subsequent releases.

No paid model/media requests or chat messages were sent. The requested OpenCode worker was stopped before implementation; the primary agent performed the change and checks.
