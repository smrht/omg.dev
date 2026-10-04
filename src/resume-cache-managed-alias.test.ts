import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  hideManagedAliasRows,
  queryResumableCache,
  resetResumeCacheConnectionForTests,
  upsertResumableRows,
  type ResumableCacheRow,
} from "./resume-cache.ts";

// Issue 547: a managed codex-aisdk chat and its native rollout row are the
// same conversation (managed.resume_handle === native.session_id) and both
// used to surface as separate "Finished" rows. The refresh-time repair must
// hide the unmanaged alias — only that row — whenever at least one managed
// row claims its id, keep standalone unmanaged rows listed, never remove the
// native transcript from the Resume picker, and stay idempotent no matter
// which refresh pass lands which row first.

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-managed-alias-"));
  PATHS.data = root;
  resetResumeCacheConnectionForTests();
});

afterEach(() => {
  resetResumeCacheConnectionForTests();
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

const NATIVE_ID = "01a0470a-1111-7111-8111-111111111111";

function nativeRow(over: Partial<ResumableCacheRow> = {}): ResumableCacheRow {
  return {
    sessionId: NATIVE_ID,
    cwd: "/home/agent/sites-beheer",
    project: "sites-beheer",
    title: "Native rollout transcript",
    lastActivityAt: 2_000,
    lastUserText: null,
    agent: "codex",
    path: `/home/agent/.codex/sessions/2026/08/25/${NATIVE_ID}.jsonl`,
    mtimeMs: 2_000,
    ...over,
  };
}

function managedRow(over: Partial<ResumableCacheRow> = {}): ResumableCacheRow {
  return {
    sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    cwd: "/home/agent/sites-beheer",
    project: "sites-beheer",
    title: "Managed chat",
    lastActivityAt: 1_000,
    lastUserText: null,
    agent: "codex",
    path: "sqlite:index:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    mtimeMs: 1_000,
    backend: "codex-aisdk",
    resumeHandle: NATIVE_ID,
    managed: true,
    ...over,
  };
}

function rosterIds(): string[] {
  return queryResumableCache({ roster: true }).sessions.map((s) => s.sessionId);
}

function pickerIds(): string[] {
  return queryResumableCache().sessions.map((s) => s.sessionId);
}

describe("managed/native alias repair (issue 547)", () => {
  test("hides the unmanaged alias, keeps the managed row listed", () => {
    upsertResumableRows([nativeRow(), managedRow()]);
    expect(hideManagedAliasRows()).toBe(1);
    expect(rosterIds()).toEqual(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
  });

  test("solves the race: whichever refresh lands the pair closes it", () => {
    // Refresh 1: only the managed catalog row exists yet.
    upsertResumableRows([managedRow()]);
    expect(hideManagedAliasRows()).toBe(0);
    // Refresh 2: the native rollout row appears and the next repair closes it.
    upsertResumableRows([nativeRow({ mtimeMs: 3_000 })]);
    expect(hideManagedAliasRows()).toBe(1);
    expect(rosterIds()).toEqual(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
  });

  test("standalone unmanaged sessions without a managed counterpart stay visible", () => {
    upsertResumableRows([
      nativeRow({ sessionId: "cccccccc-dddd-4eee-8fff-000000000001", title: "CLI session" }),
    ]);
    expect(hideManagedAliasRows()).toBe(0);
    expect(rosterIds()).toEqual(["cccccccc-dddd-4eee-8fff-000000000001"]);
  });

  test("two managed rows on one handle hide the native alias, all three stay in Resume", () => {
    upsertResumableRows([
      nativeRow(),
      managedRow({ sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
      managedRow({
        sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeffff",
        title: "Resumed under a new managed row",
        resumeHandle: NATIVE_ID,
      }),
    ]);
    expect(hideManagedAliasRows()).toBe(1);
    expect(rosterIds()).not.toContain(NATIVE_ID);
    expect(pickerIds().sort()).toEqual(
      [
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeffff",
        NATIVE_ID,
      ].sort(),
    );
    expect(queryResumableCache().total).toBe(3);
  });

  test("repeated refresh-shaped upserts never resurrect the hidden alias", () => {
    upsertResumableRows([nativeRow(), managedRow()]);
    expect(hideManagedAliasRows()).toBe(1);
    // A later refresh re-enriches the same native rollout (newer fingerprint).
    upsertResumableRows([nativeRow({ mtimeMs: 9_000, lastActivityAt: 9_000, title: "Grown" })]);
    expect(hideManagedAliasRows()).toBe(0);
    expect(rosterIds()).toEqual(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
  });

  test("Resume picker without the roster filter keeps both rows", () => {
    upsertResumableRows([nativeRow(), managedRow()]);
    hideManagedAliasRows();
    expect(pickerIds().sort()).toEqual(
      ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", NATIVE_ID].sort(),
    );
    expect(queryResumableCache().total).toBe(2);
  });
});
