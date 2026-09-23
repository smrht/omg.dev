// Long-lived Meta Muse Code session through `muse serve`, the CLI's MSP
// (Muse Session Protocol) host: JSON-RPC 2.0 over newline-delimited JSON on
// stdio. Muse ships no ACP surface and no SDK; MSP is the only structured,
// supported way to drive it, and it reuses the `muse login` / META_API_KEY
// credential the CLI already holds.
//
// Handshake: `initialize` -> `initialized` -> `session/start` (or
// `session/resume` for recovery; sessions are durable on disk under
// ~/.local/share/muse/sessions). A turn is `turn/start`; the reply streams as
// `item/started` / `item/delta` / `item/completed` view notifications and ends
// with `turn/completed`. Approval and user-input prompts arrive as
// `approval/requested` / `userInput/requested` and are answered with
// `approval/decide` / `userInput/answer`. Recorded against muse 1.0.2.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractAttachments, isImageMime, readAsBase64 } from "../../attachment-images.ts";
import { museChildEnv } from "../../muse-proxy.ts";
import { runManagedSdkSession, type ManagedSdkEventSink } from "./managed-sdk-session.ts";

function arg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

// The published installer drops a launcher in ~/.local/bin/muse that keeps the
// real binary next to it (muse-bin-<version>). Always go through the launcher.
export function musePath(): string {
  const override = process.env.LFG_MUSE_PATH?.trim();
  if (override) return override;
  return Bun.which("muse") || join(homedir(), ".local", "bin", "muse");
}

/**
 * Sandbox posture is fixed for the host's lifetime and is not negotiable over
 * the wire. omg sessions run as the box user with full workspace access, the
 * same footing deepseek (danger-full-access) and fx (`code` mode) get, so the
 * OS sandbox is off; `--trust-workspace` loads the workspace's skills and
 * rules the way the TUI does after its trust prompt.
 */
/**
 * omg → muse session id bridge. muse 1.0.2 strips the environment of the MCP
 * servers it spawns (only HOME/PATH/PWD/… survive) and does not interpolate
 * settings.json `env` values, so the omg session id cannot reach the omg MCP
 * server by inheritance or by a `${VAR}` placeholder. The one thing the MCP
 * child keeps is its working directory (= the session workspace), so the
 * harness records `sha256(realpath(cwd)) → sessionId` here and the guard
 * wrapper looks it up by its own cwd. A workspace with no record is a
 * standalone muse (no omg session), and the guard skips the server entirely.
 */
export function museSessionMapDir(): string {
  return join(homedir(), ".cache", "omg-muse-sessions");
}

export function museSessionMapKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 32);
}

function recordMuseSession(cwd: string, sessionId: string): void {
  try {
    const dir = museSessionMapDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, museSessionMapKey(cwd)), sessionId, { mode: 0o600 });
  } catch {
    // A missing map only means the omg MCP servers stay off for this session.
  }
}

export function museServeArgv(): string[] {
  return ["serve", "--disable-sandbox", "--trust-workspace"];
}

export const MUSE_APPROVAL_MODES = ["allowAll", "promptUnmatched", "onRequest", "denyUnmatched"] as const;
export type MuseApprovalMode = (typeof MUSE_APPROVAL_MODES)[number];

/**
 * Approval mode is selected on the wire at `session/start` (select, never
 * create). `allowAll` matches how the other managed agents launch; a stricter
 * mode still works because approval requests are routed to the dashboard
 * prompt below.
 */
export function museApprovalMode(env: NodeJS.ProcessEnv = process.env): MuseApprovalMode {
  const raw = env.LFG_MUSE_APPROVAL_MODE?.trim() as MuseApprovalMode | undefined;
  return raw && MUSE_APPROVAL_MODES.includes(raw) ? raw : "allowAll";
}

/**
 * Muse asks for approval on every MCP tool call regardless of approval mode:
 * `allowAll` covers its own built-in tools, but an `mcp__*` call still raises
 * `approval/requested` with subject kind `tool_action` (measured 2026-09-04,
 * muse 1.0.3, session log `effective_mode: allow_all`). The choices are
 * once/session-scoped only, so a human answer never survives the next session
 * and every fresh Muse session prompted again on its first computer or omg
 * tool. Under `allowAll` omg answers those itself with the widest approving
 * choice; a stricter mode still routes to the dashboard prompt.
 */
export function museAutoApprovalChoice<T extends { choiceId: string; decision?: string }>(
  choices: T[],
  mode: MuseApprovalMode = museApprovalMode(),
): T | undefined {
  if (mode !== "allowAll") return undefined;
  return choices.find((c) => c.decision === "approvedForSession") ?? choices.find((c) => c.decision === "approved");
}

/**
 * Provider routing for `session/start`. Left implicit, MSP resolves a bare
 * `modelId` to provider `muse`, and that route cannot replay media it retained
 * from an earlier model call: the first call with an uploaded image succeeds,
 * the second one after a tool result fails with "retained media history is
 * unsupported by target provider `muse`" (measured 2026-09-03, muse 1.0.2).
 * The CLI's own default route is `meta`, which handles it; name it explicitly.
 * LFG_MUSE_PROVIDER is the test hook (`echo` answers without a login).
 */
export function museProviderId(env: NodeJS.ProcessEnv = process.env): string {
  return env.LFG_MUSE_PROVIDER?.trim() || "meta";
}

/** The `session/start` params for a fresh omg session. Exposed for tests. */
export function museSessionStartParams(
  cwd: string,
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    commandId: uuidv7(),
    workspaceRoot: cwd,
    approvalMode: museApprovalMode(env),
    providerId: museProviderId(env),
  };
  // "auto" is omg's cross-agent placeholder for the provider default.
  if (model && model !== "auto") params.modelId = model;
  return params;
}

/** The `session/setApprovalMode` params that re-apply the configured mode. Exposed for tests. */
export function museSetApprovalModeParams(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    commandId: uuidv7(),
    sessionId,
    mode: museApprovalMode(env),
  };
}

export const MUSE_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra"] as const;

/** Map omg's thinking vocabulary onto Muse's `reasoningEffort`; unknown = server default. */
export function museReasoningEffort(level?: string | null): string | undefined {
  const value = level?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "max") return "ultra";
  if (value === "off") return "none";
  return (MUSE_REASONING_EFFORTS as readonly string[]).includes(value) ? value : undefined;
}

/** MSP command ids are UUIDv7 (time-ordered); the turn id derives from it. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type MspItem = {
  itemId: string;
  kind: string;
  status?: string;
  text?: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  failureReason?: string;
  summary?: string[];
};

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

/**
 * Minimal MSP client over a child's stdio. Exposed for tests: `attach` takes
 * any writer/reader pair so the framing and dispatch can run without a muse
 * binary.
 */
export class MspClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, (params: any) => void>();
  private closed: Error | null = null;

  constructor(private readonly write: (line: string) => void) {}

  onNotification(method: string, handler: (params: any) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.method) {
      if (message.id != null) {
        // A server-initiated request (re-issued approval/userInput prompts
        // after a resume). Acknowledge the envelope; the decision itself
        // travels as its own command, same as for the notification form.
        this.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
      const handler = this.notificationHandlers.get(message.method.replace(/\/request$/, "/requested"));
      if (handler) {
        try {
          handler(message.params);
        } catch {}
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const detail = message.error.data && typeof message.error.data === "object" && "kind" in message.error.data
        ? ` (${String((message.error.data as { kind?: unknown }).kind)})`
        : "";
      pending.reject(new Error(`muse ${pending.method}: ${message.error.message ?? "error"}${detail}`));
      return;
    }
    pending.resolve(message.result);
  }

  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    this.write(JSON.stringify(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method }));
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = new Error(reason);
    for (const pending of this.pending.values()) pending.reject(this.closed);
    this.pending.clear();
  }
}

export type MuseTurnState = {
  draft: string;
  thought: string;
  /** agentMessage draft length when the open item started, so a completed item can replace its own streamed text. */
  draftBase: number;
  items: Map<string, MspItem>;
  toolOutput: Map<string, string>;
  reasoning: Map<string, string[]>;
};

export function newMuseTurnState(): MuseTurnState {
  return { draft: "", thought: "", draftBase: 0, items: new Map(), toolOutput: new Map(), reasoning: new Map() };
}

function flushDraft(sink: ManagedSdkEventSink, state: MuseTurnState): void {
  const body = state.draft;
  if (!body.trim()) {
    state.draft = "";
    state.draftBase = 0;
    return;
  }
  state.draft = "";
  state.draftBase = 0;
  sink.commitText(body);
  sink.draft("");
}

/** Fold one view notification into the sink. Exposed for tests. */
export function applyMuseViewEvent(
  method: string,
  params: any,
  sink: ManagedSdkEventSink,
  state: MuseTurnState,
): void {
  const item = params?.item as MspItem | undefined;
  switch (method) {
    case "item/started": {
      if (!item) return;
      state.items.set(item.itemId, item);
      if (item.kind === "agentMessage") {
        state.draftBase = state.draft.length;
        if (item.text) {
          state.draft += item.text;
          sink.draft(state.draft);
        }
      } else if (item.kind === "toolCall") {
        // Muse narrates between tools; commit each segment before the tool so
        // the transcript keeps message boundaries.
        flushDraft(sink, state);
        sink.toolStart(item.itemId, item.tool ?? "tool", parseArgs(item.args));
      } else if (item.kind === "reasoning") {
        state.reasoning.set(item.itemId, [...(item.summary ?? [])]);
      }
      return;
    }
    case "item/delta": {
      const itemId = String(params?.itemId ?? "");
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const field = typeof params?.field === "string" ? params.field : "text";
      if (!itemId || !delta) return;
      const open = state.items.get(itemId);
      const kind = open?.kind ?? (field.startsWith("summary") ? "reasoning" : field === "visibleOutput" ? "toolCall" : "agentMessage");
      if (kind === "agentMessage" && field === "text") {
        if (!open) state.items.set(itemId, { itemId, kind: "agentMessage" });
        state.draft += delta;
        sink.draft(state.draft);
      } else if (kind === "reasoning") {
        const parts = state.reasoning.get(itemId) ?? [];
        const part = Number(field.split(".")[1] ?? 0) || 0;
        parts[part] = (parts[part] ?? "") + delta;
        state.reasoning.set(itemId, parts);
        state.thought = reasoningText(state);
        sink.thinking(state.thought);
      } else if (kind === "toolCall" && field === "visibleOutput") {
        state.toolOutput.set(itemId, (state.toolOutput.get(itemId) ?? "") + delta);
      }
      return;
    }
    case "item/updated":
    case "item/completed": {
      if (!item) return;
      const open = state.items.get(item.itemId);
      if (!open && method === "item/updated") return;
      if (item.kind === "agentMessage") {
        if (!open) state.draftBase = state.draft.length;
        state.items.set(item.itemId, item);
        if (typeof item.text === "string") {
          // The completed object is authoritative; deltas may have saturated.
          state.draft = state.draft.slice(0, state.draftBase) + item.text;
          sink.draft(state.draft);
        }
        if (method === "item/completed") state.draftBase = state.draft.length;
      } else if (item.kind === "toolCall") {
        if (!open) {
          state.items.set(item.itemId, item);
          flushDraft(sink, state);
          sink.toolStart(item.itemId, item.tool ?? "tool", parseArgs(item.args));
        }
        if (method !== "item/completed") return;
        const output = item.visibleOutput ?? state.toolOutput.get(item.itemId) ?? item.failureReason ?? "";
        const failed = item.status != null && item.status !== "completed";
        sink.toolEnd(item.itemId, item.tool ?? "tool", output, failed);
        state.toolOutput.delete(item.itemId);
      } else if (item.kind === "reasoning") {
        state.items.set(item.itemId, item);
        if (item.summary?.length) state.reasoning.set(item.itemId, [...item.summary]);
        state.thought = reasoningText(state);
        if (state.thought) sink.thinking(state.thought);
      }
      return;
    }
    default:
      return;
  }
}

function reasoningText(state: MuseTurnState): string {
  const parts: string[] = [];
  for (const summary of state.reasoning.values()) {
    const text = summary.filter(Boolean).join("\n").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function parseArgs(raw?: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The composer delivers uploads as a trailing "Attached file(s):" block of
 * local paths. MSP takes images natively (`{type:"image", base64Data,
 * mediaType}`), so those become parts and the block leaves the text; anything
 * else (PDFs, unknown types) stays as the path line for the agent to read.
 */
export function museTurnInput(prompt: string): Array<Record<string, unknown>> {
  const extracted = extractAttachments(prompt);
  const images = extracted.attachments.filter((att) => isImageMime(att.mime));
  if (!images.length) return [{ type: "text", text: prompt }];
  const parts: Array<Record<string, unknown>> = [];
  for (const att of images) {
    const data = readAsBase64(att.path);
    if (data) parts.push({ type: "image", mediaType: att.mime, base64Data: data });
  }
  if (!parts.length) return [{ type: "text", text: prompt }];
  const rest = extracted.attachments.filter((att) => !isImageMime(att.mime));
  const text = rest.length
    ? `${extracted.cleanText}\n\nAttached files:\n${rest.map((att) => `- ${att.filename}: ${att.path}`).join("\n")}`
    : extracted.cleanText || "(image attachment)";
  return [{ type: "text", text }, ...parts];
}

/**
 * Stall watchdog for the muse serve view stream.
 *
 * Measured 2026-09-04 (muse 1.0.3, five sessions in one evening): muse's
 * per-session view projection flips to `unavailable` mid-turn — the run keeps
 * going in muse's own journal (model calls, tool calls, approval waits) but
 * the serve stops emitting `item/*`, `approval/requested` and `turn/completed`
 * to this harness. The dashboard showed a permanent busy spinner, a pending
 * shell approval nobody could see, and a stop button that cancelled the turn
 * inside muse yet never released the harness because no `turn/completed`
 * followed. Two bounds fix that: an open turn with no bytes from the serve for
 * MUSE_STREAM_STALL_MS, or no `turn/completed` within MUSE_INTERRUPT_GRACE_MS
 * of an interrupt, drops the serve; the next turn boots a fresh one and
 * resumes the durable session. A pending dashboard prompt is legitimate
 * silence (muse waits for the human) and never counts.
 */
export const MUSE_STREAM_STALL_MS = 10 * 60_000;
export const MUSE_INTERRUPT_GRACE_MS = 20_000;
export const MUSE_STALL_POLL_MS = 15_000;

export function isMuseStreamStalled(input: {
  turnOpen: boolean;
  pendingPrompts: number;
  lastEventAt: number;
  now: number;
  stallMs?: number;
}): boolean {
  if (!input.turnOpen || input.pendingPrompts > 0) return false;
  return input.now - input.lastEventAt >= (input.stallMs ?? MUSE_STREAM_STALL_MS);
}

/** The plain-text question list Muse's `userInput/requested` carries. Exposed for tests. */
export function museUserInputAnswers(
  questions: Array<{ id: string; question: string; header?: string; options?: Array<{ label: string; description?: string }> }>,
  choose: (question: string, options: Array<{ label: string; description?: string }>, header?: string) => Promise<number | null>,
): Promise<Array<{ questionId: string; selectedLabel: string }> | null> {
  return (async () => {
    const answers: Array<{ questionId: string; selectedLabel: string }> = [];
    for (const question of questions) {
      const options = (question.options ?? []).map((option) => ({ label: option.label, description: option.description }));
      if (!options.length) return null;
      const selected = await choose(question.question, options, question.header);
      if (selected == null) return null;
      answers.push({ questionId: question.id, selectedLabel: options[selected]!.label });
    }
    return answers;
  })();
}

export async function cmdMuseMspSession(argv: string[]): Promise<void> {
  const key = arg(argv, "--key");
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const model = arg(argv, "--model") ?? "auto";
  const managedName = arg(argv, "--managed-name") ?? "";
  const resume = arg(argv, "--resume");
  const thinkingLevel = arg(argv, "--thinking-level");
  const recoveredAt = Number(arg(argv, "--recovered-at")) || null;
  const separator = argv.indexOf("--");
  const initialPrompt = separator >= 0 ? argv.slice(separator + 1).join(" ").trim() : "";
  if (!key) throw new Error("muse-msp-session: --key <uuid> is required");

  await runManagedSdkSession({
    key,
    agent: "muse",
    cwd,
    model,
    managedName,
    resume,
    thinkingLevel,
    recoveredAt,
    initialPrompt,
    async createRuntime(sink) {
      // Record cwd → session id so the guarded MCP launchers can pass the real
      // omg session id to `omg mcp` (muse strips their env). `key` is the omg
      // session id (the harness key).
      if (key) recordMuseSession(cwd, key);
      let child: ChildProcess | null = null;
      let client: MspClient | null = null;
      let exited = true;
      let turnDone: ((params: any) => void) | null = null;
      let lastEventAt = Date.now();
      let pendingPrompts = 0;
      let state = newMuseTurnState();
      let effort = museReasoningEffort(thinkingLevel);
      let sessionId = "";
      const seenApprovals = new Set<string>();
      const seenUserInputs = new Set<string>();

      // A dashboard prompt is a legitimate silence: muse waits for the human,
      // so the stall watchdog must not count that time.
      const askGuarded: ManagedSdkEventSink["ask"] = async (question, options, header) => {
        pendingPrompts++;
        try {
          return await sink.ask(question, options, header);
        } finally {
          pendingPrompts--;
        }
      };

      function failTurn(reason: string): void {
        const done = turnDone;
        turnDone = null;
        done?.({ terminal: "failed", error: { message: reason } });
      }

      // Drop the current `muse serve`. The session itself is durable on disk;
      // the next turn boots a fresh serve and resumes it (see boot()).
      function dropServe(reason: string): void {
        const current = child;
        const currentClient = client;
        exited = true;
        child = null;
        client = null;
        currentClient?.close(reason);
        try {
          current?.stdin?.end();
        } catch {}
        try {
          current?.kill();
        } catch {}
        failTurn(reason);
      }

      function wire(c: MspClient): void {
        for (const method of ["item/started", "item/delta", "item/updated", "item/completed"]) {
          c.onNotification(method, (params) => {
            lastEventAt = Date.now();
            applyMuseViewEvent(method, params, sink, state);
          });
        }
        c.onNotification("turn/completed", (params) => {
          lastEventAt = Date.now();
          const done = turnDone;
          turnDone = null;
          done?.(params);
        });
        c.onNotification("approval/requested", (params) => {
          lastEventAt = Date.now();
          const approvalId = String(params?.approvalId ?? "");
          if (!approvalId || seenApprovals.has(approvalId)) return;
          seenApprovals.add(approvalId);
          const choices = (params?.availableChoices ?? []) as Array<{ choiceId: string; label: string; decision?: string }>;
          if (!choices.length) return;
          const auto = museAutoApprovalChoice(choices);
          if (auto) {
            void c
              .request("approval/decide", {
                commandId: uuidv7(),
                sessionId,
                approvalId,
                choiceId: auto.choiceId,
                requirementId: params?.currentRequirementId,
              })
              .catch(() => {});
            return;
          }
          const subject = params?.subject ?? {};
          const title = subject.command
            ? `${params?.toolName ?? "tool"}: ${subject.command}`
            : `${params?.toolName ?? "tool"} ${params?.rawArgs ?? ""}`.trim();
          void askGuarded(title, choices.map((choice) => ({ label: choice.label, description: choice.decision })), "Muse permission")
            .then((selected) => {
              const choice = selected == null ? choices.find((x) => x.decision === "denied") ?? choices[choices.length - 1]! : choices[selected]!;
              return c.request("approval/decide", {
                commandId: uuidv7(),
                sessionId,
                approvalId,
                choiceId: choice.choiceId,
                requirementId: params?.currentRequirementId,
              });
            })
            .catch(() => {});
        });
        c.onNotification("userInput/requested", (params) => {
          lastEventAt = Date.now();
          const userInputId = String(params?.userInputId ?? "");
          if (!userInputId || seenUserInputs.has(userInputId)) return;
          seenUserInputs.add(userInputId);
          void museUserInputAnswers(params?.questions ?? [], (question, options, header) => askGuarded(question, options, header ?? "Muse question"))
            .then((answers) =>
              answers
                ? c.request("userInput/answer", { commandId: uuidv7(), sessionId, userInputId, answers })
                : c.request("userInput/cancel", { commandId: uuidv7(), sessionId, userInputId }),
            )
            .catch(() => {});
        });
      }

      // Spawn `muse serve`, handshake, and select the session: `session/start`
      // on first boot, `session/resume` for recovery and for every re-boot
      // after dropServe().
      async function boot(resumeId: string | undefined): Promise<void> {
        const spawned: ChildProcess = spawn(musePath(), museServeArgv(), {
          cwd,
          env: museChildEnv(),
          stdio: ["pipe", "pipe", "inherit"],
        });
        if (!spawned.stdin || !spawned.stdout) throw new Error("muse serve stdio was not available");
        const stdin = spawned.stdin;
        const c = new MspClient((line) => {
          stdin.write(`${line}\n`);
        });
        child = spawned;
        client = c;
        exited = false;
        lastEventAt = Date.now();
        spawned.stdout.setEncoding("utf8");
        // Raw bytes are NOT progress: muse serve keeps writing keepalives
        // (~200 bytes / 20 s, measured 2026-09-04) while its view projection
        // is dead, which kept `lastEventAt` fresh and the stall watchdog blind
        // for half an hour. Only view-stream notifications count (see wire()).
        spawned.stdout.on("data", (chunk: string) => {
          c.feed(chunk);
        });
        spawned.on("exit", (code, signal) => {
          if (child !== spawned) return;
          exited = true;
          child = null;
          client = null;
          const reason = `muse serve exited (${signal ?? code ?? "unknown"})`;
          c.close(reason);
          failTurn(reason);
        });
        wire(c);

        await c.request("initialize", {
          clientInfo: { name: "omg", title: "omg.dev", version: "1" },
        });
        c.notify("initialized");
        if (resumeId) {
          // Durable on disk: resuming returns the session without replaying
          // its history as live events, so nothing is re-indexed.
          const result = await c.request<{ session?: { sessionId?: string } }>("session/resume", {
            commandId: uuidv7(),
            sessionId: resumeId,
            excludeItems: true,
          });
          sessionId = result?.session?.sessionId ?? resumeId;
          // A resumed session keeps the approval mode it was stored with, which
          // predates omg's allowAll default (measured 2026-09-04: a "Ga verder"
          // continuation ran on-request and prompted every tool call). Re-select
          // the configured mode so resume behaves like a fresh start.
          await c.request("session/setApprovalMode", museSetApprovalModeParams(sessionId));
        } else {
          const result = await c.request<{ session?: { sessionId?: string } }>(
            "session/start",
            museSessionStartParams(cwd, model),
          );
          sessionId = result?.session?.sessionId ?? "";
          if (!sessionId) throw new Error("muse session/start returned no session id");
        }
      }

      await boot(resume);

      return {
        nativeSessionId: sessionId,
        async runTurn(prompt) {
          state = newMuseTurnState();
          if (exited) {
            // The previous serve went silent or died and was dropped. Bring a
            // fresh one up on the same durable session; if muse cannot resume
            // it, the error reaches the chat instead of an endless spinner.
            await boot(sessionId || resume);
          }
          const c = client;
          if (!c) throw new Error("muse serve is not running");
          const completed = new Promise<any>((resolve) => {
            turnDone = resolve;
          });
          lastEventAt = Date.now();
          const watchdog = setInterval(() => {
            if (!turnDone || client !== c) return;
            const now = Date.now();
            if (!isMuseStreamStalled({ turnOpen: true, pendingPrompts, lastEventAt, now })) return;
            const silent = Math.round((now - lastEventAt) / 1000);
            console.error(`muse-msp-session ${key}: muse serve silent ${silent}s mid-turn; restarting muse serve`);
            dropServe(`muse serve went silent for ${silent}s mid-turn; it has been restarted — send the message again to continue`);
          }, MUSE_STALL_POLL_MS);
          try {
            const params: Record<string, unknown> = {
              commandId: uuidv7(),
              sessionId,
              input: museTurnInput(prompt),
            };
            if (effort) params.reasoningEffort = effort;
            await c.request("turn/start", params);
            const outcome = await completed;
            if (outcome?.terminal === "failed") {
              const message = outcome?.error?.message ?? outcome?.reason ?? "turn failed";
              throw new Error(String(message));
            }
            return { text: state.draft, thinking: state.thought };
          } finally {
            clearInterval(watchdog);
            turnDone = null;
          }
        },
        async interrupt() {
          const c = client;
          if (exited || !sessionId || !c) return;
          // A live serve answers an interrupt with `turn/completed`
          // (terminal cancelled) within about a second. When its view stream
          // is dead nothing arrives, and without this bound the turn stayed
          // open forever: busy spinner, every follow-up queued behind it.
          // Armed BEFORE the request goes out: a serve whose stream is dead
          // does not answer `turn/interrupt` either, and awaiting that reply
          // first meant the timer was never armed (session fd89be61,
          // 2026-09-04: 30 min busy, zero log lines).
          setTimeout(() => {
            if (!turnDone || client !== c) return;
            console.error(`muse-msp-session ${key}: no turn/completed ${MUSE_INTERRUPT_GRACE_MS / 1000}s after interrupt; restarting muse serve`);
            dropServe("interrupted, but muse serve sent no turn/completed; it has been restarted — send the message again to continue");
          }, MUSE_INTERRUPT_GRACE_MS);
          try {
            await c.request("turn/interrupt", { commandId: uuidv7(), sessionId });
          } catch {}
        },
        async setModel(next) {
          if (!next || next === "auto" || !client) return;
          await client.request("session/setModel", { commandId: uuidv7(), sessionId, model: { modelId: next } });
        },
        setThinkingLevel(next) {
          effort = museReasoningEffort(next);
        },
        close() {
          const current = child;
          const currentClient = client;
          exited = true;
          child = null;
          client = null;
          currentClient?.close("session closed");
          try {
            current?.stdin?.end();
          } catch {}
          current?.kill();
        },
      };
    },
  });
}

if (import.meta.main) {
  cmdMuseMspSession(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
