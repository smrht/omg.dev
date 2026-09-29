# Local verification — 0.6.143 / own accounts / media

2026-09-29. This is local evidence, NOT a live Agentbox release.
No remote writes in this run; mandatory Tailscale SSH verification is pending.

- Isolated Codex CLI 0.159.0 with the existing Mac ChatGPT login: actual Sol 6.1
  short reply OK, actual Sol 6 Daybreak Blue requested turn OK. No served-policy
  claim; no global Mac CLI/default/auth change.
- Actual thread pipeline: persisted Sol 6.1 selection → routing prompt → own
  Codex turn → parsed short reply → two stored messages, no task started.
- Own-media core and UI: 65 passing focused tests after primary review. Real
  decoded PNG and ffmpeg MP4 through the default artifact path; malformed/header-
  only files refused. Concurrent idempotency/cancel/poll, bounded downloads,
  cost guards, manual upload, unknown video adapters and cache cleanup covered.
- Thread-media bridge offline HTTP contract tests pass; successful media results
  post through the existing ThreadMedia shape without model inference.
- Actual interface components checked through Selenium/approved Firefox CLI:
  desktop light/dark and 390px iframe viewport, four provider choices, model
  selection and conditional Daybreak, no horizontal overflow. A local component
  harness supplies provider metadata only: this is not live API generation.
- Existing picker, overview, workspace, usage controls and merge logic regression
  files pass, as do session relaunch/token attribution checks available on Mac.
- Three session-relaunch-containment cases skip on Mac and REQUIRE Linux.
  session-usage.test.ts requires /proc/systemd-run (10 Mac failures); not a
  cross-platform acceptance gate. usage-providers.test.ts has one unchanged
  upstream list assertion omitting the already-present Devin provider; 24 pass.
  src/usage.ts and these two test files are unchanged by this implementation.
- No paid OpenAI/KIE/Flow/OMG media generation. Agentbox credentials, pricing,
  actual remote catalog/login, active sessions/Computer/routines and preservation
  manifest require remote verification before activation.

Final review evidence:
- Backend focused suite: 268 pass, 0 fail, 11 files.
- Frontend focused suite: 49 pass, 0 fail, 6 files.
- Root and web typechecks: exit 0; protocol/client prerequisite builds exit 0.
- Production web build: exit 0 (7.61s); ordinary bundle-size warning remains.
- Actual own OpenCode account: GLM 5.3 / max → persisted Thread → OK reply,
  two messages, no task. The earlier over-strict direct probe rejected a
  non-exact greeting; the full real Thread response supersedes it.
- Send waits for successful model persistence; failed saves keep messages unsent.
- JSONC quoted strings/trailing commas, bounded MCP-source scan and teardown of
  an exited process-group leader covered by review. The local Bun detached
  subprocess was independently confirmed to lead its private process group.
- Browser component QA rerun after final UI changes: desktop light/dark and
  mobile 390px pass. No full live application/browser account claim.
- Real manual-result HTTP handlers → default decoded artifact → ThreadMedia:
  image/png 1x1, one posted message; retry refused without a duplicate. No paid
  generation. OpenAI 2.5 xhigh/max options match current official guide.
- Public Agentbox bootstrap rechecked: still 0.6.138, now 20 sessions. Sessions
  are active mutable state: recapture before any safe activation, never use
  the earlier 18-session baseline as a current roster.

A full global bun suite is not claimed: A full global bun suite is not claimed:
shared/global fixtures and Linux-specific tests are separate requirements.
