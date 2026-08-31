import { describe, expect, test } from "bun:test";
import type { ResumableSession, Session } from "../App";
import { recentSessionRoster } from "./recent-session-roster";

function liveRow(over: Partial<Session>): Session {
  return {
    sessionId: "live-1",
    agent: "claude",
    project: "app",
    title: "Live one",
    runtime: "tmux",
    tmuxTarget: "%3",
    busy: true,
    startedAt: 100,
    lastActivityAt: 200,
    ...over,
  };
}

function resumeRow(over: Partial<ResumableSession>): ResumableSession {
  return {
    sessionId: "old-1",
    cwd: "/srv/app",
    project: "app",
    title: "Old one",
    lastActivityAt: 50,
    lastUserText: "ship it",
    agent: "claude",
    ...over,
  };
}

describe("recentSessionRoster", () => {
  test("live rows pass through unchanged and come first", () => {
    const a = liveRow({ sessionId: "a" });
    const b = liveRow({ sessionId: "b", nativeSessionId: "nb" });
    const roster = recentSessionRoster([a, b], [resumeRow({ sessionId: "old-1" })]);
    expect(roster.slice(0, 2)).toEqual([a, b]);
  });

  test("resume rows become Finished review rows with resume timestamps", () => {
    const roster = recentSessionRoster([], [
      resumeRow({
        sessionId: "old-1",
        lastActivityAt: 4321,
        assignedUser: "sam@example.com",
        model: "opus",
      }),
    ]);
    expect(roster).toHaveLength(1);
    const row = roster[0];
    expect(row.sessionId).toBe("old-1");
    expect(row.shippedReview).toBe(true);
    expect(row.reviewLabel).toBe("Finished");
    expect(row.startedAt).toBeNull();
    expect(row.lastActivityAt).toBe(4321);
    expect(row.assignedUser).toBe("sam@example.com");
    expect(row.model).toBe("opus");
  });

  test("historical rows carry no busy/runtime/tmux fields", () => {
    const roster = recentSessionRoster([], [resumeRow()]);
    const row = roster[0];
    expect("busy" in row).toBe(false);
    expect("runtime" in row).toBe(false);
    expect("tmuxTarget" in row).toBe(false);
    expect("tmuxName" in row).toBe(false);
    expect("pid" in row).toBe(false);
  });

  test("dedupes against live sessionId and nativeSessionId", () => {
    const roster = recentSessionRoster(
      [
        liveRow({ sessionId: "dup-by-session" }),
        liveRow({ sessionId: "live-2", nativeSessionId: "dup-by-native" }),
      ],
      [resumeRow({ sessionId: "dup-by-session" }), resumeRow({ sessionId: "dup-by-native" })],
    );
    expect(roster).toHaveLength(2);
    expect(roster.every((s) => s.shippedReview !== true)).toBe(true);
  });

  test("collapses duplicate resume rows and keeps input order", () => {
    const roster = recentSessionRoster([], [
      resumeRow({ sessionId: "newer", lastActivityAt: 20 }),
      resumeRow({ sessionId: "newer", lastActivityAt: 20 }),
      resumeRow({ sessionId: "older", lastActivityAt: 10 }),
    ]);
    expect(roster.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });
});
