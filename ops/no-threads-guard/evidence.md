# Evidence — 2 October 2026

All four gates met; no abandoned gates. Work executed directly, without workers.

- G1: `python3 ops/no-threads-guard/test_guard.py`: 8 tests pass, `GUARD_TESTS_OK`.
  Positive controls exercise every feature token in server and active lazy JS,
  restored module, missing entrypoint/asset, external script. Clean fixture and
  retained inactive bundle pass. Live scan passes across 406 active web files.
- G2: `python3 scripts/agentbox/test_omg_safe_update.py` in sites-beheer: 8 tests
  pass. Simulated update creates `src/threads.ts`; policy rejects before restart,
  rollback removes it, only the restored release starts and mutable state remains.
  Missing policy checker refuses before update/snapshot. Existing rollback tests pass.
- G3: official GitHub v0.6.157 `omg-bundle.tar.gz`, SHA256
  `112ff66dba287db50c26e940df02789e9311ea2610e6063841079930c844c3e8`,
  verified against GitHub release API digest. Extracted in isolated cache;
  checker reports restored source module, API/MCP registrations and active UI.
  Existing private preflight rejects version 0.6.157 before applying files.
  This was the platform-neutral source/web archive, not the full Linux dependency archive.
- G4: `python3 ops/no-threads-guard/verify-live.py` returns `LIVE_POLICY_OK`
  and `LIVE_HASHES_OK`. Deployed updater invokes installed policy with current
  tree (pass) and official candidate (refused). systemd loaded hook runs after
  resource/private/isolation overlays. Current version stays 0.6.150, service
  active, same PID 1790026, root HTTP200, /api/threads and /api/threads/new404.
  No restart or live upgrade was performed for this policy installation.

Deployed hashes:
- updater: 2e067b5c360055fee8369cc60701d66f5e90457484033d81982b60e9d209a499
- checker: d3d05578037920b03c44db590980e50cb33c6860b1ba268c42e2b9a82337b8d2
- systemd hook: b38c1d0fb8a0c100e29712dc484774a937087ba65f6bc7804ee970af5fc3caf4

The prior updater is backed up at
`~/.local/state/omg-no-threads-backup/omg-safe-update-before`.
Do not remove the policy to install an unsupported release. Port the removal and
verify the future release first. Update availability is not local approval.
