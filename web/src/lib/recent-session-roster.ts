import type { ResumableSession, Session } from "../App";

/**
 * Merge the live fleet with the recent resumable roster so the Live workspace
 * can list finished sessions alongside running ones.
 *
 * Live rows pass through untouched and keep their real runtime fields. Each
 * resume row that is NOT already on screen (matched by sessionId or
 * nativeSessionId, because a resumed session can reappear under either id)
 * becomes a review-mode Session: `shippedReview: true` with a "Finished"
 * label, and no busy/runtime/tmux/pid fields — a historical row must never
 * look driveable or working, and nothing downstream may mistake it for a
 * process that could be attached to.
 *
 * startedAt/lastActivityAt come from the resume row; the resume cache records
 * no start time, so startedAt stays null rather than being invented.
 */
export function recentSessionRoster(
  live: Session[],
  recent: ResumableSession[],
): Session[] {
  const seen = new Set<string>();
  for (const session of live) {
    if (session.sessionId) seen.add(session.sessionId);
    if (session.nativeSessionId) seen.add(session.nativeSessionId);
  }
  const historical: Session[] = [];
  for (const row of recent) {
    if (!row.sessionId || seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    historical.push({
      sessionId: row.sessionId,
      agent: row.agent,
      cwd: row.cwd ?? undefined,
      project: row.project,
      title: row.title,
      lastUserText: row.lastUserText ?? null,
      model: row.model ?? null,
      assignedUser: row.assignedUser ?? null,
      startedAt: null,
      lastActivityAt: row.lastActivityAt ?? null,
      shippedReview: true,
      reviewLabel: "Finished",
    });
  }
  return [...live, ...historical];
}
