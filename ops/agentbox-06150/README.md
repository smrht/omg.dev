# Agentbox OMG 0.6.150 with private setup preserved

Scope: official 0.6.150 + existing private fork, Updates panel placement, safe
browser memory relief. Issue smrht/sites-beheer#1040. These one-time paths are
specific to the 2026-09-30 cutover; do not replay them after newer changes.

Official Linux x64 SHA256:
`b7b8667629a1c10c3f2122fad6e30f075ca6316c0b5c6c1c6e982865e0b69bac`.

Before preparation, all 180 protected source entries matched the previous
private source commit. Source merge resolves the duplicate roster introduced
by upstream pins without losing resumable sessions, custom overview, model
favorites, Flash, usage and per-chat Daybreak. The project filter remains a
sticky local preference, as requested; upstream's new expiry does not clear it.
The workspace Updates list now portals from a compact header trigger and
scrolls inside a viewport-bounded popup. The actual rail and mobile sheet remain.

`stage.py` starts from the verified official archive, applies explicit fork
source deltas and final protocol/client/web builds, and retains every existing
hashed web asset. Startup SQLite/shared-checkout/isolation transforms must be
no-ops. `preserve.py` rejects unknown drift and a wrong version before applying
anything. Replay and second replay are tested.

`agents.py` checks the old official builder skill by its exact checksum, adds
missing official template files, and never replaces a personal edit. Its plan,
previous bytes, exact post-update hashes and standalone rollback helper are
retained in the backup. Existing personal agents files remain outside replacement.

`run-safe.sh` calls the existing safe updater with pinned preflight, activation,
restart and health hooks. Before cutover it creates and verifies software,
config and online SQLite snapshots (`quick_check`). Runtime replacement excludes
`data`, `agents` and env files. The only agent-file changes use the separately
verified narrow plan. The service's `KillMode=process` preserves agent children;
post-cutover checks compare settings/routines/config hashes, session adoption
and unchanged Computer PID/start identity. A failed cutover restores software,
bundled-file edits and the old private pointer, never later user data.

`rollback-runtime.py` is copied beside the verified backup manifest. Run it there
with Python to restore software only; it includes the bundled-file rollback.
Safety layer and Codex CLI service override remain unchanged.

Browser: Chromium Memory Saver enabled in its existing profile through the
browser settings API (balanced/default timer retained). `browser-memory.ts`
backs up preference/session metadata privately and collects only unreachable
JavaScript objects. It does not close, unload or force-discard any user tab.
The preference-only restore helper leaves current profile and sessions intact.
No paid generation or provider API was exercised.

Acceptance: root/web types, final production build, 102 UI tests, 170 focused
Linux backend/isolation/upstream tests. Full all-files Mac suite is not green:
Linux /proc assumptions, temp-path realpath assertions and shared closed-SQLite
fixtures fail there. Linux checks isolate files and include the full template
fixture. Do not label the full suite passed. Public browser acceptance and live
preservation results are recorded after activation below.

Live acceptance (2026-09-30): safe updater completed successfully, verified
backup at `/home/agent/.local/state/omg-update-backups/update-06150/20260930T183605Z-v0.6.143-620faaba`.
Running API and public browser both report 0.6.150. Private manifest: 9,676
entries, zero changes on final replay. All 26 settings, 83 routines, baseline
27 session identities/transcripts and three Computer process identities remain.
The later `check-live <backup>` audit accepts only additional account bindings
for new live chats or chats proved normally ended with a durable transcript;
account records and all pre-existing bindings must still
equal the verified backup. Activation `check` remains byte-exact.

Public Firefox acceptance passed at desktop widths 1500/1200/1024 and mobile
390x844: Updates bounds/scroll, Escape/focus/outside click, report open/back,
dark quick menu, Thread open/back, Flash/favorites/usage, Sol 6.1 selection,
Daybreak toggle on an account-entitled model, and all four own-media provider
choices. No chats sent, routines triaged, findings dismissed or media generated.
Browser preferences are restored after the probe. Sol 6.1 offers only
`standard` today; Daybreak is not invented for a model the account does not offer.

Browser GC: 9.8649 -> 9.3605 GiB, all 44 user tabs retained, no forced unload.
Memory Saver is enabled. Later load was about 9.52 GiB while chats continued;
host and Computer PSI avg10 were zero. This is a measured reduction, not a
claim that future browser memory is fixed at 9.36 GiB. The preference-only
restore script remains in the browser backup. No new failed units; the
pre-existing cross-backup-borg failure is separate from this release.

iPhone crash fixes require a newer TestFlight app for the full native fix;
updating the Agentbox runtime does not install an iPhone application.
