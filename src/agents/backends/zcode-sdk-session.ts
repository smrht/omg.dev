// Z.ai ZCode as an omg coding agent (agentbox overlay, 25-10-2026).
//
// ZCode exposes no ACP and no SDK; its documented automation surface is the
// headless CLI: one `zcode --prompt` process per turn, continued with
// `--resume <sess_...>`, streaming NDJSON with `--output-format stream-json`.
// This harness maps that stream onto the shared managed-SDK lifecycle.
//
// Model + reasoning level have no CLI flag. They live in ZCode's personal
// provider file, so every omg session gets its own copy (mode 0600, key
// included) with `defaultModelSelection` set, pointed at by
// ZCODE_PERSONAL_PROVIDER_CONFIG_FILE. The shared file stays the source of the
// provider/key. omg MCP tools come from ~/.zcode/cli/config.json (stdio
// `omg mcp`), which resolves the session from the inherited env.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { patchEntry } from "../../aisdk-registry.ts";
import { readStoredSessionTokenUsage, writeStoredSessionTokenUsage, type StoredSessionTokenUsage } from "../../session-token-usage.ts";
import { PATHS } from "../../config.ts";
import { runManagedSdkSession, type ManagedSdkEventSink } from "./managed-sdk-session.ts";

export const ZCODE_DEFAULT_PROVIDER = "zaiplan";

function arg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function zcodeBinary(): string {
  const home = homedir();
  for (const candidate of [`${home}/.local/bin/zcode`, "/usr/local/bin/zcode"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "zcode";
}

/** `zaiplan/glm-5.3` -> provider + model; a bare id uses the default provider. */
export function splitZcodeModel(model: string | undefined): { providerId: string; modelId: string } | null {
  const raw = (model ?? "").trim();
  if (!raw || raw === "auto") return null;
  const slash = raw.indexOf("/");
  if (slash < 0) return { providerId: ZCODE_DEFAULT_PROVIDER, modelId: raw };
  return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

/** A per-session copy of the shared provider file with the chosen model selected. */
export function zcodeProviderConfig(
  shared: unknown,
  model: string | undefined,
  thinkingLevel: string | undefined,
): unknown {
  const doc = JSON.parse(JSON.stringify(shared ?? {})) as {
    config?: { defaultModelSelection?: { providerId?: string; modelId?: string; options?: Record<string, unknown> } };
  };
  if (!doc.config) return doc;
  const current = doc.config.defaultModelSelection ?? {};
  const picked = splitZcodeModel(model);
  const next = picked ? { ...current, providerId: picked.providerId, modelId: picked.modelId } : { ...current };
  const options = { ...(next.options ?? {}) };
  if (thinkingLevel) options.reasoningLevel = thinkingLevel;
  else delete options.reasoningLevel;
  next.options = options;
  doc.config.defaultModelSelection = next;
  return doc;
}

type StreamEvent = {
  type?: string;
  sessionId?: string;
  response?: string;
  usage?: Record<string, unknown>;
  projection?: { contextUsed?: number; contextWindow?: number };
  payload?: Record<string, any>;
};

export type ZcodeTurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  contextUsed: number | null;
  contextWindow: number | null;
};

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type ZcodeTurnState = {
  draft: string;
  thought: string;
  committed: boolean;
  sessionId: string | null;
  response: string | null;
  resultType: string | null;
  tools: Map<string, string>;
  usage: ZcodeTurnUsage | null;
};

export function newZcodeTurnState(sessionId: string | null): ZcodeTurnState {
  return { draft: "", thought: "", committed: false, sessionId, response: null, resultType: null, tools: new Map(), usage: null };
}

/** Apply one stream-json event to the sink. Exported for tests. */
export function applyZcodeEvent(event: StreamEvent, sink: ManagedSdkEventSink, state: ZcodeTurnState): void {
  if (event.sessionId && !state.sessionId) state.sessionId = event.sessionId;
  const p = event.payload ?? {};
  switch (event.type) {
    case "model.streaming":
      if (p.kind === "text_delta" && typeof p.delta === "string") {
        state.draft += p.delta;
        sink.draft(state.draft);
      } else if (p.kind === "reasoning_delta" && typeof p.delta === "string") {
        state.thought += p.delta;
        sink.thinking(state.thought);
      }
      return;
    case "tool.updated": {
      const id = typeof p.toolCallId === "string" ? p.toolCallId : null;
      if (!id) return;
      if (p.kind === "scheduled") {
        if (state.draft.trim()) {
          sink.commitText(state.draft);
          state.committed = true;
        }
        state.draft = "";
        const name = typeof p.toolName === "string" ? p.toolName : "tool";
        state.tools.set(id, name);
        sink.toolStart(id, name, p.input);
      } else if (p.kind === "result") {
        const name = state.tools.get(id) ?? (typeof p.toolName === "string" ? p.toolName : "tool");
        const result = (p.result ?? {}) as { success?: boolean; content?: unknown; error?: unknown };
        sink.toolEnd(id, name, result.content ?? result.error ?? result, result.success === false);
      }
      return;
    }
    case "turn.completed":
      if (typeof p.resultType === "string") state.resultType = p.resultType;
      if (typeof p.response === "string") state.response = p.response;
      return;
    case "result": {
      if (typeof event.response === "string") state.response = event.response;
      const u = event.usage;
      if (u) {
        // ZCode reports Anthropic-style totals where inputTokens includes the
        // cached prefix; omg keeps fresh input and cache reads apart.
        const cacheRead = n(u.cacheReadTokens);
        state.usage = {
          input: Math.max(0, n(u.inputTokens) - cacheRead),
          output: n(u.outputTokens),
          cacheRead,
          cacheWrite: n(u.cacheWriteTokens),
          reasoning: n(u.reasoningTokens),
          total: n(u.totalTokens),
          contextUsed: typeof event.projection?.contextUsed === "number" ? event.projection.contextUsed : null,
          contextWindow: typeof event.projection?.contextWindow === "number" ? event.projection.contextWindow : null,
        };
      }
      return;
    }
    default:
      return;
  }
}

/** Text the shared lifecycle should commit as the turn's final assistant row. */
export function finalZcodeText(state: ZcodeTurnState): string {
  if (state.draft.trim()) return state.draft;
  if (!state.committed && state.response) return state.response;
  return "";
}

/** Fold one turn's usage into the session's stored snapshot. Exported for tests. */
export function mergeZcodeUsage(
  previous: StoredSessionTokenUsage | null,
  turn: ZcodeTurnUsage,
  model: string,
  now = Date.now(),
): StoredSessionTokenUsage {
  const t = previous?.totals ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: null };
  const totals = {
    input: t.input + turn.input,
    output: t.output + turn.output,
    cacheRead: t.cacheRead + turn.cacheRead,
    cacheWrite: t.cacheWrite + turn.cacheWrite,
    reasoning: t.reasoning + turn.reasoning,
    total: t.total + turn.total,
    // Flat-rate Coding Plan: there is no per-token price to show.
    costUsd: null,
  };
  const context =
    turn.contextUsed != null && turn.contextWindow
      ? {
          categories: [],
          totalTokens: turn.contextUsed,
          maxTokens: turn.contextWindow,
          rawMaxTokens: turn.contextWindow,
          percentage: (turn.contextUsed / turn.contextWindow) * 100,
          model,
        }
      : previous?.context ?? null;
  return { updatedAt: now, model, context, totals, reporter: "ZCode" };
}

export function zcodeTurnArgv(binary: string, prompt: string, cwd: string, sessionId: string | null): string[] {
  const argv = [binary, "--prompt", prompt, "--cwd", cwd, "--mode", "yolo", "--output-format", "stream-json", "--no-color"];
  if (sessionId) argv.push("--resume", sessionId);
  return argv;
}

export async function cmdZcodeSdkSession(argv: string[]): Promise<void> {
  const key = arg(argv, "--key");
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const model = arg(argv, "--model") ?? "auto";
  const managedName = arg(argv, "--managed-name") ?? "";
  const resume = arg(argv, "--resume");
  const thinkingLevel = arg(argv, "--thinking-level");
  const recoveredAt = Number(arg(argv, "--recovered-at")) || null;
  const separator = argv.indexOf("--");
  const initialPrompt = separator >= 0 ? argv.slice(separator + 1).join(" ").trim() : "";
  if (!key) throw new Error("zcode-sdk-session: --key <uuid> is required");

  await runManagedSdkSession({
    key,
    agent: "zcode",
    cwd,
    model,
    managedName,
    resume,
    thinkingLevel,
    recoveredAt,
    initialPrompt,
    async createRuntime() {
      const binary = zcodeBinary();
      const sessionHome = join(PATHS.data, "zcode-sdk", key);
      await mkdir(sessionHome, { recursive: true, mode: 0o700 });
      const providerFile = join(sessionHome, "provider_config.json");
      const sharedFile = join(homedir(), ".zcode", "v2", "provider_config.json");
      let currentModel = model;
      let currentThinking = thinkingLevel;
      const writeProviderFile = async () => {
        let shared: unknown = {};
        try {
          shared = JSON.parse(readFileSync(sharedFile, "utf8"));
        } catch (error) {
          throw new Error(`ZCode provider config missing or unreadable at ${sharedFile}: ${(error as Error).message}`);
        }
        await writeFile(providerFile, JSON.stringify(zcodeProviderConfig(shared, currentModel, currentThinking)), { mode: 0o600 });
        await chmod(providerFile, 0o600);
      };
      await writeProviderFile();

      let sessionId: string | null = resume ?? null;
      let child: ChildProcess | null = null;
      let interrupted = false;

      return {
        nativeSessionId: sessionId ?? "",
        async runTurn(prompt, sink) {
          interrupted = false;
          const state = newZcodeTurnState(sessionId);
          const [cmd, ...args] = zcodeTurnArgv(binary, prompt, cwd, sessionId);
          const proc = spawn(cmd!, args, {
            cwd,
            env: {
              ...process.env,
              OMG_SESSION_ID: process.env.OMG_SESSION_ID ?? process.env.LFG_SESSION_ID ?? key,
              ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerFile,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          child = proc;
          let stderr = "";
          let buffer = "";
          proc.stderr!.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-4000);
          });
          const handleLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) return;
            let event: StreamEvent;
            try {
              event = JSON.parse(trimmed) as StreamEvent;
            } catch {
              return;
            }
            applyZcodeEvent(event, sink, state);
            if (state.sessionId && state.sessionId !== sessionId) {
              sessionId = state.sessionId;
              patchEntry(key, { threadId: sessionId });
            }
          };
          proc.stdout!.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              handleLine(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
            }
          });
          const code = await new Promise<number | null>((resolve, reject) => {
            proc.once("error", reject);
            proc.once("close", (exitCode) => resolve(exitCode));
          });
          if (buffer.trim()) handleLine(buffer);
          child = null;
          if (state.usage) {
            try {
              writeStoredSessionTokenUsage(key, mergeZcodeUsage(readStoredSessionTokenUsage(key), state.usage, currentModel));
            } catch {}
          }
          const text = finalZcodeText(state);
          if (interrupted || state.resultType === "cancelled") {
            return { text: text || undefined, thinking: state.thought || undefined };
          }
          if (code !== 0 && !text) {
            const detail = stderr
              .split("\n")
              .filter((line) => line.trim() && !line.startsWith("ZCode Built-in"))
              .slice(-6)
              .join("\n");
            throw new Error(`zcode exited ${code}${detail ? `: ${detail}` : ""}`);
          }
          return { text, thinking: state.thought || undefined };
        },
        interrupt() {
          if (!child) return;
          interrupted = true;
          child.kill("SIGINT");
        },
        close() {
          child?.kill("SIGINT");
        },
        async setModel(next) {
          currentModel = next;
          await writeProviderFile();
        },
        async setThinkingLevel(next) {
          currentThinking = next;
          await writeProviderFile();
        },
      };
    },
  });
}

if (import.meta.main) {
  cmdZcodeSdkSession(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
