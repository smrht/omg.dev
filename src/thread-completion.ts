/**
 * The bounded, tool-less one-shot completion behind a thread's @omg replies.
 *
 * Every adapter here answers ONE prompt with ONE text on the box's own
 * connected account — never the hosted omg.dev chat endpoint, and never a
 * fallback to some other provider. A request it cannot serve safely is an
 * error the thread shows, not a quieter route taken instead:
 *
 *   - Claude ("claude"/"aisdk"): the installed, already-authenticated Claude
 *     CLI through the Agent SDK, with every built-in tool and every MCP server
 *     off and a single turn. An error result is a failure, never a partial
 *     success.
 *   - Codex ("codex"/"codex-aisdk"): one ephemeral Daybreak app-server turn
 *     (runCodexDaybreakTurn), which disables tool surfaces and every
 *     configured MCP server by name before the model runs. The routing
 *     instructions travel in the prompt; an explicit cyberAccessProgram is
 *     validated against live metadata before anything spawns.
 *   - OpenCode ("opencode"/"omg"): an isolated `opencode serve` this module
 *     owns, on 127.0.0.1: deny-all permissions (wildcard included), every
 *     configured MCP server disabled by name, the runtime's own tool list
 *     switched off per prompt, removed in `finally`, every call and the whole
 *     run under a hard timeout.
 *
 * Auth always comes from each CLI's existing config on this box. No
 * process.env is mutated, no credential file is copied or read, prompts travel
 * by stdin or SDK channel (never an interpolated shell string), and errors are
 * trimmed and redacted so a provider message cannot leak a secret into a
 * thread.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { THREAD_CHAT_AGENT_KEYS } from "../packages/protocol/src/threads.ts";
import { readModelDiscoveryCacheSync, type CodexModelCapabilities } from "./model-discovery.ts";
import type { ThreadPair } from "./thread-model.ts";

/** One chat reply is worth waiting for, and no longer. */
export const THREAD_COMPLETION_TIMEOUT_MS = 90_000;

export type ThreadCompletionInput = {
  agent: string;
  model: string;
  thinkingLevel?: string | null;
  system: string;
  user: string;
  cwd?: string | null;
  /** Explicit cyber access program (Codex family only), validated before spawn. */
  cyberAccessProgram?: string | null;
};

/** Error text a thread can show: whitespace-collapsed, capped, and stripped of anything secret-shaped. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /(api[_-]?key|token|secret|password)["':=\s]+[^\s"']{6,}/gi,
];

export function visibleCompletionError(error: unknown, fallback = "the reply failed"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Redact on the FULL text first: truncating first could cut a secret in
  // half and leave a prefix the patterns no longer recognize.
  let text = raw;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  text = text.replace(/\s+/g, " ").trim().slice(0, 300);
  return text || fallback;
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = THREAD_COMPLETION_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return work(controller.signal).finally(() => clearTimeout(timer));
}

/* -------------------------------------------------------------------------- */
/* Claude                                                                      */
/* -------------------------------------------------------------------------- */

/** Claude reasoning efforts the Agent SDK accepts; other levels collapse to the nearest. */
function claudeEffort(level?: string | null): string | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "minimal") return "low";
  return ["low", "medium", "high", "xhigh", "max"].includes(level) ? level : undefined;
}

/**
 * The exact Agent SDK options a thread reply runs with. Exported as the single
 * proof surface: no tools, no MCP servers (strict, so user settings cannot
 * add any), one turn, the chosen model and effort.
 */
export function claudeThreadQueryOptions(
  model: string,
  thinkingLevel: string | null | undefined,
  system: string,
): Record<string, unknown> {
  const effort = claudeEffort(thinkingLevel);
  return {
    model,
    systemPrompt: system,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: 1,
    ...(effort ? { effort } : {}),
  };
}

async function completeViaClaude(input: ThreadCompletionInput): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { resolveClaudePath } = await import("./agents/backends/claude-path.ts");
  const claudePath = resolveClaudePath();
  return withTimeout(async (signal) => {
    const abortController = new AbortController();
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const options = {
      ...claudeThreadQueryOptions(input.model, input.thinkingLevel, input.system),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      abortController,
    };
    let text = "";
    for await (const message of query({ prompt: input.user, options })) {
      if (message.type === "result") {
        // An error result is a failure: maxTurns, budget, execution. Never
        // read it as a partial success.
        if (message.subtype !== "success") {
          throw new Error(`claude (${input.model}) ended without an answer (${message.subtype})`);
        }
        text = message.result;
        break;
      }
    }
    if (!text.trim()) throw new Error(`claude (${input.model}) returned no text`);
    return text.trim();
  });
}

/* -------------------------------------------------------------------------- */
/* Codex, through one ephemeral Daybreak turn                                  */
/* -------------------------------------------------------------------------- */

/** Structural slice of codex-daybreak's DaybreakTurnInput; the module stays the owner. */
export type CodexDaybreakTurnInput = {
  prompt: string;
  model: string;
  effort?: string;
  cyberAccessProgram?: string;
  capabilities?: Record<string, CodexModelCapabilities>;
  cwd?: string;
  timeoutMs?: number;
};

export type CodexDaybreakRunner = (input: CodexDaybreakTurnInput) => Promise<{ text: string }>;

/** Injectable so tests capture the exact turn input without spawning codex. */
let codexTurnRunner: CodexDaybreakRunner = (input) =>
  import("./codex-daybreak.ts").then((module) => module.runCodexDaybreakTurn(input) as Promise<{ text: string }>);

export function setCodexTurnRunnerForTests(runner: CodexDaybreakRunner | null): void {
  codexTurnRunner = runner ?? ((input) =>
    import("./codex-daybreak.ts").then((module) => module.runCodexDaybreakTurn(input) as Promise<{ text: string }>));
}

/** Live capability metadata for the Codex family, from the discovery cache. Never seeded statically. */
export function codexFamilyCapabilities(
  cache: { providers?: Record<string, { modelCapabilities?: Record<string, CodexModelCapabilities> } | undefined> } | null | undefined,
  key = "codex-aisdk",
): Record<string, CodexModelCapabilities> | undefined {
  return cache?.providers?.[key]?.modelCapabilities ?? undefined;
}

/** Efforts the Codex CLI documents, used ONLY when no live metadata exists for the model. */
const CODEX_STATIC_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * The effort sent to a Daybreak turn. An EXPLICIT level the model does not
 * offer is a visible error, never a silent downgrade to the account default.
 * Live metadata (which may carry fresh levels like "ultra") is authoritative;
 * the static vocabulary is the fallback only when metadata is absent.
 */
export function codexThreadEffort(
  model: string,
  level: string | null | undefined,
  capabilities: Record<string, CodexModelCapabilities> | undefined,
): string | undefined {
  if (!level) return undefined;
  const offered = capabilities?.[model]?.reasoningEfforts;
  if (offered?.length) {
    if (offered.includes(level)) return level;
    throw new Error(`thinking level "${level}" is not offered by ${model} (offered: ${offered.join(", ")}); pick another level for this thread`);
  }
  if (CODEX_STATIC_EFFORTS.includes(level)) return level;
  throw new Error(`thinking level "${level}" is not supported by codex ${model}`);
}

/**
 * The exact Daybreak turn a Codex thread reply runs: the routing instructions
 * (system) lead the prompt, the program only when one was explicitly chosen.
 * Absent program field = automatic, preserving the account's standard default.
 */
export function codexDaybreakInput(
  input: ThreadCompletionInput,
  capabilities: Record<string, CodexModelCapabilities> | undefined = codexFamilyCapabilities(readModelDiscoveryCacheSync()),
): CodexDaybreakTurnInput {
  const effort = codexThreadEffort(input.model, input.thinkingLevel, capabilities);
  return {
    prompt: `${input.system}\n\n---\n\n${input.user}`,
    model: input.model,
    ...(effort ? { effort } : {}),
    ...(input.cyberAccessProgram ? { cyberAccessProgram: input.cyberAccessProgram, ...(capabilities ? { capabilities } : {}) } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}

async function completeViaCodex(input: ThreadCompletionInput): Promise<string> {
  const result = await codexTurnRunner(codexDaybreakInput(input));
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  if (!text) throw new Error(`codex (${input.model}) returned no text`);
  return text;
}

/* -------------------------------------------------------------------------- */
/* OpenCode (opencode and the omg agent kind, which runs through it)            */
/* -------------------------------------------------------------------------- */

/** The deny-everything permission table, wildcard included so nothing new slips past. */
const OPENCODE_DENY_PERMISSIONS = {
  "*": "deny",
  edit: "deny",
  bash: "deny",
  webfetch: "deny",
  doom_loop: "deny",
  external_directory: "deny",
} as const;

/** Known built-in tools, switched off in the server config as the static floor. */
const OPENCODE_TOOLS_OFF = {
  bash: false,
  edit: false,
  write: false,
  patch: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  webfetch: false,
  todowrite: false,
  todocreate: false,
  todoread: false,
  task: false,
} as const;

/** Any config source larger than this is refused, not partially read. */
const OPENCODE_CONFIG_MAX_BYTES = 256 * 1024;
/** stdout we scan for the listening line, and stderr we drain, both bounded. */
const OPENCODE_OUTPUT_MAX_BYTES = 64 * 1024;

/** MCP server names in one opencode config (JSON/JSONC text). Unparseable or oversized is UNSAFE. */
export function opencodeConfiguredMcpServers(configText: string | null | undefined): { servers: string[]; unsafe: string | null } {
  if (!configText?.trim()) return { servers: [], unsafe: null };
  if (configText.length > OPENCODE_CONFIG_MAX_BYTES) {
    return { servers: [], unsafe: "a config source is larger than the read bound" };
  }
  try {
    // Strip // and /* */ comments, then parse as JSON. A config we cannot
    // fully understand is UNSAFE, never "probably no MCP": the whole point is
    // proving no MCP server survives into the chat.
    // Preserve quoted strings, including URLs and comment-like server names.
    const cleaned = configText.replace(
      /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
      token => token.startsWith('"') ? token : " ",
    ).replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : "");
    const parsed = JSON.parse(cleaned) as { mcp?: Record<string, unknown> };
    const mcp = parsed?.mcp;
    if (!mcp || typeof mcp !== "object") return { servers: [], unsafe: null };
    return { servers: Object.keys(mcp), unsafe: null };
  } catch {
    return { servers: [], unsafe: "a config source could not be parsed" };
  }
}

/** One file-backed config source: absent, read-bounded, or unsafe. Never returns file CONTENTS. */
function scanConfigFile(path: string, label: string): { servers: string[]; unsafe: string | null } {
  let text: string;
  try {
    if (!existsSync(path)) return { servers: [], unsafe: null };
    const stat = Bun.file(path);
    if (stat.size > OPENCODE_CONFIG_MAX_BYTES) {
      return { servers: [], unsafe: `${label} is larger than the read bound` };
    }
    text = readFileSync(path, "utf8");
  } catch {
    return { servers: [], unsafe: `${label} could not be read` };
  }
  const scanned = opencodeConfiguredMcpServers(text);
  return scanned.unsafe ? { servers: [], unsafe: `${label}: ${scanned.unsafe}` } : scanned;
}

/**
 * Every MCP server name OpenCode itself would merge for a chat like ours,
 * read from the SAME sources its loader reads: the global config files
 * (config.json, opencode.json, opencode.jsonc), the explicit OPENCODE_CONFIG
 * path, and OPENCODE_CONFIG_CONTENT from the environment. Project config is
 * excluded on purpose: the child runs with OPENCODE_DISABLE_PROJECT_CONFIG,
 * so it is inert. Returns UNSAFE (fail closed) when any source that exists
 * cannot be read or parsed — an unreadable config may hide a server name,
 * and a chat that could leave MCP enabled is refused, not guessed at.
 * Never returns or logs config text: only server names and a label.
 */
export function scanOpencodeMcpSources(env: Record<string, string | undefined> = process.env): { servers: string[]; unsafe: string | null } {
  const configRoot = join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "opencode");
  const sources: Array<{ servers: string[]; unsafe: string | null }> = [];
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    sources.push(scanConfigFile(join(configRoot, name), `global config ${name}`));
  }
  if (existsSync(join(configRoot, "config"))) {
    return { servers: [], unsafe: "legacy TOML config requires migration before a tool-less chat" };
  }
  const customDir = env.OPENCODE_CONFIG_DIR?.trim();
  if (customDir) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      sources.push(scanConfigFile(join(customDir, name), `OPENCODE_CONFIG_DIR ${name}`));
    }
  }
  const explicit = env.OPENCODE_CONFIG?.trim();
  if (explicit) sources.push(scanConfigFile(explicit, "OPENCODE_CONFIG"));
  const content = env.OPENCODE_CONFIG_CONTENT;
  if (content?.trim()) {
    const scanned = opencodeConfiguredMcpServers(content);
    sources.push(scanned.unsafe ? { servers: [], unsafe: `OPENCODE_CONFIG_CONTENT: ${scanned.unsafe}` } : scanned);
  }
  const unsafe = sources.find((row) => row.unsafe)?.unsafe ?? null;
  if (unsafe) return { servers: [], unsafe };
  return { servers: [...new Set(sources.flatMap((row) => row.servers))], unsafe: null };
}

/**
 * The server-level OpenCode config a thread reply runs under: every permission
 * denied (wildcard included), every known tool off, every MCP server from
 * every merged source disabled BY NAME (so no MCP child is ever spawned for a
 * chat), sharing off. The provider/auth blocks of the box's own configs are
 * never touched — this only subtracts capabilities, on top of them.
 */
export function opencodeThreadServerConfig(mcpServers: readonly string[] = []): Record<string, unknown> {
  return {
    permission: { ...OPENCODE_DENY_PERMISSIONS },
    tools: { ...OPENCODE_TOOLS_OFF },
    ...(mcpServers.length
      ? { mcp: Object.fromEntries(mcpServers.map((name) => [name, { enabled: false }])) }
      : {}),
    share: "disabled",
    autoupdate: false,
  };
}

/** "provider/model-id" (or omg's "omg/vendor/id") split at the first slash, as the SDK wants it. */
export function opencodeModelRef(model: string): { providerID: string; modelID: string } | undefined {
  const i = model.indexOf("/");
  if (i <= 0) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/**
 * The prompt body a thread reply sends: the routing instructions in the body's
 * own `system` field, the model, its thinking variant, and the runtime's own
 * tool ids switched off for this one prompt.
 */
export function opencodeThreadPromptBody(
  model: string,
  thinkingLevel: string | null | undefined,
  system: string,
  user: string,
  toolIds: readonly string[] = [],
): Record<string, unknown> {
  const ref = opencodeModelRef(model);
  return {
    ...(ref ? { model: ref } : {}),
    ...(thinkingLevel ? { variant: thinkingLevel } : {}),
    system,
    ...(toolIds.length ? { tools: Object.fromEntries(toolIds.map((id) => [id, false])) } : {}),
    parts: [{ type: "text", text: user }],
  };
}

function resolveOpencodeBinary(): string | undefined {
  const { LFG_OPENCODE_PATH, PATH } = process.env;
  try {
    if (LFG_OPENCODE_PATH) return LFG_OPENCODE_PATH;
    const onPath = Bun.which("opencode", { PATH });
    if (onPath) return onPath;
    return join(import.meta.dir, "..", "node_modules", ".bin", "opencode");
  } catch {
    return undefined;
  }
}

/**
 * Kill the server we spawned, and only it. The child runs detached (setsid),
 * so it leads its OWN process group and a negative-pid signal reaches that
 * group alone — its children die with it, and no unrelated process is ever
 * signalled. TERM, a short grace, then KILL; always awaited. On Linux the
 * isolation worker's cgroup reaps anything the group missed.
 */
async function killProcessTree(proc: Bun.Subprocess): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };
  signalGroup("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(2_000)]);
  // The leader may have exited while a descendant still occupies its group.
  signalGroup("SIGKILL");
  await proc.exited.catch(() => {});
}

/** Read a stream up to a hard byte bound, then cancel it: chatty output cannot wedge or bloat the run. */
async function drainBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<void> {
  const reader = stream.getReader();
  try {
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value?.byteLength ?? 0;
      if (seen > limit) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  } catch {
    // A closed pipe is fine; it is only a drain.
  } finally {
    reader.releaseLock();
  }
}

/** The `opencode server listening on <url>` line, read as it is printed, bounded. */
function readServerUrl(proc: Bun.Subprocess, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const timer = setTimeout(() => done(new Error("opencode server did not start in time")), 20_000);
    const done = (error: Error | null, url?: string) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reader.cancel().catch(() => {});
      if (error) reject(error);
      else resolve(url!);
    };
    const onAbort = () => done(new Error("opencode server startup aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > OPENCODE_OUTPUT_MAX_BYTES) {
            done(new Error("opencode server produced no listening line"));
            return;
          }
          const match = buffer.match(/opencode server listening on (https?:\/\/\S+)/);
          if (match) {
            done(null, match[1]!);
            return;
          }
        }
        done(new Error("opencode server exited before listening"));
      } catch (error) {
        done(error instanceof Error ? error : new Error("opencode server output failed"));
      }
    })();
  });
}

async function completeViaOpencode(input: ThreadCompletionInput): Promise<string> {
  if (input.model.startsWith("omg/")) {
    const { ensureOmgProvider } = await import("./omg-provider.ts");
    ensureOmgProvider();
  }
  const binary = resolveOpencodeBinary();
  if (!binary) throw new Error("opencode binary not found for thread replies");
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const cwd = input.cwd || homedir();
  // Fail closed BEFORE spawning: a config source we cannot fully read may hide
  // an MCP server name, and a chat that could leave MCP enabled is refused.
  // The scan never surfaces config text, only server names or a label.
  const scan = scanOpencodeMcpSources(process.env);
  if (scan.unsafe) {
    throw new Error(`opencode chat refuses to run: ${scan.unsafe}; refusing a reply that could leave MCP enabled`);
  }
  const ref = opencodeModelRef(input.model);
  if (!ref) {
    throw new Error(`opencode model "${input.model}" has no provider prefix, so its tool list cannot be proven off`);
  }
  const proc = Bun.spawn([binary, "serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd,
    env: {
      ...process.env,
      // Fresh object: process.env itself is never mutated. Project config is
      // inert for this chat only (documented flag); the box's own provider
      // and auth configs still load untouched.
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeThreadServerConfig(scan.servers)),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Own session and process group: cleanup can signal the group alone.
    detached: true,
  });
  // Drain stderr, bounded, so a chatty server cannot block or bloat the run.
  void drainBounded(proc.stderr as ReadableStream<Uint8Array>, OPENCODE_OUTPUT_MAX_BYTES);
  let sessionId: string | null = null;
  let client: Awaited<ReturnType<typeof createOpencodeClient>> | null = null;
  try {
    return await withTimeout(async (signal) => {
      // Every request the client makes — create, tool.list, prompt — carries
      // the run's own deadline, so a hung call cannot outlive the turn.
      const boundedFetch = ((inputUrl: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(inputUrl, { ...init, signal })) as unknown as typeof fetch;
      const url = await readServerUrl(proc, signal);
      client = createOpencodeClient({ baseUrl: url, fetch: boundedFetch } as never);
      const created = await client.session.create({ body: {}, query: { directory: cwd } });
      if (created.error || !created.data?.id) {
        throw new Error(`opencode session.create failed: ${JSON.stringify(created.error).slice(0, 200)}`);
      }
      sessionId = created.data.id;
      // The runtime's OWN tool list for this model, switched off per prompt.
      // This is mandatory, not best-effort: without it we cannot prove which
      // tools exist, and a reply with unknown tools enabled is refused BEFORE
      // any prompt is sent.
      const tools = await client.tool.list({ query: { directory: cwd, provider: ref.providerID, model: ref.modelID } });
      if (tools.error || !Array.isArray(tools.data)) {
        throw new Error(`opencode tool discovery failed for ${input.model}; refusing a reply with unknown tools`);
      }
      const toolIds = tools.data.map((tool) => tool.id).filter((id) => typeof id === "string");
      const res = (await client.session.prompt({
        path: { id: sessionId },
        query: { directory: cwd },
        body: opencodeThreadPromptBody(input.model, input.thinkingLevel, input.system, input.user, toolIds) as never,
      })) as { error?: unknown; data?: { parts?: Array<{ type?: string; text?: string }> } };
      if (res.error) throw new Error(`opencode prompt failed: ${JSON.stringify(res.error).slice(0, 200)}`);
      const text = (res.data?.parts ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      if (!text) throw new Error(`opencode (${input.model}) returned no text`);
      return text;
    });
  } finally {
    // Bounded cleanup, always run and always awaited: the session we made is
    // removed, and the server tree we spawned is gone before we return.
    // (The client was created inside the timeout callback, so the narrowing
    // here is by cast, not by flow.)
    const made = client as Awaited<ReturnType<typeof createOpencodeClient>> | null;
    if (made && sessionId) {
      await Promise.race([
        made.session
          .delete({ path: { id: sessionId } })
          .catch(() => {})
          .then(() => {}, () => {}),
        Bun.sleep(10_000),
      ]);
    }
    await killProcessTree(proc);
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

export type ThreadCompletionAdapters = {
  claude: (input: ThreadCompletionInput) => Promise<string>;
  codex: (input: ThreadCompletionInput) => Promise<string>;
  opencode: (input: ThreadCompletionInput) => Promise<string>;
};

export const threadCompletionAdapters: ThreadCompletionAdapters = {
  claude: completeViaClaude,
  codex: completeViaCodex,
  opencode: completeViaOpencode,
};

function adapterKeyFor(agent: string): keyof ThreadCompletionAdapters | null {
  if (agent === "claude" || agent === "aisdk") return "claude";
  if (agent === "codex" || agent === "codex-aisdk") return "codex";
  if (agent === "opencode" || agent === "omg") return "opencode";
  return null;
}

/** The adapter families a key maps to, for tests and error text. */
export function threadCompletionAdapterKey(agent: string): keyof ThreadCompletionAdapters | null {
  return adapterKeyFor(agent);
}

/** Whether this dispatch must run inside the isolation worker. Pure, so tests can pin it. */
export function threadCompletionNeedsIsolation(platform: NodeJS.Platform, contained: boolean): boolean {
  return platform === "linux" && !contained;
}

export type ThreadCompletionDispatch = {
  adapters?: ThreadCompletionAdapters;
  /** True only inside the isolation worker, where the dispatch must stay local. */
  contained?: boolean;
  /** Platform override for tests; defaults to this process. */
  platform?: NodeJS.Platform;
  /** Isolation runner override for tests; defaults to the real contained worker run. */
  isolate?: (input: ThreadCompletionInput) => Promise<string>;
};

/**
 * Run one thread completion on the box's own account. Throws on any failure;
 * the caller shows the redacted message. There is no hosted endpoint here and
 * no fallback: an unsupported agent is an error, not a detour. On Linux the
 * whole run goes through the isolation worker (memory and task caps,
 * cgroup-wide cleanup) unless it IS that worker (contained: true) — the guard
 * that keeps containment from recursing.
 */
export async function dispatchThreadCompletion(input: ThreadCompletionInput, deps: ThreadCompletionDispatch = {}): Promise<string> {
  const key = adapterKeyFor(input.agent);
  if (!key) {
    throw new Error(
      `"${input.agent}" cannot answer thread replies (supported: ${THREAD_CHAT_AGENT_KEYS.join(", ")})`,
    );
  }
  const adapters = deps.adapters ?? threadCompletionAdapters;
  if (threadCompletionNeedsIsolation(deps.platform ?? process.platform, deps.contained === true)) {
    const isolate =
      deps.isolate ?? ((task: ThreadCompletionInput) =>
        import("./omg-isolation-runtime.ts").then((module) => module.isolatedChatCompletion(task)));
    return isolate(input);
  }
  return adapters[key](input);
}
