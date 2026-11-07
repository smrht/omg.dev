import type { OmgChatMessage } from "./omg-chat-transport";

// Session-switch transcript cache.
//
// Opening a session used to blank the pane and wait on a fresh
// `/api/sessions/{id}/messages` round trip every single time — including for a
// session you had open seconds ago. The server page itself is sub-millisecond,
// so that wait was pure network latency, and it read as "transcript loading is
// slow" whenever the link was slow (remote/tunnelled/mobile).
//
// We keep the last-known page per session in memory so a re-open paints
// instantly from cache and revalidates in the background (stale-while-
// revalidate). Live transcript events keep the cached entry current while the
// session stays mounted, so the cached paint is usually already correct.

export type TranscriptCacheEntry = {
  messages: OmgChatMessage[];
  nextBefore: number | null;
  at: number;
};

// Bounded so a long-lived tab that visits many sessions can't grow without
// limit; insertion-ordered Map = cheap LRU when we re-set on read.
const MAX_SESSIONS = 24;
const cache = new Map<string, TranscriptCacheEntry>();

function trim() {
  for (const sid of cache.keys()) {
    if (cache.size <= MAX_SESSIONS) return;
    cache.delete(sid);
  }
}

export function readTranscriptCache(sid: string): TranscriptCacheEntry | null {
  const entry = cache.get(sid);
  if (!entry) return null;
  // Refresh LRU position on read.
  cache.delete(sid);
  cache.set(sid, entry);
  return entry;
}

// Optimistic turns (in flight, or queued behind a running turn) are client-side
// state, not transcript: the agent may have read them minutes ago by the time
// the cached page is painted again. Caching one would repaint it as still
// waiting on re-open, so the cache keeps only rows the server has confirmed.
function settledOnly(messages: OmgChatMessage[]): OmgChatMessage[] {
  const settled = messages.filter((message) => !message.metadata?.omgMessage?.pending);
  return settled.length === messages.length ? messages : settled;
}

export function writeTranscriptCache(
  sid: string,
  messages: OmgChatMessage[],
  nextBefore: number | null,
) {
  if (!sid) return;
  cache.delete(sid);
  cache.set(sid, { messages: settledOnly(messages), nextBefore, at: Date.now() });
  trim();
}

// Keep the cached page in sync as live events land, without disturbing LRU
// order or creating an entry for a session we never loaded a page for.
export function updateTranscriptCacheMessages(sid: string, messages: OmgChatMessage[]) {
  const entry = cache.get(sid);
  if (!entry) return;
  entry.messages = settledOnly(messages);
  entry.at = Date.now();
}

// How many of the top-of-list sessions to warm ahead of the user opening them.
const PREFETCH_COUNT = 8;

// Module-level, not a component ref: the app remounts (e.g. after picking a
// profile) and a per-instance ref would re-run the whole prefetch sweep.
const attempted = new Set<string>();
const stamps = new Map<string, string>();
const stale = new Set<string>();
const queue: string[] = [];
let sweeping = false;

// `requestIdleCallback` where available, timeout fallback for Safari. Keeps
// prefetch off the critical path of the list's first paint.
function whenIdle(run: () => void) {
  const ric = (
    globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  ).requestIdleCallback;
  if (typeof ric === "function") ric(run, { timeout: 2000 });
  else setTimeout(run, 500);
}

/**
 * Warm the cache for the first few sessions in the order the user actually sees
 * them, so the *first* open of a session paints instantly too — not just
 * re-opens. Best-effort and idempotent: every sid is attempted at most once,
 * and a page the user's own open already wrote is never clobbered.
 */
export function prefetchTranscripts(
  orderedSids: string[],
  load: (sid: string) => Promise<{ messages: OmgChatMessage[]; nextBefore: number | null }>,
) {
  // agentbox: an entry may be "sid@stamp". The stamp is the session's last
  // activity once it is idle (constant while it runs). A chat prefetched while
  // it was still working kept that page forever, so opening it right after it
  // finished painted the transcript without its final answer until the
  // revalidate landed. A new stamp means: fetch this one again, once.
  const sids: string[] = [];
  for (const entry of orderedSids.slice(0, PREFETCH_COUNT)) {
    const at = entry.indexOf("@");
    const sid = at < 0 ? entry : entry.slice(0, at);
    const stamp = at < 0 ? "" : entry.slice(at + 1);
    if (!sid) continue;
    const seen = stamps.get(sid);
    if (stamp && seen != null && seen !== stamp) {
      attempted.delete(sid);
      stale.add(sid);
    }
    if (stamp) stamps.set(sid, stamp);
    sids.push(sid);
  }
  for (const sid of sids.filter((sid) => !attempted.has(sid) && (!cache.has(sid) || stale.has(sid)))) {
    if (!queue.includes(sid)) queue.push(sid);
  }
  // Queued rather than dropped: the narrow and wide layouts each report their
  // own on-screen order, and a sweep already running must not discard the other.
  if (!queue.length || sweeping) return;
  sweeping = true;
  whenIdle(async () => {
    try {
      // Serial: background work must never contend with the fetch for a session
      // the user actually opened.
      while (queue.length) {
        const sid = queue.shift() as string;
        const refresh = stale.delete(sid);
        if (attempted.has(sid) || (cache.has(sid) && !refresh)) continue;
        attempted.add(sid);
        try {
          const startedAt = Date.now();
          const page = await load(sid);
          // Never clobber a page written after this request left (the user's
          // own open, or live events on a mounted chat).
          const current = cache.get(sid);
          if (current && (!refresh || current.at > startedAt)) continue;
          writeTranscriptCache(sid, page.messages, page.nextBefore);
        } catch {
          // Best-effort; opening the session still fetches normally.
        }
      }
    } finally {
      sweeping = false;
    }
  });
}

export function clearTranscriptCache(sid?: string) {
  if (sid) {
    cache.delete(sid);
    attempted.delete(sid);
    return;
  }
  cache.clear();
  attempted.clear();
  stamps.clear();
  stale.clear();
  queue.length = 0;
}

/**
 * agentbox: start a session's page fetch at pointerdown, before React spends
 * ~100-350 ms rendering the open. The chat effect then takes this promise
 * instead of issuing its own request. Only a very recent prime counts, so a
 * stray press that never became an open cannot serve a stale page later.
 */
const PRIME_TTL_MS = 3000;
const primed = new Map<string, { at: number; page: Promise<unknown> }>();

export function primeTranscriptFetch(sid: string, fetchPage: (sid: string) => Promise<unknown>) {
  if (!sid) return;
  const hit = primed.get(sid);
  if (hit && Date.now() - hit.at < PRIME_TTL_MS) return;
  const page = fetchPage(sid);
  page.catch(() => {}); // an unused prime must not surface as unhandled
  primed.set(sid, { at: Date.now(), page });
}

export function takePrimedTranscript<T>(sid: string): Promise<T> | null {
  const hit = primed.get(sid);
  primed.delete(sid);
  if (!hit || Date.now() - hit.at >= PRIME_TTL_MS) return null;
  return hit.page as Promise<T>;
}
