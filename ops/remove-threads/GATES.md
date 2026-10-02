# Remove people-first Threads from Agentbox

- [x] G1: Desktop and mobile web show no Threads entrypoint or pull gesture, and make no thread requests.
  MANUAL: Browser QA on both sizes; ordinary session navigation remains usable.
- [x] G2: Thread API and MCP tools, task bridges and feature modules are removed from runtime.
  MANUAL: Review imports and runtime endpoint/tool checks; provider thread IDs remain.
- [x] G3: Focused behavioral regressions and root/web typechecks pass.
  MANUAL: Record commands and results in evidence.md.
- [x] G4: Safe deploy preserves live sessions, configuration, routines and browser processes.
  MANUAL: Snapshot and compare using existing preservation route; record backup and rollback.
- [x] G5: The private update layer preserves this removal and final browser QA passes.
  MANUAL: Verify live manifest and browser desktop/mobile.

Evidence for G1–G5: evidence.md; deploy.log; check.log; live-tools.json; typecheck exit 0; desktop/mobile screenshots. All five gates met, zero abandoned.
