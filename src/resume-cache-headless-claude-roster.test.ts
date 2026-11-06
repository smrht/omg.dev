import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { hasClaudeLaunchClassification, transcriptLaunchSignals } from "./sessions.ts";

// Issue 552, vierde recurrence (27-08-2026): the daily `claude -p` cron routines
// kept landing in the Live roster as ordinary chats. Signal 5 only knew the
// Agent SDK entrypoint "sdk-ts", while a headless CLI run writes "sdk-cli".

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-headless-claude-roster-"));
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
    sessionId: "sdk-cli",
    cwd: "/home/agent/opleidingen/quiz",
    project: "quiz",
    title: "Je maakt de dagelijkse oefenset",
    lastActivityAt: 1_000,
    lastUserText: null,
    agent: "claude",
    path: "/home/agent/.claude/projects/x/y.jsonl",
    mtimeMs: 1_000,
    originator: "claude_sdk_cli",
    ...over,
  };
}

function transcript(rows: unknown[]): string {
  const path = join(root, `t-${Math.round(rows.length * 1e6) + rows.length}.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"));
  return path;
}

function userRow(over: Record<string, unknown> = {}) {
  return {
    type: "user",
    parentUuid: null,
    promptSource: "sdk",
    entrypoint: "sdk-cli",
    message: { content: "Je maakt de dagelijkse wiskunde-oefenset voor Sam" },
    ...over,
  };
}

describe("headless claude runs stay out of the Live roster", () => {
  test("a `claude -p` cron run is classified as claude_sdk_cli", async () => {
    const signals = await transcriptLaunchSignals(transcript([userRow()]));
    expect(signals.originator).toBe("claude_sdk_cli");
    expect(hasClaudeLaunchClassification(signals.originator)).toBe(true);
  });

  test("the Agent SDK keeps its own originator and a human keeps claude_other", async () => {
    const sdk = await transcriptLaunchSignals(transcript([userRow({ entrypoint: "sdk-ts" })]));
    expect(sdk.originator).toBe("claude_sdk_ts");

    const human = await transcriptLaunchSignals(
      transcript([userRow({ promptSource: "cli", entrypoint: "cli", message: { content: "hoi" } })]),
    );
    expect(human.originator).toBe("claude_other");

    // A future headless door we have not seen yet must not need a code change.
    const future = await transcriptLaunchSignals(transcript([userRow({ entrypoint: "sdk-py" })]));
    expect(future.originator).toBe("claude_sdk_cli");
  });

  test("only unmanaged headless rows are hidden", () => {
    upsertResumableRows([
      row({ sessionId: "cron" }),
      row({ sessionId: "agent-sdk", originator: "claude_sdk_ts" }),
      row({ sessionId: "human", originator: "claude_other" }),
      row({ sessionId: "managed-headless", managed: true }),
      row({ sessionId: "codex-row", agent: "codex", originator: "claude_sdk_cli" }),
    ]);

    expect(hideInternalRosterRows()).toBe(2);
    expect(
      queryResumableCache({ roster: true, limit: 20 })
        .sessions.map((s) => s.sessionId)
        .sort(),
    ).toEqual(["codex-row", "human", "managed-headless"]);
    expect(queryResumableCache({ limit: 20 }).sessions).toHaveLength(5);
  });

  test("repair is idempotent and re-enrichment never resurrects the row", () => {
    const cron = row({ sessionId: "cron" });
    upsertResumableRows([cron]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(hideInternalRosterRows()).toBe(0);
    upsertResumableRows([{ ...cron, mtimeMs: 2_000, title: "Oefenset van morgen" }]);
    expect(queryResumableCache({ roster: true, limit: 20 }).sessions).toHaveLength(0);
  });
});
