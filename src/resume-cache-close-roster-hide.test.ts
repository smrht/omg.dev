import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  __resetPendingRosterHideForTests,
  hideFromRosterWhenCached,
  queryResumableCache,
  resetResumeCacheConnectionForTests,
  upsertResumableRows,
  type ResumableCacheRow,
} from "./resume-cache.ts";

// A chat closed from the Live workspace leaves the roster for good (the
// archive dialog promises exactly that) while Resume keeps every row. The
// close can land before the cache has learned the transcript, so the hide must
// survive until the row arrives.

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-close-roster-hide-"));
  PATHS.data = root;
  resetResumeCacheConnectionForTests();
  __resetPendingRosterHideForTests();
});

afterEach(() => {
  resetResumeCacheConnectionForTests();
  __resetPendingRosterHideForTests();
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

function row(over: Partial<ResumableCacheRow> = {}): ResumableCacheRow {
  return {
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: "/home/agent/sites-beheer",
    project: "sites-beheer",
    title: "Ordinary chat",
    lastActivityAt: 1_000,
    lastUserText: null,
    agent: "claude",
    path: "/home/agent/.claude/projects/x/11111111-2222-4333-8444-555555555555.jsonl",
    mtimeMs: 1_000,
    ...over,
  };
}

const rosterIds = () =>
  queryResumableCache({ roster: true, limit: 200 }).sessions.map((s) => s.sessionId);
const pickerIds = () => queryResumableCache({ limit: 200 }).sessions.map((s) => s.sessionId);

describe("close from the Live workspace hides the roster row", () => {
  test("an already cached chat leaves the roster at once and stays in Resume", () => {
    upsertResumableRows([row({ sessionId: "closed-now" }), row({ sessionId: "other" })]);
    expect(hideFromRosterWhenCached("closed-now")).toBe(true);
    expect(rosterIds()).toEqual(["other"]);
    expect(pickerIds().sort()).toEqual(["closed-now", "other"]);
  });

  test("a close before the cache knows the chat lands when the row arrives", () => {
    expect(hideFromRosterWhenCached("closed-early")).toBe(false);
    upsertResumableRows([row({ sessionId: "closed-early" }), row({ sessionId: "other" })]);
    expect(rosterIds()).toEqual(["other"]);
    expect(pickerIds().sort()).toEqual(["closed-early", "other"]);
  });

  test("a re-enriching refresh never resurrects the hidden row", () => {
    upsertResumableRows([row({ sessionId: "closed-now" })]);
    hideFromRosterWhenCached("closed-now");
    upsertResumableRows([row({ sessionId: "closed-now", title: "Renamed", mtimeMs: 2_000 })]);
    expect(rosterIds()).toEqual([]);
  });

  test("the native alias of a dual-id chat is hidden through resume_handle", () => {
    upsertResumableRows([row({ sessionId: "lfg-id", resumeHandle: "native-id" })]);
    expect(hideFromRosterWhenCached("native-id")).toBe(true);
    expect(rosterIds()).toEqual([]);
  });
});
