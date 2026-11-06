// Headless interactive session harness for the "aisdk" agent kind.
//
// This is the long-lived process behind a "claude code" managed session. It runs
// as a detached process and drives a multi-turn conversation through the
// OFFICIAL @anthropic-ai/claude-agent-sdk (`query()` with streaming input) — one
// live claude subprocess for the whole session, no per-turn resume dance.
//
// History: this harness previously went through the Vercel AI SDK
// (`streamText` + ai-sdk-provider-claude-code). That adapter wrapped this same
// Agent SDK but hid its session surface — no permission callbacks (the
// AskUserQuestion hang), no first-hand message stream (transcripts had to be
// re-discovered from ~/.claude/projects JSONL), version-locked to ai@6. Going
// direct removes the middle layer while keeping the exact same external
// contract, so serve and the web UI are unchanged:
//   - transcript OUT: SDK messages are indexed directly into SQLite under the
//     synthetic lfg:// session key. The Agent SDK's private JSONL may still
//     exist for its own resume machinery, but lfg does not read or write it.
//   - control IN: we tail a command file (data/aisdk/<sessionId>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<sessionId>.json) that we
//     keep updated; serve reads it for the live-view busy dot and session list.
//
// Interrupt is the SDK's native `query.interrupt()` — it stops the current turn
// without killing the session process.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
  currentBootId,
} from "../../aisdk-registry.ts";
import { normalizeLineMessages, type SessionMsg } from "../../sessions.ts";
import { sessionTitleFromPrompt } from "../../omg-capabilities.ts";
import {
  indexSessionMessagesDirect,
  reindexFileHistoryUnderSessionKey,
  sessionHasIndexedMessages,
} from "../../transcript-index.ts";
import { makeDraftPublisher } from "./draft.ts";
import { readFileSync, statSync } from "node:fs";
import { initialCmdOffset, readNewCmdLines, writeCursor } from "./cmd-tail.ts";
import { claudeAccountEnv } from "../../claude-creds.ts";
import { describeClaudeBinary, resolveClaudePath } from "./claude-path.ts";
import { omgMcpServers } from "../../config.ts";
import {
  claudeAccountConfigDir,
  resolveClaudeAccount,
} from "../../claude-accounts.ts";
import {
  readStoredSessionTokenUsage,
  writeStoredSessionTokenUsage,
  type ClaudeContextUsageSnapshot,
} from "../../session-token-usage.ts";
import { extractAttachments, isImageMime, readAsBase64 } from "../../attachment-images.ts";
import { contextPreambleText, toWireContextDetailed, validatedCentralContext } from "../../mac-chat/context.ts";
import { macClaudeSpawnFactory } from "../../mac-chat/claude-transport.ts";
import { macBridgeMcpServers } from "../../mac-chat/mcp.ts";
import { macSshSpawn } from "../../mac-chat/stream.ts";
import { recordMacStartRequest, updateMacStart } from "../../mac-chat/pending.ts";

/**
 * Inert executable selector for the MAC route.
 *
 * `query()` resolves its native CLI binary BEFORE it ever calls
 * `spawnClaudeCodeProcess`: without this option the SDK looks up its
 * platform-specific optional dependency, and a host without the matching one
 * (the linux-x64 attest run) dies with "Native CLI binary for linux-x64 not
 * found" before a single ssh byte — even though the remote route needs no
 * local CLI at all. Verified against @anthropic-ai/claude-agent-sdk 0.3.206:
 * an explicit `pathToClaudeCodeExecutable` skips that resolution entirely;
 * with `spawnClaudeCodeProcess` set the SDK hands {command, args, cwd, env,
 * signal} to the callback and never spawns or validates the path locally.
 *
 * The VALUE must not end in .js/.mjs/.ts/.tsx/.jsx — the SDK then treats it
 * as a script and puts it ON ARGV, where the Mac transport's allowlist
 * refuses non-flag tokens. A URI-shaped sentinel can never resolve or
 * execute as a local file; the Mac supervisor pins the real CLI.
 * attest.ts (Mac attestation turns) shares this exact value.
 */
export const MAC_CLAUDE_REMOTE_EXECUTABLE = "mac-stream://claude";

function parseExecutionHost(argv: string[]): "agentbox" | "mac" {
  // tmux sends `--execution-host <host>` as TWO argv tokens; matching the
  // single joined token silently launched LOCALLY on a requested Mac session
  // (WIRE-RECONCILIATION defect 11). Strict two-token parse, strict values.
  const value = arg(argv, "--execution-host");
  if (value === undefined) return "agentbox";
  if (value === "mac" || value === "agentbox") return value;
  console.error(`aisdk-session: unknown --execution-host "${value}"`);
  process.exit(1);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Map lfg's shared thinking-level vocabulary onto the Agent SDK's `effort`
// option (low|medium|high|xhigh|max). Mirrors claudeEffortFor in tmux.ts;
// duplicated here to keep this harness free of the heavier tmux/serve
// dependency graph. Undefined → SDK/model default effort.
function effortFor(level?: string): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "minimal") return "low";
  if (["low", "medium", "high", "xhigh", "max"].includes(level)) {
    return level as "low" | "medium" | "high" | "xhigh" | "max";
  }
  return undefined;
}

function sdkMessageIdentity(msg: Record<string, unknown>): string | null {
  const message = msg.message as Record<string, unknown> | undefined;
  const id = msg.uuid ?? msg.id ?? message?.uuid ?? message?.id;
  return typeof id === "string" && id ? id : null;
}

function normalizeSdkEnvelope(msg: Record<string, unknown>): SessionMsg[] {
  const id = sdkMessageIdentity(msg);
  const envelope = { ...msg } as Record<string, unknown>;
  if (!envelope.uuid && id) envelope.uuid = id;
  const now = Date.now();
  const fallbackId =
    id ??
    `${String(msg.type ?? "message")}:${String(envelope.timestamp ?? now)}:${JSON.stringify(msg.message ?? msg).slice(0, 200)}`;
  return normalizeLineMessages(JSON.stringify(envelope)).map((message, index) => ({
    ...message,
    id: message.id ?? (index === 0 ? fallbackId : `${fallbackId}#${index}`),
    ts: message.ts ?? now,
  }));
}

function userTextMessage(text: string, ts = Date.now()): SessionMsg {
  return { id: crypto.randomUUID(), role: "user", kind: "text", text, ts };
}

/**
 * Commit local user rows at the point their turn can be ordered safely.
 *
 * An ordinary send has no earlier runtime row to wait for, so it keeps the
 * existing immediate commit. A send paired with an interrupt is different:
 * the Claude CLI first emits the interrupted assistant text and its synthetic
 * interrupt marker. Keep that local row pending until either the SDK echoes
 * the user turn itself or the interrupted turn ends. `order_seq` then records
 * the same append order the SDK produced instead of the command-dispatch race.
 *
 * The deferred row is stamped when it is committed, not when it was typed.
 * Its typed time is older than the interrupted answer written before it, and
 * the live views place an arriving row by `ts`: the web drew the steering
 * message ABOVE the answer it interrupted until a reload read the stored order.
 */
export class AisdkUserRowCommitter {
  private deferred: SessionMsg[] = [];
  private latestTs = 0;

  constructor(
    private readonly commit: (messages: SessionMsg[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private commitRows(messages: SessionMsg[]): void {
    for (const message of messages) {
      if (typeof message.ts === "number" && message.ts > this.latestTs) this.latestTs = message.ts;
    }
    this.commit(messages);
  }

  send(text: string, afterInterrupt: boolean): void {
    const row = userTextMessage(text, this.now());
    if (afterInterrupt) this.deferred.push(row);
    else this.commitRows([row]);
  }

  sdk(messages: SessionMsg[]): void {
    const unmatched = [...this.deferred];
    for (const message of messages) {
      if (message.role !== "user" || message.kind !== "text") continue;
      const index = unmatched.findIndex((row) => row.text.trim() === message.text.trim());
      if (index >= 0) unmatched.splice(index, 1);
    }
    this.deferred = unmatched;
    this.commitRows(messages);
  }

  turnEnded(): void {
    if (!this.deferred.length) return;
    const at = Math.max(this.now(), this.latestTs + 1);
    const rows = this.deferred.map((row, index) => ({ ...row, ts: Math.max(row.ts ?? 0, at + index) }));
    this.deferred = [];
    this.commitRows(rows);
  }
}

/**
 * Why the SDK stream ended, phrased for the person looking at the session.
 *
 * The bad case is a stream that ends *without* throwing. `for await` simply
 * finishes, `catch` never runs, and the harness exits 1 having printed nothing
 * at all — no stdout, no stderr, no transcript row. That is what a box with no
 * authenticated Claude does: the Agent SDK's subprocess cannot start, and the
 * iterator closes empty. On a fresh install the session then sat on the
 * thinking dots forever, because a UI can only report what it was told, and it
 * was told nothing.
 *
 * `turns` distinguishes the two shapes. Zero turns means nothing ever ran, so
 * the cause is upstream of the conversation — almost always that no agent is
 * connected yet, which is the state every new install starts in. After at
 * least one turn the runtime existed and died later, which is a different
 * problem and must not be described as missing auth.
 */
export function describeAisdkStreamEnd(input: {
  turns: number;
  error?: unknown;
  claudePath?: string | null;
  accountConnected?: boolean;
}): string {
  const cause =
    input.error instanceof Error ? input.error.message : input.error ? String(input.error) : "";
  if (input.turns > 0) {
    return cause
      ? `The coding agent stopped unexpectedly: ${cause}`
      : "The coding agent stopped unexpectedly after the session had started.";
  }
  // Nothing ran. Name the missing piece, because on a new install it is the
  // only thing standing between the user and a working session.
  const missing: string[] = [];
  if (!input.claudePath) missing.push("the Claude CLI is not installed");
  if (!input.accountConnected) missing.push("no Claude account is connected");
  const detail = cause ? ` (${cause})` : "";
  if (missing.length) {
    return (
      `Claude could not start: ${missing.join(" and ")}. ` +
      `Open Settings → Coding agents to install it and sign in.${detail}`
    );
  }
  return (
    `Claude could not start, and it stopped before running a single turn.${detail} ` +
    `Check Settings → Coding agents.`
  );
}

/**
 * Human-readable detail for a non-success Agent SDK `result` message.
 *
 * This used to be `String(msg.result ?? msg.subtype)`, which reported nothing
 * but `"error_during_execution"` — three sessions died that way on 2026-08-06
 * with no recoverable reason. The cause is that `result` exists only on
 * SDKResultSuccess; the ERROR variant (SDKResultError) has no such field, so
 * the `??` always fell through to the bare subtype. Everything that explains
 * the failure lives in fields the old line never read:
 *
 *   errors[]           the actual messages
 *   terminal_reason    prompt_too_long / api_error / model_error / blocking_limit / …
 *   stop_reason        why the turn stopped
 *   permission_denials a turn can end simply because a tool was refused
 *
 * Defensive about shapes on purpose: this runs on the failure path, where a
 * throw would destroy the very diagnostic we're trying to emit.
 */
export function describeAisdkFailure(msg: Record<string, unknown>): string {
  const parts: string[] = [typeof msg.subtype === "string" ? msg.subtype : "unknown"];
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const terminal = str(msg.terminal_reason);
  if (terminal) parts.push(`terminal_reason=${terminal}`);
  const stop = str(msg.stop_reason);
  if (stop) parts.push(`stop_reason=${stop}`);

  const errors = (Array.isArray(msg.errors) ? msg.errors : [])
    .map((e) => str(e) ?? (e == null ? null : safeJson(e)))
    .filter((e): e is string => !!e);
  if (errors.length) parts.push(`errors=[${errors.join("; ")}]`);

  const denials = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
  if (denials.length) {
    const tools = [
      ...new Set(
        denials
          .map((d) => (d && typeof d === "object" ? str((d as Record<string, unknown>).tool_name) : null))
          .filter((t): t is string => !!t),
      ),
    ];
    parts.push(`permission_denials=${denials.length}${tools.length ? ` (${tools.join(", ")})` : ""}`);
  }

  // Only the success variant carries `result` today, but read it anyway: the
  // SDK has moved this field before, and an unexpected one is still a clue.
  const legacy = str(msg.result) ?? (msg.result && typeof msg.result === "object" ? safeJson(msg.result) : null);
  if (legacy) parts.push(`result=${legacy}`);

  if (typeof msg.num_turns === "number") parts.push(`num_turns=${msg.num_turns}`);
  if (typeof msg.duration_ms === "number") parts.push(`duration_ms=${msg.duration_ms}`);
  return parts.join(" ");
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null; // circular / non-serializable — better a missing field than a throw
  }
}

function buildClaudeMessage(text: string): { role: "user"; content: string | Array<Record<string, unknown>> } {
  const extracted = extractAttachments(text);
  if (!extracted.attachments.length) return { role: "user", content: text };
  const clean = extracted.cleanText || "(image attachment)";
  const content: Array<Record<string, unknown>> = [{ type: "text", text: clean }];
  for (const att of extracted.attachments) {
    const b64 = readAsBase64(att.path);
    if (!b64) continue;
    if (isImageMime(att.mime)) {
      content.push({ type: "image", source: { type: "base64", media_type: att.mime, data: b64 } });
    } else if (att.mime === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: att.mime, data: b64 } });
    }
  }
  if (content.length === 1) return { role: "user", content: text };
  return { role: "user", content };
}

// Minimal push-driven AsyncIterable — the Agent SDK's streaming-input mode
// consumes this; serve-side sends are pushed in as they arrive on the cmd file.
type UserMsg = {
  type: "user";
  message: { role: "user"; content: string | Array<Record<string, unknown>> };
  parent_tool_use_id: null;
};

export class InputChannel implements AsyncIterable<UserMsg> {
  private buffer: UserMsg[] = [];
  private waiter: ((v: IteratorResult<UserMsg>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    const msg: UserMsg = {
      type: "user",
      message: buildClaudeMessage(text),
      parent_tool_use_id: null,
    };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  private pushMessage(msg: UserMsg): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  /**
   * Move only messages the SDK has not requested yet to a replacement query.
   * The in-flight prompt already handed to the old query is intentionally not
   * replayed: provider execution may have started even when its event stream is
   * silent. This keeps recovery at-most-once while closing the send/restart gap.
   */
  handoffTo(next: InputChannel): void {
    const pending = this.buffer.splice(0);
    this.close();
    for (const msg of pending) next.pushMessage(msg);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<UserMsg> {
    return {
      next: (): Promise<IteratorResult<UserMsg>> => {
        if (this.buffer.length) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

export const AISDK_STREAM_STALL_MS = 15 * 60_000;
export const AISDK_STREAM_WATCHDOG_TICK_MS = 30_000;

export function isAisdkStreamStalled(input: {
  busy: boolean;
  closing: boolean;
  restartRequested: boolean;
  lastSdkEventAt: number;
  now: number;
  stallMs?: number;
}): boolean {
  return input.busy &&
    !input.closing &&
    !input.restartRequested &&
    input.now - input.lastSdkEventAt >= (input.stallMs ?? AISDK_STREAM_STALL_MS);
}

export async function cmdAisdkSession(argv: string[]): Promise<void> {
  const sessionIdArg = arg(argv, "--session");
  const model = arg(argv, "--model") ?? "opus";
  const effort = effortFor(arg(argv, "--thinking-level"));
  let fastMode = argv.includes("--fast-mode");
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--managed-name") ?? arg(argv, "--tmux") ?? "";
  const recoveredAt = Number(arg(argv, "--recovered-at")) || null;
  const claudeAccountId = arg(argv, "--claude-account");
  // Mac execution host (integration revision 2): this harness stays local,
  // but the native claude subprocess streams to the MacBook M1 over ssh
  // (src/mac-chat/**). Auth is the Mac's OWN login — a local claude account
  // binding would be an account copy and is refused before the spawn.
  const executionHost = parseExecutionHost(argv);
  // Everything after `--` is the initial prompt (mirrors how spawnManagedSession
  // passes the first message to the claude CLI).
  const dashI = argv.indexOf("--");
  const initialPrompt = dashI >= 0 ? argv.slice(dashI + 1).join(" ").trim() : "";

  if (!sessionIdArg) {
    console.error("aisdk-session: --session <uuid> is required");
    process.exit(1);
  }
  const sessionId: string = sessionIdArg;
  if (executionHost === "mac" && claudeAccountId) {
    console.error("aisdk-session: claude-accountbinding is lokaal; een mac-sessie draait op de eigen Mac-login (geen accountkopie)");
    process.exit(1);
  }

  try {
    process.chdir(cwd);
  } catch {}

  const claudePath = resolveClaudePath();
  console.error(`aisdk-session ${sessionId}: claude binary ${describeClaudeBinary(claudePath)}`);
  const account = executionHost === "mac" ? null : resolveClaudeAccount(claudeAccountId);
  const accountConfigDir = account ? claudeAccountConfigDir(account.id) : null;
  const accountEnv = executionHost === "mac"
    ? null
    : claudeAccountEnv(
        process.env,
        !!account,
        accountConfigDir ?? undefined,
      );
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Mac transport configuration (env from the launcher; never argv secrets).
  const macTarget = executionHost === "mac" ? (process.env.LFG_MAC_SSH_TARGET ?? "").trim() : "";
  const macBridgeUrl = executionHost === "mac" ? (process.env.LFG_MAC_BRIDGE_URL ?? "").replace(/\/+$/, "") : "";
  const macBridgeToken = executionHost === "mac" ? (process.env.LFG_MAC_BRIDGE_TOKEN ?? "") : "";
  const macNamespaces = executionHost === "mac"
    ? (process.env.LFG_MAC_NAMESPACES ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const macFirstRequestId = executionHost === "mac" ? (process.env.LFG_MAC_REQUEST_ID ?? "").trim() : "";
  if (executionHost === "mac" && (!macTarget || !macBridgeUrl || !macBridgeToken || macNamespaces.length === 0)) {
    console.error("aisdk-session: mac-transport mist LFG_MAC_SSH_TARGET/LFG_MAC_BRIDGE_URL/LFG_MAC_BRIDGE_TOKEN/LFG_MAC_NAMESPACES; refusing to start");
    process.exit(1);
  }
  // Bridge MCP entries per namespace (frozen wire shape: url + bearer). The
  // URL must NAME the session lease (?session=mac-<sessionId>) or the bridge
  // answers 401 session_required — bearer alone is not a session. The one
  // shared builder (mac-chat/mcp.ts) derives it from this harness's central
  // sessionId, which is the id the launcher minted the lease for.
  const macMcpServers = (): Record<string, { type: "http"; url: string; bearerToken: string; headerName: string }> =>
    macBridgeMcpServers({
      bridgeUrl: macBridgeUrl,
      bridgeToken: macBridgeToken,
      sessionId,
      namespaces: macNamespaces,
    });
  let macRequestUsed = false;
  const macNextRequestId = (): string => {
    const id = macFirstRequestId && !macRequestUsed ? macFirstRequestId : crypto.randomUUID();
    macRequestUsed = true;
    // EVERY stream id is journaled before it touches the network, so an
    // unknown outcome always reconciles by the id that is live on the Mac.
    recordMacStartRequest(sessionId, id);
    return id;
  };
  const macSpawnDeps = { spawn: macSshSpawn };
  let macRemoteInitReported = false;
  const macReportInit = (state: "ready" | "failed" | "unknown", detail: { requestId?: string | null; pid?: number; cwd?: string; reason?: string }): void => {
    patchEntry(sessionId, {
      executionHost: "mac",
      remoteInit: {
        state,
        ...(detail.requestId !== undefined ? { requestId: detail.requestId ?? null } : {}),
        ...(detail.pid !== undefined ? { remotePid: detail.pid } : {}),
        ...(detail.cwd !== undefined ? { scratch: detail.cwd } : {}),
        ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
        updatedAt: Date.now(),
      },
    });
    if (!macRemoteInitReported && (state === "ready" || state === "failed")) {
      macRemoteInitReported = true;
      updateMacStart(sessionId, {
        state,
        ...(detail.pid !== undefined ? { remotePid: detail.pid } : {}),
        ...(detail.reason ? { reason: detail.reason } : {}),
      });
    }
  };
  /**
   * Per-turn central context: re-read at every send; rides the turn text.
   * Item 35: REQUIRED instruction failures THROW here (unreadable/over-size
   * central sources) — the send path catches that and refuses the turn
   * BEFORE any provider input. Optional skill/memory omissions stay
   * non-fatal inside the preamble.
   */
  const macPreamble = (): string => {
    const validated = validatedCentralContext("claude", cwd);
    if (!validated.ok) throw new Error(validated.error);
    return contextPreambleText(validated.context, "claude");
  };
  /**
   * Full central context for the stream metadata, re-read per launch.
   * Item 35: an incomplete REQUIRED context refuses the stream launch by
   * throwing BEFORE any ssh spawn (no provider contact, fail closed).
   * Skill/memory wire-transport omissions remain logged, non-fatal.
   */
  const macWireContext = () => {
    const validated = validatedCentralContext("claude", cwd);
    if (!validated.ok) {
      console.error(`aisdk-session ${sessionId}: stream-launch GEWEIGERD — ${validated.error}`);
      throw new Error(validated.error);
    }
    const { wire, omitted } = toWireContextDetailed(validated.context);
    for (const omission of omitted) {
      console.error(`aisdk-session ${sessionId}: contextbron niet wire-transportabel: ${omission.path} (${omission.reason})`);
    }
    return wire;
  };
  /** Settings extracted off the native argv (--settings) → re-applied natively. */
  let macPendingFlagSettings: Record<string, unknown> | null = null;

  // Control-plane registry entry — the moment this exists (and our pid is alive),
  // serve will surface the session in the live view.
  const bootId = currentBootId();
  writeEntry({
    sessionId,
    agent: "claude",
    harnessPid: process.pid,
    tmuxName,
    supervisor: "process",
    bootId,
    recoveryClaimBootId: recoveredAt ? bootId : null,
    recoveredAt,
    thinkingLevel: arg(argv, "--thinking-level") ?? null,
    fastMode,
    cwd,
    model,
    busy: false,
    title: sessionTitleFromPrompt(initialPrompt),
    createdAt: Date.now(),
    // Mac-hosted: durable local registration with a PENDING remote init —
    // the remote provider start is visible (remoteInit flips on handshake).
    ...(executionHost === "mac"
      ? {
          executionHost: "mac" as const,
          remoteInit: {
            state: "pending" as const,
            requestId: macFirstRequestId || null,
            remotePid: null,
            scratch: null,
            updatedAt: Date.now(),
          },
        }
      : {}),
  });

  // Direct-indexed rows for this id mean we're a relaunched harness continuing
  // an existing session. Fresh sessions mint the deterministic id up front
  // (sessionId and resume are mutually exclusive on the SDK).
  const resuming = sessionHasIndexedMessages(sessionId);
  // Legacy claude sessions have their history under a native ~/.claude JSONL
  // file path, not the synthetic session key — so a resumed pane would render
  // empty. Seed the synthetic key from that file history so the transcript is
  // visible and new turns append to it. Done AFTER `resuming` is captured, so
  // the SDK still starts in `{ sessionId }` mode (no resume of an id the SDK
  // never minted) — visibility now, continuation as a fresh underlying thread.
  if (!resuming) reindexFileHistoryUnderSessionKey(sessionId);

  const publishDraft = makeDraftPublisher(sessionId);

  let input = new InputChannel();
  let closing = false;
  let draft = "";
  let busy = false;
  let restartRequested = false;
  let lastSdkEventAt = Date.now();
  let sdkMessagesSeen = 0;
  const previousUsage = readStoredSessionTokenUsage(sessionId);
  let sessionTotals = previousUsage?.totals ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
  };
  let contextUsage = previousUsage?.context ?? null;
  let usageRefresh = 0;

  const persistUsage = () => {
    writeStoredSessionTokenUsage(sessionId, {
      updatedAt: Date.now(),
      model,
      context: contextUsage,
      totals: sessionTotals,
    });
  };

  let q: ReturnType<typeof query>;
  let interruptedTurnOpen = false;
  const userRows = new AisdkUserRowCommitter((messages) => {
    indexSessionMessagesDirect(sessionId, messages);
  });

  const refreshUsageSnapshot = () => {
    const request = ++usageRefresh;
    void Promise.allSettled([
      q.getContextUsage(),
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    ])
      .then(([contextResult, totalsResult]) => {
        if (request !== usageRefresh) return;
        if (contextResult.status === "fulfilled") {
          contextUsage = contextResult.value as ClaudeContextUsageSnapshot;
        }
        if (totalsResult.status === "fulfilled") {
          const reported = totalsResult.value.session;
          const modelTotals = Object.values(reported.model_usage);
          const input = modelTotals.reduce((sum, row) => sum + row.inputTokens, 0);
          const output = modelTotals.reduce((sum, row) => sum + row.outputTokens, 0);
          const cacheRead = modelTotals.reduce((sum, row) => sum + row.cacheReadInputTokens, 0);
          const cacheWrite = modelTotals.reduce(
            (sum, row) => sum + row.cacheCreationInputTokens,
            0,
          );
          sessionTotals = {
            input,
            output,
            cacheRead,
            cacheWrite,
            reasoning: 0,
            total: input + output + cacheRead + cacheWrite,
            costUsd: reported.total_cost_usd,
          };
        }
        persistUsage();
      })
      .catch(() => {});
  };

  // Busy is ACTIVITY-DRIVEN, not turn-counted. The SDK's streaming input may
  // merge a queued/steering send into the running turn, so `result` events do
  // not correspond 1:1 with sends — a counter drifts and the busy dot sticks.
  // Instead: any send or assistant activity marks busy, any turn result clears
  // it, and if the CLI immediately starts another turn for a queued message the
  // next stream event flips it right back. Self-healing in every ordering.
  const setBusy = (next: boolean) => {
    if (busy === next) return;
    busy = next;
    if (next) lastSdkEventAt = Date.now();
    patchEntry(sessionId, next ? { busy: true } : { busy: false, draftText: null, draftUpdatedAt: null });
  };

  const startQuery = (resumeRuntime: boolean) => query({
    prompt: input as AsyncIterable<never>,
    options: {
      model,
      cwd,
      ...(resumeRuntime ? { resume: sessionId } : { sessionId }),
      // Full capability + no permission prompts, mirroring the tmux claude's
      // --dangerously-skip-permissions.
      permissionMode: "bypassPermissions",
      // This headless/paneless harness can't render or answer an interactive
      // question, and bypassPermissions does NOT auto-resolve AskUserQuestion —
      // the CLI's permission resolver returns behavior:"ask" for it BEFORE the
      // bypass auto-allow branch, so without this a turn would hang busy
      // forever. Disallowing the tool forces the agent to decide for itself.
      disallowedTools: ["AskUserQuestion"],
      // MAC ROUTE (item 33): settingSources: [] is hermetic per chat — the
      // SDK emits `--setting-sources=` (empty), which loads NO Mac-local
      // user/project settings and NO CLAUDE.md from any source (official
      // docs; live-proven on the M1 install with explicit strict MCP and
      // OAuth untouched). The transport also enforces this form and refuses
      // non-empty client values as standing-context collisions.
      ...(executionHost === "mac" ? { settingSources: [] as never[] } : {}),
      // MAC ROUTE: the native argv must stay inside the Mac transport's
      // allowlist. NO mcpServers (the SDK would emit a LOCAL temp
      // --mcp-config path that cannot exist on the Mac — MCP is provisioned
      // in the session lease), NO settings:{fastMode} (the SDK would emit
      // `--settings {...}` on argv, which the transport refuses) — Fast and
      // other flag settings ride q.applyFlagSettings natively instead, and
      // the fresh central context rides each TURN's text (a resumed claude
      // keeps its first stored system prompt, so argv/system-prompt
      // channels cannot refresh it).
      ...(executionHost === "mac"
        ? {
            spawnClaudeCodeProcess: macClaudeSpawnFactory(macSpawnDeps, {
              sessionId,
              target: macTarget,
              context: macWireContext(),
              mcpServers: macMcpServers(),
              settings: {
                model,
                ...(effort ? { thinkingLevel: effort } : {}),
                fastMode,
              },
              nextRequestId: macNextRequestId,
              onArgvExtraction: (notes, extractedSettings) => {
                for (const note of notes) console.error(`aisdk-session ${sessionId}: ${note}`);
                if (extractedSettings && Object.keys(extractedSettings).length) {
                  macPendingFlagSettings = extractedSettings;
                }
              },
              onHandshake: (handshake) => {
                if (handshake.status === "ready") {
                  macReportInit("ready", { requestId: handshake.requestId, pid: handshake.pid, cwd: handshake.cwd });
                } else {
                  macReportInit("failed", {
                    requestId: handshake.requestId,
                    reason: [handshake.reason, handshake.detail].filter(Boolean).join(": ") || `remote weigerde (${handshake.status})`,
                  });
                }
              },
            }),
          }
        : {
            // Local route unchanged: settingSources honors ~/.claude config
            // (and loads filesystem skills); the omg MCP endpoint is
            // re-registered under this session's own URL.
            settingSources: ["user", "project"] as never[],
            ...omgMcpServers(sessionId),
          }),
      // stream_event partial messages drive the live draft in the web UI.
      includePartialMessages: true,
      ...(effort ? { effort } : {}),
      // env is a FULL replacement for the subprocess environment when set —
      // without a connected account, inherit process.env so the platform proxy
      // remains available. With a connected account, keep the full environment
      // except the three platform Anthropic variables that override the user's
      // ~/.claude/.credentials.json. (The old Vercel provider's sanitizing
      // allowlist dropped LFG_* and orphaned every lfg_create_subagent child.)
      ...(accountEnv ? { env: accountEnv } : {}),
      // MAC ROUTE: the explicit remote selector keeps the SDK from resolving
      // (and requiring) a LOCAL native claude binary before the custom spawn
      // runs — see MAC_CLAUDE_REMOTE_EXECUTABLE. Local/agentbox stays exactly
      // as it was: the resolved local claudePath when one exists.
      ...(executionHost === "mac"
        ? { pathToClaudeCodeExecutable: MAC_CLAUDE_REMOTE_EXECUTABLE }
        : executionHost === "agentbox" && claudePath
          ? { pathToClaudeCodeExecutable: claudePath }
          : {}),
    },
  });

  function handleMessage(msg: Record<string, unknown>): void {
    lastSdkEventAt = Date.now();
    // Proof the runtime actually spoke. A stream that ends having produced
    // nothing at all never started, which is a different failure from one that
    // started and later died — and only the first is explained by missing auth.
    sdkMessagesSeen++;
    const type = msg.type as string;
    if (type === "stream_event") {
      setBusy(true);
      // Only the top-level assistant stream feeds the draft; subagent/tool
      // streams carry a parent_tool_use_id.
      if (msg.parent_tool_use_id != null) return;
      const event = msg.event as { type?: string; delta?: { type?: string; text?: string } };
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const delta = event.delta.text ?? "";
        if (delta) {
          draft += delta;
          publishDraft(draft);
        }
      }
      return;
    }
    if (type === "system" && (msg as { subtype?: string }).subtype === "init") {
      return;
    }
    if (type === "assistant" || type === "user") {
      setBusy(true);
      const messages = normalizeSdkEnvelope(msg);
      if (messages.length) {
        if (type === "user") userRows.sdk(messages);
        else indexSessionMessagesDirect(sessionId, messages);
      }
      // A finalized assistant message supersedes the streamed draft. Without
      // this reset the draft accumulates EVERY text block of a long multi-tool
      // turn (it only cleared on `result`), so the live view rendered one
      // ever-growing blob duplicating the already-indexed messages.
      if (type === "assistant" && messages.some((m) => m.kind === "text") && draft) {
        draft = "";
        publishDraft("", true);
      }
      return;
    }
    if (type === "result") {
      // The CLI's interrupt marker is part of the interrupted turn and arrives
      // before its result. Commit a steering row only after that boundary when
      // the SDK did not already echo the row itself.
      userRows.turnEnded();
      interruptedTurnOpen = false;
      const result = msg as {
        usage?: Record<string, unknown>;
        total_cost_usd?: number;
      };
      const usage = result.usage;
      if (usage) {
        const input = Number(usage.input_tokens) || 0;
        const output = Number(usage.output_tokens) || 0;
        const cacheRead = Number(usage.cache_read_input_tokens) || 0;
        const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
        sessionTotals.input += input;
        sessionTotals.output += output;
        sessionTotals.cacheRead += cacheRead;
        sessionTotals.cacheWrite += cacheWrite;
        sessionTotals.total += input + output + cacheRead + cacheWrite;
        sessionTotals.costUsd = (sessionTotals.costUsd ?? 0) + (Number(result.total_cost_usd) || 0);
        persistUsage();
        refreshUsageSnapshot();
      }
      if ((msg as { subtype?: string }).subtype !== "success") {
        // Every harness logs into the one serve journal, so a line identifying
        // the turn only by pid meant cross-referencing timestamps by hand to
        // find out WHICH session had died. Name it.
        console.error(
          `aisdk-session ${sessionId} turn ended with error: ${describeAisdkFailure(msg).slice(0, 2000)}`,
        );
      }
      draft = "";
      publishDraft("", true);
      setBusy(false);
      return;
    }
  }

  function send(text: string, afterInterrupt = false): void {
    draft = "";
    publishDraft("", true);
    setBusy(true);
    userRows.send(text, afterInterrupt);
    // MAC ROUTE: the fresh central context rides EVERY provider-facing turn
    // (a resumed claude keeps its first stored system prompt, and prompt text
    // may never ride argv — WIRE-RECONCILIATION defect 2/3). The central
    // transcript keeps the CLEAN user text; only the provider sees the
    // wrapper, rebuilt from disk at every send. Item 35: a REQUIRED
    // instruction failure REFUSES this turn before any provider input — the
    // session stays alive for later turns (a fixed source unblocks the next
    // send) and the refusal carries the failing path+reason, never content.
    if (executionHost !== "mac") {
      input.push(text);
      return;
    }
    let preamble: string;
    try {
      preamble = macPreamble();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`aisdk-session ${sessionId}: beurt GEWEIGERD — ${reason}`);
      publishDraft(`Mac-route geweigerd: ${reason}`, true);
      setBusy(false);
      return;
    }
    input.push(`${preamble}\n\n${text}`);
  }

  function shutdown(): void {
    if (closing) return;
    closing = true;
    input.close();
    void q.interrupt().catch(() => {});
    // Fallback if the SDK loop doesn't wind down promptly.
    setTimeout(() => {
      removeEntry(sessionId);
      process.exit(0);
    }, 1500);
  }

  function restartSilentRuntime(): void {
    if (restartRequested || closing) return;
    restartRequested = true;
    const silentSeconds = Math.round((Date.now() - lastSdkEventAt) / 1000);
    console.error(
      `aisdk-session ${sessionId}: SDK stream silent ${silentSeconds}s while busy; restarting runtime`,
    );
    draft = "";
    publishDraft("", true);
    setBusy(false);
    // Route sends that arrive during close/recreate to the next query. Only
    // locally buffered messages move; the stuck in-flight prompt is not replayed.
    const previousInput = input;
    input = new InputChannel();
    previousInput.handoffTo(input);
    q.close();
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") {
      if (cmd.text.trim()) send(cmd.text, interruptedTurnOpen);
    } else if (cmd.type === "interrupt") {
      interruptedTurnOpen = true;
      void q.interrupt().catch(() => {
        interruptedTurnOpen = false;
        userRows.turnEnded();
      });
    } else if (cmd.type === "set_thinking_level") {
      const nextEffort = effortFor(cmd.thinkingLevel);
      // The query launch option accepts `max`, but the SDK's documented live
      // Settings layer currently stops at `xhigh`.
      if (!nextEffort || nextEffort === "max") return;
      // Claude's streaming SDK exposes live flag settings on the same process.
      // effortLevel is the setting behind the interactive `/effort` command;
      // applying it here changes subsequent turns without adding a fake chat
      // message or restarting the conversation.
      void q.applyFlagSettings({ effortLevel: nextEffort }).then(() => {
        patchEntry(sessionId, { thinkingLevel: cmd.thinkingLevel });
      }).catch((error) => {
        console.error(`aisdk-session thinking-level change failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (cmd.type === "set_fast_mode") {
      void q.applyFlagSettings({ fastMode: cmd.enabled }).then(() => {
        fastMode = cmd.enabled;
        patchEntry(sessionId, { fastMode });
      }).catch((error) => {
        console.error(`aisdk-session Fast-mode change failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (cmd.type === "close") {
      shutdown();
    }
  }

  // Tail the command file by BYTE offset. Polling (vs fs.watch) is simpler and
  // reliable across editors/filesystems; 250ms is well within interactive feel.
  // See cmd-tail.ts for why the arithmetic must stay in bytes — mixing bytes and
  // UTF-16 lengths used to rewind the cursor to 0 and replay the entire command
  // history as new turns.
  const cmdFile = cmdPath(sessionId);
  let cmdOffset = initialCmdOffset(cmdFile);
  writeCursor(cmdFile, cmdOffset);
  const poll = setInterval(() => {
    const { lines, offset } = readNewCmdLines(cmdFile, cmdOffset);
    if (offset === cmdOffset && !lines.length) return;
    cmdOffset = offset;
    for (const line of lines) {
      try {
        const command = JSON.parse(line) as AisdkCommand;
        dispatch(command);
      } catch {}
    }
    // Record what we consumed so a restart resumes here rather than re-reading
    // delivered commands or skipping ones queued while this process was down.
    writeCursor(cmdFile, cmdOffset);
  }, 250);

  const watchdog = setInterval(() => {
    if (isAisdkStreamStalled({
      busy,
      closing,
      restartRequested,
      lastSdkEventAt,
      now: Date.now(),
    })) restartSilentRuntime();
  }, AISDK_STREAM_WATCHDOG_TICK_MS);

  // First message, if any, kicks off the conversation immediately.
  if (initialPrompt) send(initialPrompt);

  // The SDK message loop IS the session lifetime: it ends when the input
  // channel closes (shutdown) or the subprocess dies.
  let runtimeGeneration = 0;
  let unexpectedExit = false;
  // What killed it, in the user's words. Written to the transcript on the way
  // out so the session shows a reason instead of thinking dots forever.
  let exitExplanation: string | null = null;
  try {
    while (!closing) {
      // startQuery can throw SYNCHRONOUSLY, before any stream exists — the SDK
      // resolves its native binary here, so a bundle without one dies on this
      // line. That throw used to escape the inner try (which only wraps the
      // `for await`) and land in the outer `finally`, whose process.exit()
      // discarded it: exit 1, no stdout, no stderr, no transcript. The session
      // showed thinking dots forever because nothing was ever told otherwise.
      try {
        q = startQuery(resuming || runtimeGeneration > 0);
        // MAC ROUTE: fastMode (and any settings extracted off the native
        // argv) are applied through the SDK's native live flag channel — the
        // transport schema refuses `--settings` on argv, so this is the only
        // faithful way the setting reaches the remote provider.
        if (executionHost === "mac") {
          const flags: Record<string, unknown> = { ...(macPendingFlagSettings ?? {}) };
          if (fastMode !== undefined) flags.fastMode = fastMode;
          if (Object.keys(flags).length) {
            void q.applyFlagSettings(flags as never).catch((error) => {
              console.error(`aisdk-session ${sessionId}: applyFlagSettings faalde: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
          macPendingFlagSettings = null;
        }
      } catch (error) {
        exitExplanation = describeAisdkStreamEnd({
          turns: sdkMessagesSeen,
          error,
          claudePath,
          accountConnected: !!account,
        });
        console.error(`aisdk-session: ${exitExplanation}`);
        unexpectedExit = true;
        break;
      }
      restartRequested = false;
      try {
        for await (const msg of q) {
          handleMessage(msg as unknown as Record<string, unknown>);
        }
      } catch (error) {
        if (closing) break;
        if (!restartRequested) {
          console.error(`aisdk-session: query loop failed: ${error instanceof Error ? error.message : error}`);
          if (error instanceof Error) console.error(error.stack?.split("\n").filter(line => /^\s*at /.test(line)).slice(0, 12).join("\n"));
          exitExplanation = describeAisdkStreamEnd({
            turns: sdkMessagesSeen,
            error,
            claudePath,
            accountConnected: !!account,
          });
          if (error instanceof Error && error.name === "TranscriptPersistenceError") exitExplanation = error.message;
          unexpectedExit = true;
          break;
        }
      }
      if (closing) break;
      if (restartRequested) {
        runtimeGeneration++;
        lastSdkEventAt = Date.now();
        continue;
      }
      // MAC ROUTE: an idle provider may be closed by the Mac supervisor
      // (power/idle policy). A stream that ends while NOT busy and with no
      // turns in flight is that cleanup, not a failure: silently re-open
      // with NATIVE RESUME (`resume: sessionId` — the conversation lives on
      // the Mac) and keep serving. No user message is replayed; only the
      // locally buffered queue moves to the new query.
      if (executionHost === "mac" && !busy && sdkMessagesSeen > 0) {
        console.error(`aisdk-session ${sessionId}: mac-stream eindigde in rust; heropen met native resume`);
        // Bounded backoff: a supervisor that keeps closing idle streams must
        // not produce a hot reconnect loop.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        runtimeGeneration++;
        lastSdkEventAt = Date.now();
        continue;
      }
      // The stream ended without throwing. Nothing above has said anything, so
      // this is the branch that used to exit 1 in total silence.
      exitExplanation = describeAisdkStreamEnd({
        turns: sdkMessagesSeen,
        claudePath,
        accountConnected: !!account,
      });
      console.error(`aisdk-session: ${exitExplanation}`);
      unexpectedExit = true;
      break;
    }
  } finally {
    clearInterval(poll);
    clearInterval(watchdog);
    userRows.turnEnded();
    // A transcript row is the only channel the web UI actually reads. Stamp it
    // as an api error so computeStatus turns the session "blocked" with a
    // reason, rather than leaving it to spin.
    if (exitExplanation) {
      try {
        indexSessionMessagesDirect(sessionId, [{
          id: crypto.randomUUID(),
          role: "assistant",
          kind: "text",
          text: exitExplanation,
          ts: Date.now(),
          apiError: true,
        }]);
      } catch {}
    }
    removeEntry(sessionId);
    process.exit(closing && !unexpectedExit ? 0 : 1);
  }
}

// Run directly: `bun src/agents/backends/aisdk-session.ts --session <uuid> ...`.
// Spawned standalone by spawnManagedAisdkSession (not via the lfg CLI) so the
// harness has no dependency on the rest of the command surface.
if (import.meta.main) {
  cmdAisdkSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
