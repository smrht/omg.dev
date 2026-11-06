/**
 * Shared, dependency-light SQL core for the transcript index database.
 *
 * Both the synchronous main-thread path (src/transcript-index.ts) and the
 * worker thread (src/transcript-database-worker.ts) execute EXACTLY these
 * statements, so a row written by either side is indistinguishable: same
 * schema, same ids, same order_seq assignment, same cursor upsert. Old/new
 * backend compatibility is preserved by construction — there is one source of
 * truth for the SQL, and the legacy migration sequence in transcript-index.ts
 * remains the only writer of pre-v12 shapes.
 *
 * This module must stay import-light (type-only imports beyond bun:sqlite) so
 * the worker can load it without pulling in runtime services, timers, or the
 * artifact/sharp module graph.
 */
import type { Database } from "bun:sqlite";
import type { ImageArtifact } from "./artifacts.ts";

export const TRANSCRIPT_SCHEMA_VERSION = 12;

/** Row payload for one message insert; author_json is precomputed by the caller. */
export type TranscriptRowInput = {
  id: string;
  message_id: string | null;
  byte_offset: number;
  ts: number | null;
  role: string;
  kind: string;
  text: string;
  author_json: string;
};

export type TranscriptCursorInput = { size: number; offset: number; mtimeMs: number };

/** sqlite_master objects that a fully-migrated (v12) database must contain. */
const REQUIRED_SCHEMA_OBJECTS: ReadonlySet<string> = new Set([
  "table|transcript_seed_state",
  "table|transcript_index_cursors",
  "table|transcript_messages",
  "table|artifacts",
  "index|transcript_messages_session_ts",
  "index|transcript_messages_path_offset",
  "index|transcript_messages_message_id",
  "index|transcript_messages_path_order",
  "index|transcript_artifact_message_unique",
  "index|artifacts_session_created",
  "trigger|transcript_messages_assign_order",
]);

/**
 * "fresh": no schema objects at all — a brand new database file.
 * "current": v12 with every required object present.
 * "legacy": anything else — the full migration transaction must run (main
 * thread only; see init() in transcript-index.ts).
 *
 * Readiness intentionally does NOT rescan `WHERE order_seq IS NULL`: that
 * predicate cannot seek the composite (path, order_seq) index, so on a large
 * install it was a full synchronous scan on every first access. The v8
 * `transcript_messages_assign_order` trigger (required below) already assigns
 * order_seq to any row an old writer process appends, and pre-v8 stragglers
 * are folded in by the version<7 migration branch, which only runs when
 * user_version is genuinely behind.
 */
export type TranscriptSchemaStatus = "fresh" | "current" | "legacy";

export function transcriptSchemaStatus(d: Database): TranscriptSchemaStatus {
  const objects = d
    .query<{ type: string; name: string }, []>(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .all();
  if (!objects.length) return "fresh";
  const have = new Set(objects.map((o) => `${o.type}|${o.name}`));
  for (const required of REQUIRED_SCHEMA_OBJECTS) {
    if (!have.has(required)) return "legacy";
  }
  const version = d.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version !== TRANSCRIPT_SCHEMA_VERSION) return "legacy";
  return "current";
}

/** Mirror of one durable artifact into the joined artifacts table. */
export function upsertTranscriptArtifactRow(d: Database, artifact: ImageArtifact): void {
  d.query(`
    INSERT INTO artifacts (
      id, session_id, media, created_at, updated_at, file_path, name, mime_type,
      size, width, height, caption, alt, title, version, source_path, source_mtime_ms, refresh_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      media = excluded.media,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      file_path = excluded.file_path,
      name = excluded.name,
      mime_type = excluded.mime_type,
      size = excluded.size,
      width = excluded.width,
      height = excluded.height,
      caption = excluded.caption,
      alt = excluded.alt,
      title = excluded.title,
      version = excluded.version,
      source_path = excluded.source_path,
      source_mtime_ms = excluded.source_mtime_ms,
      refresh_json = excluded.refresh_json
  `).run(
    artifact.id,
    artifact.sessionId,
    artifact.media ?? "image",
    artifact.createdAt,
    artifact.updatedAt ?? null,
    artifact.filePath,
    artifact.name,
    artifact.mimeType,
    artifact.size,
    artifact.width ?? null,
    artifact.height ?? null,
    artifact.caption ?? null,
    artifact.alt ?? null,
    artifact.title ?? null,
    artifact.version ?? null,
    artifact.sourcePath,
    artifact.sourceMtimeMs ?? null,
    artifact.refresh ? JSON.stringify(artifact.refresh) : null,
  );
}

/**
 * Bring an EMPTY database straight to the v12 schema. This is the union of
 * every CREATE the legacy migration sequence leaves behind, including the
 * order_seq trigger that keeps pre-v8 writer processes compatible. Seed
 * artifacts are provided by the caller (main thread reads the durable JSON
 * index; the worker never reads PATHS itself, so dataDir changes propagate
 * through the request payload).
 *
 * Re-checks "fresh" inside the immediate transaction: a concurrent creator
 * (serve plus ~16 harness processes share one file) may have committed the
 * schema while this connection waited for the write lock.
 */
export function createCurrentTranscriptSchema(
  d: Database,
  seedArtifacts: ImageArtifact[] = [],
): void {
  d.transaction(() => {
    if (transcriptSchemaStatus(d) !== "fresh") return;
    d.exec(`
      CREATE TABLE IF NOT EXISTS transcript_seed_state (path TEXT PRIMARY KEY, complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS transcript_index_cursors (
        path TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        offset INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS transcript_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        message_id TEXT,
        byte_offset INTEGER NOT NULL,
        order_seq INTEGER,
        ts INTEGER,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        author_json TEXT NOT NULL DEFAULT '{"kind":"legacy","participantId":"legacy:unknown","verified":false}'
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        media TEXT NOT NULL DEFAULT 'image',
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        caption TEXT,
        alt TEXT,
        title TEXT,
        version INTEGER,
        source_path TEXT,
        source_mtime_ms REAL,
        refresh_json TEXT
      );
      CREATE INDEX IF NOT EXISTS transcript_messages_session_ts
        ON transcript_messages(session_id, ts);
      CREATE INDEX IF NOT EXISTS transcript_messages_path_offset
        ON transcript_messages(path, byte_offset);
      CREATE INDEX IF NOT EXISTS transcript_messages_message_id
        ON transcript_messages(message_id);
      CREATE INDEX IF NOT EXISTS transcript_messages_path_order
        ON transcript_messages(path, order_seq);
      CREATE INDEX IF NOT EXISTS artifacts_session_created
        ON artifacts(session_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS transcript_artifact_message_unique
        ON transcript_messages(message_id)
        WHERE message_id LIKE 'artifact-%';
      CREATE TRIGGER IF NOT EXISTS transcript_messages_assign_order
      AFTER INSERT ON transcript_messages
      WHEN NEW.order_seq IS NULL
      BEGIN
        UPDATE transcript_messages
           SET order_seq = COALESCE((
             SELECT max(order_seq) + 1
               FROM transcript_messages
              WHERE path = NEW.path AND rowid <> NEW.rowid
           ), 0)
         WHERE rowid = NEW.rowid;
      END;
      PRAGMA user_version = ${TRANSCRIPT_SCHEMA_VERSION};
    `);
    for (const artifact of seedArtifacts) upsertTranscriptArtifactRow(d, artifact);
  }).immediate();
}

/**
 * Read-only fast path for schema readiness. Returns "current" without taking
 * any write lock (fixes: init() used to open a BEGIN IMMEDIATE transaction on
 * every first access even when the schema was already current). "fresh" means
 * the caller may create the schema via createCurrentTranscriptSchema; "legacy"
 * means only the full migration in transcript-index.ts init() can proceed.
 */
export function ensureTranscriptSchemaCurrent(
  d: Database,
  seedArtifacts: () => ImageArtifact[] = () => [],
): TranscriptSchemaStatus | "created" {
  const status = transcriptSchemaStatus(d);
  if (status === "fresh") {
    createCurrentTranscriptSchema(d, seedArtifacts());
    return "created" as const;
  }
  return status;
}

export function nextTranscriptOrderSeq(d: Database, path: string): number {
  const max = d
    .query<{ max_seq: number | null }, [string]>(
      "SELECT max(order_seq) AS max_seq FROM transcript_messages WHERE path = ?",
    )
    .get(path)?.max_seq;
  return (max ?? -1) + 1;
}

export function updateTranscriptCursor(
  d: Database,
  path: string,
  sessionId: string,
  cursor: { size: number; offset: number; mtimeMs: number },
): void {
  d.query(`
      INSERT INTO transcript_index_cursors (path, session_id, size, offset, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id = excluded.session_id,
        size = excluded.size,
        offset = excluded.offset,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
      WHERE excluded.offset >= transcript_index_cursors.offset
    `)
    .run(path, sessionId, cursor.size, cursor.offset, cursor.mtimeMs, Date.now());
}

/**
 * Insert one parsed batch and advance the cursor. NOT wrapped in a
 * transaction here: both call sites wrap it in BEGIN IMMEDIATE so
 * nextTranscriptOrderSeq and the cursor upsert commit atomically with the
 * rows. Retries are at-least-once deliveries of a deterministic-id payload:
 * INSERT OR IGNORE plus the monotonic cursor dedup whatever an earlier
 * attempt already committed, leaving the ROWS exactly-once — but a lost ack
 * is never proof that nothing committed, so destructive operations must not
 * be blind-replayed on top of it.
 */
export function insertTranscriptRows(
  d: Database,
  path: string,
  sessionId: string,
  rows: TranscriptRowInput[],
  cursor?: TranscriptCursorInput,
): number {
  let orderSeq = nextTranscriptOrderSeq(d, path);
  const msgStmt = d.query(`
    INSERT OR IGNORE INTO transcript_messages
      (id, session_id, path, message_id, byte_offset, order_seq, ts, role, kind, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const authorStmt = d.query("UPDATE transcript_messages SET author_json = ? WHERE id = ?");
  let inserted = 0;
  for (const row of rows) {
    const result = msgStmt.run(
      row.id,
      sessionId,
      path,
      row.message_id,
      row.byte_offset,
      orderSeq++,
      row.ts,
      row.role,
      row.kind,
      row.text,
    );
    const changed = Number(result.changes ?? 0);
    inserted += changed;
    if (changed) authorStmt.run(row.author_json, row.id);
  }
  if (cursor) updateTranscriptCursor(d, path, sessionId, cursor);
  return inserted;
}

/**
 * Re-read the cursor for a file path and, when it belongs to a different
 * session id, move rows + cursor to this session in one write transaction.
 * Returns the pre-adoption cursor so the caller can resume from its offset.
 */
export function adoptTranscriptSession(
  d: Database,
  path: string,
  sessionId: string,
): { cursor: { offset: number; session_id: string } | null; rebound: boolean } {
  const existing = d
    .query<{ offset: number; session_id: string }, [string]>(
      "SELECT offset, session_id FROM transcript_index_cursors WHERE path = ?",
    )
    .get(path);
  if (!existing) return { cursor: null, rebound: false };
  if (existing.session_id === sessionId) return { cursor: existing, rebound: false };
  d.transaction(() => {
    d.query("UPDATE transcript_messages SET session_id = ? WHERE path = ?").run(sessionId, path);
    d.query("UPDATE transcript_index_cursors SET session_id = ? WHERE path = ?").run(sessionId, path);
  }).immediate();
  return { cursor: { ...existing, session_id: sessionId }, rebound: true };
}

/** Drop every indexed row and the cursor for a path (transcript shrank/rotated). */
export function resetTranscriptPathRows(d: Database, path: string): void {
  d.transaction(() => {
    d.query("DELETE FROM transcript_messages WHERE path = ?").run(path);
    d.query("DELETE FROM transcript_index_cursors WHERE path = ?").run(path);
  }).immediate();
}

/** Best-effort PASSIVE checkpoint; returns SQLite's own counters. */
export function checkpointTranscriptWal(d: Database): { busy: number; log: number; checkpointed: number } {
  return (
    d.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(PASSIVE)").get() ?? {
      busy: 1,
      log: 0,
      checkpointed: 0,
    }
  );
}
