import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  backfillConfirmedInternalRows,
  hideInternalRosterRows,
  queryResumableCache,
  resetResumeCacheConnectionForTests,
  setRosterHidden,
  upsertResumableRows,
  type ResumableCacheRow,
} from "./resume-cache.ts";

// Issue 552: internal sessions stay out of the Chat roster while Resume keeps
// every row. Three durable source signals do the hiding — never agent kind or
// titles: (1) managed lineage (parentSessionId / spawnedBy, bots exempt, forks
// stay listed), (2) codex session_meta provenance (originator codex_sdk_ts =
// SDK launch, source {subagent} = native thread spawn; codex_exec from a shell
// stays listed), (3) the omg runtime-contract envelope on a claude transcript's
// first user message. The seven confirmed screenshot rows are hidden once by
// exact id; a later manual unhide of those survives the repair.

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-internal-roster-"));
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

function rosterIds(): string[] {
  return queryResumableCache({ roster: true, limit: 200 }).sessions.map((s) => s.sessionId);
}

function pickerIds(): string[] {
  return queryResumableCache({ limit: 200 }).sessions.map((s) => s.sessionId);
}

describe("internal roster repair — managed lineage (issue 552)", () => {
  test("a managed child worker is hidden, an ordinary managed chat stays listed", () => {
    upsertResumableRows([
      row({ sessionId: "child-worker", managed: true, parentSessionId: "parent-1" }),
      row({ sessionId: "ordinary-managed", managed: true }),
    ]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(rosterIds()).toEqual(["ordinary-managed"]);
  });

  test("headless managed spawns hide; bots and forks stay listed", () => {
    upsertResumableRows([
      row({ sessionId: "spawn-subagent", managed: true, spawnedBy: "subagent" }),
      row({ sessionId: "spawn-finding", managed: true, spawnedBy: "finding" }),
      row({ sessionId: "spawn-schedule", managed: true, spawnedBy: "schedule" }),
      row({
        sessionId: "spawn-bot",
        managed: true,
        spawnedBy: "bot",
        botId: "bot_1",
      }),
      row({ sessionId: "spawn-fork", managed: true, spawnedBy: "fork", parentSessionId: "parent-1" }),
    ]);
    expect(hideInternalRosterRows()).toBe(3);
    expect(rosterIds().sort()).toEqual(["spawn-bot", "spawn-fork"]);
  });

  test("a bot with worker lineage is still exempt (bot_id wins)", () => {
    upsertResumableRows([
      row({ sessionId: "bot-with-parent", managed: true, parentSessionId: "p", botId: "bot_2" }),
    ]);
    expect(hideInternalRosterRows()).toBe(0);
    expect(rosterIds()).toEqual(["bot-with-parent"]);
  });
});

describe("internal roster repair — codex session_meta provenance (issue 552)", () => {
  test("SDK-driven and subagent-spawned rollouts hide; shell exec and T3 stay listed", () => {
    upsertResumableRows([
      row({ sessionId: "sdk-watch", agent: "codex", originator: "codex_sdk_ts" }),
      row({ sessionId: "native-spawn", agent: "codex", originator: "codex_exec", sourceKind: "subagent" }),
      row({ sessionId: "shell-exec", agent: "codex", originator: "codex_exec", sourceKind: "exec" }),
      row({ sessionId: "t3-desktop", agent: "codex", originator: "t3code_desktop", sourceKind: "vscode" }),
    ]);
    expect(hideInternalRosterRows()).toBe(2);
    expect(rosterIds().sort()).toEqual(["shell-exec", "t3-desktop"]);
  });
});

describe("internal roster repair — claude launch envelope (issue 552)", () => {
  test("a transcript launched with the omg contract hides; interactive stays listed", () => {
    upsertResumableRows([
      row({ sessionId: "watch-transcript", agent: "claude", launchContract: true }),
      row({ sessionId: "interactive-cli", agent: "claude", launchContract: false }),
    ]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(rosterIds()).toEqual(["interactive-cli"]);
  });

  test("the flag survives a later managed-branch re-upsert without it (MAX, not overwrite)", () => {
    upsertResumableRows([row({ sessionId: "watch-transcript", agent: "claude", launchContract: true })]);
    expect(hideInternalRosterRows()).toBe(1);
    // A later refresh upserts the same id from the managed catalog loop, which
    // does not carry the transcript flag: the envelope classification must not
    // be wiped by a null pass.
    upsertResumableRows([row({ sessionId: "watch-transcript", agent: "claude", managed: true })]);
    expect(hideInternalRosterRows()).toBe(0);
    expect(rosterIds()).toEqual([]);
  });
});

describe("confirmed screenshot backfill (issue 552)", () => {
  const SCREENSHOT_INTERNAL = [
    "01a03ad5-3c42-7ff0-b4ff-289e514f76a8",
    "d7238594-af1f-461b-a177-9b53f5f1c27f",
    "cba6e1e7-58b6-4317-ab2d-fc9f0ece3ab7",
    "169bfbf6-15f9-4d6a-a4b3-1ee17910c6ed",
    "42f61b9c-5879-461f-923d-c8fd4a05d132",
    "1487c065-f6ac-4f87-afc2-d97591c1bcaa",
    "7ade84cc-217b-406f-aee2-8f1cdebb0bc7",
  ];
  const ORDINARY = "625af1eb-8415-44b1-b02f-f1f13a8dffa8";

  const MANAGED_OPENCODE = ["169bfbf6", "42f61b9c", "1487c065", "7ade84cc"];

  function screenshotRow(id: string): ResumableCacheRow {
    const managedOpencode = MANAGED_OPENCODE.some((p) => id.startsWith(p));
    return row({
      sessionId: id,
      agent: id.startsWith("01a03ad5") ? "codex" : managedOpencode ? "opencode" : "claude",
      managed: managedOpencode,
    });
  }

  test("hides exactly the seven confirmed ids once; the ordinary chat stays listed", () => {
    upsertResumableRows([
      ...SCREENSHOT_INTERNAL.map(screenshotRow),
      row({ sessionId: ORDINARY, managed: true, agent: "codex", backend: "codex-aisdk" }),
    ]);
    expect(backfillConfirmedInternalRows()).toBe(7);
    expect(backfillConfirmedInternalRows()).toBe(0); // one time, durably
    expect(rosterIds()).toEqual([ORDINARY]);
    // All eight screenshot rows stay queryable without the roster filter.
    expect(pickerIds().sort()).toEqual([...SCREENSHOT_INTERNAL, ORDINARY].sort());
    expect(queryResumableCache({ limit: 200 }).total).toBe(8);
  });

  test("the backfill never touches a lookalike id", () => {
    upsertResumableRows([
      row({ sessionId: "01a03ad5-0000-0000-0000-000000000000", agent: "codex" }),
    ]);
    expect(backfillConfirmedInternalRows()).toBe(0);
    expect(rosterIds()).toEqual(["01a03ad5-0000-0000-0000-000000000000"]);
  });

  test("a manual unhide after the backfill survives the repair", () => {
    upsertResumableRows([
      row({ sessionId: "42f61b9c-5879-461f-923d-c8fd4a05d132", managed: true, agent: "opencode" }),
    ]);
    expect(backfillConfirmedInternalRows()).toBe(1);
    expect(setRosterHidden("42f61b9c-5879-461f-923d-c8fd4a05d132", false)).toBe(true);
    expect(hideInternalRosterRows()).toBe(0);
    expect(backfillConfirmedInternalRows()).toBe(0);
    expect(rosterIds()).toEqual(["42f61b9c-5879-461f-923d-c8fd4a05d132"]);
  });
});

describe("internal roster repair — controlled routine launcher (issue 552 primary review)", () => {
  // The scheduled-task cron launcher (claude -p, no omg envelope) opens every
  // run with the SAME controlled first prompt. Future legacy transcripts like
  // cba6e1e7 must auto-hide from that full signature — not only the one-time
  // exact-id backfill. All parts required, never a keyword: a human chat that
  // merely mentions the opening stays listed.
  const REAL_ROUTINE_PROMPT =
    "Voer de geplande routine 'nieuwswacht-qa' uit. Lees eerst " +
    "/home/agent/.claude/scheduled-tasks/nieuwswacht-qa/SKILL.md en volg die " +
    "instructies exact. Je draait headless op dedicated agentbox2; WordPress " +
    "en Django-productie staan op netcup-vps8000-wp en zijn alleen via de " +
    "bekende remote routes bereikbaar.";

  test("a transcript whose first prompt carries the full signature hides (sourceKind routine)", () => {
    upsertResumableRows([
      row({ sessionId: "legacy-routine", agent: "claude", sourceKind: "routine" }),
      row({ sessionId: "human-chat", agent: "claude" }),
    ]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(rosterIds()).toEqual(["human-chat"]);
    expect(pickerIds().sort()).toEqual(["human-chat", "legacy-routine"]);
  });

  test("the routine classification survives a signal-less re-upsert (COALESCE, not wipe)", () => {
    upsertResumableRows([row({ sessionId: "legacy-routine", agent: "claude", sourceKind: "routine" })]);
    expect(hideInternalRosterRows()).toBe(1);
    // A later refresh upserts the same id without the transcript signal (e.g.
    // from the managed catalog loop): the classification must persist.
    upsertResumableRows([row({ sessionId: "legacy-routine", agent: "claude", managed: true })]);
    expect(hideInternalRosterRows()).toBe(0);
    expect(rosterIds()).toEqual([]);
    expect(pickerIds()).toEqual(["legacy-routine"]);
  });

  test("the signature matcher accepts the real prompt and rejects every near-miss", async () => {
    const { isRoutineLaunchPrompt } = await import("./sessions.ts");
    expect(isRoutineLaunchPrompt(REAL_ROUTINE_PROMPT)).toBe(true);
    // Human chat that MERELY MENTIONS the opening: no skill-read line with the
    // scheduled-tasks path, no headless agentbox2 line — stays roster-visible.
    expect(
      isRoutineLaunchPrompt(
        "Wat betekent dat rijtje 'Voer de geplande routine' precies in de cron van gisteren?",
      ),
    ).toBe(false);
    // Human chat that STARTS with the phrase but lacks the rest of the shape.
    expect(
      isRoutineLaunchPrompt(
        "Voer de geplande routine genoemd in de runbook eens uit en laat zien wat er gebeurt.",
      ),
    ).toBe(false);
    // Older routine variant without the headless agentbox2 line: not this
    // signature — hiding those needs a deliberate decision, not a guess.
    expect(
      isRoutineLaunchPrompt(
        "Voer de geplande routine 'ns-ads-zoektermen' uit. Lees eerst " +
          "/home/agent/.claude/scheduled-tasks/ns-ads-zoektermen/SKILL.md en volg die instructies exact.",
      ),
    ).toBe(false);
    // All three parts present but the text does not OPEN with the controlled
    // prefix: a human quoting the middle of the prompt.
    expect(isRoutineLaunchPrompt(`Uit mijn hoofd stond er zoiets van: Lees eerst
/home/agent/.claude/scheduled-tasks/x/SKILL.md en Je draait headless op dedicated
agentbox2 — hoe zat het ook alweer? Voer de geplande routine toch eens uit.`)).toBe(false);
  });

  test("the transcript scanner classifies the first user message only", async () => {
    const { transcriptLaunchSignals } = await import("./sessions.ts");
    const writeTranscript = async (name: string, first: string, second?: string) => {
      const path = join(root, name);
      const lines: string[] = [
        JSON.stringify({ type: "summary", summary: "meta header row" }),
        JSON.stringify({ type: "user", message: { content: first } }),
      ];
      if (second) lines.push(JSON.stringify({ type: "user", message: { content: second } }));
      await Bun.write(path, lines.join("\n"));
      return path;
    };

    // Full signature as the first prompt: a legacy cron routine transcript.
    expect(
      await transcriptLaunchSignals(await writeTranscript("routine.jsonl", REAL_ROUTINE_PROMPT)),
    ).toEqual({ launchContract: false, sourceKind: "routine", originator: "claude_other" });
    // The SAME signature, but only on the SECOND user turn after a human
    // opening question: not a controlled launch — first prompt decides.
    expect(
      await transcriptLaunchSignals(
        await writeTranscript("mention-later.jsonl", "Kun je die routine tonen?", REAL_ROUTINE_PROMPT),
      ),
    ).toEqual({ launchContract: false, sourceKind: null, originator: "claude_other" });
    // A human chat that merely mentions the opening in its first message.
    expect(
      await transcriptLaunchSignals(
        await writeTranscript(
          "mention-only.jsonl",
          "Wat betekent 'Voer de geplande routine' in die cron mail?",
        ),
      ),
    ).toEqual({ launchContract: false, sourceKind: null, originator: "claude_other" });
    // The omg envelope keeps its own signal and never implies routine.
    expect(
      await transcriptLaunchSignals(
        await writeTranscript(
          "envelope.jsonl",
          "=== omg.dev RUNTIME CONTRACT (capability version 2026-08-21.1) ===\n- Managed launch.",
        ),
      ),
    ).toEqual({ launchContract: true, sourceKind: null, originator: "claude_other" });
  });
});

describe("refresh-shaped idempotence (issue 552)", () => {
  test("re-enrichment and repeated repair never resurrect a hidden row", () => {
    upsertResumableRows([
      row({ sessionId: "sdk-watch", agent: "codex", originator: "codex_sdk_ts", mtimeMs: 1_000 }),
      row({ sessionId: "shell-exec", agent: "codex", originator: "codex_exec", mtimeMs: 1_000 }),
    ]);
    expect(hideInternalRosterRows()).toBe(1);
    // Later refresh re-enriches both (newer fingerprints) — same signals.
    upsertResumableRows([
      row({ sessionId: "sdk-watch", agent: "codex", originator: "codex_sdk_ts", mtimeMs: 9_000, title: "Grown" }),
      row({ sessionId: "shell-exec", agent: "codex", originator: "codex_exec", mtimeMs: 9_000, title: "Grown" }),
    ]);
    expect(hideInternalRosterRows()).toBe(0);
    expect(rosterIds()).toEqual(["shell-exec"]);
    expect(pickerIds().sort()).toEqual(["sdk-watch", "shell-exec"]);
  });

  test("rows classified in a later pass than the one that inserted them still hide", () => {
    // Refresh 1 inserts the row (no lineage recorded yet).
    upsertResumableRows([row({ sessionId: "late-child", managed: true })]);
    expect(hideInternalRosterRows()).toBe(0);
    expect(rosterIds()).toEqual(["late-child"]);
    // Refresh 2 lands the managed registry record with parent lineage.
    upsertResumableRows([row({ sessionId: "late-child", managed: true, parentSessionId: "p" })]);
    expect(hideInternalRosterRows()).toBe(1);
    expect(rosterIds()).toEqual([]);
  });
});
