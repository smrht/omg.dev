// Issue 521 — which sessions a capped self-hosted launch may trade away.
//
// memoryReclaimCandidates already refuses busy, launching, persistent,
// unmanaged and non-resumable work (seam 2). This file pins the single
// addition the cap path makes: schedule-spawned residents belong to the
// schedule pool — closing them from an interactive launch would starve
// exactly the work the separate pool exists to protect.
import { describe, expect, test } from "bun:test";
import { capReclaimCandidate } from "./idle-archive.ts";

const base = {
  sessionId: "s",
  managed: true,
  agent: "opencode",
  runtime: "command-file" as const,
  lastActivityAt: 0,
};

describe("capReclaimCandidate picks the oldest safe ordinary session (issue 521)", () => {
  test("returns the oldest idle durable ordinary session", () => {
    const pick = capReclaimCandidate([
      { ...base, sessionId: "newest", lastActivityAt: 300 },
      { ...base, sessionId: "oldest", lastActivityAt: 100 },
      { ...base, sessionId: "middle", lastActivityAt: 200 },
    ]);
    expect(pick?.sessionId).toBe("oldest");
  });

  test("never picks busy, launching, persistent, unmanaged or non-resumable work", () => {
    expect(
      capReclaimCandidate([{ ...base, sessionId: "busy", busy: true, lastActivityAt: 1 }]),
    ).toBeNull();
    expect(
      capReclaimCandidate([{ ...base, sessionId: "starting", launching: true, lastActivityAt: 1 }]),
    ).toBeNull();
    expect(
      capReclaimCandidate([{ ...base, sessionId: "bot", persistent: true, lastActivityAt: 1 }]),
    ).toBeNull();
    expect(
      capReclaimCandidate([{ ...base, sessionId: "human", managed: false, lastActivityAt: 1 }]),
    ).toBeNull();
    // tmux runtime has no resume record: reclaiming it would be a kill.
    expect(
      capReclaimCandidate([
        { ...base, sessionId: "tmux", runtime: "tmux" as const, lastActivityAt: 1 },
      ]),
    ).toBeNull();
    expect(capReclaimCandidate([{ ...base, sessionId: null, lastActivityAt: 1 }])).toBeNull();
  });

  test("schedule-spawned residents are not traded for an interactive slot", () => {
    expect(
      capReclaimCandidate([
        { ...base, sessionId: "cron", spawnedBy: "schedule", lastActivityAt: 1 },
      ]),
    ).toBeNull();
    // ...but they do not shield the interactive candidate either.
    expect(
      capReclaimCandidate([
        { ...base, sessionId: "cron", spawnedBy: "schedule", lastActivityAt: 1 },
        { ...base, sessionId: "chat", spawnedBy: "ui", lastActivityAt: 2 },
      ])?.sessionId,
    ).toBe("chat");
  });
});
