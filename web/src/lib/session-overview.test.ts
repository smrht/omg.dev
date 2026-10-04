import { describe, expect, test } from "bun:test";
import {
  overviewState,
  overviewStateLabel,
  sessionMatchesSearch,
  type SessionOverviewInput,
} from "./session-overview.ts";

function makeSession(
  overrides: Partial<SessionOverviewInput> = {},
): SessionOverviewInput {
  return {
    sessionId: "wrap-1",
    nativeSessionId: "nat-1",
    title: "Fix login flow",
    lastUserText: "the OAuth redirect loops",
    project: "acme-web",
    last: { text: "Reproduced the loop on staging" },
    status: "ok",
    agent: "claude",
    model: "sonnet",
    ...overrides,
  };
}

describe("overviewState", () => {
  test("a session whose sessionId is an open question is attention", () => {
    expect(overviewState(makeSession(), false, new Set(["wrap-1"]))).toBe(
      "attention",
    );
  });

  test("a session matched only by its nativeSessionId is attention too", () => {
    const session = makeSession({ sessionId: "other" });
    expect(overviewState(session, false, new Set(["nat-1"]))).toBe(
      "attention",
    );
  });

  test("blocked outranks busy", () => {
    expect(overviewState(makeSession({ status: "blocked" }), true, new Set()))
      .toBe("attention");
  });

  test("an open question also outranks busy", () => {
    expect(overviewState(makeSession(), true, new Set(["nat-1"]))).toBe(
      "attention",
    );
  });

  test("busy with no question and no block is working", () => {
    expect(overviewState(makeSession(), true, new Set())).toBe("working");
  });

  test("an idle session with nothing pending is recent, not attention", () => {
    expect(overviewState(makeSession(), false, new Set())).toBe("recent");
  });

  test("a missing status is treated as not blocked", () => {
    const session = makeSession();
    delete session.status;
    expect(overviewState(session, false, new Set())).toBe("recent");
  });

  test("null or undefined ids never match, even if the set holds the old value", () => {
    const session = makeSession({
      sessionId: null,
      nativeSessionId: undefined,
    });
    expect(overviewState(session, false, new Set(["wrap-1"]))).toBe("recent");
  });

  test("an empty-string transitional id is treated as absent", () => {
    const session = makeSession({ sessionId: "", nativeSessionId: "" });
    expect(overviewState(session, false, new Set([""]))).toBe("recent");
  });

  test("a question for a different session does not spill over", () => {
    expect(overviewState(makeSession(), false, new Set(["wrap-2"]))).toBe(
      "recent",
    );
  });
});

describe("overviewStateLabel", () => {
  test("labels each state without implying completion", () => {
    expect(overviewStateLabel("attention")).toBe("Needs attention");
    expect(overviewStateLabel("working")).toBe("Working");
    expect(overviewStateLabel("recent")).toBe("Recent");
  });
});

describe("sessionMatchesSearch", () => {
  test("an empty query matches everything", () => {
    expect(sessionMatchesSearch(makeSession(), "")).toBe(true);
  });

  test("a whitespace-only query matches everything", () => {
    expect(sessionMatchesSearch(makeSession(), "   \t ")).toBe(true);
  });

  test("matching is case-insensitive across fields", () => {
    expect(sessionMatchesSearch(makeSession(), "oAUTH")).toBe(true);
    expect(sessionMatchesSearch(makeSession(), "ACME-WEB")).toBe(true);
  });

  test("all whitespace-separated tokens must match, across different fields", () => {
    expect(sessionMatchesSearch(makeSession(), "oauth acme staging")).toBe(
      true,
    );
    expect(sessionMatchesSearch(makeSession(), "oauth nomatch")).toBe(false);
  });

  test("accents fold in both directions with mixed case", () => {
    const session = makeSession({
      title: "Résumé van de Café-export",
    });
    expect(sessionMatchesSearch(session, "resume CAFE")).toBe(true);
    expect(sessionMatchesSearch(session, "CAFÉ résumé")).toBe(true);
    expect(sessionMatchesSearch(session, "cafexyz")).toBe(false);
  });

  test("agent and model are searchable", () => {
    expect(sessionMatchesSearch(makeSession(), "claude sonnet")).toBe(true);
    expect(sessionMatchesSearch(makeSession(), "claude gpt")).toBe(false);
  });

  test("absent fields do not crash and cannot match", () => {
    const bare: SessionOverviewInput = { sessionId: "x", title: null };
    expect(sessionMatchesSearch(bare, "")).toBe(true);
    expect(sessionMatchesSearch(bare, "anything")).toBe(false);
  });
});
