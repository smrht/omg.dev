import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  hideInternalRosterRows,
  queryResumableCache,
  resetResumeCacheConnectionForTests,
  upsertResumableRows,
  type ResumableCacheRow,
} from "./resume-cache.ts";

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-controlled-exec-roster-"));
  PATHS.data = root;
  resetResumeCacheConnectionForTests();
});

afterEach(() => {
  resetResumeCacheConnectionForTests();
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

function row(over: Partial<ResumableCacheRow> = {}): ResumableCacheRow {
  return {
    sessionId: "ordinary",
    cwd: "/home/agent/sites-beheer",
    project: "sites-beheer",
    title: "Ordinary exec",
    lastActivityAt: 1_000,
    lastUserText: null,
    agent: "codex",
    path: "/home/agent/.codex/sessions/ordinary.jsonl",
    mtimeMs: 1_000,
    originator: "codex_exec",
    sourceKind: "exec",
    ...over,
  };
}

describe("controlled Codex exec roster repair (issue 552 recurrence)", () => {
  test("hides only unmanaged exec rows from the dedicated Nieuwswacht cwd", () => {
    upsertResumableRows([
      row({ sessionId: "controlled", cwd: "/home/agent/sites-beheer/scripts/nieuwswacht" }),
      row({ sessionId: "controlled-child", cwd: "/home/agent/sites-beheer/scripts/nieuwswacht/img-20260826" }),
      row({ sessionId: "human-elsewhere", cwd: "/home/agent/sites-beheer" }),
      row({ sessionId: "managed", cwd: "/home/agent/sites-beheer/scripts/nieuwswacht", managed: true }),
      row({ sessionId: "wrong-source", cwd: "/home/agent/sites-beheer/scripts/nieuwswacht", sourceKind: null }),
      row({ sessionId: "claude", cwd: "/home/agent/sites-beheer/scripts/nieuwswacht", agent: "claude" }),
    ]);

    expect(hideInternalRosterRows()).toBe(2);
    expect(queryResumableCache({ roster: true, limit: 20 }).sessions.map((s) => s.sessionId).sort())
      .toEqual(["claude", "human-elsewhere", "managed", "wrong-source"]);
    expect(queryResumableCache({ limit: 20 }).sessions).toHaveLength(6);
  });

  test("repeated repair and re-enrichment never resurrect a controlled row", () => {
    const controlled = row({
      sessionId: "controlled",
      cwd: "/home/agent/sites-beheer/scripts/nieuwswacht",
    });
    upsertResumableRows([controlled]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(hideInternalRosterRows()).toBe(0);
    upsertResumableRows([{ ...controlled, mtimeMs: 2_000 }]);
    expect(queryResumableCache({ roster: true, limit: 20 }).sessions).toHaveLength(0);
    expect(queryResumableCache({ limit: 20 }).sessions).toHaveLength(1);
  });
});
