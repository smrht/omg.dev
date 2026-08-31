-- Issue 552 (omg-fork): durable internal-session lineage for the Chat roster.
-- The roster repair (hideInternalRosterRows in resume-cache.ts) hides internal
-- sessions from SOURCE signals instead of agent kind or titles; those signals
-- need columns to live in, because titles get overridden and a managed
-- registry row dies with its process while the cache row lives on:
--   parent_session_id / spawned_by / bot_id — managed registry lineage
--     (children, headless spawns, bots), captured at enrich time.
--   originator / source_kind — codex rollout session_meta provenance
--     (originator "codex_sdk_ts" = SDK launch, source {subagent} = native
--     thread spawn), en voor claude-transcripts de controlled routine-signatuur
--     (sourceKind "routine", zie isRoutineLaunchPrompt in sessions.ts).
--   launch_contract — the transcript's first user message carries omg's
--     runtime-contract envelope (claude transcripts; omg-capabilities.ts).
-- resume_cache_meta carries the one-time confirmed-internal backfill marker,
-- so a later manual unhide of a backfilled row is a user decision the repair
-- respects, not a bug it fights.
ALTER TABLE resumable_sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE resumable_sessions ADD COLUMN spawned_by TEXT;
ALTER TABLE resumable_sessions ADD COLUMN bot_id TEXT;
ALTER TABLE resumable_sessions ADD COLUMN originator TEXT;
ALTER TABLE resumable_sessions ADD COLUMN source_kind TEXT;
ALTER TABLE resumable_sessions ADD COLUMN launch_contract INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS resume_cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

PRAGMA user_version = 9;
