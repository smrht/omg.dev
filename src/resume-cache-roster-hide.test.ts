import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { PATHS } from "./config.ts";
import {
  queryResumableCache,
  resetResumeCacheConnectionForTests,
  setRosterHidden,
  upsertResumableRows,
} from "./resume-cache.ts";

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-roster-hide-"));
  PATHS.data = root;
  resetResumeCacheConnectionForTests();
});

afterEach(() => {
  resetResumeCacheConnectionForTests();
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

function row(
  over: Partial<Parameters<typeof upsertResumableRows>[0][number]> = {},
): Parameters<typeof upsertResumableRows>[0][number] {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    cwd: "/srv/app",
    project: "app",
    title: "Finished work",
    lastActivityAt: 1_000,
    lastUserText: null,
    agent: "claude",
    path: "/tmp/1.jsonl",
    mtimeMs: 1_000,
    ...over,
  };
}

describe("roster_hidden (issue 521 follow-up)", () => {
  test("migration 007 adds the column; init stamps the latest user_version", () => {
    // Trigger init() so the database exists, then inspect the schema it made.
    // The version pin follows the NEWEST migration (9 = independent Fast
    // mode), not roster_hidden's 007 itself.
    expect(queryResumableCache().total).toBe(0);
    const db = new Database(join(root, "resume-cache.sqlite"), { readonly: true });
    const columns = db
      .query<{ name: string; notnull: number }, []>("PRAGMA table_info(resumable_sessions)")
      .all();
    expect(columns.map((column) => column.name)).toContain("roster_hidden");
    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(9);
    const fresh = columns.find((column) => column.name === "roster_hidden");
    expect(fresh?.notnull ?? 0).toBe(1);
    db.close();
  });

  test("re-enriching upserts never resurrect a hidden row", () => {
    upsertResumableRows([row()]);
    expect(setRosterHidden("11111111-1111-4111-8111-111111111111", true)).toBe(true);
    // Same session, grown transcript: the scanner upserts a fresh fingerprint.
    upsertResumableRows([row({ mtimeMs: 2_000, lastActivityAt: 2_000, title: "Re-enriched" })]);
    const db = new Database(join(root, "resume-cache.sqlite"), { readonly: true });
    const state = db
      .query<{ roster_hidden: number; title: string }, []>(
        "SELECT roster_hidden, title FROM resumable_sessions WHERE session_id = '11111111-1111-4111-8111-111111111111'",
      )
      .get();
    db.close();
    expect(state?.title).toBe("Re-enriched");
    expect(state?.roster_hidden).toBe(1);
  });

  test("default query keeps hidden rows; ?roster query filters them", () => {
    upsertResumableRows([
      row(),
      row({
        sessionId: "22222222-2222-4222-8222-222222222222",
        path: "/tmp/2.jsonl",
        lastActivityAt: 2_000,
        mtimeMs: 2_000,
      }),
    ]);
    expect(setRosterHidden("11111111-1111-4111-8111-111111111111", true)).toBe(true);

    // Resume > Sessions: no roster param — the hidden session stays visible.
    const picker = queryResumableCache();
    expect(picker.sessions.map((session) => session.sessionId)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(picker.total).toBe(2);

    // Live workspace roster: hidden row gone, facets and total follow.
    const roster = queryResumableCache({ roster: true });
    expect(roster.sessions.map((session) => session.sessionId)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(roster.total).toBe(1);
    expect(roster.facets.agents).toEqual([{ agent: "claude", count: 1 }]);
  });

  test("setRosterHidden answers false for unknown ids and false for dual-id handles", () => {
    upsertResumableRows([
      row({ sessionId: "33333333-3333-4333-8333-333333333333", resumeHandle: "native-3" }),
    ]);
    expect(setRosterHidden("99999999-9999-4999-8999-999999999999", true)).toBe(false);
    expect(setRosterHidden("native-3", true)).toBe(true);
    const roster = queryResumableCache({ roster: true });
    expect(roster.sessions).toHaveLength(0);
    // Unhide restores the row to both surfaces.
    expect(setRosterHidden("native-3", false)).toBe(true);
    expect(queryResumableCache({ roster: true }).sessions).toHaveLength(1);
  });
});

// Direct SQL proof that the shipped migration is additive and version-stamped.
// Since the 0.6.24 port the fork migration is number 8: upstream claimed 7 for
// fast_mode, and the wiring guards on the actual schema, not the counter.
describe("migration 008 file", () => {
  test("is a single additive column with default 0", () => {
    const sql = readFileSync(
      new URL("./migrations/resume-cache/008_roster_hidden.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("ALTER TABLE resumable_sessions ADD COLUMN roster_hidden INTEGER NOT NULL DEFAULT 0");
    expect(sql).toContain("PRAGMA user_version = 8");
  });
});
