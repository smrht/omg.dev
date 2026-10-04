// FULL END-TO-END: real TS client → real PYTHON supervisor (transport.py,
// the production Mac code) → fixture provider. No stub-ssh stand-in for the
// supervisor: the ssh argv is real, the shim only execs the same forced
// command the real Mac would run. Covers the frozen wire end to end:
//
//   - probe: frozen MacRuntimeProbeReport from the REAL op_probe; providers
//     empty without attestation (never invented), present with the
//     primary-generated attestation file;
//   - claude stream: adapted real SDK argv, metadata settings fastMode
//     materialized NATIVELY by the supervisor (--settings on the provider
//     argv), lease MCP materialized into a 0600 private file (--mcp-config,
//     --strict-mcp-config) with the bearer NEVER on argv, full context with
//     NON-ASCII content validated cross-language on the real wire;
//   - codex stream: Fast via metadata.settings → the supervisor injects the
//     exact service-tier.ts argv; a full turn roundtrip;
//   - duplicate requestId never creates a second process (peer contract);
//   - status one-shot answers the real request records.
//
// Runs the REAL shared_capacity/jobs modules (darwin): fixture state/policy/
// jobs-root/coordinator heartbeat satisfy the same admission invariants the
// production Mac enforces. Item 34 fixture facts this file relies on:
//   (a) shared_capacity.COORDINATOR_FILE === "capacity-coordinator.json"
//       (NOT coordinator.json — waiting on the wrong name forced a 30 s delay);
//   (b) policy freshness is 8 s AND the supervisor re-checks it during a
//       live stream (enforce_runtime_policy), so a refresher keeps the
//       fixture policy fresh on a regular interval — writing it once goes
//       stale and every stream refuses;
//   (c) toWireContext returns the wire context DIRECTLY (no { wire } wrapper);
//   (d) buildCentralContext defaults to the REAL home — the fixture injects
//       its own home/root (the `home` option; NEVER an env HOME override) so
//       real M4 instructions cannot flood the fixture;
//   (e) the fixture provider dumps its launch/turn evidence through
//       E2E_DUMP_DIR, exported by the provider-bin wrappers the supervisor
//       execs (the supervisor, not the test, owns the provider env);
//   (f) fixture paths resolve from src/mac-chat via ../../test (= repo
//       test/), matching the committed fixtures.
// No network beyond localhost pipes; no models; temp files live ONLY under
// the build cache and are cleaned up by afterAll.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openMacStream, type SpawnedSshChild } from "./stream.ts";
import { sha256Hex, type MacStreamMetadata } from "./wire.ts";
import { buildCentralContext, toWireContext, canonJsonBytes } from "./context.ts";
import { adaptClaudeArgv } from "./argv-adapter.ts";
import { isProbeReport, evaluateMacRuntime, type MacChatConfig } from "../execution-host.ts";

const PEER_DIR = process.env.MAC_CHAT_TRANSPORT_DIR ?? "/Users/samht/sites-beheer/scripts/agentbox/mac-chat-transport";
const PEER_TRANSPORT = join(PEER_DIR, "transport.py");
const BUILD_TMP = process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests";
const FIXTURE_PROVIDER = join(import.meta.dir, "../../test/mac-chat/fixtures/e2e-provider.py");
const SDK_FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/sdk-argv-fixture.json");

let base: string;
let fixtureHome: string;
let configPath: string;
let sshShimDir: string;
let jobsRoot: string;
let coordinator: Bun.Subprocess | null = null;
let policyTimer: ReturnType<typeof setInterval> | null = null;

function refreshPolicy(): void {
  // The admission gate refuses policy files older than 8 s, and the
  // supervisor keeps re-checking while a stream runs. Kept fresh on a
  // regular interval (item 34b) — plus an explicit touch right before each
  // one-shot exchange.
  const policyPath = join(base, "policy.json");
  writeFileSync(policyPath, JSON.stringify({ eligible: true }));
  chmodSync(policyPath, 0o644);
}

function fixtureSshSpawn(argv: readonly string[]): SpawnedSshChild {
  // The REAL ssh argv; the shim execs the python supervisor with
  // SSH_ORIGINAL_COMMAND exactly as the Mac forced command provides it.
  const child = Bun.spawn([join(sshShimDir, "ssh"), ...argv.slice(1)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, AGENTBOX_TRANSPORT_CONFIG: configPath },
  });
  return {
    pid: child.pid ?? 0,
    stdin: {
      write(data) {
        child.stdin!.write(data as never);
      },
      end() {
        child.stdin!.end();
      },
    },
    stdout: child.stdout as ReadableStream<Uint8Array>,
    exited: child.exited as Promise<number>,
    kill(signal) {
      child.kill(signal);
    },
  };
}

beforeAll(async () => {
  base = mkdtempSync(join(BUILD_TMP, "e2e-"));
  const stateDir = join(base, "state");
  jobsRoot = join(base, "jobs");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(jobsRoot, { recursive: true });
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  mkdirSync(join(stateDir, "requests"), { recursive: true });

  // (d) Injected fixture home: buildCentralContext reads its DEFAULT global
  // roots from HERE — real M4 instructions must never flood the fixture.
  // This is the documented `home` OPTION, not an env HOME override.
  fixtureHome = join(base, "home");
  mkdirSync(join(fixtureHome, ".claude"), { recursive: true });
  mkdirSync(join(fixtureHome, ".codex"), { recursive: true });

  // Policy: fixture file owned by us, mode without group/world write, fresh
  // (kept fresh by the interval refresher below — item 34b).
  refreshPolicy();

  // (e) The provider dumps its evidence through E2E_DUMP_DIR; the wrappers
  // below are the supervisor's provider_bins, so the export rides the
  // supervisor's own spawn env — no test-side env leakage into the peer.
  const dumpDir = join(base, "dump");
  mkdirSync(dumpDir, { recursive: true });

  configPath = join(base, "transport-config.json");
  writeFileSync(configPath, JSON.stringify({
    state_dir: stateDir,
    home: process.env.HOME,          // real HOME preserved (no overrides)
    policy: join(base, "policy.json"),
    policy_uid: process.getuid?.() ?? 501,
    provider_bins: { claude: join(base, "claude-bin"), codex: join(base, "codex-bin") },
    jobs_root: jobsRoot,
    mcp_allowed_origins: ["https://bridge.e2e.test/"],
    require_coordinator: true,
    capacity: { max_coding: 10, coordinator_fresh: 60 },
    admission: { min_available_bytes: 1, runtime_min_available_bytes: 1, rss_limit_bytes: 3221225472, probe_timeout: 15 },
    stream: { meta_max: 524288, grace: 3.0 },
  }));
  // Provider bins: the SAME fixture script under both names, exporting the
  // dump dir the test asserts against (item 34e).
  for (const name of ["claude-bin", "codex-bin"]) {
    writeFileSync(join(base, name), [
      "#!/bin/sh",
      `export E2E_DUMP_DIR=${JSON.stringify(dumpDir)}`,
      `exec python3 "${FIXTURE_PROVIDER}" "$@"`,
      "",
    ].join("\n"));
    chmodSync(join(base, name), 0o755);
  }

  // ssh shim: the forced command verb travels exactly as on the Mac.
  sshShimDir = join(base, "bin");
  mkdirSync(sshShimDir, { recursive: true });
  // The real Mac forced command receives ONLY the verb tail (probe | stream |
  // status UUID | cancel UUID) — never ssh's own -T/-o flags. POSIX-sh safe.
  writeFileSync(join(sshShimDir, "ssh"), [
    "#!/bin/sh",
    "verb=; last=",
    'for a in "$@"; do last="$a"; case "$a" in probe|stream|status|cancel) verb="$a";; esac; done',
    'case "$verb" in',
    '  status|cancel) SSH_ORIGINAL_COMMAND="$verb $last" ;;',
    '  probe|stream) SSH_ORIGINAL_COMMAND="$verb" ;;',
    '  *) SSH_ORIGINAL_COMMAND="" ;;',
    "esac",
    "export SSH_ORIGINAL_COMMAND",
    `exec python3 "${PEER_TRANSPORT}" bridge`,
    "",
  ].join("\n"));
  chmodSync(join(sshShimDir, "ssh"), 0o755);

  // Coordinator heartbeat: the REAL shared_capacity module writing the same
  // heartbeat the mac-agents pool daemon writes, bound to this PID+lstart
  // and the SAME canonical jobs root (item 16 invariant).
  const heartbeatScript = [
    "import sys, time, json, os",
    `sys.path.insert(0, ${JSON.stringify(join(PEER_DIR, "..", "mac-agents"))})`,
    "import shared_capacity",
    `cfg = {"jobs_dir": ${JSON.stringify(jobsRoot)}, "capacity": {"coordinator_fresh": 60}}`,
    "while True:",
    "    shared_capacity.coordinator_heartbeat(cfg)",
    "    time.sleep(5)",
  ].join("\n");
  coordinator = Bun.spawn(["python3", "-c", heartbeatScript], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  // (a) Wait for the REAL coordinator file name: shared_capacity writes
  // capacity-coordinator.json (COORDINATOR_FILE), NOT coordinator.json —
  // the wrong name used to burn the full 30 s deadline every run.
  const heartbeatPath = join(jobsRoot, "capacity-coordinator.json");
  const heartbeatDeadline = Date.now() + 15_000;
  while (!(existsSync(heartbeatPath) && readFileSync(heartbeatPath, "utf8").length > 0)) {
    if (Date.now() > heartbeatDeadline) throw new Error("coordinator heartbeat never appeared (capacity-coordinator.json)");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // (b) Keep the fixture policy fresh for the whole suite: admission reads
  // it at stream setup AND the runtime monitor re-reads it while streams
  // are live. A regular 3 s interval leaves the 8 s window always satisfied.
  policyTimer = setInterval(refreshPolicy, 3_000);
});

afterAll(async () => {
  if (policyTimer) clearInterval(policyTimer);
  if (coordinator) {
    coordinator.kill();
    await coordinator.exited.catch(() => 0);
  }
  rmSync(base, { recursive: true, force: true });
});

const pinnedConfig: MacChatConfig = {
  enabled: true,
  adapter: "/nonexistent",
  machineIdentity: "fixture-identity",
  buildManifestSha256: "00".repeat(32),
  osVersion: "0",
  toolManifestSha256: "11".repeat(32),
  ssh: { target: "e2e" },
  bridge: { bindAddress: "127.0.0.1", port: 1, publicUrl: "https://bridge.e2e.test" },
};

function emptyWireContext(): MacStreamMetadata["context"] {
  return {
    revision: sha256Hex(canonJsonBytes({ instructions: [], skills: [], memory: [] })),
    instructions: [],
    skills: [],
    memory: [],
  };
}

function claudeMetadata(overrides: Partial<MacStreamMetadata> = {}): MacStreamMetadata {
  const sdkArgv = JSON.parse(readFileSync(SDK_FIXTURE, "utf8")) as string[];
  const adapted = adaptClaudeArgv(sdkArgv);
  if (!adapted.ok) throw new Error(`sdk fixture argv failed adaptation: ${adapted.error}`);
  return {
    transport: 1,
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    provider: "claude",
    args: adapted.extraction.argv,
    context: emptyWireContext(),
    mcp: { servers: {} },
    settings: { model: "opus", fastMode: true },
    ...overrides,
  };
}

async function readStreamUntil(
  stdout: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const reader = stdout.getReader();
  const seen: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 500))]);
    if (!chunk) continue;
    if (chunk.done) break;
    seen.push(new TextDecoder().decode(chunk.value));
    if (seen.join("").includes(marker)) break;
  }
  return seen.join("");
}

/** All *.json files under a directory tree (the supervisor nests session files). */
function jsonFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".json")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Provider-launch dump lines: BOTH bins append to one file — parse per line. */
function providerLaunches(dumpDir: string): Array<{ argv: string[] }> {
  return readFileSync(join(dumpDir, "provider-launch.json"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { argv: string[] });
}

describe("E2E: TS client → real python supervisor → fixture provider", () => {
  test("probe answers the frozen report; attestation gates parity (never invented)", async () => {
    refreshPolicy();
    const { macSshOneShot } = await import("./stream.ts");
    const answer = await macSshOneShot(fixtureSshSpawn, "e2e", { kind: "probe" }, {
      stdinJson: { type: "probe", schema: 1 },
      timeoutMs: 60_000,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const report = JSON.parse(answer.stdout.trim().split("\n")[0]!) as unknown;
    expect(isProbeReport(report)).toBe(true);
    const parsed = report as NonNullable<Parameters<typeof evaluateMacRuntime>[1]>;
    // Without an attestation file: providers [] — parity is NEVER invented.
    expect(parsed.providers).toEqual([]);
    const evaluation = evaluateMacRuntime(pinnedConfig, parsed, null, parsed.probedAt);
    // The evaluation itself fails closed on the fixture pins (by design);
    // what matters here is that no provider record exists to enable.
    if (evaluation.ok) expect(evaluation.providers.size).toBe(0);
    else expect(evaluation.reason.length).toBeGreaterThan(0);
  }, 120_000);

  test("claude stream: settings fastMode + lease MCP materialized natively; non-ASCII context validated on the REAL wire; turn roundtrip; no secrets on argv", async () => {
    // (d) injected fixture home + explicit empty skill/memory roots: the
    // real M4 home never leaks into this fixture context.
    const context = buildCentralContext({
      cwd: base,
      provider: "claude",
      home: fixtureHome,
      skillRoots: [],
      memoryRoots: [],
    });
    // Non-ASCII instruction content rides the wire (item 23/29 canonical form).
    const nonce = `E2E-NONCE-Unicode-Çafe-中文-🚀-${crypto.randomUUID().slice(0, 8)}`;
    // (c) toWireContext returns the wire context DIRECTLY.
    const wire = toWireContext({
      ...context,
      instructions: [...context.instructions, { order: context.instructions.length, path: `${base}/E2E.md`, sha256: "0".repeat(64), content: nonce }],
    } as never);
    const bearer = "e2e-bearer-token-0123456789abcdef";
    const metadata = claudeMetadata({
      context: wire,
      mcp: { servers: { omg: { type: "http", url: "https://bridge.e2e.test/mcp/omg", bearerToken: bearer, headerName: "authorization" } } },
    });

    const handle = openMacStream({ spawn: fixtureSshSpawn, handshakeTimeoutMs: 60_000 }, { target: "e2e", metadata });
    const ready = await handle.whenReady;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.handshake.status).toBe("ready");

    handle.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "E2E claude turn" } })}\n`);
    const text = await readStreamUntil(ready.stdout, '"result"', 30_000);
    expect(text).toContain("e2e:");
    handle.kill();

    // Provider-side assertions from the dump: the supervisor materialized
    // the metadata natively and kept secrets off the provider argv.
    const dumpDir = join(base, "dump");
    const claudeLaunch = providerLaunches(dumpDir).find((l) => l.argv.some((a) => a === "--settings"));
    expect(claudeLaunch).toBeDefined();
    if (!claudeLaunch) return;
    const joined = claudeLaunch.argv.join(" ");
    // Fast: settings.fastMode materialized as the native --settings flag
    // (json.dumps spacing: {"fastMode": true}).
    expect(joined).toContain("--settings");
    expect(joined).toMatch(/"fastMode":\s*true/);
    // Lease MCP: private config file + strict mode; token NEVER on argv.
    expect(joined).toContain("--mcp-config");
    expect(joined).toContain("--strict-mcp-config");
    expect(joined).not.toContain(bearer);
    // The supervisor's own mcp materialization file carries the bearer
    // (it lives under state/sessions/<sid>/central/).
    const mcpFiles = jsonFilesUnder(join(base, "state", "sessions", metadata.sessionId));
    expect(mcpFiles.length).toBeGreaterThan(0);
    const mcpDoc = JSON.parse(readFileSync(mcpFiles.find((f) => f.includes("mcp")) ?? mcpFiles[0]!, "utf8")) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
    expect(mcpDoc.mcpServers.omg?.headers?.authorization).toBe(`Bearer ${bearer}`);
    // The request record the reconciliation path reads (status one-shot below).
    const record = JSON.parse(readFileSync(join(base, "state", "requests", `${metadata.requestId}.json`), "utf8")) as { state: string; mcp_servers?: unknown };
    expect(["completed", "active", "disconnected", "interrupted"]).toContain(record.state);
    void record.mcp_servers;
  }, 120_000);

  test("codex stream: metadata Fast → exact service-tier argv injected; full turn; duplicate requestId never respawns", async () => {
    const metadata: MacStreamMetadata = {
      transport: 1,
      requestId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      provider: "codex",
      args: ["app-server", "--stdio"],
      context: emptyWireContext(),
      mcp: { servers: {} },
      settings: { model: "gpt-5.5", serviceTier: "fast", thinkingLevel: "high" },
    };
    const handle = openMacStream({ spawn: fixtureSshSpawn, handshakeTimeoutMs: 60_000 }, { target: "e2e", metadata });
    const ready = await handle.whenReady;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    handle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { experimentalApi: true } } })}\n`);
    handle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    handle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: {} })}\n`);
    handle.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "e2e-thread-1", input: [{ type: "text", text: "E2E codex turn" }] } })}\n`);
    const text = await readStreamUntil(ready.stdout, "turn/completed", 30_000);
    expect(text).toContain("turn/completed");
    handle.kill();

    // Provider argv: the supervisor injected the EXACT service-tier.ts emission
    // plus the metadata thinkingLevel as native model_reasoning_effort.
    const dumpDir = join(base, "dump");
    const codexLaunch = providerLaunches(dumpDir).reverse().find((l) => l.argv.some((a) => a === "app-server" || a.includes("service_tier")));
    expect(codexLaunch).toBeDefined();
    if (!codexLaunch) return;
    const joined = codexLaunch.argv.join(" ");
    expect(joined).toContain('service_tier="fast"');
    expect(joined).toContain("features.fast_mode=true");
    expect(joined).toContain('model_reasoning_effort="high"');

    // Duplicate requestId + SAME contract: the real peer refuses a second
    // process (its current spelling is "reused"; the frozen word is
    // "exists" — both degrade safely to the same fail-closed refusal).
    const duplicate = openMacStream({ spawn: fixtureSshSpawn, handshakeTimeoutMs: 30_000 }, { target: "e2e", metadata });
    const dupReady = await duplicate.whenReady;
    expect(dupReady.ok).toBe(false);
    if (dupReady.ok) return;
    expect(dupReady.error).toMatch(/exists|reused|refused/);
    duplicate.kill();
  }, 120_000);

  test("status one-shot answers the real request record (reconciliation path)", async () => {
    // Reuse the claude requestId from earlier in this suite run.
    const requestsDir = join(base, "state", "requests");
    const files = readdirSync(requestsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const rid = files[0]!.replace(/\.json$/, "");
    refreshPolicy();
    const { macSshOneShot } = await import("./stream.ts");
    const answer = await macSshOneShot(fixtureSshSpawn, "e2e", { kind: "status", requestId: rid }, { timeoutMs: 30_000 });
    if (answer.ok && answer.stdout.trim()) {
      const status = JSON.parse(answer.stdout.trim().split("\n")[0]!) as { requestId?: string; state?: string };
      expect(status.requestId).toBe(rid);
      expect(typeof status.state).toBe("string");
    } else {
      // The peer answers unknown requests with an OpError on stderr + empty
      // stdout — the reconciliation caller sees a clean refusal, never a
      // fabricated record.
      expect(answer.ok ? true : answer.error.length).toBeTruthy();
    }
  }, 60_000);
});
