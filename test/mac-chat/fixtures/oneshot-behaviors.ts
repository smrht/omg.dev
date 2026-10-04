// Fixture: one-shot supervisor answer behaviors for macSshOneShot (item 30):
//   FIXTURE_MODE=delayed     — JSON line + a 100 KB burst, then exit 0. The
//                              burst is written immediately before exit so an
//                              implementation that resolves on `exited` (and
//                              not on drained stdout) returns truncated data.
//   FIXTURE_MODE=nonzero     — JSON line, then exit 3. A real process whose
//                              output LOOKS fine but whose exit status is a
//                              failure must surface as an error.
//   FIXTURE_MODE=probereport — one frozen MacRuntimeProbeReport line, exit 0
//                              (drives serveSshProbeOverride end-to-end).
//   FIXTURE_MODE=hang        — silent for 30s (timeout kill path).
// The mode may ALSO arrive as the first positional argv token (Bun.spawn
// does not observe runtime env mutations in the parent, so tests pin the
// mode deterministically through argv).
const argvMode = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
const mode = argvMode ?? process.env.FIXTURE_MODE ?? "delayed";

function write(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (mode === "delayed") {
  write({ transport: 1, marker: "oneshot-delayed" });
  // ASCII-letters burst: the one-shot contract returns TEXT, so the race
  // payload must survive the UTF-8 round-trip byte-for-byte.
  const burst = Buffer.alloc(100_000);
  for (let i = 0; i < burst.length; i++) burst[i] = 65 + ((i * 3 + 5) % 26);
  process.stdout.write(burst);
  // Exit immediately after the burst: exit-vs-drain race window.
  process.exit(0);
}
if (mode === "nonzero") {
  write({ transport: 1, marker: "looks-fine-but-failing" });
  process.exit(3);
}
if (mode === "probereport") {
  write({
    schema: 1,
    probedAt: Date.now(),
    machineIdentity: "fixture-probe-identity",
    buildManifestSha256: "ab".repeat(32),
    os: { platform: process.platform, version: "99" },
    cliVersion: "claude=fixture-1; codex=fixture-1",
    toolManifestSha256: "cd".repeat(32),
    health: { power: "adapter", thermal: "normal", policy: "eligible" },
    providers: [],
  });
  process.exit(0);
}
if (mode === "hang") {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  process.exit(0);
}
process.stderr.write(`oneshot fixture: unknown mode ${mode}\n`);
process.exit(2);
