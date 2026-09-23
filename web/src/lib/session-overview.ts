/**
 * Pure classification and search over the structural session shape the Live
 * roster renders. No imports: callers pass plain rows, so App's `Session`,
 * resume-roster rows, and test fixtures all fit without coupling this module
 * to App.tsx (a 30k-line file that would drag the DOM into every import).
 *
 * Precedence is the product decision encoded here: a session a human must act
 * on ("blocked" status, or an open question aimed at it) outranks activity. A
 * row can be mid-turn AND blocked; showing "Working" then would hide the one
 * state that needs a person. `busy` arrives as its own argument because the
 * live working flag is polled/streamed separately from the row itself.
 *
 * The fallthrough state is "recent", never "completed": this module sees a
 * list snapshot, not a lifecycle event, and a finished-looking row may just be
 * quiet. Callers that know a session truly finished say so themselves
 * (`shippedReview`/`reviewLabel` on the row).
 */

/** Structural minimum the overview helpers read. Optional fields may be
 *  missing, null, or (during id handoff between wrapper and native agent)
 *  empty strings — helpers treat all three as "no value". */
export type SessionOverviewInput = {
  sessionId?: string | null;
  nativeSessionId?: string | null;
  title?: string | null;
  lastUserText?: string | null;
  project?: string;
  last?: { text?: string } | null;
  status?: string;
  agent?: string;
  model?: string | null;
};

/** Coarse attention state for one session row, in priority order. */
export type SessionOverviewState =
  | "attention"
  | "working"
  | "recent";

function presentId(id: string | null | undefined): id is string {
  return typeof id === "string" && id !== "";
}

/**
 * Classify one session row.
 *
 * "attention" when the backend marked the session blocked, or when either id
 * names an open question. Both ids are checked because a resumed session can
 * reappear under its wrapper sessionId or its nativeSessionId (the same
 * dual-id contract recent-session-roster matches on), and a question recorded
 * against one must surface either way. "working" only when nothing needs a
 * human and the session is busy. Everything else is "recent" — recent, not
 * finished; this module cannot know completion.
 */
export function overviewState(
  session: SessionOverviewInput,
  busy: boolean,
  questionSessionIds: ReadonlySet<string>,
): SessionOverviewState {
  if (session.status === "blocked") return "attention";
  if (
    (presentId(session.sessionId) && questionSessionIds.has(session.sessionId)) ||
    (presentId(session.nativeSessionId) &&
      questionSessionIds.has(session.nativeSessionId))
  ) {
    return "attention";
  }
  if (busy) return "working";
  return "recent";
}

/** Fold a string for search: case-insensitive and accent-insensitive, so
 *  "café" meets "CAFE" and "resume" meets "résumé". Accents are common in
 *  this app's Dutch/French content and exact-codepoint search would miss
 *  keyboard variants of the same word. */
function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Does this row match the query? Every whitespace-separated token must appear
 * (AND across tokens) in at least one of the searched fields: title,
 * lastUserText, project, last.text, agent, model. An empty or blank query
 * matches everything, so an emptied search box never filters rows out.
 */
export function sessionMatchesSearch(
  session: SessionOverviewInput,
  query: string,
): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  const haystack = foldForSearch(
    [
      session.title ?? "",
      session.lastUserText ?? "",
      session.project ?? "",
      session.last?.text ?? "",
      session.agent ?? "",
      session.model ?? "",
    ].join("\n"),
  );
  return trimmed
    .split(/\s+/)
    .map(foldForSearch)
    .every((token) => haystack.includes(token));
}

/** Human label for a state. "Recent" names position in the list, never
 *  completion — see overviewState. */
export function overviewStateLabel(state: SessionOverviewState): string {
  switch (state) {
    case "attention":
      return "Needs attention";
    case "working":
      return "Working";
    default:
      return "Recent";
  }
}
