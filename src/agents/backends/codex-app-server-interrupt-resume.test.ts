// Focused deterministic regression for the codex-interrupt-2 driver failure
// (live facts 4 Oct 2026): turn 3 interrupted mid-turn via the real abort
// path, turn 4 resumed the SAME thread immediately — and died with the
// generic "Codex app-server closed during the turn". Root cause: the
// thread/resume response is ONE history+catalog line (~1.07 MB live); the
// client's frame cap killed it mid-resume and the onClosed handler masked
// the protocol error.
//
// This test drives the REAL remote transport (createRemoteCodexTransport
// over the fake-ssh fixture subprocess — metadata line, handshake, verbatim
// native bytes) through the REAL adapter abort lifecycle: adapter 1 runs a
// held turn, is aborted exactly like the harness aborts (AbortSignal), and
// adapter 2 resumes the same thread IMMEDIATELY, with the fixture padding
// the resume response to the live ~1.07 MB size. No network, no ssh host,
// no inference: the fixture IS the Mac supervisor stand-in.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerThread } from "./codex-app-server-session.ts";
import { createRemoteCodexTransport } from "../../mac-chat/codex-transport.ts";
import type { SpawnedSshChild } from "../../mac-chat/stream.ts";
import type { ThreadEvent } from "@openai/codex-sdk";

const FIXTURE = join(import.meta.dir, "../../../test/mac-chat/fixtures/fake-ssh.ts");
const THREAD = "thread-interrupt-resume-1";
let outDir: string;

/** Spawn the fixture ssh stand-in with per-test regression knobs in env. */
function fixtureSpawn(extraEnv: Record<string, string>) {
  return (argv: readonly string[]): SpawnedSshChild => {
    const child = Bun.spawn([process.execPath, FIXTURE, ...argv.slice(1)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, FIXTURE_OUT: outDir, ...extraEnv },
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
  };
}

function launchTransport(env: Record<string, string>) {
  return createRemoteCodexTransport({
    deps: { spawn: fixtureSpawn(env) },
    sessionId: crypto.randomUUID(),
    target: "mac-fixture",
    context: {
      revision: "ab".repeat(32),
      instructions: [{ order: 0, path: "/repo/AGENTS.md", sha256: "cd".repeat(32), content: "REGRESSION-CONTEXT" }],
      skills: [],
      memory: [],
    },
    mcpServers: {},
    settings: { model: "gpt-6.1-sol" },
  });
}

type EventIterator = AsyncIterator<ThreadEvent, void, unknown>;

/** Next event, bounded — a wedged stream fails the test instead of hanging it. */
async function nextEvent(iterator: EventIterator, timeoutMs = 15_000): Promise<ThreadEvent | null> {
  const timedOut = Symbol("timeout");
  const event = await Promise.race([
    iterator.next(),
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
  ]);
  return event === timedOut ? null : (event as IteratorResult<ThreadEvent>).value ?? null;
}

async function drainRest(iterator: EventIterator): Promise<ThreadEvent[]> {
  const out: ThreadEvent[] = [];
  for (;;) {
    const event = await nextEvent(iterator, 5_000);
    if (event === null) return out;
    out.push(event);
  }
}

beforeAll(() => {
  outDir = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "codex-interrupt-resume-"));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("interrupt followed immediately by resume over the actual transport fixture", () => {
  test("turn 3 aborts mid-turn; turn 4 resumes the same thread with a live-sized resume line and completes", async () => {
    // ---- Turn 3: held turn, aborted mid-turn like the harness does. ----
    const adapter1 = new CodexAppServerThread({
      model: "gpt-6.1-sol",
      transport: launchTransport({ FIXTURE_PROVIDER_THREAD: THREAD, FIXTURE_HOLD_TURN: "1" }),
    });
    const controller = new AbortController();
    const turn3 = await adapter1.runStreamed("beurt 3", { signal: controller.signal });
    const iterator3 = turn3.events[Symbol.asyncIterator]();
    const started = await nextEvent(iterator3);
    expect(started).toEqual({ type: "thread.started", thread_id: THREAD });
    expect(await nextEvent(iterator3)).toEqual({ type: "turn.started" });

    controller.abort();
    const rest = await drainRest(iterator3);
    // A deliberate interrupt is never an error, and no bogus completion.
    expect(rest.some((event) => event.type === "error")).toBe(false);
    expect(rest.some((event) => event.type === "turn.completed")).toBe(false);
    await adapter1.close();

    // ---- Turn 4: IMMEDIATE resume, same thread, live-sized resume line. ----
    const adapter2 = new CodexAppServerThread({
      model: "gpt-6.1-sol",
      resumeThreadId: adapter1.id,
      transport: launchTransport({ FIXTURE_PROVIDER_THREAD: THREAD, FIXTURE_RESUME_PAD_BYTES: "1075000" }),
    });
    expect(adapter2.id).toBe(THREAD);
    const turn4 = await adapter2.runStreamed("beurt 4");
    const iterator4 = turn4.events[Symbol.asyncIterator]();
    const events4 = await drainRest(iterator4);
    await adapter2.close();

    // Before the fix this was exactly ONE event: the generic
    // "Codex app-server closed during the turn" from the frame cap.
    const types = events4.map((event) => event.type);
    expect(types).toEqual(["thread.started", "turn.started", "item.completed", "turn.completed"]);
    expect(events4[0]).toEqual({ type: "thread.started", thread_id: THREAD });
    expect(events4.some((event) => event.type === "error")).toBe(false);

    // The wire saw the real lifecycle: resume of the SAME native thread.
    // (The turn/interrupt REQUEST itself is pinned at adapter level in
    // codex-app-server-session.test.ts; whether the line still crosses the
    // ssh pipe before close()'s SIGTERM is transport-flush timing, not this
    // regression.)
    const providerStdin = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
    expect(providerStdin).toContain('"thread/resume"');
    expect(providerStdin).toContain(`"threadId":"${THREAD}"`);
  });
});
