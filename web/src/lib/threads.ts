import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./omg-client";
import type { CodingAgentInfo } from "../App";
import { CodingAgentsContext } from "./session-ui";
import {
  THREAD_CHAT_AGENT_KEYS,
  type ThreadDetail,
  type ThreadMessage,
  type ThreadSelection,
  type ThreadSelectionOption,
  type ThreadSummary,
} from "../../../packages/protocol/src/threads";

/**
 * Threads on the web: people-first chat with no agent behind it. The machine
 * owns them (src/threads.ts); the card rules are shared with iOS in
 * packages/protocol/src/threads.ts.
 */

export type { ThreadDetail, ThreadMessage, ThreadSelection, ThreadSelectionOption, ThreadSummary };

const json = { "Content-Type": "application/json" };

/**
 * Who is writing. A hosted Computer stamps the viewer on every request; a
 * self-hosted box learns it from the profile picked in this browser, the same
 * `user` the bot and session lists send.
 */
function asUser(user?: string | null): string {
  return user ? `?user=${encodeURIComponent(user)}` : "";
}

export function listThreads(): Promise<ThreadSummary[]> {
  return api<{ threads?: ThreadSummary[] }>("/api/threads").then((res) => res.threads ?? []);
}

/** A file already uploaded to the machine (POST /api/uploads), to go with a message. */
export type ThreadAttachment = { path: string; name: string };

export function createThread(
  text: string,
  user?: string | null,
  attachments: ThreadAttachment[] = [],
  selection?: ThreadSelection | null,
): Promise<ThreadSummary> {
  return api<{ thread: ThreadSummary }>("/api/threads", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      text,
      ...(user ? { user } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(selection ? { selection } : {}),
    }),
  }).then((res) => res.thread);
}

export function getThread(id: string, user?: string | null): Promise<ThreadDetail> {
  return api<ThreadDetail>(`/api/threads/${encodeURIComponent(id)}${asUser(user)}`);
}

export function sendThreadMessage(
  id: string,
  text: string,
  user?: string | null,
  /** A top-level message id, to post in its replies. */
  replyTo?: string | null,
  attachments: ThreadAttachment[] = [],
): Promise<ThreadMessage> {
  return api<{ message: ThreadMessage }>(`/api/threads/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ text, ...(user ? { user } : {}), ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments } : {}) }),
  }).then((res) => res.message);
}

/** "I am typing" (or not). Fire and forget: a lost ping only delays a dot. */
export function sendThreadTyping(id: string, typing: boolean, user?: string | null, replyTo?: string | null): void {
  void api(`/api/threads/${encodeURIComponent(id)}/typing`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ typing, ...(user ? { user } : {}), ...(replyTo ? { replyTo } : {}) }),
  }).catch(() => {});
}

export function updateThread(
  id: string,
  patch: { projectCwd?: string | null; title?: string | null; archived?: boolean; selection?: ThreadSelection | null },
): Promise<ThreadSummary> {
  return api<{ thread: ThreadSummary }>(`/api/threads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify(patch),
  }).then((res) => res.thread);
}

/* -------------------------------------------------------------------------- */
/* The model a thread answers with                                             */
/* -------------------------------------------------------------------------- */

type CatalogModelItem = {
  key: string;
  label: string;
  defaultModel: string;
  models: string[];
  thinkingLevels: string[];
  thinkingLevelsByModel?: Record<string, string[]>;
};

/** Codex-family capability metadata as /api/coding-agents reports it. */
type CatalogCapabilities = Record<string, { reasoningEfforts?: string[]; cyberAccessPrograms?: string[] }>;

/** Codex-family keys whose per-model thinking levels come from live capability metadata. */
const CODEX_FAMILY_KEYS = new Set(["codex", "codex-aisdk"]);

/**
 * The agents a thread can answer with: connected, shown on this box, and
 * running through one of the thread reply adapters. Same rules as the server
 * (src/thread-model.ts), so what the picker offers is what answers. Cyber
 * access programs and fresh reasoning levels come from live metadata only.
 */
export function threadSelectionOptionsFrom(
  codingAgents: readonly CodingAgentInfo[] | undefined,
  models: readonly CatalogModelItem[] | null,
  codexCapabilities?: CatalogCapabilities | null,
): ThreadSelectionOption[] {
  if (!codingAgents || !models) return [];
  const connected = new Map<string, CodingAgentInfo>(codingAgents.map((agent) => [agent.key, agent]));
  const out: ThreadSelectionOption[] = [];
  for (const item of models) {
    if (!THREAD_CHAT_AGENT_KEYS.includes(item.key)) continue;
    const info = connected.get(item.key);
    if (!info || !info.visible || info.status.configured !== true) continue;
    if (!item.models?.length) continue;
    const levelsByModel = CODEX_FAMILY_KEYS.has(item.key) && codexCapabilities
      ? Object.fromEntries(item.models.flatMap((model) => {
          const efforts = codexCapabilities[model]?.reasoningEfforts;
          return efforts?.length ? [[model, [...efforts]]] : [];
        }))
      : {};
    const mergedLevels: Record<string, string[]> = {
      ...(item.thinkingLevelsByModel ?? {}),
      ...levelsByModel,
    };
    const programs = codexCapabilities
      ? Object.fromEntries(
          item.models.flatMap((model) => {
            const offered = codexCapabilities[model]?.cyberAccessPrograms ?? [];
            return offered.length ? [[model, [...offered]]] : [];
          }),
        )
      : {};
    out.push({
      key: item.key,
      label: info.label || item.label,
      models: item.models,
      defaultModel: item.defaultModel || item.models[0],
      thinkingLevels: item.thinkingLevels ?? [],
      ...(Object.keys(mergedLevels).length ? { thinkingLevelsByModel: mergedLevels } : {}),
      ...(Object.keys(programs).length ? { cyberAccessProgramsByModel: programs } : {}),
    });
  }
  return out;
}

/** The model catalog is fetched once per open app; the roster refreshes on its own. */
let cachedModels: { at: number; items: CatalogModelItem[] | null; capabilities: CatalogCapabilities | null } | null = null;

/** Test seam: pre-seed the catalog so a render never needs the machine. */
export function setThreadSelectionCatalogForTests(items: CatalogModelItem[] | null, capabilities: CatalogCapabilities | null = null): void {
  cachedModels = items ? { at: Number.MAX_SAFE_INTEGER, items, capabilities } : null;
}

export function useThreadSelectionOptions(): { options: ThreadSelectionOption[]; loading: boolean } {
  const [items, setItems] = useState<CatalogModelItem[] | null>(cachedModels?.items ?? null);
  const [capabilities, setCapabilities] = useState<CatalogCapabilities | null | undefined>(cachedModels?.capabilities ?? undefined);
  const [loading, setLoading] = useState(!cachedModels);
  useEffect(() => {
    if (cachedModels && Date.now() - cachedModels.at < 5 * 60_000) {
      setItems(cachedModels.items);
      setCapabilities(cachedModels.capabilities);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api<{ models?: CatalogModelItem[] | null; discovery?: { providers?: Record<string, { modelCapabilities?: CatalogCapabilities } | undefined> } | null }>("/api/coding-agents")
      .then((res) => {
        const caps = res.discovery?.providers?.["codex-aisdk"]?.modelCapabilities ?? null;
        cachedModels = { at: Date.now(), items: res.models ?? [], capabilities: caps };
        if (alive) {
          setItems(res.models ?? []);
          setCapabilities(caps);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const codingAgents = useContext(CodingAgentsContext);
  const options = useMemo(
    () => threadSelectionOptionsFrom(codingAgents, items, capabilities),
    [codingAgents, items, capabilities],
  );
  return { options, loading: loading || codingAgents === undefined };
}

/**
 * Poll while the tab is visible, and refresh at once when it comes back. The
 * same shape as the ask center's list, which is the other list this app keeps
 * without a socket.
 */
function usePolled<T>(load: () => Promise<T>, everyMs: number, onValue: (value: T) => void) {
  const latest = useRef({ load, onValue });
  latest.current = { load, onValue };
  const run = useCallback(async () => {
    try {
      latest.current.onValue(await latest.current.load());
    } catch {
      // A machine from before threads answers 404; keep what we have.
    }
  }, []);
  useEffect(() => {
    void run();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, everyMs);
    const wake = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [run, everyMs]);
  return run;
}

export function useThreads(): { threads: ThreadSummary[]; refresh: () => Promise<void>; archive: (id: string) => void } {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const refresh = usePolled(listThreads, 10_000, setThreads);
  const archive = useCallback(
    (id: string) => {
      setThreads((rows) => rows.filter((row) => row.id !== id));
      void updateThread(id, { archived: true }).catch(() => void refresh());
    },
    [refresh],
  );
  return { threads, refresh, archive };
}

export function useThread(
  id: string | null,
  user?: string | null,
): { detail: ThreadDetail | null; refresh: () => Promise<void> } {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  useEffect(() => setDetail(null), [id]);
  const load = useCallback(() => (id ? getThread(id, user) : Promise.resolve(null)), [id, user]);
  const refresh = usePolled(load, 3_000, (value) => {
    if (value) setDetail(value);
  });
  // A different thread loads at once, not on the next tick.
  useEffect(() => {
    void refresh();
  }, [load, refresh]);
  return { detail, refresh };
}
