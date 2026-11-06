// Fixture: a supervisor-shaped process whose stdout is NOT a probe report.
// Drives the fail-closed parse path of sshProbeRuntime — reachability is
// preflight, never proof (no invented parity booleans).
process.stdout.write("not-json\nnot-json-either\n");
process.exit(0);
