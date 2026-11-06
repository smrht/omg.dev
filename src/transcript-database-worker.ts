/**
 * Worker-thread entry for transcript index database IO.
 *
 * One narrow, reusable worker executes the lock-bound SQLite operations that
 * used to run on serve's event loop: schema init, message batch inserts,
 * cursor adoption/reset, and the periodic WAL checkpoint. The web loop stays
 * responsive because busy_timeout lock waits (up to 15s) happen on THIS
 * thread, not on the request path.
 *
 * Rules this file deliberately obeys:
 *  - It never imports transcript-index.ts, chat-ingest.ts, config.ts or any
 *    runtime service, so it cannot start duplicate checkpoint timers, the
 *    durable write queue, or anything else with a side effect.
 *  - It never spawns workers itself (no recursive worker spawn).
 *  - It does not read PATHS/env for its database location: every request
 *    carries dbPath, so dataDir changes on the main thread (tests, multi-tenant
 *    tooling) propagate per message and the connection rebinds safely.
 *  - All SQL lives in transcript-database-core.ts, shared with the synchronous
 *    main-thread path — same schema, same ids, same semantics.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  adoptTranscriptSession,
  checkpointTranscriptWal,
  createCurrentTranscriptSchema,
  insertTranscriptRows,
  resetTranscriptPathRows,
  transcriptSchemaStatus,
} from "./transcript-database-core.ts";
// Type-only: the request union lives with the client so both sides share one
// definition; it erases at runtime and does not pull client code into the worker.
import type { TranscriptDatabaseRequest } from "./transcript-database.ts";

const WORKER_BUSY_TIMEOUT_MS = 15_000;

let db: Database | null = null;
let openPath: string | null = null;

function connection(dbPath: string): Database {
  if (db && openPath === dbPath) return db;
  if (db) {
    try {
      db.close();
    } catch {
      // Rebinding after a dataDir change; a failed close must not wedge the worker.
    }
    db = null;
    openPath = null;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const opened = new Database(dbPath, { create: true });
  try {
    opened.exec(`PRAGMA busy_timeout = ${WORKER_BUSY_TIMEOUT_MS}`);
    opened.exec("PRAGMA journal_mode = WAL");
    opened.exec("PRAGMA synchronous = NORMAL");
    opened.exec("PRAGMA wal_autocheckpoint = 1000");
  } catch (error) {
    // Never leak a half-configured connection: setup can itself hit lock
    // contention on a busy file.
    try {
      opened.close();
    } catch {
      // close after a failed exec is best-effort
    }
    throw error;
  }
  db = opened;
  openPath = dbPath;
  return opened;
}

function handle(request: TranscriptDatabaseRequest): unknown {
  switch (request.kind) {
    case "schema-init": {
      const d = connection(request.dbPath);
      const status = transcriptSchemaStatus(d);
      if (status === "fresh") {
        createCurrentTranscriptSchema(d, request.seedArtifacts ?? []);
        return { status: "created" as const };
      }
      return { status };
    }
    case "insert-messages": {
      const d = connection(request.dbPath);
      let inserted = 0;
      d.transaction(() => {
        inserted = insertTranscriptRows(d, request.path, request.sessionId, request.rows, request.cursor);
      }).immediate();
      return { inserted };
    }
    case "adopt-session": {
      const d = connection(request.dbPath);
      return adoptTranscriptSession(d, request.path, request.sessionId);
    }
    case "reset-path": {
      const d = connection(request.dbPath);
      resetTranscriptPathRows(d, request.path);
      return { reset: true as const };
    }
    case "checkpoint": {
      const d = connection(request.dbPath);
      return checkpointTranscriptWal(d);
    }
  }
}

// `self` is not declared by the bun lib in this compile context; reach the
// worker global port generically so the file typechecks in every config.
const workerPort = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; op: TranscriptDatabaseRequest }>) => void) | null;
  postMessage: (message: unknown) => void;
};

workerPort.onmessage = (event: MessageEvent<{ id: number; op: TranscriptDatabaseRequest }>) => {
  const { id, op } = event.data;
  let response: { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { message: string; code?: string } };
  try {
    response = { id, ok: true, result: handle(op) };
  } catch (error) {
    const err = error as { code?: string; errno?: number; message?: string };
    response = {
      id,
      ok: false,
      error: {
        message: err?.message ?? String(error),
        // Surface SQLite contention codes so callers can distinguish a busy
        // retry from a hard failure without shipping message text around.
        code: err?.code ?? (typeof err?.errno === "number" ? `SQLITE_${err.errno & 255}` : undefined),
      },
    };
  }
  workerPort.postMessage(response);
};
