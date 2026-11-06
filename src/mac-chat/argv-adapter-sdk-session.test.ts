// Actual-SDK capture test for the equals-canonicalization fix.
//
// The production harness died BEFORE any ssh byte: its SDK build emits the
// session id in equals form (`--session-id=<uuid>`), which the Mac argv
// allowlist (and the client screen mirroring it) refused as an unknown flag.
// This repo's SDK build emits the same flag separated, so these tests pin
// BOTH halves against the real thing:
//
//   1. the REAL installed SDK query() is captured with the FULL harness
//      mac-route option set — sessionId + effort "high" (fresh branch) and
//      resume (restart branch) — and the captured argv must pass
//      adaptClaudeArgv AND the peer's actual schema.py validator;
//   2. the production equals shape (rewritten from the real capture, exactly
//      what the failing SDK build emitted) must canonicalize back to the
//      separated form and be accepted by the actual schema.py — proof
//      against the real supervisor contract, not a fixture.
//
// No network, no models, no remote: the spawn callback captures the request
// and returns a silent dead child; python3 imports schema.py read-only.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Writable, PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { adaptClaudeArgv } from "./argv-adapter.ts";
import { MAC_CLAUDE_REMOTE_EXECUTABLE } from "../agents/backends/aisdk-session.ts";

const PEER_DIR = process.env.MAC_CHAT_TRANSPORT_DIR ?? "/Users/samht/sites-beheer/scripts/agentbox/mac-chat-transport";
const CLAUDE_PREFIX = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

function pythonValidateClaude(argv: string[]): { ok: boolean; error?: string } {
  const script = `import sys,json;sys.path.insert(0,${JSON.stringify(PEER_DIR)});import schema;schema.validate_claude(json.loads(sys.argv[1]), "/private/tmp/fixture-scratch")`;
  const proc = Bun.spawnSync(["python3", "-c", script, JSON.stringify(argv)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: proc.exitCode === 0, error: proc.stderr.toString().trim().slice(0, 300) };
}

/** Minimal silent SpawnedProcess (accepts stdin, EOFs stdout, no self-exit). */
function silentSpawnedProcess(): SpawnedProcess {
  const stdin = new Writable({
    write(_chunk, _enc, callback) {
      callback();
    },
    final(callback) {
      callback();
    },
  });
  const stdout = new PassThrough();
  stdout.end();
  const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let killed = false;
  return {
    stdin,
    stdout: stdout as unknown as Readable,
    get killed() {
      return killed;
    },
    get exitCode() {
      return null;
    },
    kill(signal) {
      if (killed) return false;
      killed = true;
      for (const listener of [...exitListeners]) listener(null, signal ?? "SIGTERM");
      return true;
    },
    on(event, listener) {
      if (event === "exit") exitListeners.add(listener as never);
      if (event === "error") errorListeners.add(listener as never);
    },
    once(event, listener) {
      if (event === "exit") exitListeners.add(listener as never);
      if (event === "error") errorListeners.add(listener as never);
    },
    off(event, listener) {
      if (event === "exit") exitListeners.delete(listener as never);
      if (event === "error") errorListeners.delete(listener as never);
    },
  };
}

/** One REAL SDK query() whose request argv is captured from the spawn seam. */
async function captureSdkArgv(options: { sessionId?: string; resume?: string }): Promise<string[]> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const captured: { args?: string[] } = {};
  const abort = new AbortController();
  const q = query({
    prompt: "SDK-CAPTURE-PROBE",
    options: {
      // The harness mac-route option set (aisdk-session.ts): model, bypass,
      // AskUserQuestion disallowed, hermetic setting sources, partial
      // messages, explicit remote executable selector.
      model: "opus",
      permissionMode: "bypassPermissions",
      disallowedTools: ["AskUserQuestion"],
      settingSources: [] as never[],
      includePartialMessages: true,
      effort: "high",
      abortController: abort,
      pathToClaudeCodeExecutable: MAC_CLAUDE_REMOTE_EXECUTABLE,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      spawnClaudeCodeProcess: (spawnOptions: SpawnOptions): SpawnedProcess => {
        captured.args = [...spawnOptions.args];
        return silentSpawnedProcess();
      },
    },
  });
  const abortTimer = setTimeout(() => abort.abort(), 500);
  try {
    for await (const _message of q) {
      void _message;
    }
  } catch {
    /* the silent child never answers; the capture is the point */
  } finally {
    clearTimeout(abortTimer);
    abort.abort();
  }
  if (!captured.args) throw new Error("SDK never reached the spawn seam");
  return captured.args;
}

function pair(argv: string[], flag: string): string {
  const at = argv.indexOf(flag);
  if (at < 0) throw new Error(`${flag} missing from captured argv: ${JSON.stringify(argv)}`);
  return argv[at + 1]!;
}

describe("actual SDK session argv (capture → adapter → REAL schema.py)", () => {
  test("fresh branch: real SDK with sessionId + effort high passes the adapter and the real schema", async () => {
    const sessionId = crypto.randomUUID();
    const captured = await captureSdkArgv({ sessionId });
    expect(captured.slice(0, CLAUDE_PREFIX.length)).toEqual(CLAUDE_PREFIX);
    expect(pair(captured, "--session-id")).toBe(sessionId);
    expect(pair(captured, "--effort")).toBe("high");
    expect(captured).toContain("--setting-sources=");
    const adapted = adaptClaudeArgv(captured);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.extraction.argv).toContain("--session-id");
    const verdict = pythonValidateClaude(adapted.extraction.argv);
    expect(verdict.ok).toBe(true);
  }, 15_000);

  test("resume branch: real SDK with resume passes the adapter and the real schema", async () => {
    const resumeId = crypto.randomUUID();
    const captured = await captureSdkArgv({ resume: resumeId });
    expect(captured).not.toContain("--session-id");
    expect(pair(captured, "--resume")).toBe(resumeId);
    const adapted = adaptClaudeArgv(captured);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    const verdict = pythonValidateClaude(adapted.extraction.argv);
    expect(verdict.ok).toBe(true);
  }, 15_000);

  test("production equals shape (--session-id=<uuid>) canonicalizes and is accepted by the REAL schema", async () => {
    const sessionId = crypto.randomUUID();
    const captured = await captureSdkArgv({ sessionId });
    // Rewrite the separated pair into the equals token EXACTLY as the
    // failing production SDK build emitted it.
    const at = captured.indexOf("--session-id");
    const equalsForm = [
      ...captured.slice(0, at),
      `--session-id=${captured[at + 1]}`,
      ...captured.slice(at + 2),
    ];
    const adapted = adaptClaudeArgv(equalsForm);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.extraction.argv).not.toContain(`--session-id=${sessionId}`);
    expect(pair(adapted.extraction.argv, "--session-id")).toBe(sessionId);
    const verdict = pythonValidateClaude(adapted.extraction.argv);
    expect(verdict.ok).toBe(true);
    // The RAW equals form (no client canonicalization) is refused by the
    // real schema — proving the wire really requires the canonical form and
    // the fix earns its keep against the actual supervisor contract.
    expect(pythonValidateClaude(equalsForm).ok).toBe(false);
  }, 15_000);
});
