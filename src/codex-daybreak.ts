/**
 * Codex "Daybreak" adapter: authoritative capability metadata plus a bounded
 * app-server client for ONE explicit cyber-access-program turn.
 *
 * Why this module exists (facts verified 2026-09-29 against codex-cli
 * 0.157.1 and the locally generated --experimental app-server schema):
 *
 * - `turn/start` accepts `cyberAccessProgram` ("standard" | "daybreakBlue" |
 *   "daybreakRed"). Omission preserves automatic behavior; the field is a
 *   REQUEST, authorization stays server-owned.
 * - `initialize` must declare `capabilities.experimentalApi: true` for the
 *   experimental fields to be accepted.
 * - Thread metadata carries a `daybreakEnabled` boolean, but that is display
 *   state, not the request flag. No supported CLI config key selects a cyber
 *   program either, and the vendored Codex SDK (0.153.4) has no request field
 *   for it. The app-server JSON-RPC surface is the only supported wire.
 * - `thread/start` accepts `ephemeral: true` for a thread that leaves no
 *   persisted history. `persistExtendedHistory` does not exist in this
 *   schema version; ephemeral is the documented lever actually available.
 *
 * KNOWN LIMITS (deliberate, until integration):
 * - Wired as the THREADS short-chat path only (src/thread-completion.ts);
 *   normal coding sessions are NOT a program toggle — an explicit program
 *   never travels into an ordinary task.
 * - The turn is tool-less by construction: every app-server request that
 *   would approve or execute a tool is rejected with a JSON-RPC error, and
 *   the thread config plus spawn argv disable the documented tool surfaces.
 *   A real tools-enabled Daybreak session is future integration work.
 * - The protocol reports no "served program" field: the result echoes the
 *   requested program only. The server may still downgrade or ignore it.
 * - gpt-6.1-sol / daybreak turns against the remote account are NOT verified
 *   here; this module never performs inference in tests (mock transport only).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CYBER_ACCESS_PROGRAMS,
  codexCliPath,
  normalizeCyberAccessProgram,
  parseCodexModels,
  type CodexModelCapabilities,
  type CyberAccessProgram,
} from "./model-discovery.ts";

export { CYBER_ACCESS_PROGRAMS, normalizeCyberAccessProgram } from "./model-discovery.ts";
export type { CodexModelCapabilities, CyberAccessProgram } from "./model-discovery.ts";

// ---------------------------------------------------------------------------
// Program validation (before any subprocess, before any inference)
// ---------------------------------------------------------------------------

/** Bounded, redaction-safe failure with a stable machine code. */
export class CodexDaybreakError extends Error {
  readonly code:
    | "unknown-program"
    | "no-metadata"
    | "program-not-offered"
    | "codex-not-found"
    | "config-unsafe"
    | "turn-failed"
    | "empty-reply"
    | "timeout"
    | "protocol"
    | "closed"
    | "codex-error";
  constructor(code: CodexDaybreakError["code"], message: string) {
    super(message);
    this.name = "CodexDaybreakError";
    this.code = code;
  }
}

/**
 * Validate one explicit program request against the account's discovered
 * metadata. Throws before anything is spawned when the program is unknown,
 * the model has no capability metadata, or the metadata does not offer the
 * program for that model. An absent request returns an absent field: on the
 * wire that means "automatic", which is the only way to preserve the
 * no-override default.
 */
export function resolveCyberAccessProgram(input: {
  model: string;
  requested?: string;
  capabilities?: Record<string, CodexModelCapabilities>;
}): { cyberAccessProgram?: CyberAccessProgram } {
  if (input.requested == null || input.requested === "") return {};
  const normalized = normalizeCyberAccessProgram(input.requested);
  if (!normalized) {
    throw new CodexDaybreakError(
      "unknown-program",
      `Unknown cyber access program "${input.requested.slice(0, 60)}"; known: ${CYBER_ACCESS_PROGRAMS.join(", ")}`,
    );
  }
  const capabilities = input.capabilities?.[input.model];
  if (!capabilities) {
    throw new CodexDaybreakError(
      "no-metadata",
      `No discovered capability metadata for "${input.model}"; refusing to request an explicit program`,
    );
  }
  const offered = capabilities.cyberAccessPrograms;
  if (!offered || !offered.includes(normalized)) {
    const list = offered?.length ? offered.join(", ") : "none";
    throw new CodexDaybreakError(
      "program-not-offered",
      `"${input.model}" does not offer "${normalized}" on this account (offered: ${list})`,
    );
  }
  return { cyberAccessProgram: normalized };
}

// ---------------------------------------------------------------------------
// Spawn shape: argv only, documented and validated against 0.157.1
// ---------------------------------------------------------------------------

/**
 * Feature flags disabled for a Daybreak turn. Every name below was read from
 * `experimentalFeature/list` on codex-cli 0.157.1 (2026-09-29); `--disable`
 * with an unknown name aborts startup, so this list is frozen until
 * revalidated. Surfaces: shell, apps/plugins, browser/computer, image
 * view+generation, code mode, tool suggestions, multi-agent. MCP is disabled
 * per configured server (see codexAppServerArgv), and web search via the
 * thread config in TOOLLESS_THREAD_CONFIG.
 */
export const DAYBREAK_DISABLED_FEATURES: readonly string[] = [
  "shell_tool",
  "sleep_tool",
  "view_image",
  "code_mode",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "apps",
  "plugins",
  "tool_suggest",
  "multi_agent",
];

/**
 * Encode one key segment as a TOML basic string, e.g. `omg.enabled` ->
 * `"omg.enabled"`. Every character that could end the string or read as
 * syntax is escaped, so the result is always exactly one key.
 */
export function tomlQuotedKey(name: string): string {
  const escaped = name.replace(/[\\"]/g, (ch) => (ch === "\\" ? "\\\\" : '\\"')).replace(
    /[\u0000-\u001f\u007f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `"${escaped}"`;
}

/**
 * Read one dotted key path starting at `from`: bare, "basic", and 'literal'
 * segments separated by dots. Returns null when the text stops matching TOML
 * key syntax — used to fail closed on config we cannot parse.
 */
function tomlKeyPath(text: string, from: number): { path: string[]; next: number } | null {
  const path: string[] = [];
  let index = from;
  for (;;) {
    while (index < text.length && /\s/.test(text[index]!)) index++;
    const ch = text[index];
    if (ch === '"') {
      let value = "";
      index++;
      let closed = false;
      while (index < text.length) {
        const c = text[index]!;
        if (c === "\\") {
          const esc = text[index + 1];
          if (esc === undefined) return null;
          if (esc === "u" || esc === "U") {
            const width = esc === "u" ? 4 : 8;
            const hex = text.slice(index + 2, index + 2 + width);
            if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
            value += String.fromCharCode(parseInt(hex, 16));
            index += 2 + width;
            continue;
          }
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
          if (!(esc in map)) return null;
          value += map[esc]!;
          index += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          index++;
          break;
        }
        if (c === "\n") return null;
        value += c;
        index++;
      }
      if (!closed || !value) return null;
      path.push(value);
    } else if (ch === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return null;
      const value = text.slice(index + 1, end);
      if (!value || value.includes("\n")) return null;
      path.push(value);
      index = end + 1;
    } else {
      const start = index;
      while (index < text.length && /[A-Za-z0-9_-]/.test(text[index]!)) index++;
      if (index === start) return null;
      path.push(text.slice(start, index));
    }
    let lookahead = index;
    while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead++;
    if (text[lookahead] === ".") {
      index = lookahead + 1;
      continue;
    }
    return { path, next: lookahead };
  }
}

export type CodexMcpServerEnumeration = {
  /** Every configured MCP server this scan could name, deduplicated. */
  servers: string[];
  /**
   * True when config.toml defines mcp_servers in a form this scanner cannot
   * safely enumerate — inline tables with content, malformed keys, or an
   * array of tables. The caller must refuse to spawn rather than risk a
   * Daybreak turn with MCP still enabled.
   */
  unsafe: boolean;
  /** First reason the scan is unsafe, when it is. */
  reason?: string;
};

/**
 * Enumerate `[mcp_servers.NAME]` servers from config.toml without a full TOML
 * parser. The scan is deliberately biased toward over-naming: a phantom name
 * only produces one harmless `enabled=false` override, while a missed real
 * server would leave tools reachable. Inline `mcp_servers = { ... }` values
 * cannot be enumerated without string-aware value parsing, so they make the
 * scan unsafe instead of partially right.
 */
export function enumerateCodexMcpServers(configToml: string): CodexMcpServerEnumeration {
  const servers: string[] = [];
  const add = (name: string) => {
    if (!servers.includes(name)) servers.push(name);
  };
  let unsafe = false;
  let reason: string | undefined;
  const fail = (why: string) => {
    if (!unsafe) {
      unsafe = true;
      reason = why;
    }
  };
  let tablePath: string[] = [];
  for (const rawLine of configToml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      // An array of tables under mcp_servers is not a shape codex documents;
      // treat it as unparseable rather than guess.
      const header = tomlKeyPath(line, 2);
      if (header && header.path[0] === "mcp_servers" && /^\s*\]\]/.test(line.slice(header.next))) {
        fail("mcp_servers uses an array-of-tables header");
      }
      tablePath = [];
      continue;
    }
    if (line.startsWith("[")) {
      const header = tomlKeyPath(line, 1);
      if (!header || !/^\s*\]/.test(line.slice(header.next))) {
        fail("a table header could not be parsed");
        tablePath = [];
        continue;
      }
      tablePath = header.path;
      if (tablePath[0] === "mcp_servers" && tablePath.length >= 2) {
        // `[mcp_servers.name.sub]` still belongs to server `name`.
        add(tablePath[1]!);
      }
      continue;
    }
    // Key-value line. Only top-level assignments can define mcp_servers
    // without a table header; assignments inside [mcp_servers.x] add keys to
    // a server the header already named.
    if (tablePath.length > 0) continue;
    if (!/^mcp_servers(?=[.\s=])/.test(line)) continue;
    if (/^mcp_servers\s*=/.test(line)) {
      const value = line.replace(/^mcp_servers\s*=\s*/, "").trim();
      if (/^{}\s*(#.*)?$/.test(value)) continue;
      fail("mcp_servers is assigned an inline or scalar value");
      continue;
    }
    const path = tomlKeyPath(line, 0);
    if (!path || path.path[0] !== "mcp_servers") {
      fail("a mcp_servers key could not be parsed");
      continue;
    }
    const rest = line.slice(path.next);
    if (!/^\s*=/.test(rest)) {
      fail("a mcp_servers key could not be parsed");
      continue;
    }
    // `mcp_servers.name = {...}` or `mcp_servers.name.key = ...`.
    if (path.path.length >= 2) add(path.path[1]!);
    else fail("mcp_servers is assigned without a server key");
  }
  return { servers, unsafe, ...(reason ? { reason } : {}) };
}

function readCodexConfigToml(): string {
  try {
    return readFileSync(join(process.env.CODEX_HOME ?? `${homedir()}/.codex`, "config.toml"), "utf8");
  } catch {
    return "";
  }
}

/**
 * The app-server argv for a Daybreak turn: `<codex> app-server --stdio` plus
 * `--disable` per tool-surface feature and ONE `-c` override that disables
 * every configured MCP server by name.
 *
 * The `-c` override form is pinned by live probes against codex-cli 0.157.1
 * (2026-09-29):
 * - The dotted PATH is not quote-aware: `mcp_servers."omg".enabled=false` is
 *   fatal at startup ("invalid transport"). Bare dotted paths work, but a
 *   server named `omg.enabled` cannot be addressed safely that way.
 * - The VALUE is parsed as real TOML and MERGED into the file's map: quoted
 *   keys are valid there, `"weird name.dot" = { enabled = false }` disables
 *   exactly that server, and a server omitted from the map stays ENABLED.
 * So every enumerated server is named explicitly inside one whole-map value,
 * each key TOML-quoted with full escaping. Enumeration completeness is
 * therefore load-bearing, which is why an unparseable config fails before
 * spawn instead of producing a partial map.
 */
export function codexAppServerArgv(
  bin: string,
  options: {
    disabledFeatures?: readonly string[];
    mcpServerNames?: readonly string[];
    /** Config text to enumerate instead of reading ~/.codex/config.toml. */
    configToml?: string;
  } = {},
): string[] {
  const argv = [bin, "app-server", "--stdio"];
  for (const feature of options.disabledFeatures ?? DAYBREAK_DISABLED_FEATURES) {
    argv.push("--disable", feature);
  }
  let servers: readonly string[];
  if (options.mcpServerNames != null) {
    servers = options.mcpServerNames;
  } else {
    const enumeration = enumerateCodexMcpServers(options.configToml ?? readCodexConfigToml());
    if (enumeration.unsafe) {
      throw new CodexDaybreakError(
        "config-unsafe",
        `~/.codex/config.toml: ${enumeration.reason}; refusing a Daybreak turn that could leave MCP enabled`,
      );
    }
    servers = enumeration.servers;
  }
  if (servers.length) {
    const entries = servers.map((name) => `${tomlQuotedKey(name)} = { enabled = false }`).join(", ");
    argv.push("-c", `mcp_servers={ ${entries} }`);
  }
  return argv;
}

/**
 * Thread config for `thread/start`. Keys are the core Config schema's
 * snake_case names (validated against the 0.157.1 ConfigReadResponse schema):
 * web_search is a WebSearchMode ("disabled"), apps default off, read-only
 * sandbox, never ask for approval. Tool features that live behind feature
 * flags are turned off at spawn (DAYBREAK_DISABLED_FEATURES) because
 * `features` is not a thread-config key.
 */
export const TOOLLESS_THREAD_CONFIG: Record<string, unknown> = {
  web_search: "disabled",
  apps: { _default: { enabled: false } },
  sandbox_mode: "read-only",
  approval_policy: "never",
};

// ---------------------------------------------------------------------------
// Trusted argv: persistent tools-enabled app-server sessions
// ---------------------------------------------------------------------------

const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Encode one config VALUE as a TOML literal (the `--config key=VALUE` side).
 * Mirrors the codex-sdk encoder: strings as basic strings (JSON.stringify's
 * escaping is exactly TOML basic-string escaping), finite numbers, booleans,
 * arrays, and nested objects as inline tables whose keys are quoted whenever
 * they are not bare — quoting is SAFE inside a value (live-probed, see
 * codexAppServerArgv). Null and non-finite numbers throw: fail closed rather
 * than emit a silently different config.
 */
export function codexConfigTomlValue(value: unknown, path: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CodexDaybreakError("config-unsafe", `config override at ${path} is not a finite number`);
    }
    return `${value}`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => codexConfigTomlValue(item, `${path}[${index}]`)).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!key) throw new CodexDaybreakError("config-unsafe", "config override keys must be non-empty strings");
      if (child === undefined) continue;
      parts.push(`${TOML_BARE_KEY_RE.test(key) ? key : tomlQuotedKey(key)} = ${codexConfigTomlValue(child, `${path}.${key}`)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  throw new CodexDaybreakError("config-unsafe", `unsupported config override value at ${path}: ${value === null ? "null" : typeof value}`);
}

/**
 * Flatten a config object into `dotted.path=toml-value` override strings —
 * the same shape the codex-sdk passes as `--config`. PATH segments must be
 * bare keys: the CLI's dotted path is not quote-aware (live-probed against
 * 0.157.1 — `mcp_servers."omg".enabled=false` is fatal at startup), so a
 * segment that cannot be written bare throws instead of producing an argv
 * that would kill the child before the first turn.
 */
export function flattenCodexConfigOverrides(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown, prefix: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === undefined) continue;
        if (!TOML_BARE_KEY_RE.test(key)) {
          throw new CodexDaybreakError(
            "config-unsafe",
            `config key "${key}" cannot ride a dotted --config path (bare [A-Za-z0-9_-] only); refusing to spawn`,
          );
        }
        walk(child, prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    out.push(`${prefix}=${codexConfigTomlValue(value, prefix)}`);
  };
  walk(config, "");
  return out;
}

/**
 * The app-server argv for a PERSISTENT tools-enabled session: plain
 * `app-server --stdio` plus one `--config key=value` per flattened trusted
 * override (OMG MCP layer, service tier, model provider config — whatever the
 * caller derived through the same codexSdkOptionsForModel layer the SDK path
 * uses). Unlike codexAppServerArgv this disables NOTHING and overrides no
 * MCP servers: the model runs its server tools itself under the thread's
 * danger-full-access / approval-never policy.
 */
export function codexAppServerTrustedArgv(
  bin: string,
  config?: { [key: string]: unknown },
): string[] {
  const argv = [bin, "app-server", "--stdio"];
  for (const override of flattenCodexConfigOverrides(config ?? {})) {
    argv.push("--config", override);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Transport: line-delimited JSON-RPC over the child's stdio
// ---------------------------------------------------------------------------

/** Injectable transport so tests never spawn a process or touch the network. */
export type CodexAppServerTransport = {
  /** Write one newline-terminated JSON-RPC line. */
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
  /** Stop this child and only this child; resolves once it is gone. */
  close(): Promise<void>;
};

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Provider text is never surfaced raw. Redaction runs BEFORE truncation, in
 * this order: strip ANSI, replace credential-shaped substrings, collapse
 * whitespace, then cap. Truncating first could cut a token in half and leave
 * a prefix the redaction patterns no longer recognize.
 */
export function redactCodexErrorText(raw: unknown): string {
  let text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  text = text
    .replace(ANSI_RE, "")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "«redacted»")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer «redacted»")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "«redacted»")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 300) || "unknown error";
}

/** Spawn the real app-server child. Stderr is ignored, never parsed or dumped. */
export function spawnCodexAppServerTransport(options: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
} = {}): CodexAppServerTransport {
  const bin = codexCliPath();
  if (!bin) throw new CodexDaybreakError("codex-not-found", "codex CLI not found; install it and sign in first");
  const argv = options.argv ?? codexAppServerArgv(bin);
  // detached puts the child in its own process group where the platform
  // supports it, so a group kill can never signal anyone else's process.
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: options.env ?? process.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    detached: true,
  });
  const lineListeners: Array<(line: string) => void> = [];
  const closeListeners: Array<() => void> = [];
  let closed = false;
  let closePromise: Promise<void> | null = null;

  void (async () => {
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        // Feed raw text; the client owns line framing and bounds.
        for (const listener of [...lineListeners]) {
          listener(decoder.decode(chunk.value, { stream: true }));
        }
      }
    } catch {
      /* read side ended; close handlers below carry the news */
    } finally {
      for (const listener of [...closeListeners]) listener();
    }
  })();

  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      // Own process group only (negative pid). Falls back to the child pid.
      process.kill(-proc.pid, sig);
      return;
    } catch {
      /* no group or already gone */
    }
    try {
      proc.kill(sig);
    } catch {
      /* already gone */
    }
  };

  const transport: CodexAppServerTransport = {
    write(line: string) {
      if (closed) return;
      try {
        proc.stdin.write(`${line}\n`);
        proc.stdin.flush();
      } catch {
        /* child died; the read loop reports the close */
      }
    },
    onLine(listener) {
      lineListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close() {
      if (closed) return closePromise!;
      closed = true;
      closePromise = (async () => {
        try {
          proc.stdin.end();
        } catch {}
        signal("SIGTERM");
        const grace = setTimeout(() => signal("SIGKILL"), 1_500);
        try {
          await proc.exited;
        } catch {}
        clearTimeout(grace);
      })();
      return closePromise;
    },
  };
  return transport;
}

// ---------------------------------------------------------------------------
// Client: requests, notifications, bounded framing, request denial
// ---------------------------------------------------------------------------

const MAX_LINE_BYTES = 1_048_576;
const MAX_MALFORMED_LINES = 64;

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: CodexDaybreakError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private readonly closedHandlers: Array<() => void> = [];
  private buffer = "";
  private malformedLines = 0;
  private closed = false;
  private closeError: CodexDaybreakError | null = null;
  private readonly lineListener = (chunk: string) => this.feed(chunk);
  private readonly closeListener = () => this.abortAll();

  constructor(
    private readonly transport: CodexAppServerTransport,
    private readonly options: { defaultTimeoutMs?: number } = {},
  ) {
    transport.onLine(this.lineListener);
    transport.onClose(this.closeListener);
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    this.notificationHandlers.set(method, [...(this.notificationHandlers.get(method) ?? []), handler]);
    return () => this.offNotification(method, handler);
  }

  /**
   * Drop one notification handler. A persistent client that registers
   * per-turn handlers must unsubscribe at turn end, or every finished turn
   * leaves its closures (and their captured buffers) attached to the
   * connection for the child's lifetime.
   */
  offNotification(method: string, handler: (params: unknown) => void): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) return;
    const next = handlers.filter((existing) => existing !== handler);
    if (next.length) this.notificationHandlers.set(method, next);
    else this.notificationHandlers.delete(method);
  }

  /** Called once when the connection ends, from a close, a protocol abort, or close(). */
  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler);
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closeError ?? new CodexDaybreakError("closed", "Codex app-server is closed"));
    const id = this.nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexDaybreakError("timeout", `Codex app-server request ${method} timed out`));
      }, timeoutMs ?? this.options.defaultTimeoutMs ?? 20_000);
      this.pending.set(id, {
        resolve,
        reject,
        timer: timeout,
      });
      this.transport.write(JSON.stringify(message));
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.transport.write(JSON.stringify({ method, params }));
  }

  async close(): Promise<void> {
    this.abortAll();
    await this.transport.close();
  }

  private abortAll(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError ??= new CodexDaybreakError("closed", "Codex app-server closed");
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.closeError);
    }
    this.pending.clear();
    for (const handler of [...this.closedHandlers]) {
      try {
        handler();
      } catch {
        /* close observers must not break shutdown */
      }
    }
  }

  private failAll(error: CodexDaybreakError): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.abortAll();
  }

  private feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (this.buffer.length > MAX_LINE_BYTES) {
          this.failAll(new CodexDaybreakError("protocol", `Codex app-server line exceeded ${MAX_LINE_BYTES} bytes`));
          void this.transport.close();
        }
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      if (this.closed) return;
    }
  }

  private handleLine(line: string): void {
    if (line.length > MAX_LINE_BYTES) {
      this.failAll(new CodexDaybreakError("protocol", `Codex app-server line exceeded ${MAX_LINE_BYTES} bytes`));
      void this.transport.close();
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Stdio carries occasional non-protocol output; bounded tolerance.
      if (++this.malformedLines > MAX_MALFORMED_LINES) {
        this.failAll(new CodexDaybreakError("protocol", "Codex app-server produced too many malformed lines"));
        void this.transport.close();
      }
      return;
    }
    if (typeof message.method === "string") {
      if (message.id != null) {
        // A server request: approval, tool call, elicitation, attestation.
        // This adapter is tool-less and non-interactive by contract, so every
        // such request is denied with a JSON-RPC error reply. That is a valid
        // response for all of them and never blocks on a human.
        this.transport.write(
          JSON.stringify({
            id: message.id,
            error: { code: -32000, message: "rejected by omg daybreak tool policy" },
          }),
        );
        return;
      }
      for (const handler of this.notificationHandlers.get(message.method) ?? []) {
        try {
          handler(message.params);
        } catch {
          /* one handler must not take down the framing */
        }
      }
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (!pending) return; // stray response after timeout: bounded ignore
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    const error = message.error as { message?: unknown } | undefined;
    if (error) {
      pending.reject(
        new CodexDaybreakError(
          "codex-error",
          `Codex app-server error: ${redactCodexErrorText(error.message ?? "unknown error")}`,
        ),
      );
    } else {
      pending.resolve((message.result ?? {}) as Record<string, unknown>);
    }
  }
}

// ---------------------------------------------------------------------------
// initialize handshake
// ---------------------------------------------------------------------------

const CLIENT_INFO = { name: "omg_dev_daybreak", title: "omg.dev Daybreak", version: "0.1.0" };

/** initialize with the experimental capability, then the `initialized` notice. */
export async function initializeAppServer(
  client: CodexAppServerClient,
): Promise<Record<string, unknown>> {
  const result = await client.request("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  return result;
}

// ---------------------------------------------------------------------------
// model/list (read-only)
// ---------------------------------------------------------------------------

export type CodexAppServerModelList = {
  models: string[];
  labels: Record<string, string>;
  capabilities: Record<string, CodexModelCapabilities>;
};

/**
 * Read the live `model/list` from a fresh app-server child. Read-only: no
 * thread, no turn, no inference. Follows `nextCursor` up to a small bound.
 */
export async function listCodexAppServerModels(options: {
  transport?: CodexAppServerTransport;
  timeoutMs?: number;
} = {}): Promise<CodexAppServerModelList> {
  const client = new CodexAppServerClient(
    options.transport ?? spawnCodexAppServerTransport(),
    { defaultTimeoutMs: options.timeoutMs },
  );
  try {
    await initializeAppServer(client);
    const models: string[] = [];
    const labels: Record<string, string> = {};
    const capabilities: Record<string, CodexModelCapabilities> = {};
    let cursor: string | null | undefined = undefined;
    // Bounded pagination: a catalog longer than 20 pages is a protocol error
    // in spirit; stop rather than loop on a server that always answers a
    // fresh cursor.
    for (let page = 0; page < 20; page++) {
      const result = await client.request(
        "model/list",
        cursor === undefined ? {} : { cursor },
        options.timeoutMs,
      );
      const pageParsed = parseCodexModels(
        JSON.stringify({ data: (result as { data?: unknown }).data ?? [] }),
      );
      for (const model of pageParsed.models) if (!models.includes(model)) models.push(model);
      Object.assign(labels, pageParsed.labels);
      Object.assign(capabilities, pageParsed.modelCapabilities ?? {});
      const next = (result as { nextCursor?: unknown }).nextCursor;
      cursor = typeof next === "string" ? next : null;
      if (cursor === null) break;
    }
    return { models, labels, capabilities };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// The one ephemeral tool-less turn
// ---------------------------------------------------------------------------

export type DaybreakTurnInput = {
  /** The user prompt for this single turn. */
  prompt: string;
  /** Explicit model id, e.g. "gpt-6-sol". Required: no silent default. */
  model: string;
  /** Optional reasoning effort override, e.g. "high". */
  effort?: string;
  /**
   * Optional explicit cyber access program. Validated against
   * `capabilities` BEFORE anything spawns; absent means automatic (the
   * server keeps its default, which is standard for ChatGPT accounts).
   */
  cyberAccessProgram?: string;
  /**
   * Authoritative per-model metadata (from the discovery cache or a fresh
   * model/list). Required whenever `cyberAccessProgram` is set.
   */
  capabilities?: Record<string, CodexModelCapabilities>;
  /** Working directory for the ephemeral thread. */
  cwd?: string;
  /** Whole-turn budget. Default 120s. */
  timeoutMs?: number;
  /** Injectable transport factory for tests. */
  transport?: CodexAppServerTransport | (() => CodexAppServerTransport | Promise<CodexAppServerTransport>);
};

export type DaybreakTurnResult = {
  text: string;
  threadId: string;
  turnId: string;
  status: "completed";
  /** The model id this call requested, echoed exactly. */
  requestedModel: string;
  /** The reasoning effort this call requested, when any. */
  requestedEffort?: string;
  /**
   * Present only when the thread (or a same-turn reroute notice) confirmed
   * serving exactly the requested model. Never inferred from a default.
   */
  servedModel?: string;
  /** The model the thread reports, when that differs from the request. */
  threadModel?: string;
  /** Present when the server rerouted this turn away from the request. */
  reroutedFromModel?: string;
  /** Present only when an explicit program was requested and sent. */
  requestedCyberAccessProgram?: CyberAccessProgram;
};

/**
 * Run exactly one tool-less ephemeral Daybreak turn against the signed-in
 * Codex account. The app-server child is ours alone: it is created for this
 * call and shut down in `finally`, timeout or not. Nothing here mutates
 * config or touches other sessions.
 *
 * The deadline in `timeoutMs` bounds the WHOLE exchange — initialize,
 * thread/start, turn/start, and the turn itself. A turn is only reported
 * completed on a `turn/completed` for our own thread and turn whose status
 * is exactly "completed"; interrupted, failed, and unknown statuses reject.
 */
export async function runCodexDaybreakTurn(input: DaybreakTurnInput): Promise<DaybreakTurnResult> {
  // Validation first: an incompatible request must fail before any spawn or
  // inference attempt.
  const { cyberAccessProgram } = resolveCyberAccessProgram({
    model: input.model,
    requested: input.cyberAccessProgram,
    capabilities: input.capabilities,
  });

  const transport =
    typeof input.transport === "function"
      ? await input.transport()
      : input.transport ?? spawnCodexAppServerTransport({ ...(input.cwd ? { cwd: input.cwd } : {}) });
  const client = new CodexAppServerClient(transport);
  const turnTimeoutMs = input.timeoutMs ?? 120_000;

  let failFast: (error: CodexDaybreakError) => void = () => {};
  const deadlineHit = new Promise<never>((_, reject) => {
    failFast = (error) => reject(error);
  });
  deadlineHit.catch(() => {}); // observed only through races below
  const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadlineHit]);

  // One overall deadline, armed before the first byte to the child.
  const deadline = setTimeout(() => {
    // Cancel our own turn when one exists, then fail. The finally block
    // below still shuts down our own child; nothing else is touched.
    if (currentTurnId) {
      void client.request("turn/interrupt", { threadId, turnId: currentTurnId }, 5_000).catch(() => {});
    }
    failFast(new CodexDaybreakError("timeout", "Daybreak turn timed out"));
  }, turnTimeoutMs);

  let threadId = "";
  let currentTurnId = "";
  let threadModel: string | undefined;
  let rerouteFrom: string | undefined;

  try {
    await bounded(initializeAppServer(client));

    // The thread is created for THIS model so thread-start reporting matches
    // the turn; the turn still sends the model explicitly.
    const threadParams: Record<string, unknown> = {
      ephemeral: true,
      config: TOOLLESS_THREAD_CONFIG,
      model: input.model,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const thread = (await bounded(client.request("thread/start", threadParams, 20_000))) as {
      thread?: { id?: unknown };
      model?: unknown;
    };
    threadId = typeof thread.thread?.id === "string" ? thread.thread.id : "";
    if (!threadId) throw new CodexDaybreakError("protocol", "thread/start returned no thread id");
    if (typeof thread.model === "string" && thread.model) threadModel = thread.model;

    /** Only events for our thread — and our turn, once its id is known. */
    const ownEvent = (params: unknown): boolean => {
      const row = (params ?? {}) as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
      if (typeof row.threadId === "string" && row.threadId !== threadId) return false;
      const eventTurnId = typeof row.turnId === "string" ? row.turnId : typeof row.turn?.id === "string" ? row.turn.id : null;
      if (eventTurnId != null && currentTurnId && eventTurnId !== currentTurnId) return false;
      return true;
    };

    const segments: string[] = [];
    let settleTurn: (result: DaybreakTurnResult) => void = () => {};
    let failTurn: (error: CodexDaybreakError) => void = () => {};
    const turnDone = new Promise<DaybreakTurnResult>((resolve, reject) => {
      settleTurn = resolve;
      failTurn = reject;
    });

    client.onNotification("item/completed", (params) => {
      if (!ownEvent(params)) return;
      const item = (params as { item?: { type?: unknown; text?: unknown } } | undefined)?.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") segments.push(item.text);
    });
    client.onNotification("turn/completed", (params) => {
      if (!ownEvent(params)) return;
      const turn = (params as { turn?: { id?: unknown; status?: unknown; error?: { message?: unknown } } } | undefined)?.turn;
      // Only "completed" is terminal success. The schema also names
      // "interrupted", "failed", and "inProgress"; anything else here is a
      // status we do not know, which rejects rather than settles.
      if (turn?.status !== "completed") {
        const status = turn?.status == null ? "missing" : String(turn.status).slice(0, 40);
        failTurn(
          new CodexDaybreakError(
            "turn-failed",
            turn?.status === "failed"
              ? `Daybreak turn failed: ${redactCodexErrorText(turn.error?.message)}`
              : `Daybreak turn ended with status "${status}", not completed`,
          ),
        );
        return;
      }
      const text = segments.join("");
      if (!text.trim()) {
        failTurn(new CodexDaybreakError("empty-reply", "Daybreak turn completed with an empty reply"));
        return;
      }
      settleTurn({
        text,
        threadId,
        turnId: typeof turn?.id === "string" ? turn.id : currentTurnId,
        status: "completed",
        requestedModel: input.model,
        ...(input.effort ? { requestedEffort: input.effort } : {}),
        ...(cyberAccessProgram ? { requestedCyberAccessProgram: cyberAccessProgram } : {}),
      });
    });
    client.onNotification("model/rerouted", (params) => {
      if (!ownEvent(params)) return;
      const row = (params ?? {}) as { fromModel?: unknown; toModel?: unknown };
      if (typeof row.fromModel === "string") rerouteFrom = row.fromModel;
      if (typeof row.toModel === "string" && row.toModel) threadModel = row.toModel;
    });

    // turn/start serialization: cyberAccessProgram is present EXACTLY when an
    // explicit program was validated, and its value is the protocol enum.
    // Absent means automatic — never an explicit "standard".
    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: input.prompt }],
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(cyberAccessProgram ? { cyberAccessProgram } : {}),
    };
    const turnResponse = (await bounded(client.request("turn/start", turnParams, 20_000))) as {
      turn?: { id?: unknown; status?: unknown };
    };
    if (typeof turnResponse.turn?.id === "string") currentTurnId = turnResponse.turn.id;
    if (turnResponse.turn?.status === "failed") {
      throw new CodexDaybreakError("turn-failed", "Daybreak turn failed at start");
    }

    // A child that dies mid-turn must fail the turn now, not at the deadline.
    client.onClosed(() =>
      failTurn(new CodexDaybreakError("closed", "Codex app-server closed during the turn")),
    );

    const result = await bounded(turnDone);

    // Honest labeling: "served" only when the thread or a same-turn reroute
    // confirmed exactly the requested model. A thread-reported default that
    // differs is exposed as threadModel, never mislabeled as served.
    const confirmed = threadModel === input.model;
    return {
      ...result,
      ...(confirmed ? { servedModel: input.model } : {}),
      ...(!confirmed && threadModel ? { threadModel } : {}),
      ...(rerouteFrom != null && rerouteFrom !== input.model ? { reroutedFromModel: rerouteFrom } : {}),
    };
  } finally {
    clearTimeout(deadline);
    await client.close();
  }
}
