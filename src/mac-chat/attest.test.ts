// Attest honest-proof tests: mocked Mac-stream peers (in-process, no ssh,
// no subprocess, no network, no models) driving the REAL production paths:
//
//   - claude: the official Agent SDK query() through macClaudeSpawnFactory
//     over a fake ssh child;
//   - codex: CodexAppServerThread over createRemoteCodexTransport over the
//     same fake ssh child.
//
// Regression coverage for the primary review findings:
//   R1 hardcoded threadId  — the turn/start params must carry the thread id
//     the server RETURNED, and the evidence must record that id;
//   R2 pipelined requests  — thread/start must not arrive before the
//     initialize response was sent (script records violations);
//   R3 abandoned reads     — delayed, split-chunk streams must still deliver
//     the terminal message (one sequential reader, no racing consumers);
//   R4 weak claude success — error-subtype results, is_error results and
//     token-less success results must NEVER prove parity;
//   R5 free-form settings  — testedSettings comes only from what a proved
//     turn actually exercised, never from a flag;
//   R6 error/quota/timeout — failed/unknown never write parity true, and
//     unknown keeps the requestId UUID for reconciliation;
//   R7 true exit           — stream EOF with a real exit code before a
//     terminal message is "unknown", never success.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MacStreamSpawnFn, SpawnedSshChild } from "./stream.ts";
import { isMacStreamUuid } from "./wire.ts";
import {
  ATTEST_DEFAULT_CLAUDE_MODEL,
  ATTEST_DEFAULT_CODEX_MODEL,
  buildProviderRecord,
  parseAttestationDocument,
  runClaudeAttestTurn,
  runCodexAttestTurn,
  type AttestOutcome,
  type AttestTurnEvidence,
} from "./attest.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

// ---------------------------------------------------------------------------
// In-process fake ssh child: records the metadata line, hands provider lines
// to the test script, and lets the script push native stdout bytes (split or
// whole), end the stream with a TRUE exit code, or get killed.
// ---------------------------------------------------------------------------

type FakeMacPeer = {
  spawn: MacStreamSpawnFn;
  argv(): string[];
  metadata(): Record<string, unknown> | null;
  providerLines(): string[];
  onMetadata(cb: (meta: Record<string, unknown>) => void): void;
  onProviderLine(cb: (line: string) => void): void;
  emit(text: string): void;
  emitRaw(bytes: Uint8Array): void;
  endStream(exitCode?: number): void;
  killed(): boolean;
  exitCode(): number | null;
};

function fakeMacPeer(): FakeMacPeer {
  let argv: string[] = [];
  let metadata: Record<string, unknown> | null = null;
  const providerLines: string[] = [];
  const metadataCbs: Array<(meta: Record<string, unknown>) => void> = [];
  const lineCbs: Array<(line: string) => void> = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let resolveExit: ((code: number) => void) | null = null;
  let exitCode: number | null = null;
  let killed = false;
  let stdoutEnded = false;
  const decoder = new TextDecoder();

  const spawn: MacStreamSpawnFn = (av): SpawnedSshChild => {
    argv = [...av];
    metadata = null;
    providerLines.length = 0;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let buffer = "";
    let sawMetadata = false;
    return {
      pid: 4242,
      stdin: {
        write(data) {
          // The production paths write BOTH strings (JSON-RPC lines) and
          // Uint8Arrays (SDK chunks) — accept both like a real pipe.
          const text = typeof data === "string" ? data : decoder.decode(data as Uint8Array, { stream: true });
          buffer += text;
          for (;;) {
            const nl = buffer.indexOf("\n");
            if (nl < 0) break;
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            if (!sawMetadata) {
              sawMetadata = true;
              try {
                metadata = JSON.parse(line) as Record<string, unknown>;
              } catch {
                metadata = {};
              }
              for (const cb of [...metadataCbs]) cb(metadata!);
            } else {
              providerLines.push(line);
              for (const cb of [...lineCbs]) cb(line);
            }
          }
        },
        end() {
          /* the fake lives in-process; nothing to close */
        },
      },
      stdout,
      exited,
      kill() {
        killed = true;
        if (!stdoutEnded) {
          stdoutEnded = true;
          try {
            controller?.close();
          } catch {}
        }
        if (resolveExit) {
          const resolve = resolveExit;
          resolveExit = null;
          exitCode = 137;
          resolve(137);
        }
      },
    };
  };

  const api: FakeMacPeer = {
    spawn,
    argv: () => argv,
    metadata: () => metadata,
    providerLines: () => [...providerLines],
    onMetadata(cb) {
      metadataCbs.push(cb);
    },
    onProviderLine(cb) {
      lineCbs.push(cb);
    },
    emit(text) {
      api.emitRaw(new TextEncoder().encode(text));
    },
    emitRaw(bytes) {
      if (stdoutEnded || !controller) return;
      try {
        controller.enqueue(bytes);
      } catch {
        /* consumer went away */
      }
    },
    endStream(code = 0) {
      if (stdoutEnded) return;
      stdoutEnded = true;
      try {
        controller?.close();
      } catch {}
      if (resolveExit) {
        const resolve = resolveExit;
        resolveExit = null;
        exitCode = code;
        resolve(code);
      }
    },
    killed: () => killed,
    exitCode: () => exitCode,
  };
  return api;
}

/** Emit a line split across two chunks with a gap: exercises framing. */
async function emitSplit(peer: FakeMacPeer, text: string, halfDelayMs = 15): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const mid = Math.floor(bytes.length / 2);
  peer.emitRaw(bytes.subarray(0, mid));
  await sleep(halfDelayMs);
  peer.emitRaw(bytes.subarray(mid));
}

// ---------------------------------------------------------------------------
// Claude fixture script (SDK stream-json shaped)
// ---------------------------------------------------------------------------

type ClaudeStep = { json: unknown; delayMs?: number; split?: boolean };
type ClaudeBehavior = {
  refuseHandshake?: boolean;
  silence?: boolean;
  steps?: ClaudeStep[];
  endAfterSteps?: boolean;
  endExitCode?: number;
};

function startClaudePeer(peer: FakeMacPeer, behavior: ClaudeBehavior): void {
  let sawInit = false;
  peer.onMetadata((meta) => {
    if (behavior.refuseHandshake) {
      peer.emit(`${JSON.stringify({ transport: 1, requestId: meta.requestId ?? null, status: "rejected", reason: "fixture refusal: policy not eligible" })}\n`);
      peer.endStream(7);
      return;
    }
    peer.emit(`${JSON.stringify({ transport: 1, requestId: meta.requestId ?? null, status: "ready", pid: 4242, cwd: "/private/tmp/fixture-scratch", sessionId: meta.sessionId ?? null })}\n`);
  });
  peer.onProviderLine((line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "control_request") {
      peer.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id ?? null } })}\n`);
      return;
    }
    if (msg.type !== "user" || behavior.silence) return;
    if (!sawInit) {
      sawInit = true;
      peer.emit(`${JSON.stringify({ type: "system", subtype: "init", session_id: "fixture-1" })}\n`);
    }
    void (async () => {
      for (const step of behavior.steps ?? []) {
        if (step.delayMs) await sleep(step.delayMs);
        const text = `${JSON.stringify(step.json)}\n`;
        if (step.split) await emitSplit(peer, text);
        else peer.emit(text);
      }
      if (!behavior.silence && behavior.endAfterSteps !== false) peer.endStream(behavior.endExitCode ?? 0);
    })();
  });
}

function claudeTurn(peer: FakeMacPeer, overrides: { timeoutMs?: number } = {}): Promise<AttestTurnEvidence> {
  return runClaudeAttestTurn(
    { spawn: peer.spawn, handshakeTimeoutMs: 10_000 },
    { target: "mac-fixture", model: ATTEST_DEFAULT_CLAUDE_MODEL, expectedToken: "ATTOKEN", timeoutMs: 8_000, ...overrides },
  );
}

// ---------------------------------------------------------------------------
// Codex fixture script (app-server JSON-RPC shaped)
// ---------------------------------------------------------------------------

type CodexNotice = { method: string; params: unknown; delayMs?: number; split?: boolean };
type CodexBehavior = {
  initDelayMs?: number;
  initError?: { code: number; message: string };
  threadId?: string;
  notices?: CodexNotice[];
  eofAfterTurnStart?: boolean;
};
type CodexScript = {
  violations: string[];
  turnStartParams: Array<Record<string, unknown>>;
};

function startCodexPeer(peer: FakeMacPeer, b: CodexBehavior): CodexScript {
  const script: CodexScript = { violations: [], turnStartParams: [] };
  const rpcResult = (id: unknown, result: unknown): string => `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
  const rpcError = (id: unknown, error: { code: number; message: string }): string => `${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`;
  const notice = (method: string, params: unknown): string => `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
  let initializeAnswered = false;
  const threadId = b.threadId ?? "thread-returned-42";

  peer.onMetadata((meta) => {
    peer.emit(`${JSON.stringify({ transport: 1, requestId: meta.requestId ?? null, status: "ready", pid: 4242, cwd: "/private/tmp/fixture-scratch", sessionId: meta.sessionId ?? null })}\n`);
  });
  peer.onProviderLine((line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.method !== "string") return; // responses to server requests
    if (msg.method === "initialize") {
      setTimeout(() => {
        peer.emit(b.initError ? rpcError(msg.id, b.initError) : rpcResult(msg.id, { capabilities: { experimentalApi: true } }));
        initializeAnswered = true;
      }, b.initDelayMs ?? 0);
      return;
    }
    if (msg.method === "initialized") return; // notification: never answered
    if (msg.method === "thread/start") {
      // R2: the OLD attest pipelined all requests in one burst; a correct
      // client waits for the initialize response first.
      if (!initializeAnswered) script.violations.push("thread/start arrived before the initialize response was sent");
      setTimeout(() => {
        peer.emit(rpcResult(msg.id, { thread: { id: threadId } }));
        peer.emit(notice("thread/started", { threadId }));
      }, 0);
      return;
    }
    if (msg.method === "turn/start") {
      script.turnStartParams.push(msg.params as Record<string, unknown>);
      setTimeout(() => {
        peer.emit(rpcResult(msg.id, { turn: { id: "turn-1", status: "inProgress" } }));
        void (async () => {
          for (const n of b.notices ?? []) {
            if (n.delayMs) await sleep(n.delayMs);
            const text = notice(n.method, n.params);
            if (n.split) await emitSplit(peer, text);
            else peer.emit(text);
          }
          if (b.eofAfterTurnStart) peer.endStream(0);
        })();
      }, 0);
      return;
    }
    if (msg.id !== undefined) setTimeout(() => peer.emit(rpcResult(msg.id, {})), 0);
  });
  return script;
}

function codexTurn(peer: FakeMacPeer, overrides: { timeoutMs?: number } = {}): Promise<AttestTurnEvidence> {
  return runCodexAttestTurn(
    { spawn: peer.spawn, handshakeTimeoutMs: 10_000 },
    { target: "mac-fixture", model: ATTEST_DEFAULT_CODEX_MODEL, expectedToken: "ATTOKEN", timeoutMs: 8_000, ...overrides },
  );
}

const agentMessageNotice = (text: string, threadId = "thread-returned-42"): CodexNotice => ({
  method: "item/completed",
  params: { threadId, item: { type: "agentMessage", id: "i1", text } },
});
const turnCompletedNotice = (status: string, threadId = "thread-returned-42", errorMessage?: string): CodexNotice => ({
  method: "turn/completed",
  params: { threadId, turn: { id: "turn-1", status, ...(errorMessage ? { error: { message: errorMessage } } : {}) } },
});

// ---------------------------------------------------------------------------
// Claude: valid / failed / interleaved / delayed / timeout / EOF / refusal
// ---------------------------------------------------------------------------

describe("runClaudeAttestTurn (real SDK over mocked Mac stream)", () => {
  test("valid stream proves chat: strict success subtype + token; UUIDs ride the metadata", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, {
      steps: [
        { json: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ATTOKEN" }] } }, split: true },
        { json: { type: "result", subtype: "success", is_error: false, result: "ATTOKEN", usage: { input_tokens: 1, output_tokens: 1 } }, delayMs: 60 },
      ],
    });
    const evidence = await claudeTurn(peer);
    expect(evidence.outcome).toBe("proved");
    expect(evidence.detail).toContain("subtype success");
    // UUID preservation: the evidence ids ARE the wire ids the supervisor saw.
    const meta = peer.metadata();
    expect(meta?.provider).toBe("claude");
    expect(meta?.requestId).toBe(evidence.requestId);
    expect(meta?.sessionId).toBe(evidence.sessionId);
    expect(isMacStreamUuid(String(meta?.requestId))).toBe(true);
    expect((meta?.settings as Record<string, unknown>)?.model).toBe("opus");
    // The prompt/token reached the provider as TURN payload, never as
    // metadata/argv (nothing prompt-shaped may ride the metadata line).
    expect(peer.providerLines().some((l) => l.includes("ATTOKEN"))).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("ATTOKEN");
  }, 30_000);

  test("error-subtype result (quota/error paths) is failed, never proved", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, {
      steps: [
        { json: { type: "result", subtype: "error_during_execution", is_error: true, result: "", errors: ["Credit balance too low (quota)"] } },
      ],
    });
    const evidence = await claudeTurn(peer);
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("error_during_execution");
    expect(evidence.detail).toContain("quota");
  }, 30_000);

  test("success-subtype result WITHOUT the expected token is failed", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, {
      steps: [
        { json: { type: "result", subtype: "success", is_error: false, result: "sorry, geen token" } },
      ],
    });
    const evidence = await claudeTurn(peer);
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("expected token");
  }, 30_000);

  test("interleaved messages and split chunks still deliver the terminal result", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, {
      steps: [
        { json: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "bezig" }] } } },
        { json: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, split: true, delayMs: 50 },
        { json: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "nog steeds bezig" }] } }, delayMs: 70 },
        { json: { type: "result", subtype: "success", is_error: false, result: "ATTOKEN" }, delayMs: 90, split: true },
      ],
    });
    const evidence = await claudeTurn(peer);
    expect(evidence.outcome).toBe("proved");
  }, 30_000);

  test("delayed result arrives without lost chunks (single sequential reader)", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, {
      steps: [
        { json: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "denk na" }] } }, delayMs: 300 },
        { json: { type: "result", subtype: "success", is_error: false, result: "ATTOKEN" }, delayMs: 700, split: true },
      ],
    });
    const evidence = await claudeTurn(peer);
    expect(evidence.outcome).toBe("proved");
  }, 30_000);

  test("deadline with a silent stream is UNKNOWN and keeps the requestId UUID", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, { silence: true });
    const evidence = await claudeTurn(peer, { timeoutMs: 700 });
    expect(evidence.outcome).toBe("unknown");
    expect(isMacStreamUuid(evidence.requestId)).toBe(true);
    expect(evidence.detail).toContain("deadline");
    expect(peer.metadata()?.requestId).toBe(evidence.requestId);
  }, 30_000);

  test("stream EOF with true exit code before a result is UNKNOWN", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, {
      steps: [
        { json: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "halveerd" }] } }, delayMs: 40 },
      ],
      endExitCode: 0,
    });
    const evidence = await claudeTurn(peer);
    expect(evidence.outcome).toBe("unknown");
    expect(evidence.detail).toContain("without a result");
    expect(await eventually(() => peer.exitCode() === 0)).toBe(true);
  }, 30_000);

  test("handshake refusal is failed with the sanitized reason", async () => {
    const peer = fakeMacPeer();
    startClaudePeer(peer, { refuseHandshake: true });
    const evidence = await claudeTurn(peer);
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("rejected");
    expect(evidence.detail).toContain("not eligible");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Codex: valid / failed / interleaved / delayed / timeout / EOF / RPC error
// ---------------------------------------------------------------------------

describe("runCodexAttestTurn (CodexAppServerThread over mocked Mac stream)", () => {
  test("full protocol proves chat with the RETURNED thread id and strict ordering", async () => {
    const peer = fakeMacPeer();
    const script = startCodexPeer(peer, {
      initDelayMs: 120, // a pipelined client would trip the ordering guard
      threadId: "thread-returned-42",
      notices: [
        { method: "item/started", params: { threadId: "thread-returned-42", item: { type: "agentMessage", id: "i1" } } },
        { ...agentMessageNotice("ATTOKEN"), split: true, delayMs: 40 },
        turnCompletedNotice("completed"),
      ],
    });
    const evidence = await codexTurn(peer);
    expect(evidence.outcome).toBe("proved");
    // R1: the thread id the server RETURNED, not a local constant.
    expect(evidence.threadId).toBe("thread-returned-42");
    expect(script.turnStartParams[0]?.threadId).toBe("thread-returned-42");
    expect(evidence.detail).toContain("thread-returned-42");
    // R2: initialize was answered before thread/start was sent.
    expect(script.violations).toEqual([]);
    // Wire facts: codex provider, model setting, app-server argv, UUIDs.
    const meta = peer.metadata();
    expect(meta?.provider).toBe("codex");
    expect((meta?.settings as Record<string, unknown>)?.model).toBe("gpt-5.5");
    expect((meta?.args as string[])[0]).toBe("app-server");
    expect(meta?.requestId).toBe(evidence.requestId);
    expect(isMacStreamUuid(evidence.requestId)).toBe(true);
    // The prompt reached the provider as TURN input, never the metadata.
    expect(peer.providerLines().some((l) => l.includes("ATTOKEN"))).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("ATTOKEN");
    // Our own ssh child is reaped after the turn.
    expect(await eventually(() => peer.killed())).toBe(true);
  }, 20_000);

  test("turn/completed with failed status (quota) is failed, never proved", async () => {
    const peer = fakeMacPeer();
    startCodexPeer(peer, {
      notices: [
        agentMessageNotice("ATTOKEN"),
        turnCompletedNotice("failed", "thread-returned-42", "usage limit reached; upgrade your plan"),
      ],
    });
    const evidence = await codexTurn(peer);
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("usage limit");
  }, 20_000);

  test("JSON-RPC error on initialize is failed", async () => {
    const peer = fakeMacPeer();
    startCodexPeer(peer, { initError: { code: -32000, message: "Not signed in / usage limit reached" } });
    const evidence = await codexTurn(peer);
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("usage limit");
  }, 20_000);

  test("interleaved notifications, retriable error notices and split chunks still prove", async () => {
    const peer = fakeMacPeer();
    startCodexPeer(peer, {
      notices: [
        { method: "thread/tokenUsage/updated", params: { threadId: "thread-returned-42", tokenUsage: { last: { inputTokens: 1, outputTokens: 1 } } } },
        { method: "error", params: { error: { message: "transient upstream error" }, willRetry: true }, split: true },
        { method: "future/unknownNotification", params: { whatever: true } },
        { method: "item/agentMessage/delta", params: { threadId: "thread-returned-42", itemId: "i1", delta: "ATTOK" } },
        { method: "item/agentMessage/delta", params: { threadId: "thread-returned-42", itemId: "i1", delta: "EN" }, delayMs: 30 },
        { ...agentMessageNotice("ATTOKEN"), delayMs: 20 },
        turnCompletedNotice("completed"),
      ],
    });
    const evidence = await codexTurn(peer);
    expect(evidence.outcome).toBe("proved");
    expect(evidence.threadId).toBe("thread-returned-42");
  }, 20_000);

  test("delayed RPC answers and delayed completion still prove", async () => {
    const peer = fakeMacPeer();
    startCodexPeer(peer, {
      initDelayMs: 150,
      notices: [
        { ...agentMessageNotice("ATTOKEN"), delayMs: 250, split: true },
        { ...turnCompletedNotice("completed"), delayMs: 150 },
      ],
    });
    const evidence = await codexTurn(peer);
    expect(evidence.outcome).toBe("proved");
  }, 20_000);

  test("deadline with a hanging turn is UNKNOWN, keeps the UUID, and reaps our child", async () => {
    const peer = fakeMacPeer();
    startCodexPeer(peer, {
      notices: [
        { method: "item/started", params: { threadId: "thread-returned-42", item: { type: "agentMessage", id: "i1" } }, delayMs: 50 },
      ],
    });
    const evidence = await codexTurn(peer, { timeoutMs: 1_200 });
    expect(evidence.outcome).toBe("unknown");
    expect(isMacStreamUuid(evidence.requestId)).toBe(true);
    expect(peer.metadata()?.requestId).toBe(evidence.requestId);
    expect(peer.killed()).toBe(true); // adapter.close() ran in the finally
  }, 20_000);

  test("stream EOF with true exit code mid-turn is UNKNOWN", async () => {
    const peer = fakeMacPeer();
    startCodexPeer(peer, {
      notices: [
        { ...agentMessageNotice("ATTOKEN"), delayMs: 40 },
      ],
      eofAfterTurnStart: true,
    });
    const evidence = await codexTurn(peer);
    expect(evidence.outcome).toBe("unknown");
    expect(evidence.detail).toContain("closed during the turn");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Record honesty: outcomes → parity, testedSettings, reconciliation notes
// ---------------------------------------------------------------------------

function synthEvidence(outcome: AttestOutcome): AttestTurnEvidence {
  return {
    provider: "claude",
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    outcome,
    detail: "synthetic detail for record assembly",
    model: "opus",
  };
}

describe("buildProviderRecord honesty rules", () => {
  test("proved → parity.chat true with exactly the settings actually exercised", () => {
    const record = buildProviderRecord({ provider: "claude", evidence: synthEvidence("proved"), target: "mac-fixture" });
    expect(record.parity.chat).toBe(true);
    expect(record.parity.tools).toBe(false);
    expect(record.parity.memory).toBe(false);
    expect(record.testedSettings).toEqual(["model"]);
    expect(record.notes?.join(" ")).toContain("e2e-turn-ok");
    expect(record.evidence?.outcome).toBe("proved");
  });

  test("failed and quota-shaped failures never write parity true", () => {
    for (const outcome of ["failed"] as const) {
      const record = buildProviderRecord({ provider: "codex", evidence: synthEvidence(outcome), target: "mac-fixture" });
      expect(record.parity.chat).toBe(false);
      expect(record.testedSettings).toEqual([]);
      expect(record.notes?.join(" ")).toContain("e2e-turn-failed");
    }
  });

  test("unknown keeps parity false AND preserves the requestId for reconciliation", () => {
    const evidence = synthEvidence("unknown");
    const record = buildProviderRecord({ provider: "claude", evidence, target: "mac-fixture" });
    expect(record.parity.chat).toBe(false);
    expect(record.testedSettings).toEqual([]);
    expect(record.notes?.join(" ")).toContain(`reconcile: ssh mac-fixture status ${evidence.requestId}`);
    expect(record.evidence?.requestId).toBe(evidence.requestId);
  });

  test("facts-only claims nothing", () => {
    const record = buildProviderRecord({ provider: "codex", evidence: null, target: "mac-fixture" });
    expect(record.parity.chat).toBe(false);
    expect(record.testedSettings).toEqual([]);
    expect(record.notes?.join(" ")).toContain("facts-only");
    expect(record.evidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Document validation gate (anti-fabrication for installed files)
// ---------------------------------------------------------------------------

describe("parseAttestationDocument", () => {
  // Cache-only temp area (same convention as e2e-python-transport.test.ts).
  const BUILD_TMP = process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests";
  let tmp: string;
  test("consistent documents pass, contradictions fail", () => {
    tmp = mkdtempSync(join(BUILD_TMP, "attest-doc-"));
    const proved = buildProviderRecord({ provider: "claude", evidence: synthEvidence("proved"), target: "t" });
    const unknown = buildProviderRecord({ provider: "codex", evidence: synthEvidence("unknown"), target: "t" });
    const good = { version: 1, providers: [proved, unknown] };
    expect(parseAttestationDocument(good).valid).toBe(true);

    // parity.chat true while the evidence says unknown → rejected.
    const contradiction = structuredClone(unknown);
    contradiction.parity.chat = true;
    expect(parseAttestationDocument({ providers: [contradiction] }).valid).toBe(false);

    // parity.chat true with no tested settings → rejected.
    const noSettings = structuredClone(proved);
    noSettings.testedSettings = [];
    expect(parseAttestationDocument({ providers: [noSettings] }).valid).toBe(false);

    // Legacy shape without evidence stays acceptable (frozen compatibility).
    const legacy = {
      id: "aisdk",
      parity: { chat: false, tools: false, memory: false },
      testedSettings: [],
      supportedContainment: { agentSlice: false, sandbox: [], egressProxy: false, restrictedRoles: false },
      testedAt: Date.now(),
    };
    expect(parseAttestationDocument({ providers: [legacy] }).valid).toBe(true);

    // A file on disk round-trips through the same gate.
    const path = join(tmp, "attestation.json");
    writeFileSync(path, JSON.stringify(good));
    expect(parseAttestationDocument(JSON.parse(readFileSync(path, "utf8"))).valid).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});
