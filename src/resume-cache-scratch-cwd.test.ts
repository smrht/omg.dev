import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";

// A session started in /tmp -- `cd /tmp && codex exec ...` instead of
// `codex exec -C <dir>` -- used to add its own "tmp" project group to the Live
// roster, one row per exec. New rows from a scratch cwd now start hidden.
// Hidden is not deleted: the transcript stays queryable without ?roster=1.

const originalData = PATHS.data;
let testData = "";
let cache: typeof import("./resume-cache.ts");

beforeAll(async () => {
  testData = await mkdtemp(join(tmpdir(), "omg-scratch-cwd-"));
  PATHS.data = testData;
  cache = await import("./resume-cache.ts");
});

afterAll(async () => {
  PATHS.data = originalData;
  await rm(testData, { recursive: true, force: true });
});

function row(sessionId: string, cwd: string) {
  return {
    sessionId,
    cwd,
    project: cwd.split("/").pop() || "",
    title: sessionId,
    lastUserText: "",
    lastActivityAt: 1_787_676_924_255,
    agent: "codex",
    path: `/dev/null/${sessionId}.jsonl`,
    mtimeMs: 1_787_676_924_255,
  } as Parameters<typeof cache.upsertResumableRows>[0][number];
}

function rosterIds(): Set<string> {
  return new Set(cache.queryResumableCache({ roster: true }).sessions.map((r) => r.sessionId));
}

describe("scratch-cwd sessions stay out of the Live roster", () => {
  test("/tmp and /var/tmp are hidden, real work dirs are not", () => {
    cache.upsertResumableRows([
      row("scratch-tmp", "/tmp"),
      row("scratch-sub", "/tmp/omgpatch.abc"),
      row("scratch-var", "/var/tmp/probe"),
      row("real-repo", "/home/agent/sites-beheer"),
      // The prefix test must not swallow a real directory that merely starts
      // with the same letters, and lfg worktrees live outside the repos root
      // but are genuine sessions.
      row("lookalike", "/tmpfoo/project"),
      row("worktree", "/home/agent/lfg-worktrees/lfg-6da1ef"),
    ]);

    const listed = rosterIds();
    expect(listed.has("scratch-tmp")).toBe(false);
    expect(listed.has("scratch-sub")).toBe(false);
    expect(listed.has("scratch-var")).toBe(false);
    expect(listed.has("real-repo")).toBe(true);
    expect(listed.has("lookalike")).toBe(true);
    expect(listed.has("worktree")).toBe(true);
  });

  test("re-enriching never resurrects a row the user hid by hand", () => {
    cache.upsertResumableRows([row("hidden-by-user", "/home/agent/sites-beheer")]);
    expect(cache.setRosterHidden("hidden-by-user", true)).toBe(true);
    expect(rosterIds().has("hidden-by-user")).toBe(false);

    // Same session seen again by the enricher: the ON CONFLICT branch must
    // leave roster_hidden alone.
    cache.upsertResumableRows([row("hidden-by-user", "/home/agent/sites-beheer")]);
    expect(rosterIds().has("hidden-by-user")).toBe(false);
  });
});
