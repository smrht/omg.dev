/**
 * Main-thread client for the transcript database worker (one narrow, bounded,
 * reusable worker thread — see transcript-database-worker.ts).
 *
 * Design contract:
 *  - SINGLE worker, FIFO. postMessage preserves order and the worker handles
 *    requests sequentially, so per-path batches commit in caller order — the
 *    same ordering the synchronous path had. Reads never enter this queue, so
 *    normal read responsiveness on the calling thread is unaffected even while
 *    one write waits out a database lock (head-of-line blocking is confined to
 *    writes, which are serialized by SQLite's single writer anyway).
 *  - Coalescing (keyed ops): concurrent schema-init / checkpoint requests for
 *    the same dbPath share one in-flight request instead of queueing repeats.
 *  - Backpressure: bounds the IN-FLIGHT payload budget (pending op count and
 *    an approximate byte estimate of dispatched requests). It is not a hard
 *    process-memory cap: one oversized request is always admitted when the
 *    queue is empty (it cannot be split), and callers awaiting capacity still
 *    hold their own row arrays until dispatch.
 *  - Lifecycle: lazy spawn on first op, respawn only when a later op requests
 *    it (never recursively / from inside the worker), a short cooldown after a
 *    failure so a broken worker cannot become a spawn loop, a watchdog that
 *    bounds a hung worker, and idle shutdown so a spawned worker never keeps
 *    an otherwise-done CLI process alive. `LFG_TRANSCRIPT_DB_WORKER=0`
 *    disables the worker entirely — callers then use their synchronous
 *    fallback so durability never depends on this module.
 *
 * Delivery semantics (honest): insert ops are AT-LEAST-ONCE with
 * deterministic-id dedup (INSERT OR IGNORE + monotonic cursor), which yields
 * exactly-once ROWS after any retry, but no ack is proof of delivery — an op
 * whose ack was lost may have committed. Callers must treat DESTRUCTIVE ops
 * (reset-path, adopt-session) that fail with a dispatched error as
 * UNCERTAIN: re-check authoritative state (the transcript file and cursor)
 * before replaying, never blind-replay.
 *
 * This module does NOT make every database operation async: reads and legacy
 * synchronous exports stay on the calling thread (see transcript-index.ts).
 */
import type { TranscriptCursorInput, TranscriptRowInput } from "./transcript-database-core.ts";
import type { ImageArtifact } from "./artifacts.ts";

export type TranscriptDatabaseRequest =
  | { kind: "schema-init"; dbPath: string; seedArtifacts: ImageArtifact[] }
  | {
      kind: "insert-messages";
      dbPath: string;
      path: string;
      sessionId: string;
      rows: TranscriptRowInput[];
      cursor?: TranscriptCursorInput;
    }
  | { kind: "adopt-session"; dbPath: string; path: string; sessionId: string }
  | { kind: "reset-path"; dbPath: string; path: string }
  | { kind: "checkpoint"; dbPath: string };

export type TranscriptDatabaseInsertResult = { inserted: number };
export type TranscriptDatabaseSchemaResult = { status: "current" | "created" | "legacy" };
export type TranscriptDatabaseAdoptResult = {
  cursor: { offset: number; session_id: string } | null;
  rebound: boolean;
};
export type TranscriptDatabaseCheckpointResult = { busy: number; log: number; checkpointed: number };

/**
 * The worker is unusable (disabled, failed to spawn, crashed, timed out, or
 * was stopped). `dispatched: true` means the failed op HAD been posted — it
 * may have committed without its ack reaching us; `dispatched: false` means it
 * never left this thread, so a synchronous fallback replay is provably safe.
 */
export class TranscriptWorkerUnavailableError extends Error {
  dispatched: boolean;
  constructor(message: string, options?: { cause?: unknown; dispatched?: boolean }) {
    super(message, options);
    this.name = "TranscriptWorkerUnavailableError";
    this.dispatched = options?.dispatched ?? false;
  }
}

/** A worker request failed (e.g. SQLite contention after the worker-side busy wait). */
export class TranscriptDatabaseOpError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "TranscriptDatabaseOpError";
    this.code = code;
  }
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_PENDING_OPS = 256;
// Read lazily so operators (and tests) can retune without a process restart.
const maxPendingBytes = (): number => positiveIntEnv("LFG_TRANSCRIPT_DB_WORKER_MAX_PENDING_BYTES", 16 * 1024 * 1024);
const workerIdleShutdownMs = (): number => positiveIntEnv("LFG_TRANSCRIPT_DB_WORKER_IDLE_MS", 15_000);
const RESPAWN_COOLDOWN_MS = 250;
// The worker may legitimately wait out a ~15s busy_timeout (and a slow legacy
// migration on first contact) without being dead. The watchdog only fires far
// beyond that. On fire, row inserts are safe to re-issue (deterministic ids),
// destructive ops must not be blind-replayed (see class comment).
const OP_WATCHDOG_MS = 60_000;

/** Rough serialized-size estimate so the byte budget bounds real payloads. */
function estimateOpBytes(op: TranscriptDatabaseRequest): number {
  if (op.kind !== "insert-messages") return 4096;
  let total = 8192;
  for (const row of op.rows) {
    total += 128 + row.id.length + (row.message_id?.length ?? 0) + row.text.length + row.author_json.length;
  }
  return total;
}

type PendingEntry = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  deadline: number;
  bytes: number;
};

let worker: Worker | null = null;
let seq = 0;
let lastFailureAt = 0;
let pendingBytes = 0;
const pending = new Map<number, PendingEntry>();
const keyed = new Map<string, Promise<unknown>>();
let watchdog: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export function transcriptDatabaseWorkerEnabled(): boolean {
  return process.env.LFG_TRANSCRIPT_DB_WORKER !== "0";
}

export function isTranscriptDatabaseWorkerRunning(): boolean {
  return worker !== null;
}

function startWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    const now = Date.now();
    for (const entry of pending.values()) {
      if (now >= entry.deadline) {
        failAll(new TranscriptWorkerUnavailableError("transcript database worker timed out", { dispatched: true }));
        return;
      }
    }
  }, 1_000);
  (watchdog as { unref?: () => void }).unref?.();
}

function stopWatchdogIfIdle(): void {
  if (pending.size || !watchdog) return;
  clearInterval(watchdog);
  watchdog = null;
}

/** Shut an idle worker down after a quiet period so it never pins a CLI exit. */
function scheduleIdleShutdown(): void {
  if (idleTimer || !worker || pending.size) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size || !worker) return;
    // No ack is pending: nothing can observe this worker again except a fresh
    // spawn on the next op, so dropping it silently is safe.
    try {
      worker.terminate();
    } catch {
      // Already gone.
    }
    worker = null;
  }, workerIdleShutdownMs());
  (idleTimer as { unref?: () => void }).unref?.();
}

function cancelIdleShutdown(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function failAll(error: Error): void {
  const entries = [...pending.values()];
  pending.clear();
  pendingBytes = 0;
  lastFailureAt = Date.now();
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // Already gone.
    }
    worker = null;
  }
  for (const entry of entries) entry.reject(error);
  stopWatchdogIfIdle();
}

function settle(id: number, entry: PendingEntry, ok: boolean, value: unknown): void {
  pending.delete(id);
  pendingBytes -= entry.bytes;
  if (pendingBytes < 0) pendingBytes = 0;
  if (ok) entry.resolve(value);
  else entry.reject(value);
  stopWatchdogIfIdle();
  if (!pending.size) scheduleIdleShutdown();
}

function ensureWorker(): Worker {
  if (!transcriptDatabaseWorkerEnabled()) {
    throw new TranscriptWorkerUnavailableError("transcript database worker disabled (LFG_TRANSCRIPT_DB_WORKER=0)");
  }
  if (worker) {
    cancelIdleShutdown();
    return worker;
  }
  if (Date.now() - lastFailureAt < RESPAWN_COOLDOWN_MS) {
    throw new TranscriptWorkerUnavailableError("transcript database worker is in respawn cooldown");
  }
  try {
    const spawned = new Worker(new URL("./transcript-database-worker.ts", import.meta.url));
    (spawned as { unref?: () => void }).unref?.();
    spawned.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: { message: string; code?: string } }>) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      if (response.ok) settle(response.id, entry, true, response.result);
      else {
        settle(
          response.id,
          entry,
          false,
          new TranscriptDatabaseOpError(response.error?.message ?? "transcript database op failed", response.error?.code),
        );
      }
    };
    spawned.onerror = () => {
      failAll(new TranscriptWorkerUnavailableError("transcript database worker crashed", { dispatched: true }));
    };
    spawned.onmessageerror = () => {
      failAll(
        new TranscriptWorkerUnavailableError("transcript database worker message failed to deserialize", {
          dispatched: true,
        }),
      );
    };
    worker = spawned;
    return spawned;
  } catch (cause) {
    lastFailureAt = Date.now();
    throw new TranscriptWorkerUnavailableError("could not start transcript database worker", { cause });
  }
}

async function post(op: TranscriptDatabaseRequest): Promise<unknown> {
  const opBytes = estimateOpBytes(op);
  // Backpressure on BOTH count and payload bytes. An empty queue always
  // proceeds — a single oversized op cannot be split and would otherwise spin
  // on a settled race — and no request is ever dropped.
  while (pending.size > 0 && (pending.size >= MAX_PENDING_OPS || pendingBytes + opBytes > maxPendingBytes())) {
    await Promise.race([...pending.values()].map((entry) => entry.promise.catch(() => {})));
  }
  let target: Worker;
  try {
    target = ensureWorker();
  } catch (error) {
    if (
      error instanceof TranscriptWorkerUnavailableError &&
      transcriptDatabaseWorkerEnabled() &&
      Date.now() - lastFailureAt < RESPAWN_COOLDOWN_MS
    ) {
      // A recent failure put the worker in respawn cooldown. Wait it out once
      // instead of pushing the caller onto the synchronous fallback path.
      await Bun.sleep(RESPAWN_COOLDOWN_MS);
      target = ensureWorker();
    } else {
      throw error;
    }
  }
  const id = ++seq;
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending.set(id, { promise, resolve, reject, deadline: Date.now() + OP_WATCHDOG_MS, bytes: opBytes });
  pendingBytes += opBytes;
  startWatchdog();
  try {
    target.postMessage({ id, op });
  } catch (cause) {
    settle(id, pending.get(id)!, false, new TranscriptWorkerUnavailableError("transcript database worker post failed", { cause }));
  }
  return promise;
}

/**
 * Run one worker operation. `opts.key` coalesces concurrent identical requests
 * (used for schema-init and checkpoint).
 */
export function runTranscriptDatabaseOp<T = unknown>(
  op: TranscriptDatabaseRequest,
  opts: { key?: string } = {},
): Promise<T> {
  const key = opts.key;
  if (key) {
    const inFlight = keyed.get(key);
    if (inFlight) return inFlight as Promise<T>;
  }
  const dispatched = post(op).finally(() => {
    if (key) keyed.delete(key);
  });
  if (key) keyed.set(key, dispatched);
  return dispatched as Promise<T>;
}

/** Read-only queue stats for tests and diagnostics. */
export function transcriptDatabasePendingStats(): { ops: number; bytes: number } {
  return { ops: pending.size, bytes: pendingBytes };
}

/** Stop the worker and fail pending ops (uncertain: they were dispatched). Used by tests and resets. */
export function stopTranscriptDatabaseWorker(): void {
  cancelIdleShutdown();
  failAll(new TranscriptWorkerUnavailableError("transcript database worker stopped", { dispatched: true }));
}
