// Trusted central MCP namespace discovery for Mac-hosted sessions.
//
// TWO layers, deliberately separate:
//
// 1. `discoverCentralNamespaces` — the AUDIT manifest: names, transports and
//    HASHED specs only. No credential values anywhere; safe for status
//    endpoints and reports.
// 2. `loadFullNamespaceEntries` — the RUNTIME map for the bridge and the Mac
//    lease bundle: exact upstream URLs WITH their original central auth
//    (claude `headers` — `${VAR}`/`${VAR:-default}` refs expanded from this
//    process env, missing refs fail closed per-header; codex
//    `bearer_token_env_var` resolved from this process env, stdio
//    `command/args/env`). Secrets stay in process memory;
//    they are never logged, never serialized to the durable lease store,
//    never sent to the remote — the remote sees ONLY the bridge URL plus the
//    short-lived lease bearer.
//
// Namespaces stay PROVIDER-SPECIFIC (claude-user vs codex-user sources are
// kept apart; union collisions never overwrite). A namespace the central
// side does not have is not in the map, and the bridge answers 404 with its
// name: nothing is silently dropped (CONTEXT-CONTRACT).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type CentralNamespaceKind = "http" | "https" | "stdio";

export type CentralNamespace = {
  name: string;
  kind: CentralNamespaceKind;
  /** http/https: the exact upstream URL from central config. stdio: null. */
  url: string | null;
  /** stdio: the exact command from central config (audit: hashed only). */
  command: string | null;
  /** stdio args (audit: hashed only). */
  args: string[];
  /** Hash over the exact spec (kind+url/command+args); env/header VALUES excluded. */
  specSha256: string;
  /** Which central user config declared it. */
  source: "claude-user" | "codex-user" | "omg-runtime";
};

/** RUNTIME entry: same shape plus the resolved central auth (in-memory only). */
export type FullNamespaceEntry = CentralNamespace & {
  /** http(s): identity headers forwarded verbatim to the exact upstream. */
  headers: Record<string, string>;
  /** stdio: env (with session identity merged by the caller). */
  env: Record<string, string>;
  /** codex http: env var name carrying the bearer (resolved into headers here). */
  bearerTokenEnvVar: string | null;
};

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

// Claude-standard env expansion for CONFIG HEADER VALUES (official
// `.mcp.json` semantics, code.claude.com/docs/en/mcp): `${VAR}` and
// `${VAR:-default}` (bash `:-`: default applies when VAR is unset OR empty).
// One deliberate divergence from Claude Code's own client, required by the
// bridge contract: Claude Code loads a missing no-default reference as
// literal `${VAR}` text, but this bridge forwards identity headers to the
// exact upstream, and a literal `${...}` or empty expansion is guaranteed
// auth failure (the live Executor header is `Bearer ${EXECUTOR_MCP_TOKEN}`,
// see the AUTH_HEADER_REJECTED note in src/tmux.ts). So a header whose
// reference cannot resolve from the supplied env FAILS CLOSED: it is omitted
// entirely — never the unresolved literal, never an empty credential — and
// the existing namespaceAuthStatus degraded state surfaces it. Malformed
// references (`${}`, `${VAR`, non-name characters) are not Claude syntax and
// stay literal.
const HEADER_ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expandHeaderValue(
  value: string,
  env: Record<string, string | undefined>,
): string | null {
  let resolved = true;
  const expanded = value.replace(HEADER_ENV_REF, (_match, name: string, def: string | undefined) => {
    const raw = env[name];
    if (typeof raw === "string" && raw !== "") return raw;
    if (def !== undefined) return def;
    resolved = false; // ${VAR} with VAR missing/empty and no default: fail closed.
    return "";
  });
  if (!resolved || expanded === "") return null;
  return expanded;
}

export type RawMcpEntry = {
  url?: unknown;
  http_headers?: unknown;
  type?: unknown;
  command?: unknown;
  args?: unknown;
  headers?: unknown;
  bearer_token_env_var?: unknown;
  env?: unknown;
  env_http_headers?: unknown;
};

function classify(
  name: string,
  entry: RawMcpEntry,
  source: CentralNamespace["source"],
  env: Record<string, string | undefined> = process.env,
): FullNamespaceEntry | null {
  if (!name || typeof name !== "string" || !/^[a-z0-9_.-]+$/i.test(name)) return null;
  if (!entry || typeof entry !== "object") return null;
  const url = typeof entry.url === "string" && entry.url.trim() ? entry.url.trim() : null;
  const command = typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : null;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  const envMap: Record<string, string> = {};
  if (entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)) {
    for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string") envMap[k] = v;
    }
  }
  if (url && command) return null; // ambiguous transport in the source config
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    const kind = parsed.protocol === "https:" ? "https" : "http";
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
      for (const [k, v] of Object.entries(entry.headers as Record<string, unknown>)) {
        if (typeof k !== "string" || typeof v !== "string") continue;
        const expanded = expandHeaderValue(v, env);
        if (expanded === null) continue; // fail closed: never forward unresolved refs
        headers[k] = expanded;
      }
    }
    // Standard literal http_headers mapping (item 24: no current entries use
    // it on this box, but support it when encountered). Same header-value env
    // expansion as `headers`.
    if (entry.http_headers && typeof entry.http_headers === "object" && !Array.isArray(entry.http_headers)) {
      for (const [k, v] of Object.entries(entry.http_headers as Record<string, unknown>)) {
        if (typeof k !== "string" || typeof v !== "string") continue;
        const expanded = expandHeaderValue(v, env);
        if (expanded === null) continue; // fail closed: never forward unresolved refs
        headers[k] = expanded;
      }
    }
    let bearerTokenEnvVar: string | null = null;
    if (typeof entry.bearer_token_env_var === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.bearer_token_env_var)) {
      bearerTokenEnvVar = entry.bearer_token_env_var;
      const value = env[bearerTokenEnvVar];
      if (value) headers["authorization"] = `Bearer ${value}`;
    }
    if (entry.env_http_headers && typeof entry.env_http_headers === "object" && !Array.isArray(entry.env_http_headers)) {
      for (const [headerName, envName] of Object.entries(entry.env_http_headers as Record<string, unknown>)) {
        if (typeof headerName !== "string" || typeof envName !== "string") continue;
        const value = env[envName];
        if (value) headers[headerName] = value;
      }
    }
    return {
      name,
      kind,
      url,
      command: null,
      args: [],
      specSha256: sha256(JSON.stringify({ kind, url })),
      source,
      headers,
      env: {},
      bearerTokenEnvVar,
    };
  }
  if (command) {
    return {
      name,
      kind: "stdio",
      url: null,
      command,
      args,
      specSha256: sha256(JSON.stringify({ kind: "stdio", command, args })),
      source,
      headers: {},
      env: envMap,
      bearerTokenEnvVar: null,
    };
  }
  return null;
}

function readClaudeUserServers(
  home: string,
  configPath: string | undefined,
  env: Record<string, string | undefined>,
): Record<string, FullNamespaceEntry> {
  const out: Record<string, FullNamespaceEntry> = {};
  const path = configPath ?? join(home, ".claude.json");
  try {
    if (!existsSync(path)) return out;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, RawMcpEntry> };
    for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
      const ns = classify(name, entry ?? {}, "claude-user", env);
      if (ns) out[name] = ns;
    }
  } catch {
    // unreadable config: contribute nothing; the map stays honest.
  }
  return out;
}

function readCodexUserServers(
  home: string,
  configPath: string | undefined,
  env: Record<string, string | undefined>,
): Record<string, FullNamespaceEntry> {
  const out: Record<string, FullNamespaceEntry> = {};
  const path = configPath ?? join(env.CODEX_HOME?.trim() || join(home, ".codex"), "config.toml");
  try {
    if (!existsSync(path)) return out;
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { mcp_servers?: Record<string, RawMcpEntry> };
    for (const [name, entry] of Object.entries(parsed.mcp_servers ?? {})) {
      const ns = classify(name, entry ?? {}, "codex-user", env);
      if (ns) out[name] = ns;
    }
  } catch {
    // unreadable config: contribute nothing.
  }
  return out;
}

/**
 * The trusted namespace inventory for one session (audit layer): omg runtime
 * namespaces (loopback, served by this server) + the PROVIDER-SPECIFIC user
 * config entries. Sources never collide: the runtime names win over user
 * entries with the same name, and claude/codex user sources are selected by
 * the session's provider (not unioned).
 */
export function discoverCentralNamespaces(input: {
  provider: "claude" | "codex";
  /** omg runtime namespaces (omg/connectors/computer) with loopback URLs. */
  runtime?: Record<string, string>;
  claudeUserConfigPath?: string;
  codexUserConfigPath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
}): Record<string, FullNamespaceEntry> {
  const home = input.home ?? process.env.HOME ?? homedir();
  const env = input.env ?? process.env;
  const userEntries = input.provider === "claude"
    ? readClaudeUserServers(home, input.claudeUserConfigPath, env)
    : readCodexUserServers(home, input.codexUserConfigPath, env);
  const merged: Record<string, FullNamespaceEntry> = { ...userEntries };
  for (const [name, url] of Object.entries(input.runtime ?? {})) {
    merged[name] = {
      name,
      kind: "http",
      url,
      command: null,
      args: [],
      specSha256: sha256(JSON.stringify({ kind: "http", url })),
      source: "omg-runtime",
      headers: {},
      env: {},
      bearerTokenEnvVar: null,
    };
  }
  return merged;
}

/**
 * Manifest for discovery surfaces (status endpoints, reports): names,
 * transports and hashed specs ONLY — never URLs with query tokens from
 * runtime entries, never commands, never env/header values.
 */
/**
 * Auth-availability evidence per namespace (item 24): whether the CENTRAL
 * credential the baseline provider used actually resolved in THIS process —
 * names and booleans only, never header values. `resolved:false` means the
 * bridge proxies without the baseline's credential (a URL-only OAuth server
 * relying on the native central store), which readiness must surface as an
 * explicit degraded state, never silent tool parity.
 */
export function namespaceAuthStatus(
  namespaces: Record<string, FullNamespaceEntry>,
): Record<string, { kind: CentralNamespaceKind; authResolved: boolean; source: CentralNamespace["source"] }> {
  const out: Record<string, { kind: CentralNamespaceKind; authResolved: boolean; source: CentralNamespace["source"] }> = {};
  for (const [name, entry] of Object.entries(namespaces)) {
    out[name] = {
      kind: entry.kind,
      authResolved: entry.source === "omg-runtime" || Object.keys(entry.headers).length > 0,
      source: entry.source,
    };
  }
  return out;
}

export function namespaceManifest(namespaces: Record<string, FullNamespaceEntry>): Array<{
  name: string;
  kind: CentralNamespaceKind;
  specSha256: string;
  source: CentralNamespace["source"];
}> {
  return Object.values(namespaces)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, kind, specSha256, source }) => ({ name, kind, specSha256, source }));
}
