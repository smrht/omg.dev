# Update protection for removed Threads

OWNS: ops/no-threads-guard/**
Scope: Keep people-first Threads absent through updates and service startup; verify official 0.6.157 is refused without replacing live software.

- [x] G1: Guard passes the removed implementation and rejects API, tool and active web regressions.
  CHECK: python3 ops/no-threads-guard/test_guard.py
  EXPECT: GUARD_TESTS_OK
  EVIDENCE: evidence.md G1; GUARD_TESTS_OK, 8 tests.
- [x] G2: Safe updater rejects a restored Threads feature before restart and rolls software back.
  EVIDENCE: evidence.md G2; 8 updater tests pass.
- [x] G3: Official 0.6.157 is rejected and installed service remains healthy on 0.6.150.
  EVIDENCE: evidence.md G3; official digest verified, live version unchanged.
- [x] G4: Persistent startup hook and updater check are installed outside the replaceable runtime.
  EVIDENCE: evidence.md G4; LIVE_POLICY_OK and LIVE_HASHES_OK.
