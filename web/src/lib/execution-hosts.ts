import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./omg-client";

/**
 * Explicit execution hosts for new sessions. The server owns the real
 * mechanics (agentbox worker, Mac worker); the UI owns exactly one decision:
 * which host a new session is asked to run on. There is no "Auto" — every
 * launch carries an explicit host, and a host that cannot run is blocked,
 * never silently swapped for the other one.
 */
export type ExecutionHostId = "agentbox" | "mac";

export type ExecutionHostInfo = {
  id: ExecutionHostId;
  label: string;
  available: boolean;
  reason?: string;
};

export type ExecutionHostsPayload = {
  hosts: ExecutionHostInfo[];
  defaultHost: ExecutionHostId;
};

/** Fixed picker order; the contract has exactly these two hosts, no Auto. */
export const EXECUTION_HOST_ORDER: readonly ExecutionHostId[] = ["agentbox", "mac"];

export function isExecutionHostId(value: unknown): value is ExecutionHostId {
  return value === "agentbox" || value === "mac";
}

/**
 * The one label per host, owned by the UI. Servers have shipped "Mac",
 * "MacBook Pro" and nothing at all for the same machine; the picker, the
 * composer summary and the session chip must all name it identically, so the
 * server's label field is accepted in the contract but never displayed.
 */
export function executionHostLabel(host: ExecutionHostId | null | undefined): string {
  return host === "mac" ? "MacBook M1" : "Agentbox";
}

/** Mac's concrete status while an answer for the current agent is in flight. */
export const EXECUTION_HOSTS_LOADING: ExecutionHostsPayload = {
  hosts: [
    { id: "agentbox", label: "Agentbox", available: true },
    {
      id: "mac",
      label: "MacBook M1",
      available: false,
      reason: "Uitvoerstatus wordt geladen",
    },
  ],
  defaultHost: "agentbox",
};

/** Mac's concrete status when the endpoint cannot answer: only Agentbox runs. */
export const EXECUTION_HOSTS_UNAVAILABLE: ExecutionHostsPayload = {
  hosts: [
    { id: "agentbox", label: "Agentbox", available: true },
    {
      id: "mac",
      label: "MacBook M1",
      available: false,
      reason: "Uitvoerstatus kon niet worden geladen",
    },
  ],
  defaultHost: "agentbox",
};

function normalizeHostEntry(entry: unknown): ExecutionHostInfo | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as { id?: unknown; available?: unknown; reason?: unknown };
  if (!isExecutionHostId(record.id)) return null;
  return {
    id: record.id,
    label: executionHostLabel(record.id),
    available: record.available === true,
    reason: typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : undefined,
  };
}

/**
 * Validate GET /api/execution-hosts?agent=<kind>. Returns null for a shape
 * this UI cannot trust (no hosts array, or no Agentbox entry — without
 * Agentbox there is nothing launchable, which is an endpoint fault, not a
 * host state). A missing Mac entry is synthesized as unavailable rather than
 * rejected, so a minimal but honest answer still renders.
 */
export function parseExecutionHostsPayload(data: unknown): ExecutionHostsPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as { hosts?: unknown; defaultHost?: unknown };
  if (!Array.isArray(record.hosts)) return null;
  const hosts: ExecutionHostInfo[] = [];
  for (const entry of record.hosts) {
    const host = normalizeHostEntry(entry);
    if (host && !hosts.some((item) => item.id === host.id)) hosts.push(host);
  }
  const agentbox = hosts.find((host) => host.id === "agentbox");
  if (!agentbox) return null;
  if (!hosts.some((host) => host.id === "mac")) {
    hosts.push({
      id: "mac",
      label: executionHostLabel("mac"),
      available: false,
      reason: "Deze box rapporteert geen Mac-werker",
    });
  }
  hosts.sort((a, b) => EXECUTION_HOST_ORDER.indexOf(a.id) - EXECUTION_HOST_ORDER.indexOf(b.id));
  // The server default is parsed for contract honesty, but a new root
  // conversation always starts on Agentbox: the composer never adopts a
  // server-side Mac default, because where a session runs is a per-launch
  // decision the person makes explicitly.
  const defaultHost = isExecutionHostId(record.defaultHost) ? record.defaultHost : "agentbox";
  return { hosts, defaultHost };
}

/**
 * Load the host list for one agent kind. Any failure — transport error, non-
 * JSON body, unusable shape — resolves to the concrete "only Agentbox"
 * payload instead of throwing: the composer must never guess Mac available.
 */
export async function loadExecutionHosts(
  agent: string,
  request: (path: string) => Promise<unknown> = (path) => api(path),
): Promise<ExecutionHostsPayload> {
  try {
    const data = await request(`/api/execution-hosts?agent=${encodeURIComponent(agent)}`);
    return parseExecutionHostsPayload(data) ?? EXECUTION_HOSTS_UNAVAILABLE;
  } catch {
    return EXECUTION_HOSTS_UNAVAILABLE;
  }
}

/** The entry for one host id, synthesized as unavailable when absent. */
export function executionHostInfo(
  hosts: readonly ExecutionHostInfo[],
  id: ExecutionHostId,
): ExecutionHostInfo {
  return (
    hosts.find((host) => host.id === id) ?? {
      id,
      label: executionHostLabel(id),
      available: false,
      reason: "Uitvoerhost is niet bekend op deze box",
    }
  );
}

export type ExecutionHostLaunch = {
  /** The host that would run — always the selected one, never a substitute. */
  host: ExecutionHostId;
  /** True when that host cannot start; the launch must be blocked, not rerouted. */
  blocked: boolean;
  /** Why it is blocked, when the box said so. */
  reason?: string;
};

/**
 * The launch policy in one place: an explicit choice survives status changes.
 * A Mac that went unavailable keeps Mac selected (so it returns the moment
 * Mac is back) and reports blocked=true; the caller disables Start and shows
 * the reason. There is no fallback to Agentbox — that would be a silent host
 * switch on exactly the decision the person made explicitly.
 */
export function resolveExecutionHostLaunch(
  selected: ExecutionHostId,
  hosts: readonly ExecutionHostInfo[],
): ExecutionHostLaunch {
  const info = executionHostInfo(hosts, selected);
  return { host: selected, blocked: !info.available, reason: info.reason };
}

/** Picker rows for a host list: fixed order, unavailable hosts disabled with note. */
export function executionHostOptions(
  hosts: readonly ExecutionHostInfo[],
  selected: ExecutionHostId,
): { id: ExecutionHostId; label: string; selected: boolean; disabled: boolean; note?: string }[] {
  return EXECUTION_HOST_ORDER.map((id) => {
    const info = executionHostInfo(hosts, id);
    return {
      id,
      label: info.label,
      selected: id === selected,
      disabled: !info.available,
      note: info.available ? undefined : info.reason,
    };
  });
}

/**
 * Host availability for a composer. Fetched when the composer becomes
 * visible, when the agent changes, and through an explicit refresh — never
 * on a poll loop. While an answer for the current agent is in flight, and
 * whenever the loaded payload belongs to another agent, Mac is
 * conservatively blocked: availability carried over from the previous agent
 * must never look current for the new one, and a Mac that became available
 * again is picked up through the refresh, not a page reload.
 */
export function useExecutionHosts(
  agent: string,
  visible: boolean,
  request: (path: string) => Promise<unknown> = (path) => api(path),
): { hosts: ExecutionHostInfo[]; defaultHost: ExecutionHostId; loading: boolean; refresh: () => void } {
  const [payload, setPayload] = useState<ExecutionHostsPayload | null>(null);
  const [payloadAgent, setPayloadAgent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Every fetch takes a ticket; only the newest may write state. Effect
  // cleanup bumps the counter, so an answer that lands after an agent
  // switch (or a refresh that was started even later) is dropped instead of
  // overwriting the status of whichever agent is current now.
  const ticketRef = useRef(0);

  const runFetch = useCallback(() => {
    const forAgent = agentRef.current;
    const ticket = ++ticketRef.current;
    setLoading(true);
    loadExecutionHosts(forAgent, (path) => requestRef.current(path))
      .then((next) => {
        if (ticketRef.current !== ticket) return;
        setPayload(next);
        setPayloadAgent(forAgent);
      })
      .finally(() => {
        if (ticketRef.current === ticket) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!visible) return;
    runFetch();
    return () => {
      ticketRef.current += 1;
    };
  }, [agent, visible, runFetch]);

  /** Explicit, person-initiated status refresh for the CURRENT agent. */
  const refresh = useCallback(() => {
    if (visibleRef.current) runFetch();
  }, [runFetch]);

  // Trust only a payload fetched for THIS agent while nothing newer is in
  // flight; every other render gets the conservative loading view, where
  // Agentbox stays launchable and Mac is blocked with a concrete reason.
  const current = !loading && payloadAgent === agent && payload ? payload : EXECUTION_HOSTS_LOADING;
  return { hosts: current.hosts, defaultHost: current.defaultHost, loading, refresh };
}
