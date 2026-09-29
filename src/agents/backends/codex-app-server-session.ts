// Persistent Codex app-server session bridge for the "codex-aisdk" harness.
//
// The official @openai/codex-sdk cannot request a cyber access program: the
// vendored Thread surface has no such field, and no supported CLI config key
// selects one either. The ONLY supported wire is the experimental app-server
// JSON-RPC surface (`turn/start` with `cyberAccessProgram`, which requires
// `capabilities.experimentalApi` on initialize) — see ../../codex-daybreak.ts.
//
// This module exposes a Thread-shaped adapter over that surface so the
// harness in ./codex-aisdk-session.ts can drive an explicit-program turn with
// the SAME event loop it already uses for SDK threads:
//
//   adapter.id                          → SDK Thread.id (null until started)
//   adapter.runStreamed(input,{signal}) → { events } of SDK-shaped events
//   adapter.close()                     → stop OUR child, bounded grace
//
// One adapter instance owns exactly ONE app-server child and ONE turn. The
// PERSISTENT thing is the thread: `thread/start` (never `ephemeral`) or
// `thread/resume` keeps history in ~/.codex/sessions, the adapter records
// the thread id in the `id` getter, and the next turn opens a fresh adapter
// that resumes the SAME id. The harness disposes each per-turn child in a
// finally so no idle app-server child sits in memory between turns.
//
// Protocol shapes below were generated from codex-cli 0.159.0
// (`codex app-server generate-json-schema --experimental`); camelCase item
// kinds are the ThreadItem union of that schema. Nothing here performs
// inference in tests — the transport is injectable and every fixture is a
// recorded notification shape.
//
// Policy: the thread runs danger-full-access with approvalPolicy never, the
// same contract as the tmux codex session and the SDK harness thread options.
// The model runs its server tools itself; a correctly-configured turn never
// asks for approval. If the server still sends an approval or client-tool
// request, CodexAppServerClient answers it with a JSON-RPC error (preserving
// the never policy: an unexpected prompt is rejected, never wedged, and
// never blindly approved).

import {
  CodexAppServerClient,
  CodexDaybreakError,
  initializeAppServer,
  redactCodexErrorText,
  spawnCodexAppServerTransport,
  type CodexAppServerTransport,
  type CyberAccessProgram,
} from "../../codex-daybreak.ts";
import type { Input, ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

/**
 * Thread config for `thread/start`/`thread/resume` — the live-validated
 * snake_case core-Config encoding (same form as TOOLLESS_THREAD_CONFIG), but
 * with the tools-enabled contract of the managed harness threads instead of
 * the Daybreak tool-less one. MCP servers and the service tier are NOT
 * touched here: they ride the trusted `--config` argv layer, so the bridge
 * inherits exactly the config a normal SDK turn would have.
 */
export const BRIDGE_THREAD_CONFIG: Record<string, unknown> = {
  sandbox_mode: "danger-full-access",
  approval_policy: "never",
};

export type CodexAppServerThreadOptions = {
  /** Explicit model id; sent on thread start/resume and on every turn. */
  model: string;
  /** Working directory for the thread (the harness cwd). */
  cwd?: string;
  /** Optional reasoning effort override for the turn. */
  effort?: string;
  /**
   * Explicit cyber access program, already validated by the caller through
   * resolveCyberAccessProgram BEFORE anything spawns. Omitted on the wire
   * when absent — omission preserves automatic behavior, which is the only
   * honest representation of "no explicit request".
   */
  cyberAccessProgram?: CyberAccessProgram;
  /** Existing thread id to resume; absent starts a new persistent thread. */
  resumeThreadId?: string | null;
  /**
   * Display-only Daybreak choice persisted onto the thread via
   * thread/metadata/update. Best effort: a failure here never fails a turn.
   */
  daybreakEnabled?: boolean;
  /**
   * Trusted app-server argv (codexAppServerTrustedArgv output). Required for
   * real children; tests inject a transport instead.
   */
  argv?: string[];
  /** Injectable transport so tests never spawn a process. */
  transport?: CodexAppServerTransport | (() => CodexAppServerTransport | Promise<CodexAppServerTransport>);
  /** Per-request RPC timeout (initialize, thread/start, turn/start). */
  requestTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Mapping: app-server camelCase items → codex-sdk snake_case items
// ---------------------------------------------------------------------------

type RawItem = Record<string, unknown>;

function statusToSnake(raw: unknown, fallback: string): "in_progress" | "completed" | "failed" | string {
  switch (raw) {
    case "inProgress":
      return "in_progress";
    case "failed":
    case "declined":
      return "failed";
    case "completed":
      return "completed";
    default:
      return fallback;
  }
}

/**
 * Map one app-server ThreadItem (camelCase, 0.159 schema) onto the vendored
 * SDK's ThreadItem union (snake_case). Kinds with no SDK counterpart
 * (userMessage, plan, dynamicToolCall, collab, imageView, sleep, …) return
 * null and are dropped from the event stream — the SDK harness has no bucket
 * for them and inventing one would change transcript shapes. Unknown future
 * kinds drop the same way instead of corrupting a known shape.
 */
export function mapAppServerItem(item: RawItem | null | undefined): ThreadItem | null {
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" && item.id ? item.id : `item_${crypto.randomUUID()}`;
  switch (item.type) {
    case "agentMessage":
      return typeof item.text === "string" && item.text.trim()
        ? { id, type: "agent_message", text: item.text }
        : null;
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? (item.summary as unknown[]).filter((s): s is string => typeof s === "string") : [];
      const content = Array.isArray(item.content) ? (item.content as unknown[]).filter((s): s is string => typeof s === "string") : [];
      const text = summary.join("\n\n") || content.join("");
      return text ? { id, type: "reasoning", text } : null;
    }
    case "commandExecution":
      return {
        id,
        type: "command_execution",
        command: typeof item.command === "string" ? item.command : "",
        aggregated_output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
        ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}),
        status: statusToSnake(item.status, "completed") as "in_progress" | "completed" | "failed",
      };
    case "fileChange": {
      const rawChanges = Array.isArray(item.changes) ? (item.changes as unknown[]) : [];
      const changes: Array<{ path: string; kind: "add" | "delete" | "update" }> = [];
      for (const raw of rawChanges) {
        const change = raw as { path?: unknown; kind?: { type?: unknown } | string } | null;
        if (!change || typeof change !== "object" || typeof change.path !== "string") continue;
        const kind =
          typeof change.kind === "string"
            ? change.kind
            : typeof (change.kind as { type?: unknown } | undefined)?.type === "string"
              ? (change.kind as { type: string }).type
              : "update";
        if (kind !== "add" && kind !== "delete" && kind !== "update") continue;
        changes.push({ path: change.path, kind });
      }
      const status = statusToSnake(item.status, "completed");
      // The SDK has no in-progress file change: only terminal states map.
      if (status !== "completed" && status !== "failed") return null;
      return { id, type: "file_change", changes, status };
    }
    case "mcpToolCall": {
      const result = item.result as { content?: unknown; structuredContent?: unknown } | null | undefined;
      const error = item.error as { message?: unknown } | null | undefined;
      return {
        id,
        type: "mcp_tool_call",
        server: typeof item.server === "string" ? item.server : "",
        tool: typeof item.tool === "string" ? item.tool : "",
        arguments: item.arguments ?? null,
        ...(result && typeof result === "object"
          ? {
              result: {
                content: (Array.isArray(result.content) ? result.content : []) as never,
                structured_content: result.structuredContent ?? null,
              },
            }
          : {}),
        ...(error && typeof error.message === "string" ? { error: { message: redactCodexErrorText(error.message) } } : {}),
        status: statusToSnake(item.status, "completed") as "in_progress" | "completed" | "failed",
      };
    }
    case "webSearch":
      return {
        id,
        type: "web_search",
        query: typeof item.query === "string" ? item.query : "",
        ...(Array.isArray(item.results) ? { results: item.results } : {}),
      };
    case "error":
      // v2 has no error ThreadItem, but older servers emitted one; keep the
      // mapping so an upstream failure still reaches the transcript.
      return { id, type: "error", message: redactCodexErrorText(item.message) };
    default:
      return null;
  }
}

/**
 * Map the SDK Input union onto app-server UserInput parts. Text maps 1:1;
 * SDK `local_image` is the protocol's `localImage`. Anything else collapses
 * to a text part so the turn never starts from a shape the wire rejects.
 */
export function toAppServerUserInput(input: Input): Array<Record<string, unknown>> {
  if (typeof input === "string") return [{ type: "text", text: input }];
  const parts: Array<Record<string, unknown>> = [];
  for (const part of input) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "local_image") parts.push({ type: "localImage", path: part.path });
    else parts.push({ type: "text", text: JSON.stringify(part) });
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
}

// ---------------------------------------------------------------------------
// Bounded event queue behind the SDK-shaped async iterator
// ---------------------------------------------------------------------------

class EventQueue {
  private pending: ThreadEvent[] = [];
  private waiters: Array<(result: IteratorResult<ThreadEvent>) => void> = [];
  private ended = false;
  private queuedChars = 0;
  constructor(private overflow: () => void) {}

  push(event: ThreadEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else {
      // Keep only the latest unsent draft for an item, without crossing its
      // terminal event. This prevents quadratic accumulated streaming text.
      if (event.type === "item.updated") {
        for (let i = this.pending.length - 1; i >= 0; i--) {
          const previous = this.pending[i]!;
          if (previous.type === "item.completed" && previous.item.id === event.item.id) break;
          if (previous.type === "item.updated" && previous.item.id === event.item.id) {
            this.queuedChars -= JSON.stringify(previous).length;
            this.pending.splice(i, 1);
            break;
          }
        }
      }
      const chars = JSON.stringify(event).length;
      if (this.pending.length >= 1024 || this.queuedChars + chars > 8 * 1024 * 1024) {
        this.pending = []; this.queuedChars = 0;
        this.overflow(); // emits one visible failure and closes our child
        return;
      }
      this.pending.push(event); this.queuedChars += chars;
    }
  }

  /** Terminal: no further events will ever be produced for this turn. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<ThreadEvent>> {
    const event = this.pending.shift();
    if (event) { this.queuedChars -= JSON.stringify(event).length; return Promise.resolve({ value: event, done: false }); }
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * The minimal stream shape the harness drives: anything the SDK's
 * StreamedTurn.events (an AsyncGenerator) satisfies, and anything our
 * custom iterator below satisfies — next/return without requiring
 * Symbol.asyncDispose.
 */
export type CodexBridgeEvents = {
  [Symbol.asyncIterator](): AsyncIterator<ThreadEvent, void, unknown>;
};

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class CodexAppServerThread {
  private readonly options: CodexAppServerThreadOptions;
  private client: CodexAppServerClient | null = null;
  private threadIdValue: string | null = null;
  private ranOnce = false;
  private closePromise: Promise<void> | null = null;
  /** Last reroute notice seen for OUR thread, exposed for honest labeling. */
  private rerouteValue: { fromModel: string; toModel: string } | null = null;

  constructor(options: CodexAppServerThreadOptions) {
    this.options = options;
  }

  /** The persistent thread id, once thread/start or thread/resume answered. */
  get id(): string | null {
    return this.threadIdValue ?? (this.options.resumeThreadId ?? null);
  }

  /** The model the server reported serving instead of the request, if any. */
  get lastReroute(): { fromModel: string; toModel: string } | null {
    return this.rerouteValue;
  }

  /**
   * Run exactly one turn. Calling twice rejects: open a new adapter that
   * resumes `id` instead — one child per turn is what keeps idle app-servers
   * out of memory while the thread history stays persistent.
   */
  async runStreamed(input: Input, turnOptions: { signal?: AbortSignal } = {}): Promise<{ events: CodexBridgeEvents }> {
    if (this.ranOnce) throw new Error("CodexAppServerThread runs exactly one turn; open a new adapter to resume the thread");
    this.ranOnce = true;
    const signal = turnOptions.signal;
    if (signal?.aborted) {
      // Abort before start: nothing spawned, nothing interrupted, and the
      // harness treats the aborted turn as a deliberate no-op.
      throw new AbortError("turn aborted before start");
    }

    const transport =
      typeof this.options.transport === "function"
        ? await this.options.transport()
        : this.options.transport ??
          (() => {
            // No default spawn here: spawnCodexAppServerTransport's own
            // default argv is the TOOL-LESS Daybreak one, which would
            // silently strip this session's tools. A real child needs the
            // caller's trusted argv.
            if (!this.options.argv) {
              throw new Error("CodexAppServerThread needs trusted argv (codexAppServerTrustedArgv) or an injected transport");
            }
            return spawnCodexAppServerTransport({ argv: this.options.argv, ...(this.options.cwd ? { cwd: this.options.cwd } : {}) });
          })();
    const client = new CodexAppServerClient(transport, {
      defaultTimeoutMs: this.options.requestTimeoutMs ?? 20_000,
    });
    this.client = client;

    const queue = new EventQueue(() => settle({ type: "error", message: "Codex streaming backlog exceeded its memory limit" }));
    let settled = false; // once true, every further notification is late and dropped
    let turnId: string | null = null;
    let lastUsage: Usage | null = null;
    // Deltas that arrive before item/completed build draft items keyed by id.
    const agentDrafts = new Map<string, string>();
    const reasoningDrafts = new Map<string, string>();
    const commandOutput = new Map<string, string>();
    const commandItems = new Map<string, Extract<ThreadItem, { type: "command_execution" }>>();
    let racedChars = 0;
    // Notifications that raced the turn/start RESPONSE wait here until the
    // turn id is adopted, then replay through the same scoping filter.
    const raced: Array<{ method: string; params: unknown }> = [];
    const unsubs: Array<() => void> = [];
    let aborting = false;

    const settle = (terminal?: ThreadEvent): void => {
      if (settled) return;
      settled = true;
      if (terminal) queue.push(terminal);
      queue.end();
      signal?.removeEventListener("abort", onAbort);
      for (const off of unsubs.splice(0)) off();
      // The turn is over, so the child is too — close even if the caller
      // forgets its finally. close() is idempotent and bounded.
      void this.close().catch(() => {});
    };

    const onAbort = (): void => {
      if (settled || aborting) return;
      aborting = true;
      // Interrupt OUR turn only, then stop OUR child. The interrupt request
      // is itself bounded; a child that cannot answer dies at close instead.
      if (turnId && this.threadIdValue) {
        void client.request("turn/interrupt", { threadId: this.threadIdValue, turnId }, 5_000).catch(() => {});
      }
      settle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    client.onClosed(() => {
      if (settled || aborting) return;
      // Child died mid-turn: fail the turn now, visibly, instead of hanging.
      settle({ type: "error", message: "Codex app-server closed during the turn" });
    });

    const scoped = (params: unknown): "ours" | "foreign" | "unknown-turn" => {
      const row = (params ?? {}) as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
      // These subscribed notifications are per-thread; missing ids cannot
      // complete or contaminate this turn. Completion carries nested turn.id.
      if (typeof row.threadId !== "string") return "foreign";
      if (this.threadIdValue && row.threadId !== this.threadIdValue) return "foreign";
      const notifiedTurn = row.turnId ?? row.turn?.id;
      if (typeof notifiedTurn === "string" && turnId && notifiedTurn !== turnId) return "foreign";
      if (typeof notifiedTurn === "string" && !turnId) return "unknown-turn";
      return "ours";
    };

    const draftChars = () => {
      let total = 0;
      for (const value of agentDrafts.values()) total += value.length;
      for (const value of reasoningDrafts.values()) total += value.length;
      return total;
    };
    const dispatch = (method: string, params: unknown): void => {
      if (settled || aborting) return;
      switch (method) {
        case "item/started":
        case "item/completed":
        case "item/updated": {
          const row = (params ?? {}) as { item?: unknown };
          const mapped = mapAppServerItem(row.item as RawItem);
          if (!mapped) return;
          if (mapped.type === "command_execution" && commandOutput.has(mapped.id) && !mapped.aggregated_output) {
            // Fold streamed command output into a completed item whose own
            // aggregate is empty or absent.
            mapped.aggregated_output = commandOutput.get(mapped.id) ?? "";
          }
          if (mapped.type === "command_execution") {
            if (!commandItems.has(mapped.id) && commandItems.size >= 256) {
              settle({ type: "error", message: "Codex concurrent commands exceeded their memory limit" }); return;
            }
            commandItems.set(mapped.id, { ...mapped, aggregated_output: "" });
          }
          if (method === "item/completed") {
            agentDrafts.delete(mapped.id); reasoningDrafts.delete(mapped.id);
            commandOutput.delete(mapped.id); commandItems.delete(mapped.id);
          }
          queue.push({
            type: method === "item/completed" ? "item.completed" : method === "item/started" ? "item.started" : "item.updated",
            item: mapped,
          });
          return;
        }
        case "item/agentMessage/delta": {
          const row = (params ?? {}) as { itemId?: unknown; delta?: unknown };
          if (typeof row.itemId !== "string" || typeof row.delta !== "string") return;
          const text = (agentDrafts.get(row.itemId) ?? "") + row.delta;
          if (text.length > 4 * 1024 * 1024 || draftChars() + row.delta.length > 8 * 1024 * 1024 || agentDrafts.size + reasoningDrafts.size >= 256) {
            settle({ type: "error", message: "Codex draft exceeded its memory limit" }); return;
          }
          agentDrafts.set(row.itemId, text);
          queue.push({ type: "item.updated", item: { id: row.itemId, type: "agent_message", text } });
          return;
        }
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          const row = (params ?? {}) as { itemId?: unknown; delta?: unknown };
          if (typeof row.itemId !== "string" || typeof row.delta !== "string") return;
          const text = (reasoningDrafts.get(row.itemId) ?? "") + row.delta;
          if (text.length > 4 * 1024 * 1024 || draftChars() + row.delta.length > 8 * 1024 * 1024 || agentDrafts.size + reasoningDrafts.size >= 256) {
            settle({ type: "error", message: "Codex reasoning draft exceeded its memory limit" }); return;
          }
          reasoningDrafts.set(row.itemId, text);
          queue.push({ type: "item.updated", item: { id: row.itemId, type: "reasoning", text } });
          return;
        }
        case "item/commandExecution/outputDelta": {
          const row = (params ?? {}) as { itemId?: unknown; delta?: unknown };
          if (typeof row.itemId !== "string" || typeof row.delta !== "string") return;
          if (!commandOutput.has(row.itemId) && commandOutput.size >= 256) {
            settle({ type: "error", message: "Codex command stream exceeded its memory limit" }); return;
          }
          const combined = (commandOutput.get(row.itemId) ?? "") + row.delta;
          const output = combined.length > 64 * 1024 ? "[earlier output truncated]\n" + combined.slice(-64 * 1024) : combined;
          commandOutput.set(row.itemId, output);
          // Output is activity even before command completion: the harness
          // watchdog must not interrupt a healthy command still streaming.
          const previous = commandItems.get(row.itemId);
          queue.push({ type: "item.updated", item: { id: row.itemId, type: "command_execution", command: previous?.command ?? "", status: "in_progress", aggregated_output: output } });
          return;
        }
        case "error": {
          const row = (params ?? {}) as { error?: { message?: unknown }; willRetry?: unknown };
          // A retriable upstream error is transient: the turn continues and
          // the completed turn status stays authoritative. Only a final
          // error is fatal for the stream.
          if (row.willRetry === true) return;
          settle({ type: "error", message: redactCodexErrorText(row.error?.message) });
          return;
        }
        case "model/rerouted": {
          const row = (params ?? {}) as { fromModel?: unknown; toModel?: unknown };
          if (typeof row.fromModel === "string" && typeof row.toModel === "string") {
            this.rerouteValue = { fromModel: row.fromModel, toModel: row.toModel };
          }
          return;
        }
        case "thread/tokenUsage/updated": {
          const usage = (params as { tokenUsage?: { last?: Record<string, unknown> } } | null)?.tokenUsage?.last;
          if (usage && typeof usage === "object") {
            const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
            lastUsage = {
              input_tokens: num(usage.inputTokens),
              cached_input_tokens: num(usage.cachedInputTokens),
              cache_write_input_tokens: num(usage.cacheWriteInputTokens),
              output_tokens: num(usage.outputTokens),
              reasoning_output_tokens: num(usage.reasoningOutputTokens),
            };
          }
          return;
        }
        case "turn/completed": {
          const turn = (params as { turn?: { id?: unknown; status?: unknown; error?: { message?: unknown } } } | null)?.turn;
          const status = turn?.status;
          // Only "completed" is terminal success. A completion that arrives
          // after we settled never reaches here (settled guard above), and a
          // non-terminal status (inProgress, unknown) is ignored rather than
          // misread as success.
          if (status === "completed") {
            settle({ type: "turn.completed", usage: lastUsage ?? ZERO_USAGE });
          } else if (status === "failed") {
            settle({ type: "turn.failed", error: { message: redactCodexErrorText(turn?.error?.message) } });
          } else if (status === "interrupted") {
            settle(aborting ? undefined : { type: "turn.failed", error: { message: "turn interrupted" } });
          }
          return;
        }
        default:
          return;
      }
    };

    const onNotify = (method: string) => (params: unknown): void => {
      if (settled || aborting) return;
      const scope = scoped(params);
      if (scope === "foreign") return;
      if (scope === "unknown-turn") {
        const chars = JSON.stringify(params).length;
        if (raced.length >= 1024 || racedChars + chars > 8 * 1024 * 1024) {
          settle({ type: "error", message: "Codex start notifications exceeded their memory limit" }); return;
        }
        racedChars += chars; raced.push({ method, params });
        return;
      }
      dispatch(method, params);
    };
    for (const method of [
      "item/started",
      "item/completed",
      "item/updated",
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
      "item/commandExecution/outputDelta",
      "error",
      "model/rerouted",
      "thread/tokenUsage/updated",
      "turn/completed",
    ]) {
      unsubs.push(client.onNotification(method, onNotify(method)));
    }

    const iterator: AsyncIterator<ThreadEvent, void, unknown> & {
      [Symbol.asyncIterator](): AsyncIterator<ThreadEvent, void, unknown>;
    } = {
      next: () => queue.next(),
      // Consumer went away (stall gate, interrupt, break): stop our child too.
      return: async (): Promise<IteratorResult<ThreadEvent, void>> => {
        settle();
        return { value: undefined, done: true };
      },
      throw: async (error: unknown): Promise<IteratorResult<ThreadEvent, void>> => {
        settle();
        throw error;
      },
      [Symbol.asyncIterator](): AsyncIterator<ThreadEvent, void, unknown> {
        return iterator;
      },
    };

    const checkAborted = () => {
      if (signal?.aborted || aborting || settled) throw new AbortError("turn aborted during setup");
    };
    try {
      checkAborted();
      await initializeAppServer(client);
      checkAborted();

      if (this.options.resumeThreadId) {
        const resumed = (await client.request(
          "thread/resume",
          {
            threadId: this.options.resumeThreadId,
            ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
            model: this.options.model,
            config: BRIDGE_THREAD_CONFIG,
          },
          this.options.requestTimeoutMs,
        )) as { thread?: { id?: unknown } };
        checkAborted();
        const id = typeof resumed.thread?.id === "string" ? resumed.thread.id : "";
        if (!id) throw new CodexDaybreakError("protocol", "thread/resume returned no thread id");
        this.threadIdValue = id;
      } else {
        const started = (await client.request(
          "thread/start",
          {
            ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
            model: this.options.model,
            config: BRIDGE_THREAD_CONFIG,
          },
          this.options.requestTimeoutMs,
        )) as { thread?: { id?: unknown } };
        checkAborted();
        const id = typeof started.thread?.id === "string" ? started.thread.id : "";
        if (!id) throw new CodexDaybreakError("protocol", "thread/start returned no thread id");
        this.threadIdValue = id;
      }
      if (this.options.daybreakEnabled !== undefined) {
        // Display-only persisted choice; never gate the turn on its answer.
        void client
          .request("thread/metadata/update", { threadId: this.threadIdValue, daybreakEnabled: this.options.daybreakEnabled }, 5_000)
          .catch(() => {});
      }
      queue.push({ type: "thread.started", thread_id: this.threadIdValue });

      checkAborted();
      const turnResponse = (await client.request(
        "turn/start",
        {
          threadId: this.threadIdValue,
          input: toAppServerUserInput(input),
          model: this.options.model,
          ...(this.options.effort ? { effort: this.options.effort } : {}),
          ...(this.options.cyberAccessProgram ? { cyberAccessProgram: this.options.cyberAccessProgram } : {}),
        },
        this.options.requestTimeoutMs,
      )) as { turn?: { id?: unknown; status?: unknown } };
      const id = typeof turnResponse.turn?.id === "string" ? turnResponse.turn.id : "";
      if (!id) throw new CodexDaybreakError("protocol", "turn/start returned no turn id");
      if (turnResponse.turn?.status === "failed") {
        throw new CodexDaybreakError("turn-failed", "turn failed at start");
      }
      turnId = id;
      if (signal?.aborted || aborting) {
        await client.request("turn/interrupt", { threadId: this.threadIdValue, turnId }, 5_000).catch(() => {});
        throw new AbortError("turn aborted while starting");
      }
      queue.push({ type: "turn.started" });
      // Adopt the turn id, then replay anything that raced the response in
      // arrival order through the same scoping filter.
      for (const racedEvent of raced.splice(0)) {
        if (settled || aborting) break;
        if (scoped(racedEvent.params) !== "foreign") dispatch(racedEvent.method, racedEvent.params);
      }
      racedChars = 0;
    } catch (error) {
      settle(
        error instanceof AbortError
          ? undefined
          : { type: "error", message: redactCodexErrorText(error instanceof Error ? error.message : String(error)) },
      );
      await this.close();
      return { events: iterator };
    }

    // The turn now runs on notifications; the queue settles via
    // turn/completed, abort, child death, or consumer return.
    return { events: iterator };
  }

  /** Stop this adapter's child with bounded grace. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.client?.close();
    })();
    return this.closePromise;
  }
}
