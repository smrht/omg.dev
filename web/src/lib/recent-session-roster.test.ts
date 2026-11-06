import { describe, expect, test } from "bun:test";
import type { ResumableSession, Session } from "../App";
import { __resetRosterStartMemory, recentSessionRoster } from "./recent-session-roster";

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

  test("a stopped chat keeps its slot instead of dropping to the bottom", () => {
    // While running, the module learns both starts from the live list.
    const before = recentSessionRoster(
      [liveRow({ sessionId: "keep-a", startedAt: 100 }), liveRow({ sessionId: "keep-b", startedAt: 200 })],
      [],
    );
    expect(before.map((s) => s.sessionId)).toEqual(["keep-a", "keep-b"]);
    // keep-a stops: it leaves the live list and returns via the resume cache.
    const after = recentSessionRoster(
      [liveRow({ sessionId: "keep-b", startedAt: 200 })],
      [resumeRow({ sessionId: "keep-a", lastActivityAt: 999 })],
    );
    expect(after.map((s) => s.sessionId)).toEqual(["keep-a", "keep-b"]);
    const stopped = after[0];
    expect(stopped.shippedReview).toBe(true);
    expect(stopped.startedAt).toBe(100);
  });

  test("live rows without a start never move", () => {
    // Learn the stopped chat's start while it is still running.
    recentSessionRoster([liveRow({ sessionId: "anchor-mid", startedAt: 150 })], []);
    const roster = recentSessionRoster(
      [
        liveRow({ sessionId: "nostart-live", startedAt: null }),
        liveRow({ sessionId: "later-live", startedAt: 200 }),
      ],
      [resumeRow({ sessionId: "anchor-mid", lastActivityAt: 999 })],
    );
    expect(roster.map((s) => s.sessionId)).toEqual(["nostart-live", "anchor-mid", "later-live"]);
  });

  test("rows never seen live sink to the tail in resume order", () => {
    const roster = recentSessionRoster([liveRow({ sessionId: "tail-live", startedAt: 200 })], [
      resumeRow({ sessionId: "tail-zeta", lastActivityAt: 20 }),
      resumeRow({ sessionId: "tail-alpha", lastActivityAt: 10 }),
    ]);
    // Reverse-alphabetical input on purpose: order comes from the resume
    // feed, not from a name sort.
    expect(roster.map((s) => s.sessionId)).toEqual(["tail-live", "tail-zeta", "tail-alpha"]);
    expect(roster[1].startedAt).toBeNull();
  });

  test("known stopped chat precedes unknown history even when it stopped last", () => {
    recentSessionRoster([liveRow({ sessionId: "last-known", startedAt: 300 })], []);
    const roster = recentSessionRoster(
      [liveRow({ sessionId: "earlier-live", startedAt: 100 })],
      [resumeRow({ sessionId: "never-known" }), resumeRow({ sessionId: "last-known" })],
    );
    expect(roster.map((s) => s.sessionId)).toEqual(["earlier-live", "last-known", "never-known"]);
  });

  test("equal starts keep the upstream session-id tiebreaker after stopping", () => {
    recentSessionRoster([
      liveRow({ sessionId: "same-a", startedAt: 100 }),
      liveRow({ sessionId: "same-b", startedAt: 100 }),
    ], []);
    const roster = recentSessionRoster(
      [liveRow({ sessionId: "same-b", startedAt: 100 })],
      [resumeRow({ sessionId: "same-a" })],
    );
    expect(roster.map((s) => s.sessionId)).toEqual(["same-a", "same-b"]);
  });

  test("remembered starts survive a reload via localStorage", () => {
    const store: Record<string, string> = {};
    const fakeStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const holder = globalThis as unknown as { localStorage?: unknown };
    const realStorage = holder.localStorage;
    holder.localStorage = fakeStorage;
    try {
      __resetRosterStartMemory();
      recentSessionRoster([liveRow({ sessionId: "persist-a", startedAt: 150 })], []);
      expect(store["omg.roster.startedAt.v1"]).toContain("persist-a");
      // A reload wipes the module memory; the next call reloads from storage.
      __resetRosterStartMemory();
      const roster = recentSessionRoster([], [resumeRow({ sessionId: "persist-a" })]);
      expect(roster).toHaveLength(1);
      expect(roster[0].startedAt).toBe(150);
    } finally {
      if (realStorage === undefined) delete holder.localStorage;
      else holder.localStorage = realStorage;
      __resetRosterStartMemory();
    }
  });
});
