import { useSyncExternalStore } from "react";

/**
 * agentbox: a stopped chat leaves "Bezig" at once (Sam, 07-11-2026).
 *
 * An interrupt returns before the agent has actually wound down; the server
 * keeps reporting busy for a few seconds and the overview, which falls back to
 * that list value once the chat is closed, kept the row under "Bezig". The
 * person pressed Stop, so the UI shows stopped until the server agrees, the
 * person sends again, or STOP_OVERRIDE_MS passes (a stop that never lands
 * shows busy again rather than hiding a running agent forever).
 */
export const STOP_OVERRIDE_MS = 20_000;
export const STOP_OVERRIDE_EVENT = "agentbox-stop-override";

const stopped = new Map<string, number>();
let version = 0;

function changed() {
  version += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STOP_OVERRIDE_EVENT));
}

export function markStopped(sid: string, now = Date.now()): void {
  if (!sid) return;
  stopped.set(sid, now + STOP_OVERRIDE_MS);
  changed();
  setTimeout(() => {
    if ((stopped.get(sid) ?? 0) <= Date.now()) {
      stopped.delete(sid);
      changed();
    }
  }, STOP_OVERRIDE_MS + 50);
}

export function clearStopped(sid: string): void {
  if (stopped.delete(sid)) changed();
}

export function isStopped(sid: string, now = Date.now()): boolean {
  const until = stopped.get(sid);
  if (until === undefined) return false;
  if (until <= now) {
    stopped.delete(sid);
    return false;
  }
  return true;
}

/**
 * Apply the overrides to a merged busy map. `listBusy` is the server's view:
 * once it says idle the override has done its job and is dropped.
 */
export function applyStopOverrides(
  busy: Record<string, boolean>,
  listBusy: Record<string, boolean>,
  now = Date.now(),
): Record<string, boolean> {
  if (!stopped.size) return busy;
  let out: Record<string, boolean> | null = null;
  for (const sid of [...stopped.keys()]) {
    if (listBusy[sid] === false) {
      stopped.delete(sid);
      continue;
    }
    if (isStopped(sid, now) && busy[sid]) {
      out ??= { ...busy };
      out[sid] = false;
    }
  }
  return out ?? busy;
}

function subscribe(cb: () => void) {
  window.addEventListener(STOP_OVERRIDE_EVENT, cb);
  return () => window.removeEventListener(STOP_OVERRIDE_EVENT, cb);
}

/** Re-render key for memos that apply the overrides. */
export function useStopOverrideVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}
