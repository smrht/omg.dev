// Focused regression test for the Mac route's remote executable selector.
//
// The real installed @anthropic-ai/claude-agent-sdk resolves its native CLI
// binary BEFORE it calls spawnClaudeCodeProcess: on hosts without the
// platform optional dependency (the linux-x64 attest run) query() threw
// "Native CLI binary for linux-x64 not found" before any ssh byte, even
// though the remote route needs no local CLI. These tests pin the two
// contract halves the fix relies on, against the REAL SDK (no module mock):
//
//   1. an explicit pathToClaudeCodeExecutable makes the SDK skip native
//      resolution, hand the sentinel to the custom spawn as `command` (never
//      on argv, never executed locally — the callback owns the process);
//   2. the production attest turn drives that exact path end-to-end through
//      macClaudeSpawnFactory over the fixture ssh subprocess: hermetic
//      `--setting-sources=` on the wire, prompt/token through the raw pipe,
//      strict proved classification.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Writable, PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { runClaudeAttestTurn } from "./attest.ts";
import { isMacStreamUuid } from "./wire.ts";
import { MAC_CLAUDE_REMOTE_EXECUTABLE } from "../agents/backends/aisdk-session.ts";
import type { SpawnedSshChild } from "./stream.ts";

const STREAMING_PREFIX = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
const FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/fake-ssh.ts");
let outDir: string;

function fixtureSpawn(argv: readonly string[]): SpawnedSshChild {
  const child = Bun.spawn([process.execPath, FIXTURE, ...argv.slice(1)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, FIXTURE_OUT: outDir },
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

beforeAll(() => {
  outDir = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "mac-chat-attest-exec-"));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * Minimal silent SpawnedProcess: accepts stdin writes, EOFs stdout at once,
 * never emits exit on its own (the aborted query closes it from its side).
 */
function deadSpawnedProcess(): SpawnedProcess {
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
  const emitExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    for (const listener of [...exitListeners]) listener(code, signal);
  };
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
      emitExit(null, signal ?? "SIGTERM");
      return true;
    },
    on(event, listener) {
      if (event === "exit") exitListeners.add(listener as never);
      if (event === "error") errorListeners.add(listener as never);
    },
    once(event, listener) {
      if (event === "exit") {
        const wrap = (...args: never[]) => {
          exitListeners.delete(wrap as never);
          (listener as (...a: never[]) => void)(...args);
        };
        exitListeners.add(wrap as never);
      }
      if (event === "error") errorListeners.add(listener as never);
    },
    off(event, listener) {
      if (event === "exit") exitListeners.delete(listener as never);
      if (event === "error") errorListeners.delete(listener as never);
    },
  };
}

describe("Mac route remote executable selector (real installed SDK)", () => {
  test("explicit selector: SDK skips native resolution, custom spawn owns the process", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const captured: { command?: string; args?: string[] } = {};
    const abort = new AbortController();
    const q = query({
      prompt: "SELECTOR-CONTRACT-PROBE",
      options: {
        model: "opus",
        permissionMode: "bypassPermissions",
        abortController: abort,
        pathToClaudeCodeExecutable: MAC_CLAUDE_REMOTE_EXECUTABLE,
        spawnClaudeCodeProcess: (options: SpawnOptions): SpawnedProcess => {
          captured.command = options.command;
          captured.args = [...options.args];
          return deadSpawnedProcess();
        },
      },
    });
    // The silent child EOFs stdout immediately; the SDK ends or errors the
    // stream on its own, with the abort timer as the bounded fallback —
    // either way, the contract under test is that the callback was reached
    // AT ALL (no native-binary throw before it) with the selector as
    // command and off argv.
    const abortTimer = setTimeout(() => abort.abort(), 500);
    try {
      for await (const _message of q) {
        void _message;
      }
    } catch {
      /* expected: the silent child never answers */
    } finally {
      clearTimeout(abortTimer);
      abort.abort();
    }
    expect(captured.command).toBe(MAC_CLAUDE_REMOTE_EXECUTABLE);
    expect(captured.args).toBeDefined();
    expect(captured.args!.slice(0, STREAMING_PREFIX.length)).toEqual(STREAMING_PREFIX);
    expect(captured.args!.includes(MAC_CLAUDE_REMOTE_EXECUTABLE)).toBe(false);
    // The selector is not a path that exists anywhere locally; had the SDK
    // spawned it instead of handing it over, the turn would have died ENOENT
    // before this assertion.
  }, 15_000);

  test("attest claude turn: real SDK over the fixture Mac stream, hermetic setting-sources on the wire", async () => {
    const evidence = await runClaudeAttestTurn(
      { spawn: fixtureSpawn, handshakeTimeoutMs: 10_000 },
      // The fixture's result text is literally "fixture" — proving requires
      // the expected token to appear in it, so pin the token to that value.
      { target: "mac-fixture", model: "opus", expectedToken: "fixture", timeoutMs: 20_000 },
    );
    expect(evidence.outcome).toBe("proved");
    expect(evidence.detail).toContain("requestId=");
    expect(isMacStreamUuid(evidence.requestId)).toBe(true);
    expect(isMacStreamUuid(evidence.sessionId)).toBe(true);

    // Wire: exactly one ssh child (the fixture) — nothing else was spawned.
    const invocations = readFileSync(join(outDir, "ssh-invocations.jsonl"), "utf8").trim().split("\n");
    expect(invocations.length).toBe(1);
    expect(JSON.parse(invocations[0]!).argv.join(" ")).toContain(" stream");

    // Metadata the supervisor would consume: streaming prefix intact, the
    // hermetic empty setting-sources rides argv, the selector never does,
    // model rides both argv and settings, no prompt-shaped text.
    const meta = JSON.parse(readFileSync(join(outDir, "metadata.jsonl"), "utf8").trim().split("\n")[0]!) as {
      provider: string;
      requestId: string;
      sessionId: string;
      args: string[];
      settings: Record<string, unknown>;
    };
    expect(meta.provider).toBe("claude");
    expect(meta.requestId).toBe(evidence.requestId);
    expect(meta.sessionId).toBe(evidence.sessionId);
    expect(meta.args.slice(0, STREAMING_PREFIX.length)).toEqual(STREAMING_PREFIX);
    expect(meta.args).toContain("--setting-sources=");
    expect(meta.args).not.toContain("--setting-sources");
    expect(meta.args.join(" ")).not.toContain(MAC_CLAUDE_REMOTE_EXECUTABLE);
    expect(meta.args).toContain("--model");
    expect(meta.args[meta.args.indexOf("--model") + 1]).toBe("opus");
    expect(meta.settings.model).toBe("opus");
    expect(JSON.stringify(meta)).not.toContain("Antwoord");

    // Extraction: the turn prompt (with the token) reached the provider
    // through the RAW pipe, never the metadata line.
    const providerStdin = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
    expect(providerStdin).toContain("Antwoord met exact deze token");
    expect(providerStdin).toContain("fixture");
  }, 30_000);
});
