import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  cachedFingerprints,
  hideInternalRosterRows,
  queryResumableCache,
  resetResumeCacheConnectionForTests,
  upsertResumableRows,
  type ResumableCacheRow,
} from "./resume-cache.ts";
import {
  hasClaudeLaunchClassification,
  transcriptLaunchSignals,
} from "./sessions.ts";

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-claude-sdk-roster-"));
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
    title: "Ordinary chat",
    lastActivityAt: 1_000,
    lastUserText: null,
    agent: "claude",
    path: "/home/agent/.claude/projects/x/ordinary.jsonl",
    mtimeMs: 1_000,
    ...over,
  };
}

async function signals(name: string, rows: unknown[]) {
  const path = join(root, name);
  await Bun.write(path, rows.map((value) => JSON.stringify(value)).join("\n"));
  return transcriptLaunchSignals(path);
}

function rootUser(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    parentUuid: null,
    message: { content: [{ type: "text", text }] },
    ...extra,
  };
}

describe("Claude SDK launch provenance (issue 552 recurrence)", () => {
  test("classifies every headless sdk-* root row, humans excepted", async () => {
    expect(
      await signals("sdk.jsonl", [
        { type: "queue-operation" },
        rootUser("watch", { promptSource: "sdk", entrypoint: "sdk-ts" }),
      ]),
    ).toEqual({ launchContract: false, sourceKind: null, originator: "claude_sdk_ts" });

    expect(
      await signals("human-sdk-ts.jsonl", [rootUser("human", { entrypoint: "sdk-ts" })]),
    ).toEqual({ launchContract: false, sourceKind: null, originator: "claude_other" });

    // Superseded 27-08-2026 (fourth recurrence): a headless `claude -p` is
    // automation too, so sdk-cli now gets its own originator instead of the
    // human sentinel. Only the entrypoint differs from the SDK case above.
    expect(
      await signals("sdk-cli.jsonl", [
        rootUser("routine", { promptSource: "sdk", entrypoint: "sdk-cli" }),
      ]),
    ).toEqual({ launchContract: false, sourceKind: null, originator: "claude_sdk_cli" });
  });

  test("later non-root SDK metadata cannot reclassify a human root", async () => {
    expect(
      await signals("later-sdk.jsonl", [
        rootUser("human"),
        {
          type: "user",
          parentUuid: "parent-1",
          promptSource: "sdk",
          entrypoint: "sdk-ts",
          message: { content: "tool result" },
        },
      ]),
    ).toEqual({ launchContract: false, sourceKind: null, originator: "claude_other" });
  });

  test("unclassified unchanged rows revisit once; both sentinels then skip", () => {
    expect(hasClaudeLaunchClassification(null)).toBe(false);
    expect(hasClaudeLaunchClassification(undefined)).toBe(false);
    expect(hasClaudeLaunchClassification("codex_sdk_ts")).toBe(false);
    expect(hasClaudeLaunchClassification("claude_sdk_ts")).toBe(true);
    expect(hasClaudeLaunchClassification("claude_other")).toBe(true);
  });

  test("only unmanaged Claude SDK rows hide; managed and non-SDK rows stay", () => {
    upsertResumableRows([
      row({ sessionId: "sdk-unmanaged", originator: "claude_sdk_ts" }),
      row({ sessionId: "sdk-managed", originator: "claude_sdk_ts", managed: true }),
      row({ sessionId: "human", originator: "claude_other" }),
    ]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(queryResumableCache({ roster: true, limit: 20 }).sessions.map((s) => s.sessionId).sort())
      .toEqual(["human", "sdk-managed"]);
    expect(queryResumableCache({ limit: 20 }).sessions).toHaveLength(3);
  });

  test("originator persists across a signal-less re-upsert and fingerprints expose it", () => {
    upsertResumableRows([row({ sessionId: "sdk", originator: "claude_sdk_ts" })]);
    upsertResumableRows([row({ sessionId: "sdk", originator: null, managed: true })]);
    expect(cachedFingerprints().get("sdk")?.originator).toBe("claude_sdk_ts");
    expect(hideInternalRosterRows()).toBe(0); // managed row stays visible
  });
});
