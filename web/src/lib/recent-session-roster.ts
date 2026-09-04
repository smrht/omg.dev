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
 * Positions are stable. Live rows arrive start-time ordered and historical
 * rows are interleaved by start time instead of appended at the end, so
 * stopping a chat keeps it where it was instead of dropping it to the bottom
 * of the list. The resume cache records no start time, so starts are learned
 * from every live list this module sees (both sessionId and nativeSessionId,
 * because a resumed session can reappear under either id) and kept across
 * reloads in localStorage on the same device. A row never seen live keeps
 * startedAt null and sinks after every known start, in resume recency order.
 */

const START_MEMORY_KEY = "omg.roster.startedAt.v1";
const START_MEMORY_CAP = 2000;

const startMemory = new Map<string, number>();
let memoryLoaded = false;
let memoryDirty = false;

function loadStartMemory(): void {
  if (memoryLoaded) return;
  memoryLoaded = true;
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(START_MEMORY_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) startMemory.set(id, at);
    }
  } catch {
    /* No storage (private mode, non-browser env) — in-memory learning still applies. */
  }
}

function saveStartMemory(): void {
  if (!memoryDirty) return;
  memoryDirty = false;
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(START_MEMORY_KEY, JSON.stringify(Object.fromEntries(startMemory)));
  } catch {
    /* Quota or private mode — retry on the next learned start. */
    memoryDirty = true;
  }
}

function rememberLiveStarts(live: Session[]): void {
  loadStartMemory();
  for (const session of live) {
    const at = session.startedAt;
    if (at == null) continue;
    for (const id of [session.sessionId, session.nativeSessionId]) {
      if (!id) continue;
      if (startMemory.get(id) !== at) {
        startMemory.set(id, at);
        memoryDirty = true;
      }
    }
  }
  while (startMemory.size > START_MEMORY_CAP) {
    const oldest = startMemory.keys().next();
    if (oldest.done) break;
    startMemory.delete(oldest.value);
  }
  saveStartMemory();
}

/** Test-only: forget learned starts (memory reloads from storage on next call). */
export function __resetRosterStartMemory(): void {
  startMemory.clear();
  memoryLoaded = false;
  memoryDirty = false;
}

export function recentSessionRoster(
  live: Session[],
  recent: ResumableSession[],
): Session[] {
  rememberLiveStarts(live);
  const seen = new Set<string>();
  for (const session of live) {
    if (session.sessionId) seen.add(session.sessionId);
    if (session.nativeSessionId) seen.add(session.nativeSessionId);
  }
  // Live order is never touched: the app sorts it by start upstream and a
  // running card must not jump. Historical rows slot into that order by
  // remembered start, so a stopped chat lands back where it ran instead of
  // dropping to the bottom. Unknown starts (never seen live) append at the
  // tail in resume recency order.
  const merged: Session[] = [...live];
  for (const row of recent) {
    if (!row.sessionId || seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    const startedAt = startMemory.get(row.sessionId) ?? null;
    const historical: Session = {
      sessionId: row.sessionId,
      agent: row.agent,
      cwd: row.cwd ?? undefined,
      project: row.project,
      title: row.title,
      lastUserText: row.lastUserText ?? null,
      model: row.model ?? null,
      assignedUser: row.assignedUser ?? null,
      startedAt,
      lastActivityAt: row.lastActivityAt ?? null,
      shippedReview: true,
      reviewLabel: "Finished",
    };
    if (startedAt == null) {
      merged.push(historical);
      continue;
    }
    const at: number = startedAt;
    const idx = merged.findIndex((s) => s.startedAt != null && s.startedAt > at);
    if (idx === -1) merged.push(historical);
    else merged.splice(idx, 0, historical);
  }
  return merged;
}
