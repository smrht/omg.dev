import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  hideInternalRosterRows,
  internalExecPolicyPath,
  queryResumableCache,
  readInternalExecPolicy,
  resetResumeCacheConnectionForTests,
  upsertResumableRows,
  type ResumableCacheRow,
} from "./resume-cache.ts";

// Issue 552, third recurrence (27-08-2026): delegated `codex exec` workers —
// one per generated image — filled the Live roster with anonymous rows titled
// after their cwd. Signal 6 only knew ONE hardcoded directory, so every new
// generator dir was a new patch. These tests pin the two durable replacements:
// the launcher's own originator stamp, and a deployment policy file.

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-agent-exec-roster-"));
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
    sessionId: "human-exec",
    cwd: "/home/agent/sites-beheer",
    project: "sites-beheer",
    title: "sites-beheer",
    lastActivityAt: 1_000,
    lastUserText: null,
    agent: "codex",
    path: "/home/agent/.codex/sessions/x.jsonl",
    mtimeMs: 1_000,
    originator: "codex_exec",
    sourceKind: "exec",
    ...over,
  };
}

function policy(value: unknown): void {
  writeFileSync(internalExecPolicyPath(), typeof value === "string" ? value : JSON.stringify(value));
}

function visible(): string[] {
  return queryResumableCache({ roster: true, limit: 50 })
    .sessions.map((s) => s.sessionId)
    .sort();
}

describe("agent-delegated codex exec stays out of the Live roster", () => {
  test("the originator stamp hides the row wherever it ran", () => {
    upsertResumableRows([
      row({ sessionId: "stamped-here", originator: "codex_agent_exec" }),
      row({ sessionId: "stamped-elsewhere", originator: "codex_agent_exec", cwd: "/home/agent/kleurplaat" }),
      row({ sessionId: "human-exec" }),
      row({ sessionId: "stamped-managed", originator: "codex_agent_exec", managed: true }),
      row({ sessionId: "stamped-claude", originator: "codex_agent_exec", agent: "claude" }),
      row({ sessionId: "stamped-no-exec", originator: "codex_agent_exec", sourceKind: null }),
    ]);

    expect(hideInternalRosterRows()).toBe(2);
    expect(visible()).toEqual([
      "human-exec",
      "stamped-claude",
      "stamped-managed",
      "stamped-no-exec",
    ]);
    // Hiding is never deleting: the unfiltered Resume index keeps all six.
    expect(queryResumableCache({ limit: 50 }).sessions).toHaveLength(6);
  });

  test("a cwd prefix in the policy covers the dir and its children, not a lookalike", () => {
    policy({ cwdPrefixes: ["/home/agent/sites-beheer/scripts/gen/", "/home/agent/foo_bar"] });
    upsertResumableRows([
      row({ sessionId: "gen-dir", cwd: "/home/agent/sites-beheer/scripts/gen" }),
      row({ sessionId: "gen-child", cwd: "/home/agent/sites-beheer/scripts/gen/img-20260827" }),
      row({ sessionId: "gen-lookalike", cwd: "/home/agent/sites-beheer/scripts/generator" }),
      row({ sessionId: "underscore", cwd: "/home/agent/foo_bar/run" }),
      row({ sessionId: "underscore-wildcard", cwd: "/home/agent/fooXbar/run" }),
      row({ sessionId: "human-exec" }),
    ]);

    expect(hideInternalRosterRows()).toBe(3);
    expect(visible()).toEqual(["gen-lookalike", "human-exec", "underscore-wildcard"]);
  });

  test("hideAllUnmanagedExec covers every delegated exec on a delegation-only box", () => {
    policy({ hideAllUnmanagedExec: true });
    upsertResumableRows([
      row({ sessionId: "human-exec" }),
      row({ sessionId: "stamped", originator: "codex_agent_exec", cwd: "/home/agent/kleurplaat" }),
      row({ sessionId: "managed-exec", managed: true }),
      row({ sessionId: "interactive", sourceKind: "cli", originator: "codex_cli_rs" }),
      row({ sessionId: "claude-exec", agent: "claude" }),
    ]);

    expect(hideInternalRosterRows()).toBe(2);
    expect(visible()).toEqual(["claude-exec", "interactive", "managed-exec"]);
  });

  test("a broken policy file degrades to the defaults instead of throwing", () => {
    policy("{ not json");
    expect(readInternalExecPolicy()).toEqual({
      originators: ["codex_agent_exec"],
      cwdPrefixes: [],
      hideAllUnmanagedExec: false,
    });
    upsertResumableRows([
      row({ sessionId: "stamped", originator: "codex_agent_exec" }),
      row({ sessionId: "human-exec" }),
    ]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(visible()).toEqual(["human-exec"]);
  });

  test("repair is idempotent and re-enrichment never resurrects a hidden row", () => {
    const stamped = row({ sessionId: "stamped", originator: "codex_agent_exec" });
    upsertResumableRows([stamped]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(hideInternalRosterRows()).toBe(0);
    upsertResumableRows([{ ...stamped, mtimeMs: 2_000, title: "Re-enriched" }]);
    expect(visible()).toEqual([]);
    expect(queryResumableCache({ limit: 50 }).sessions).toHaveLength(1);
  });
});
