/**
 * Regression tests for worker-backed transcript database IO.
 *
 * These exercise REAL SQLite contention on an isolated fixture database (an
 * external connection holds the WAL writer lock), and pin the properties the
 * change must preserve: an unblocked event loop while writes wait, exactly-once
 * rows after release/retry, live subscriber delivery, cursor correctness
 * (including shrink reset and the volatile cursor `turn_ended` marker), the
 * untouched durable direct-write queue, and worker failure/recovery.
 *
 * Everything runs against a temp PATHS.data (never a live home store). The
 * database file path is derived per call, which is also how dataDir
 * propagation through worker requests is verified.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { PATHS } from "./config.ts";
import {
  ensureChatTranscriptCaughtUp,
  subscribeChatTranscript,
  type ChatIngestEvent,
} from "./chat-ingest.ts";
import {
  deleteTranscriptIndexForPathAsync,
  indexSessionMessagesDirect,
  indexTranscriptMessagesAsync,
  indexedMessagePage,
  indexTranscript,
  initTranscriptIndexAsync,
  resetTranscriptIndexConnectionForTests,
  sessionHasIndexedMessages,
  transcriptCursorFor,
} from "./transcript-index.ts";
import {
  isTranscriptDatabaseWorkerRunning,
  runTranscriptDatabaseOp,
  stopTranscriptDatabaseWorker,
  transcriptDatabasePendingStats,
  TranscriptWorkerUnavailableError,
  type TranscriptDatabaseCheckpointResult,
} from "./transcript-database.ts";
import type { SessionMsg } from "./sessions.ts";

function dbFile(): string {
  return join(PATHS.data, "transcript-index.sqlite");
}

function claudeLine(role: "user" | "assistant", text: string, id: string): string {
  return JSON.stringify({
    type: role,
    uuid: id,
    timestamp: "2026-01-02T03:04:05.000Z",
    message: { role, content: text },
  });
}

/** Hold the REAL WAL writer lock with an external connection. */
function holdExternalWriteLock(): { release: () => void } {
  const locker = new Database(dbFile(), { create: false, readwrite: true });
  locker.exec("PRAGMA busy_timeout = 200");
  locker.exec("BEGIN IMMEDIATE");
  locker.exec("CREATE TABLE _external_lock_probe(x)");
  return {
    release: () => {
      try {
        locker.exec("ROLLBACK");
      } finally {
        locker.close();
      }
    },
  };
}

/** Sample event-loop responsiveness while database work is pending. */
function startLoopMonitor(intervalMs = 5) {
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    maxGapMs: () => maxGapMs,
    stop: () => clearInterval(timer),
  };
}

describe("worker-backed transcript database", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-transcript-db-"));
    PATHS.data = join(root, "data");
    resetTranscriptIndexConnectionForTests();
  });

  afterEach(() => {
    resetTranscriptIndexConnectionForTests();
    delete process.env.LFG_TRANSCRIPT_DB_WORKER;
    delete process.env.LFG_TRANSCRIPT_DB_WORKER_MAX_PENDING_BYTES;
    delete process.env.LFG_TRANSCRIPT_DB_WORKER_IDLE_MS;
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("first catch-up creates the schema through the worker", async () => {
    const path = join(root, "fresh.jsonl");
    writeFileSync(path, claudeLine("user", "hello", "u1") + "\n");
    const result = await ensureChatTranscriptCaughtUp(path, "11111111-1111-4111-8111-111111111111", "test");
    expect(result.lines).toBe(1);
    expect(result.indexed).toBe(1);
    expect(statSync(dbFile()).size).toBeGreaterThan(0);
  });

  test("async ingest waits out a held writer lock off the event loop, then commits exactly once", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const path = join(root, "contended.jsonl");
    writeFileSync(path, "");
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");

    appendFileSync(
      path,
      Array.from({ length: 40 }, (_, i) => claudeLine(i % 2 ? "assistant" : "user", `message ${i}`, `m${i}`)).join("\n") +
        "\n",
    );

    const lock = holdExternalWriteLock();
    const monitor = startLoopMonitor();
    const pending = ensureChatTranscriptCaughtUp(path, sessionId, "test");
    // The lock is held for 700ms. The sync baseline blocks the loop for the
    // remaining hold; the worker path must keep ticking.
    await Bun.sleep(700);
    expect(monitor.maxGapMs()).toBeLessThan(300);
    lock.release();
    const result = await pending;
    monitor.stop();
    expect(result.lines).toBe(40);
    expect(result.indexed).toBe(40);

    const page = await indexedMessagePage(path, sessionId, { limit: 100 });
    expect(page.messages.length).toBe(40);
    expect(page.messages[0].text).toBe("message 0");
    expect(page.messages[39].text).toBe("message 39");

    // Re-running the same content must not duplicate rows (exactly-once).
    const again = await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    expect(again.unchanged).toBe(true);
    const pageAfter = await indexedMessagePage(path, sessionId, { limit: 100 });
    expect(pageAfter.messages.length).toBe(40);
    expect(pageAfter.total).toBe(40);
  });

  test("HTTP responses stay fast while async ingest waits on the writer lock", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const path = join(root, "http.jsonl");
    writeFileSync(path, "");
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    appendFileSync(
      path,
      Array.from({ length: 20 }, (_, i) => claudeLine("assistant", `line ${i}`, `h${i}`)).join("\n") + "\n",
    );

    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const lock = holdExternalWriteLock();
      const pending = ensureChatTranscriptCaughtUp(path, sessionId, "test");
      const latencies: number[] = [];
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const started = Date.now();
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(response.status).toBe(200);
        await response.text();
        latencies.push(Date.now() - started);
      }
      lock.release();
      await pending;
      expect(Math.max(...latencies)).toBeLessThan(300);
    } finally {
      server.stop(true);
    }
    const page = await indexedMessagePage(path, sessionId, { limit: 50 });
    expect(page.messages.length).toBe(20);
  });

  test("live subscribers still receive messages when catch-up goes through the worker", async () => {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const path = join(root, "live.jsonl");
    writeFileSync(path, claudeLine("user", "first", "l1") + "\n");
    const received: ChatIngestEvent[] = [];
    const unsubscribe = subscribeChatTranscript(path, sessionId, (event) => received.push(event));
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");

    appendFileSync(path, claudeLine("assistant", "second", "l2") + "\n");
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");

    const texts = received.flatMap((event) => event.messages.map((message) => message.text));
    expect(texts).toEqual(["first", "second"]);

    const page = await indexedMessagePage(path, sessionId, { limit: 10 });
    expect(page.messages.map((message) => message.text)).toEqual(["first", "second"]);
    expect(transcriptCursorFor(path)?.offset).toBe(statSync(path).size);
    unsubscribe();
  });

  test("cursor correctness: lazy file import advances exactly to file size", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const path = join(root, "import.jsonl");
    writeFileSync(
      path,
      [claudeLine("user", "one", "i1"), claudeLine("assistant", "two", "i2")].join("\n") + "\n",
    );
    const result = await indexTranscript(path, sessionId);
    expect(result.indexed).toBe(2);
    expect(result.offset).toBe(statSync(path).size);
    const repeated = await indexTranscript(path, sessionId);
    expect(repeated.indexed).toBe(0);
    const page = await indexedMessagePage(path, sessionId, { limit: 10 });
    expect(page.messages.length).toBe(2);
  });

  test("cursor correctness: a rewritten smaller transcript resets rows and reindexes", async () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const path = join(root, "shrunk.jsonl");
    writeFileSync(
      path,
      [
        claudeLine("user", "a longer first line", "s1"),
        claudeLine("assistant", "a longer second line", "s2"),
        claudeLine("user", "a longer third line", "s3"),
      ].join("\n") + "\n",
    );
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    expect((await indexedMessagePage(path, sessionId, { limit: 10 })).messages.length).toBe(3);

    writeFileSync(path, [claudeLine("user", "new one", "n1"), claudeLine("user", "new two", "n2")].join("\n") + "\n");
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");

    const page = await indexedMessagePage(path, sessionId, { limit: 10 });
    expect(page.messages.map((message) => message.text)).toEqual(["new one", "new two"]);
    expect(transcriptCursorFor(path)?.offset).toBe(statSync(path).size);
  });

  test("a file-trailing cursor turn_ended marker stays uncommitted", async () => {
    const sessionId = "77777777-7777-4777-8777-777777777777";
    const path = join(root, "volatile.jsonl");
    const marker = JSON.stringify({ type: "turn_ended", timestamp: "2026-01-02T03:04:06.000Z" });
    writeFileSync(path, claudeLine("user", "hi", "v1") + "\n" + marker + "\n");
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");

    const cursor = transcriptCursorFor(path);
    expect(cursor).not.toBeNull();
    expect(cursor!.offset).toBeLessThan(statSync(path).size);
    expect((await indexedMessagePage(path, sessionId, { limit: 10 })).messages.map((m) => m.text)).toEqual(["hi"]);

    // The marker is rewritten in place by the next turn; it must be indexed then.
    appendFileSync(path, claudeLine("assistant", "done", "v2") + "\n");
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    expect((await indexedMessagePage(path, sessionId, { limit: 10 })).messages.map((m) => m.text)).toEqual([
      "hi",
      "done",
    ]);
    expect(transcriptCursorFor(path)?.offset).toBe(statSync(path).size);
  });

  test("schema readiness is read-only on a current database while the writer lock is held", async () => {
    const path = join(root, "schema.jsonl");
    writeFileSync(path, claudeLine("user", "seed", "w1") + "\n");
    await ensureChatTranscriptCaughtUp(path, "88888888-8888-4888-8888-888888888888", "test");

    const lock = holdExternalWriteLock();
    try {
      const started = Date.now();
      await initTranscriptIndexAsync();
      // The old init opened a writer transaction on first access and would
      // have blocked here until the lock released.
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      lock.release();
    }
    // The checkpoint op runs through the worker and reports SQLite counters.
    const checkpoint = await runTranscriptDatabaseOp<TranscriptDatabaseCheckpointResult>({
      kind: "checkpoint",
      dbPath: dbFile(),
    });
    expect(typeof checkpoint.busy).toBe("number");
  });

  test("direct session writes still go through the durable synchronous queue", () => {
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const message: SessionMsg = {
      id: "d1",
      role: "assistant",
      kind: "text",
      text: "hello direct",
      ts: Date.now(),
    } as SessionMsg;
    const inserted = indexSessionMessagesDirect(sessionId, [message]);
    expect(inserted).toBe(1);
    expect(sessionHasIndexedMessages(sessionId)).toBe(true);
  });

  test("worker opt-out falls back to synchronous durable writes and recovers when re-enabled", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const path = join(root, "fallback.jsonl");
    writeFileSync(path, claudeLine("user", "before", "f1") + "\n");

    process.env.LFG_TRANSCRIPT_DB_WORKER = "0";
    const first = await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    expect(first.indexed).toBe(1);
    expect(isTranscriptDatabaseWorkerRunning()).toBe(false);

    delete process.env.LFG_TRANSCRIPT_DB_WORKER;
    appendFileSync(path, claudeLine("assistant", "after", "f2") + "\n");
    const second = await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    expect(second.indexed).toBe(1);
    expect(isTranscriptDatabaseWorkerRunning()).toBe(true);

    const page = await indexedMessagePage(path, sessionId, { limit: 10 });
    expect(page.messages.map((message) => message.text)).toEqual(["before", "after"]);
  });

  test("stopping the worker rejects in-flight ops and a later op respawns it", async () => {
    const path = join(root, "lifecycle.jsonl");
    writeFileSync(path, claudeLine("user", "seed", "c1") + "\n");
    await ensureChatTranscriptCaughtUp(path, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "test");
    expect(isTranscriptDatabaseWorkerRunning()).toBe(true);

    const lock = holdExternalWriteLock();
    const pending = runTranscriptDatabaseOp({
      kind: "insert-messages",
      dbPath: dbFile(),
      path: join(root, "pending.jsonl"),
      sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      rows: [],
      cursor: { size: 0, offset: 0, mtimeMs: 0 },
    });
    stopTranscriptDatabaseWorker();
    await expect(pending).rejects.toBeInstanceOf(TranscriptWorkerUnavailableError);
    lock.release();

    // Respawn happens on the next request (after the short cooldown).
    await Bun.sleep(300);
    const checkpoint = await runTranscriptDatabaseOp<TranscriptDatabaseCheckpointResult>({
      kind: "checkpoint",
      dbPath: dbFile(),
    });
    expect(typeof checkpoint.busy).toBe("number");
    expect(isTranscriptDatabaseWorkerRunning()).toBe(true);
  });

  // Parent review: the shared row builder must reproduce the BASE importer's
  // ids/content exactly — including lines that mix empty-text and non-empty
  // message blocks, where index assignment could silently drift.
  test("importer rows are identical to the base snapshot importer (ids, order, content)", async () => {
    const baseRoot = mkdtempSync(join(tmpdir(), "lfg-base-compat-"));
    const fixture = join(root, "compat.jsonl");
    const mixedLine = JSON.stringify({
      type: "user",
      uuid: "compat-mixed",
      timestamp: "2026-01-02T03:04:05.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "   " },
          { type: "text", text: "alpha" },
          { type: "text", text: "" },
          { type: "text", text: "beta" },
        ],
      },
    });
    writeFileSync(
      fixture,
      [
        mixedLine,
        claudeLine("assistant", "gamma", "compat-plain"),
        JSON.stringify({
          type: "user",
          uuid: "compat-empty",
          timestamp: "2026-01-02T03:04:06.000Z",
          message: { role: "user", content: "" },
        }),
        claudeLine("user", "delta", "compat-last"),
      ].join("\n") + "\n",
    );
    const session = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    const baseConfig = await import("../../base/src/config.ts");
    const originalBaseData = baseConfig.PATHS.data;
    baseConfig.PATHS.data = join(baseRoot, "data");
    const baseIndex = await import("../../base/src/transcript-index.ts");
    try {
      const baseResult = await baseIndex.indexTranscript(fixture, session);
      const candidateResult = await indexTranscript(fixture, session);
      expect(candidateResult.indexed).toBe(baseResult.indexed);
      expect(candidateResult.offset).toBe(baseResult.offset);

      const readRows = (dbPath: string) =>
        new Database(dbPath, { create: false, readonly: true })
          .query(
            "SELECT id, message_id, role, kind, ts, text, byte_offset, order_seq FROM transcript_messages ORDER BY rowid",
          )
          .all();
      const baseRows = readRows(join(baseRoot, "data", "transcript-index.sqlite"));
      const candidateRows = readRows(dbFile());
      expect(baseRows.length).toBeGreaterThan(0);
      expect(candidateRows).toEqual(baseRows);
    } finally {
      baseIndex.resetTranscriptIndexConnectionForTests();
      baseConfig.PATHS.data = originalBaseData;
      rmSync(baseRoot, { recursive: true, force: true });
    }
  });

  // Parent review: backpressure must bound queued payload BYTES, not just op
  // count; nothing may be dropped.
  test("byte backpressure defers oversized follow-on writes without dropping them", async () => {
    process.env.LFG_TRANSCRIPT_DB_WORKER_MAX_PENDING_BYTES = "16384";
    const seedPath = join(root, "bp-seed.jsonl");
    writeFileSync(seedPath, "");
    await ensureChatTranscriptCaughtUp(seedPath, "feedfeed-feed-4feed-8feed-feedfeedfeed", "test");

    const bigLines = (tag: string) =>
      Array.from({ length: 120 }, (_, i) => ({
        offset: i * 100,
        messages: [
          {
            id: `${tag}-${i}`,
            role: "assistant",
            kind: "text",
            text: `${tag} padded message ${i} ${"y".repeat(60)}`,
            ts: 1_700_000_000_000 + i,
          } as SessionMsg,
        ],
      }));
    const pathA = join(root, "bp-a.jsonl");
    const pathB = join(root, "bp-b.jsonl");
    writeFileSync(pathA, "");
    writeFileSync(pathB, "");

    const lock = holdExternalWriteLock();
    const first = indexTranscriptMessagesAsync(pathA, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", bigLines("a"), {
      size: 12_000,
      offset: 12_000,
      mtimeMs: 1,
    });
    await Bun.sleep(250); // first op posted and busy-waiting inside the worker
    const second = indexTranscriptMessagesAsync(pathB, "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2", bigLines("b"), {
      size: 12_000,
      offset: 12_000,
      mtimeMs: 1,
    });
    await Bun.sleep(150);
    // The second oversized payload must be held back, not queued unbounded.
    expect(transcriptDatabasePendingStats().ops).toBe(1);
    lock.release();
    const [firstInserted, secondInserted] = await Promise.all([first, second]);
    expect(firstInserted).toBe(120);
    expect(secondInserted).toBe(120);
    expect((await indexedMessagePage(pathA, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", { limit: 200 })).total).toBe(120);
    expect((await indexedMessagePage(pathB, "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2", { limit: 200 })).total).toBe(120);
  });

  // Parent review: a destructive op whose ack was lost must NOT be replayed
  // synchronously — surface the uncertainty and leave durable state alone.
  test("an uncertain destructive op is rejected, never silently replayed", async () => {
    const sessionId = "abababab-abab-4aba-8bab-abababababab";
    const path = join(root, "uncertain.jsonl");
    writeFileSync(path, claudeLine("user", "durable", "u1") + "\n");
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    expect((await indexedMessagePage(path, sessionId, { limit: 10 })).total).toBe(1);

    const lock = holdExternalWriteLock();
    const pendingDelete = deleteTranscriptIndexForPathAsync(path);
    await Bun.sleep(250); // reset-path is busy-waiting inside the worker
    stopTranscriptDatabaseWorker();
    let caught: unknown;
    try {
      await pendingDelete;
    } catch (error) {
      caught = error;
    }
    lock.release();
    expect(caught).toBeInstanceOf(TranscriptWorkerUnavailableError);
    expect((caught as TranscriptWorkerUnavailableError).dispatched).toBe(true);
    // No synchronous replay happened: the committed rows are untouched.
    expect((await indexedMessagePage(path, sessionId, { limit: 10 })).total).toBe(1);
    // Authoritative state re-derives on the next catch-up pass.
    await ensureChatTranscriptCaughtUp(path, sessionId, "test");
    expect((await indexedMessagePage(path, sessionId, { limit: 10 })).total).toBe(1);
  });

  // Parent review: opening the database must not pin a worker in every idle
  // agent process; the periodic checkpoint only uses an already-running one.
  test("opening the database never spawns a worker by itself", async () => {
    resetTranscriptIndexConnectionForTests();
    const message: SessionMsg = {
      id: "no-spawn",
      role: "assistant",
      kind: "text",
      text: "no spawn probe",
      ts: Date.now(),
    } as SessionMsg;
    indexSessionMessagesDirect("acacacac-acac-4cac-8cac-acacacacacac", [message]);
    expect(isTranscriptDatabaseWorkerRunning()).toBe(false);
    await Bun.sleep(100);
    expect(isTranscriptDatabaseWorkerRunning()).toBe(false);
  });

  // Parent review: an idle worker must shut down and never block CLI exit.
  test("an idle worker shuts down and the process exits without explicit cleanup", async () => {
    const exitRoot = mkdtempSync(join(tmpdir(), "lfg-worker-exit-"));
    const srcDir = import.meta.dir;
    const dataDir = join(exitRoot, "data");
    const fixture = join(exitRoot, "exit.jsonl");
    const script = `
      const { writeFileSync } = await import("node:fs");
      const { PATHS } = await import(${JSON.stringify(join(srcDir, "config.ts"))});
      PATHS.data = ${JSON.stringify(dataDir)};
      const ingest = await import(${JSON.stringify(join(srcDir, "chat-ingest.ts"))});
      const { isTranscriptDatabaseWorkerRunning } = await import(${JSON.stringify(join(srcDir, "transcript-database.ts"))});
      writeFileSync(${JSON.stringify(fixture)}, ${JSON.stringify(claudeLine("user", "exit probe", "e1") + "\n")});
      await ingest.ensureChatTranscriptCaughtUp(${JSON.stringify(fixture)}, "adadadad-adad-4dad-8dad-adadadadadad", "exit-test");
      console.log("RUNNING=" + (isTranscriptDatabaseWorkerRunning() ? 1 : 0));
      await Bun.sleep(450);
      console.log("AFTER=" + (isTranscriptDatabaseWorkerRunning() ? 1 : 0));
    `;
    try {
      const proc = Bun.spawn(["bun", "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env, LFG_TRANSCRIPT_DB_WORKER_IDLE_MS: "150" },
      });
      const exited = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => null)]);
      const out = await new Response(proc.stdout).text();
      if (exited === null) {
        proc.kill();
        throw new Error("child process never exited; worker pinned the event loop");
      }
      expect(exited).toBe(0);
      expect(out).toContain("RUNNING=1");
      expect(out).toContain("AFTER=0");
    } finally {
      rmSync(exitRoot, { recursive: true, force: true });
    }
  });
});
