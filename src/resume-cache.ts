// Durable cache + query layer for the "resume a session" picker.
//
// listResumable() used to readdir the whole ~/.claude/projects tree and re-read
// each candidate transcript's title/cwd/last-message on EVERY request. That is
// fine for "newest 20" but makes search / filtering across the full history
// impractical. This module persists the enriched roster in a small SQLite DB so
// repeat loads are instant and search/filter/facets run as indexed SQL.
//
// The scan/enrich orchestration lives in sessions.ts (it owns the transcript
// helpers); this module owns only persistence + querying.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { PATHS } from "./config";
import type { ResumableSession } from "./sessions";

// One cache row == a ResumableSession plus the fingerprint fields used to decide
// whether an entry needs re-enriching on the next scan.
export type ResumableCacheRow = ResumableSession & {
  path: string | null;
  mtimeMs: number;
  backend?: ResumableBackend | null;
  resumeHandle?: string | null;
  model?: string | null;
  assignedUser?: string | null;
  managed?: boolean;
  // Durable internal-roster lineage (issue 552): hide decisions read source
  // signals, never agent kind or titles. Managed rows carry their registry
  // lineage; codex rollouts carry session_meta provenance; claude transcripts
  // carry whether omg's runtime-contract envelope launched them, and the
  // controlled scheduled-task launcher's first prompt persists as sourceKind
  // "routine" (see isRoutineLaunchPrompt in sessions.ts).
  parentSessionId?: string | null;
  spawnedBy?: string | null;
  botId?: string | null;
  originator?: string | null;
  sourceKind?: string | null;
  launchContract?: boolean;
  // Some durable transcripts (currently Grok and Cursor) can be discovered
  // and searched but not resumed by LFG. Keep them in the same derived catalog
  // without exposing them in the existing Resume picker.
  resumable?: boolean;
};

export type ResumableBackend =
  | "aisdk"
  | "codex-aisdk"
  | "opencode"
  | "pi"
  | "grok"
  | "cursor"
  | "fx"
  | "muse"
  | "copilot"
  | "jcode";

export type ResumableQuery = {
  limit?: number;
  offset?: number;
  // Space-separated terms; every term must appear (AND) in title / last message
  // / project (case-insensitive substring).
  search?: string;
  // "claude" | "codex" — omit for all engines.
  agent?: string;
  // Exact project match — omit for all projects.
  project?: string;
  // Currently-live session ids to hide (they belong in the live list, not here).
  excludeIds?: Set<string>;
  // Exclude rows the user removed from the Live roster (roster_hidden = 1).
  // Omitted by the Resume > Sessions picker, which keeps showing every row:
  // hiding is a list decision, not deletion.
  roster?: boolean;
};

export type ResumableFacets = {
  agents: Array<{ agent: string; count: number }>;
  projects: Array<{ project: string; count: number }>;
};

export type ResumableQueryResult = {
  sessions: ResumableSession[];
  total: number;
  facets: ResumableFacets;
};

export type HistoricalSession = {
  sessionId: string;
  cwd: string | null;
  project: string;
  title: string;
  agent: string;
  lastActivityAt: number | null;
  transcriptPath: string | null;
  assignedUser: string | null;
};

export type HistoricalQuery = {
  sessionId?: string;
  user?: string;
  project?: string;
  activeAfter?: number;
  activeBefore?: number;
  limit?: number;
};

export type HistoricalQueryResult = {
  sessions: HistoricalSession[];
  total: number;
  truncated: boolean;
};

type Row = {
  session_id: string;
  cwd: string | null;
  project: string;
  title: string;
  last_user_text: string | null;
  last_activity_at: number | null;
  agent: string;
  path: string | null;
  mtime_ms: number;
  backend: string | null;
  resume_handle: string | null;
  model: string | null;
  thinking_level: string | null;
  service_tier: string | null;
  fast_mode: number;
  assigned_user: string | null;
  managed: number;
  resumable: number;
};

let db: Database | null = null;
let initialized = false;

function database(): Database {
  if (db) return db;
  const dbPath = join(PATHS.data, "resume-cache.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 2500");
  return db;
}

function init(): Database {
  const d = database();
  if (initialized) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS resumable_sessions (
      session_id TEXT PRIMARY KEY,
      cwd TEXT,
      project TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      last_user_text TEXT,
      last_activity_at INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude',
      path TEXT,
      mtime_ms REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS resumable_sessions_activity
      ON resumable_sessions(last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS resumable_sessions_project
      ON resumable_sessions(project);
  `);
  const version = d.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version < 1) {
    const migration = readFileSync(
      new URL("./migrations/resume-cache/001_managed_session_resume.sql", import.meta.url),
      "utf8",
    );
    d.exec(migration);
  }
  if (version < 2) {
    const migration = readFileSync(
      new URL("./migrations/resume-cache/002_historical_sessions.sql", import.meta.url),
      "utf8",
    );
    d.exec(migration);
  }
  if (version < 3) {
    const migration = readFileSync(
      new URL("./migrations/resume-cache/003_native_tui_resume.sql", import.meta.url),
      "utf8",
    );
    d.exec(migration);
  }
  if (version < 4) {
    const migration = readFileSync(
      new URL("./migrations/resume-cache/004_repair_backend_identity.sql", import.meta.url),
      "utf8",
    );
    d.exec(migration);
  }
  if (version < 5) {
    const migration = readFileSync(
      new URL("./migrations/resume-cache/005_refresh_historical_titles.sql", import.meta.url),
      "utf8",
    );
    d.exec(migration);
  }
  if (version < 6) {
    const migration = readFileSync(
      new URL("./migrations/resume-cache/006_strip_runtime_contract_titles.sql", import.meta.url),
      "utf8",
    );
    d.exec(migration);
  }
  if (version < 7) {
    const migration = readFileSync(
      new URL("./migrations/resume-cache/007_fast_mode.sql", import.meta.url),
      "utf8",
    );
    d.exec(migration);
  }
  // omg-fork: roster-hide + internal-roster lineage. Guarded by the actual
  // schema, not only user_version: the pre-0.6.24 fork numbered these 7/8 and
  // carried fast_mode as its own 009, so a live database arrives here at
  // user_version 9 with every column already present, while a fresh install
  // reaches 7 with none of the fork columns. Columns, not counters, decide.
  {
    const forkColumns = new Set(
      d.query<{ name: string }, []>("PRAGMA table_info(resumable_sessions)")
        .all()
        .map((column) => column.name),
    );
    if (!forkColumns.has("roster_hidden")) {
      d.exec(
        readFileSync(
          new URL("./migrations/resume-cache/008_roster_hidden.sql", import.meta.url),
          "utf8",
        ),
      );
    }
    if (!forkColumns.has("parent_session_id")) {
      d.exec(
        readFileSync(
          new URL("./migrations/resume-cache/009_internal_roster_lineage.sql", import.meta.url),
          "utf8",
        ),
      );
    }
  }
  initialized = true;
  return d;
}

function toSession(row: Row): ResumableSession {
  return {
    sessionId: row.session_id,
    cwd: row.cwd,
    project: row.project,
    title: row.title,
    lastActivityAt: row.last_activity_at,
    lastUserText: row.last_user_text,
    agent: (
      row.agent === "codex" ||
      row.agent === "opencode" ||
      row.agent === "pi" ||
      row.agent === "grok" ||
      row.agent === "cursor" ||
      row.agent === "fx" ||
      row.agent === "muse"
        ? row.agent
        : "claude"
    ) as ResumableSession["agent"],
    backend: (row.backend || undefined) as ResumableSession["backend"],
    resumeHandle: row.resume_handle,
    model: row.model,
    thinkingLevel: row.thinking_level,
    serviceTier: row.service_tier === "fast" ? "fast" : null,
    fastMode: row.fast_mode === 1 || row.service_tier === "fast",
    assignedUser: row.assigned_user,
  };
}

// The (id -> fingerprint) map the scanner diffs against so it only pays the
// enrich cost for transcripts that are new or have grown since last time.
export function cachedFingerprints(): Map<
  string,
  { mtimeMs: number; path: string | null; originator: string | null }
> {
  const d = init();
  const rows = d
    .query<
      { session_id: string; mtime_ms: number; path: string | null; originator: string | null },
      []
    >(
      "SELECT session_id, mtime_ms, path, originator FROM resumable_sessions",
    )
    .all();
  const out = new Map<
    string,
    { mtimeMs: number; path: string | null; originator: string | null }
  >();
  for (const r of rows) {
    out.set(r.session_id, {
      mtimeMs: r.mtime_ms,
      path: r.path,
      originator: r.originator,
    });
  }
  return out;
}

/**
 * Is this cwd a scratch directory rather than somewhere work actually lives?
 *
 * A session started in /tmp is a one-off probe -- `codex exec` from a shell
 * that happened to cd there -- not a conversation anyone wants to find back.
 * Each one otherwise becomes its own "tmp" project group in the Live roster.
 *
 * ponytail: /tmp and /var/tmp only. Widen the list if another scratch root
 * starts showing up; do NOT generalise this to "outside the repos root",
 * because lfg worktrees live outside it too and must stay listed.
 */
function isScratchCwd(cwd: string | undefined | null): boolean {
  if (!cwd) return false;
  return ["/tmp", "/var/tmp"].some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

export function upsertResumableRows(rows: ResumableCacheRow[]): void {
  if (!rows.length) return;
  const d = init();
  // roster_hidden stays out of the conflict update: re-enriching an existing
  // transcript must never resurrect a row the user removed from the Live
  // roster. It IS set on insert, so a session born in a scratch dir starts
  // hidden instead of adding a throwaway project group to the roster. The
  // internal-roster lineage columns (issue 552) are COALESCE/MAX-preserved the
  // same way: a refresh pass without the signal (e.g. the managed catalog loop
  // upserting a claude transcript's id) must not wipe the classification a
  // transcript pass recorded, and launch_contract only ever goes 0 -> 1.
  const stmt = d.query(`
    INSERT INTO resumable_sessions
      (session_id, cwd, project, title, last_user_text, last_activity_at, agent, path, mtime_ms,
       backend, resume_handle, model, thinking_level, service_tier, fast_mode,
       assigned_user, managed, resumable, roster_hidden,
       parent_session_id, spawned_by, bot_id, originator, source_kind, launch_contract)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = excluded.cwd,
      project = excluded.project,
      title = excluded.title,
      last_user_text = excluded.last_user_text,
      last_activity_at = excluded.last_activity_at,
      agent = excluded.agent,
      path = excluded.path,
      mtime_ms = excluded.mtime_ms,
      backend = excluded.backend,
      resume_handle = excluded.resume_handle,
      model = excluded.model,
      thinking_level = excluded.thinking_level,
      service_tier = excluded.service_tier,
      fast_mode = excluded.fast_mode,
      assigned_user = COALESCE(excluded.assigned_user, resumable_sessions.assigned_user),
      managed = excluded.managed,
      resumable = excluded.resumable,
      parent_session_id = COALESCE(excluded.parent_session_id, resumable_sessions.parent_session_id),
      spawned_by = COALESCE(excluded.spawned_by, resumable_sessions.spawned_by),
      bot_id = COALESCE(excluded.bot_id, resumable_sessions.bot_id),
      originator = COALESCE(excluded.originator, resumable_sessions.originator),
      source_kind = COALESCE(excluded.source_kind, resumable_sessions.source_kind),
      launch_contract = MAX(excluded.launch_contract, resumable_sessions.launch_contract)
  `);
  d.transaction((batch: ResumableCacheRow[]) => {
    for (const r of batch) {
      stmt.run(
        r.sessionId,
        r.cwd,
        r.project || "",
        r.title || "",
        r.lastUserText,
        r.lastActivityAt,
        r.agent,
        r.path,
        r.mtimeMs,
        r.backend ?? null,
        r.resumeHandle ?? null,
        r.model ?? null,
        r.thinkingLevel ?? null,
        r.serviceTier ?? null,
        r.fastMode ? 1 : 0,
        r.assignedUser ?? null,
        r.managed ? 1 : 0,
        r.resumable === false ? 0 : 1,
        isScratchCwd(r.cwd) ? 1 : 0,
        r.parentSessionId ?? null,
        r.spawnedBy ?? null,
        r.botId ?? null,
        r.originator ?? null,
        r.sourceKind ?? null,
        r.launchContract ? 1 : 0,
      );
    }
  })(rows);
}

// Drop cache rows whose transcripts no longer exist so a deleted / rotated
// session stops showing up in the picker.
export function pruneResumableExcept(keep: Set<string>): void {
  const d = init();
  const existing = d
    .query<{ session_id: string }, []>("SELECT session_id FROM resumable_sessions WHERE managed = 0")
    .all();
  const stale = existing.filter((r) => !keep.has(r.session_id)).map((r) => r.session_id);
  if (!stale.length) return;
  const del = d.query("DELETE FROM resumable_sessions WHERE session_id = ?");
  d.transaction((ids: string[]) => {
    for (const id of ids) del.run(id);
  })(stale);
}

/**
 * Working directories of sessions that were active within `windowMs`.
 *
 * The worktree sweeper's liveness checks (tmux, the managed registry,
 * /proc cwd) all describe *this instant*. A session that a reboot knocked
 * over, or whose managed row was replaced by a resume, looks dead to all
 * three while still being perfectly resumable — and deleting its worktree is
 * what makes it permanently unresumable. Recent activity is the durable
 * signal, so the sweeper consults it before removing anything.
 */
export function recentlyActiveCwds(windowMs: number, now = Date.now()): Set<string> {
  const d = init();
  const rows = d
    .query<{ cwd: string | null }, [number]>(
      "SELECT DISTINCT cwd FROM resumable_sessions WHERE cwd IS NOT NULL AND last_activity_at >= ?",
    )
    .all(now - windowMs);
  const out = new Set<string>();
  for (const row of rows) if (row.cwd) out.add(row.cwd);
  return out;
}

/**
 * Most recent `last_activity_at` this cache has recorded for `cwd`, or `null`
 * if it has none.
 *
 * The worktree retention window (worktree.ts, worktreeRetentionMs) needs a
 * single age per worktree, not just a windowed membership test. This cache's
 * value — a real transcript-derived timestamp — is a far better clock than a
 * directory's own mtime (which only moves when something touches the
 * worktree root directly, not when a session edits a file three levels
 * deep). Callers should treat this as authoritative when present and fall
 * back to filesystem mtime only when it is null.
 */
export function lastActivityAtForCwd(cwd: string): number | null {
  const d = init();
  const row = d
    .query<{ m: number | null }, [string]>(
      "SELECT MAX(last_activity_at) AS m FROM resumable_sessions WHERE cwd = ?",
    )
    .get(cwd);
  return row?.m ?? null;
}

export function getCachedResumableSession(sessionId: string): ResumableSession | null {
  const d = init();
  const row = d
    .query<Row, [string]>(`
      SELECT session_id, cwd, project, title, last_user_text, last_activity_at, agent, path, mtime_ms,
             backend, resume_handle, model, thinking_level, service_tier, fast_mode,
             assigned_user, managed, resumable
      FROM resumable_sessions
      WHERE session_id = ? AND resumable = 1
    `)
    .get(sessionId);
  return row ? toSession(row) : null;
}

// Resolve a durable transcript path after the live managed registry is gone.
// Dual-id native TUIs (Grok/Cursor) mint an LFG sessionId for the UI while the
// file is named by the native id — look up either side so closed sessions keep
// serving their chat_history / agent-transcript after removeManaged.
export function getCachedTranscriptPath(sessionId: string): string | null {
  if (!sessionId) return null;
  const d = init();
  const row = d
    .query<{ path: string | null }, [string, string, string]>(`
      SELECT path FROM resumable_sessions
      WHERE session_id = ? OR resume_handle = ?
      ORDER BY
        CASE WHEN session_id = ? THEN 0 ELSE 1 END,
        last_activity_at IS NULL,
        last_activity_at DESC
      LIMIT 1
    `)
    .get(sessionId, sessionId, sessionId);
  const path = row?.path?.trim() || null;
  return path || null;
}

export function updateResumableUser(sessionId: string, user: string | null): boolean {
  const result = init()
    .query("UPDATE resumable_sessions SET assigned_user = ? WHERE session_id = ?")
    .run(user, sessionId);
  return Number(result.changes ?? 0) > 0;
}

// Mark a durable row as removed from the Live roster (or restore it). Returns
// false when no cache row matches, so the caller can answer 404 instead of
// silently claiming success. Matches resume_handle too because dual-id native
// TUIs (Grok/Cursor) file the transcript under the native id while the roster
// lists the LFG session id.
export function setRosterHidden(sessionId: string, hidden: boolean): boolean {
  const result = init()
    .query(
      "UPDATE resumable_sessions SET roster_hidden = ? WHERE session_id = ? OR resume_handle = ?",
    )
    .run(hidden ? 1 : 0, sessionId, sessionId);
  return Number(result.changes ?? 0) > 0;
}

// A managed codex-aisdk chat and its native rollout row describe the SAME
// conversation: the managed row carries the LFG session id while the native
// rollout row is keyed by the provider thread id (managed.resume_handle ===
// native.session_id). Both rows start roster-visible, so a finished chat used
// to surface as two "Finished" entries. This repair hides the native alias —
// never the managed row — whenever at least one managed row claims its id.
//
// The scan is table-wide on purpose: native and managed rows can land in
// different refresh passes, so whichever refresh completes the pair is the
// one that closes it. Roster order stays untouched for standalone unmanaged
// sessions — they match nothing and stay visible.
export function hideManagedAliasRows(): number {
  const result = init()
    .query(
      `UPDATE resumable_sessions
       SET roster_hidden = 1
       WHERE managed = 0
         AND roster_hidden = 0
         AND session_id IN (
           SELECT resume_handle FROM resumable_sessions
           WHERE managed = 1 AND resume_handle IS NOT NULL
         )`,
    )
    .run();
  return Number(result.changes ?? 0);
}

// The confirmed-internal rows from the 2026-08-25 Chat-roster screenshot
// (issue 552): four closed managed review workers whose registry lineage died
// with the process, one omg-dispatched watch rollout, and two headless claude
// runs whose transcripts carry no durable origin marker at all (a cron
// `claude -p` routine has no envelope; one dispatch transcript predates the
// classification). Exact ids, exactly once: the run is gated on a durable
// resume_cache_meta marker, so a later manual unhide (setRosterHidden false)
// stays a decision the repair respects instead of fighting. The cron id
// (cba6e1e7) now ALSO matches the routine first-prompt signature, so its
// future siblings auto-hide via source_kind "routine" — the id stays here for
// immediate effect at deploy time, before the first refresh re-classifies it.
const CONFIRMED_INTERNAL_BACKFILL_IDS: readonly string[] = [
  "01a03ad5-3c42-7ff0-b4ff-289e514f76a8", // codex watch rollout (originator codex_sdk_ts)
  "d7238594-af1f-461b-a177-9b53f5f1c27f", // claude finding-dispatch transcript (omg contract envelope)
  "cba6e1e7-58b6-4317-ab2d-fc9f0ece3ab7", // claude cron routine (claude -p, geen envelope-signaal)
  "169bfbf6-15f9-4d6a-a4b3-1ee17910c6ed", // managed opencode review worker
  "42f61b9c-5879-461f-923d-c8fd4a05d132", // managed opencode implementatie-worker
  "1487c065-f6ac-4f87-afc2-d97591c1bcaa", // managed opencode release-review
  "7ade84cc-217b-406f-aee2-8f1cdebb0bc7", // managed opencode contractreview
];
const INTERNAL_ROSTER_BACKFILL_KEY = "internal_roster_backfill_552";

export function backfillConfirmedInternalRows(): number {
  const d = init();
  const done = d
    .query<{ value: string }, [string]>("SELECT value FROM resume_cache_meta WHERE key = ?")
    .get(INTERNAL_ROSTER_BACKFILL_KEY);
  if (done) return 0;
  const result = d
    .query(
      `UPDATE resumable_sessions
       SET roster_hidden = 1
       WHERE roster_hidden = 0
         AND session_id IN (${CONFIRMED_INTERNAL_BACKFILL_IDS.map(() => "?").join(", ")})`,
    )
    .run(...CONFIRMED_INTERNAL_BACKFILL_IDS);
  d.query(
    "INSERT INTO resume_cache_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  ).run(INTERNAL_ROSTER_BACKFILL_KEY, new Date().toISOString());
  return Number(result.changes ?? 0);
}

// Deployment policy for unmanaged `codex exec` rollouts (issue 552, third
// recurrence). Signal 6 below hardcodes ONE controlled directory, so every new
// generator dir refilled the roster with one anonymous row per delegated
// worker — same bug, new cwd, another patch. Two durable answers replace that
// treadmill:
//
//   * originators — an agent that shells out to codex sets
//     CODEX_INTERNAL_ORIGINATOR_OVERRIDE, so the rollout header states its own
//     provenance ("codex_agent_exec") and the cwd stops mattering entirely.
//   * cwdPrefixes / hideAllUnmanagedExec — on a box where `codex exec` is only
//     ever agent delegation, say that once in config instead of patching code
//     per directory.
//
// Defaults keep upstream behaviour: only the explicit agent stamp counts as
// internal, so a human's `codex exec` stays in the roster.
export type InternalExecPolicy = {
  originators: string[];
  cwdPrefixes: string[];
  hideAllUnmanagedExec: boolean;
};

export const DEFAULT_INTERNAL_EXEC_POLICY: InternalExecPolicy = {
  originators: ["codex_agent_exec"],
  cwdPrefixes: [],
  hideAllUnmanagedExec: false,
};

export function internalExecPolicyPath(): string {
  return join(PATHS.data, "roster-internal-exec.json");
}

// Never throws: a missing, unreadable or malformed policy file degrades to the
// defaults. A roster filter is not worth taking the refresh down for.
export function readInternalExecPolicy(): InternalExecPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(internalExecPolicyPath(), "utf8"));
  } catch {
    return DEFAULT_INTERNAL_EXEC_POLICY;
  }
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : fallback;
  return {
    originators: list(obj.originators, DEFAULT_INTERNAL_EXEC_POLICY.originators),
    // Trailing slashes would break the "prefix or prefix/child" match below.
    cwdPrefixes: list(obj.cwdPrefixes, DEFAULT_INTERNAL_EXEC_POLICY.cwdPrefixes).map((entry) =>
      entry.length > 1 && entry.endsWith("/") ? entry.slice(0, -1) : entry,
    ),
    hideAllUnmanagedExec: obj.hideAllUnmanagedExec === true,
  };
}

// Internal sessions stay out of the Chat roster (issue 552) — read from source
// signals, never from agent kind or titles. Strongest available signal per
// session family:
//
// 1. managed lineage: a managed row that is somebody's child or headless spawn
//    (parentSessionId, or spawnedBy subagent/finding/schedule) is a worker, not
//    a chat. Bots are exempt (bot_id set): a persistent bot conversation is a
//    product surface even though something spawned it. A fork (spawnedBy
//    "fork") is a user-initiated copy and stays listed.
// 2. codex session_meta: the rollout header records who launched it.
//    originator "codex_sdk_ts" is an SDK-driven rollout (omg watch/auto and
//    worker launches; the native aliases of ordinary managed chats are already
//    hidden by hideManagedAliasRows), and source {subagent: …} marks
//    codex-native thread spawns. `codex exec` from a shell (originator
//    "codex_exec") stays listed — that is a human at the keyboard.
// 3. claude launch envelope: omg wraps the first prompt of every claude it
//    launches in the runtime contract (see omg-capabilities.ts), so the
//    transcript's first user message carries the envelope. Interactive CLI
//    sessions open with what the human typed and aisdk-managed chats keep the
//    contract out of the user turn, so both stay listed.
// 4. controlled routine launcher: a cron `claude -p` routine carries NO omg
//    envelope, so the scheduled-task launcher's own controlled first prompt is
//    the marker — the FULL signature (starts with the fixed Dutch routine
//    opening, contains the skill-read line naming the scheduled-tasks path,
//    and contains the headless agentbox2 line; sessions.ts
//    isRoutineLaunchPrompt), persisted as sourceKind "routine" at enrich time.
//    All parts required, never a broad keyword: a human chat that merely
//    mentions "Voer de geplande routine" stays listed, and so does an older
//    routine variant without the headless line. This is what makes FUTURE
//    legacy run-routine transcripts (like cba6e1e7) auto-hide instead of
//    depending on the one-time id backfill below.
// 5. Claude SDK provenance: a transcript whose first root user row carries
//    promptSource "sdk" AND entrypoint "sdk-ts" is an SDK/headless run. The
//    scanner persists originator "claude_sdk_ts" (Agent SDK) or
//    "claude_sdk_cli" (a headless `claude -p` from cron or a script); all
//    other parsed Claude roots get "claude_other" so unchanged human
//    transcripts are not reparsed forever. Managed findings remain visible
//    because this clause requires managed = 0.
// 6. Controlled Codex exec: Nieuwswacht generators launch bounded `codex
//    exec` workers from their dedicated scripts/nieuwswacht cwd. Keep human
//    shell exec elsewhere visible; require the exact provenance pair and cwd.
// 7. Agent-delegated Codex exec: the launcher's own stamp
//    (CODEX_INTERNAL_ORIGINATOR_OVERRIDE -> session_meta.originator) plus the
//    deployment policy in readInternalExecPolicy. This is the cwd-independent
//    successor to signal 6 — a new generator directory no longer needs code.
//
// Table-wide and idempotent on purpose (same contract as hideManagedAliasRows):
// a row can be classified in a later refresh than the one that inserted it,
// and re-enrichment never resurrects what a repair hid.
export function hideInternalRosterRows(): number {
  const d = init();
  let hidden = 0;
  hidden += Number(
    d
      .query(
        `UPDATE resumable_sessions
         SET roster_hidden = 1
         WHERE managed = 1 AND roster_hidden = 0 AND bot_id IS NULL
           AND (spawned_by IN ('subagent', 'finding', 'schedule')
                OR (parent_session_id IS NOT NULL
                    AND COALESCE(spawned_by, '') != 'fork'))`,
      )
      .run().changes ?? 0,
  );
  hidden += Number(
    d
      .query(
        `UPDATE resumable_sessions
         SET roster_hidden = 1
         WHERE managed = 0 AND roster_hidden = 0 AND agent = 'codex'
           AND (originator = 'codex_sdk_ts' OR source_kind = 'subagent')`,
      )
      .run().changes ?? 0,
  );
  hidden += Number(
    d
      .query(
        `UPDATE resumable_sessions
         SET roster_hidden = 1
         WHERE managed = 0 AND roster_hidden = 0 AND agent = 'claude'
           AND launch_contract = 1`,
      )
      .run().changes ?? 0,
  );
  hidden += Number(
    d
      .query(
        `UPDATE resumable_sessions
         SET roster_hidden = 1
         WHERE managed = 0 AND roster_hidden = 0 AND agent = 'claude'
           AND originator IN ('claude_sdk_ts', 'claude_sdk_cli')`,
      )
      .run().changes ?? 0,
  );
  hidden += Number(
    d
      .query(
        `UPDATE resumable_sessions
         SET roster_hidden = 1
         WHERE managed = 0 AND roster_hidden = 0 AND agent = 'codex'
           AND originator = 'codex_exec' AND source_kind = 'exec'
           AND (cwd = '/home/agent/sites-beheer/scripts/nieuwswacht'
             OR cwd LIKE '/home/agent/sites-beheer/scripts/nieuwswacht/%')`,
      )
      .run().changes ?? 0,
  );
  // Signal 4 — see the header comment: the controlled scheduled-task launcher
  // signature, persisted as source_kind "routine" by the transcript pass.
  hidden += Number(
    d
      .query(
        `UPDATE resumable_sessions
         SET roster_hidden = 1
         WHERE roster_hidden = 0 AND source_kind = 'routine'`,
      )
      .run().changes ?? 0,
  );
  // Signal 7 — see readInternalExecPolicy. Read per repair so a policy edit
  // lands on the next refresh instead of at the next restart.
  const policy = readInternalExecPolicy();
  if (policy.originators.length) {
    const marks = policy.originators.map(() => "?").join(", ");
    hidden += Number(
      d
        .query(
          `UPDATE resumable_sessions
           SET roster_hidden = 1
           WHERE managed = 0 AND roster_hidden = 0 AND agent = 'codex'
             AND source_kind = 'exec' AND originator IN (${marks})`,
        )
        .run(...policy.originators).changes ?? 0,
    );
  }
  if (policy.hideAllUnmanagedExec) {
    hidden += Number(
      d
        .query(
          `UPDATE resumable_sessions
           SET roster_hidden = 1
           WHERE managed = 0 AND roster_hidden = 0 AND agent = 'codex'
             AND source_kind = 'exec'`,
        )
        .run().changes ?? 0,
    );
  } else {
    for (const prefix of policy.cwdPrefixes) {
      // ESCAPE, because a literal _ in a path is a LIKE wildcard: without it
      // /home/agent/foo_bar would also hide /home/agent/fooXbar.
      const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
      hidden += Number(
        d
          .query(
            `UPDATE resumable_sessions
             SET roster_hidden = 1
             WHERE managed = 0 AND roster_hidden = 0 AND agent = 'codex'
               AND source_kind = 'exec'
               AND (cwd = ? OR cwd LIKE ? ESCAPE '\\')`,
          )
          .run(prefix, like).changes ?? 0,
      );
    }
  }
  return hidden;
}

export function updateCachedSessionTitle(sessionId: string, title: string): boolean {
  const result = init()
    .query("UPDATE resumable_sessions SET title = ? WHERE session_id = ?")
    .run(title, sessionId);
  return Number(result.changes ?? 0) > 0;
}

// Turn "foo bar" into an AND of case-insensitive substring predicates over the
// searchable columns, plus the bound params. Empty query -> no predicate.
function searchClause(search: string | undefined): { sql: string; params: string[] } {
  const terms = (search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return { sql: "", params: [] };
  const params: string[] = [];
  const clauses = terms.map((term) => {
    const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    params.push(like, like, like);
    return (
      "(LOWER(title) LIKE ? ESCAPE '\\'" +
      " OR LOWER(COALESCE(last_user_text,'')) LIKE ? ESCAPE '\\'" +
      " OR LOWER(project) LIKE ? ESCAPE '\\')"
    );
  });
  return { sql: clauses.join(" AND "), params };
}

function excludeClause(excludeIds: Set<string> | undefined): { sql: string; params: string[] } {
  const ids = excludeIds ? [...excludeIds] : [];
  if (!ids.length) return { sql: "", params: [] };
  return { sql: `session_id NOT IN (${ids.map(() => "?").join(",")})`, params: ids };
}

export function queryResumableCache(opts: ResumableQuery = {}): ResumableQueryResult {
  const d = init();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
  const offset = Math.max(0, opts.offset ?? 0);

  const search = searchClause(opts.search);
  const exclude = excludeClause(opts.excludeIds);

  // Facets ignore the agent/project selection (so chip counts stay stable while
  // you toggle them) but DO respect search + the live-session exclusion.
  const facetWhere: string[] = [];
  const facetParams: (string | number)[] = [];
  if (search.sql) {
    facetWhere.push(search.sql);
    facetParams.push(...search.params);
  }
  if (exclude.sql) {
    facetWhere.push(exclude.sql);
    facetParams.push(...exclude.params);
  }
  facetWhere.push("resumable = 1");
  if (opts.roster) facetWhere.push("roster_hidden = 0");
  const facetWhereSql = facetWhere.length ? `WHERE ${facetWhere.join(" AND ")}` : "";

  const agentFacet = d
    .query<{ agent: string; count: number }, (string | number)[]>(
      `SELECT agent, COUNT(*) AS count FROM resumable_sessions ${facetWhereSql} GROUP BY agent ORDER BY count DESC`,
    )
    .all(...facetParams);
  const projectFacet = d
    .query<{ project: string; count: number }, (string | number)[]>(
      `SELECT project, COUNT(*) AS count FROM resumable_sessions ${facetWhereSql} GROUP BY project ORDER BY count DESC, project ASC`,
    )
    .all(...facetParams);

  // The visible page respects every filter.
  const where = [...facetWhere];
  const params = [...facetParams];
  if (opts.agent) {
    where.push("agent = ?");
    params.push(opts.agent);
  }
  if (opts.project) {
    where.push("project = ?");
    params.push(opts.project);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total =
    d
      .query<{ count: number }, (string | number)[]>(
        `SELECT COUNT(*) AS count FROM resumable_sessions ${whereSql}`,
      )
      .get(...params)?.count ?? 0;

  const rows = d
    .query<Row, (string | number)[]>(`
      SELECT session_id, cwd, project, title, last_user_text, last_activity_at, agent, path, mtime_ms,
             backend, resume_handle, model, thinking_level, service_tier, fast_mode,
             assigned_user, managed, resumable
      FROM resumable_sessions
      ${whereSql}
      ORDER BY last_activity_at IS NULL, last_activity_at DESC, session_id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);

  return {
    sessions: rows.map(toSession),
    total,
    facets: {
      agents: agentFacet.map((r) => ({ agent: r.agent, count: r.count })),
      projects: projectFacet
        .filter((r) => r.project)
        .map((r) => ({ project: r.project, count: r.count })),
    },
  };
}

function escapedLike(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

export function queryHistoricalCache(opts: HistoricalQuery = {}): HistoricalQueryResult {
  const d = init();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (opts.sessionId?.trim()) {
    where.push("LOWER(session_id) LIKE ? ESCAPE '\\'");
    params.push(`${escapedLike(opts.sessionId.trim().toLowerCase())}%`);
  }
  if (opts.user?.trim()) {
    where.push("LOWER(COALESCE(assigned_user, '')) = ?");
    params.push(opts.user.trim().toLowerCase());
  }
  if (opts.project?.trim()) {
    const like = `%${escapedLike(opts.project.trim().toLowerCase())}%`;
    where.push(
      "(LOWER(project) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(cwd, '')) LIKE ? ESCAPE '\\')",
    );
    params.push(like, like);
  }
  if (Number.isFinite(opts.activeAfter)) {
    where.push("last_activity_at >= ?");
    params.push(opts.activeAfter!);
  }
  if (Number.isFinite(opts.activeBefore)) {
    where.push("last_activity_at <= ?");
    params.push(opts.activeBefore!);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total =
    d
      .query<{ count: number }, (string | number)[]>(
        `SELECT COUNT(*) AS count FROM resumable_sessions ${whereSql}`,
      )
      .get(...params)?.count ?? 0;
  const rows = d
    .query<Row, (string | number)[]>(`
      SELECT session_id, cwd, project, title, last_user_text, last_activity_at, agent, path, mtime_ms,
             backend, resume_handle, model, thinking_level, service_tier, fast_mode,
             assigned_user, managed, resumable
      FROM resumable_sessions
      ${whereSql}
      ORDER BY last_activity_at IS NULL, last_activity_at DESC, session_id DESC
      LIMIT ?
    `)
    .all(...params, limit);

  return {
    sessions: rows.map((row) => ({
      sessionId: row.session_id,
      cwd: row.cwd,
      project: row.project,
      title: row.title,
      agent: row.agent,
      lastActivityAt: row.last_activity_at,
      transcriptPath: row.path,
      assignedUser: row.assigned_user,
    })),
    total,
    truncated: total > rows.length,
  };
}

export function resetResumeCacheConnectionForTests(): void {
  db?.close();
  db = null;
  initialized = false;
}
