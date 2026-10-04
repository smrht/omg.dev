-- Issue 521 follow-up (omg-fork): persistent "hidden from the Live roster" flag.
-- The Live workspace merges recent resumable rows into its list; hiding one is
-- a UI-list decision, not data deletion — the Resume > Sessions picker keeps
-- showing the row so the session stays resumable and its transcript intact.
-- Default 0 keeps every existing row listed exactly as before the upgrade.
ALTER TABLE resumable_sessions ADD COLUMN roster_hidden INTEGER NOT NULL DEFAULT 0;

PRAGMA user_version = 8;
