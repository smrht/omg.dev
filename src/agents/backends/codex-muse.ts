// Muse Spark inside the Codex harness.
//
// Meta's api.meta.ai/v1 is OpenAI-compatible (Responses + Chat Completions),
// and the credential `muse login` leaves in ~/.config/muse/auth.json is the
// Muse *subscription* key: every call answers with a
// `response.subscription_usage` event, so nothing here is pay-as-you-go. Muse
// Code's own harness (muse-msp-session.ts) kept losing its view stream mid-turn
// (muse 1.0.3); Codex is Responses-native and drives the same model with a
// mature agent loop, so a `muse-spark-*` model picked on the codex-aisdk agent
// is routed through these overrides instead of through `muse serve`.
//
// Meta's own Codex recipe (dev.meta.ai/docs/coding-agents) plus two things it
// does not say, both measured on 2026-09-04:
//   - ChatGPT Apps connectors (gmail, heygen) carry recursive JSON schemas
//     ($defs self-references); Meta rejects the WHOLE request with
//     "Recursive JSON schemas are not currently supported" → `features.apps`
//     off for these threads.
//   - muse-spark-1.3 is region-gated (NL origin only; from this box the model
//     is `model_not_found`), so the thread inherits the Muse egress proxy
//     (OMG_MUSE_PROXY → museChildEnv). That bridge admits Meta hosts only, so
//     every remote MCP server that is neither local nor on the tailnet is
//     disabled for the thread rather than left to hang on startup.
// The default ~/.codex profile is untouched: OpenAI models keep working next to
// this, the overrides ride the per-launch `--config` layer.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexConfigValue } from "../../codex-mcp-config.ts";
import { museChildEnv } from "../../muse-proxy.ts";

export const CODEX_MUSE_MODELS: readonly string[] = ["muse-spark-1.3", "muse-spark-1.2"];
/** Reasoning levels Meta serves per model; `max` is Standard-tier 1.3 only. */
const MUSE_REASONING_LEVELS: Record<string, readonly string[]> = {
  "muse-spark-1.3": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  "muse-spark-1.2": ["none", "minimal", "low", "medium", "high", "xhigh"],
};
export const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";

export function isMuseCodexModel(model: string | null | undefined): boolean {
  return typeof model === "string" && /^muse-spark-/.test(model);
}

/**
 * The Muse subscription credential: META_API_KEY when set, else the api_key
 * `muse login` stored (the OAuth access_token next to it is NOT accepted by
 * the model endpoints — 401). Undefined when nobody is logged in.
 */
export function museSubscriptionKey(
  env: NodeJS.ProcessEnv = process.env,
  authPath: string = join(env.HOME ?? homedir(), ".config", "muse", "auth.json"),
): string | undefined {
  const fromEnv = env.META_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as { providers?: { meta?: { api_key?: unknown } } };
    const key = auth?.providers?.meta?.api_key;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

const LOCAL_OR_TAILNET_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[^/]*\.ts\.net)(?::\d+)?(?:\/|$)/i;

/** Names of the remote MCP servers in config.toml that the Meta-only egress cannot reach. */
export function unreachableRemoteMcpServers(codexConfig: Record<string, unknown> | null | undefined): string[] {
  const servers = codexConfig?.mcp_servers;
  if (!servers || typeof servers !== "object") return [];
  const out: string[] = [];
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
    const url = (def as { url?: unknown } | null)?.url;
    if (typeof url === "string" && url && !LOCAL_OR_TAILNET_URL.test(url)) out.push(name);
  }
  return out;
}

/** Shallow merge of two codex `--config` layers; `mcp_servers` merges per server so both layers keep their entries. */
export function mergeCodexConfig(
  base: { [key: string]: CodexConfigValue } | undefined,
  extra: { [key: string]: CodexConfigValue } | undefined,
): { [key: string]: CodexConfigValue } | undefined {
  if (!base) return extra;
  if (!extra) return base;
  const out: { [key: string]: CodexConfigValue } = { ...base, ...extra };
  const a = base.mcp_servers;
  const b = extra.mcp_servers;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const merged: { [key: string]: CodexConfigValue } = { ...a };
    for (const [name, def] of Object.entries(b)) {
      const prev = merged[name];
      merged[name] =
        prev && typeof prev === "object" && !Array.isArray(prev) && def && typeof def === "object" && !Array.isArray(def)
          ? { ...prev, ...def }
          : def;
    }
    out.mcp_servers = merged;
  }
  return out;
}

export type MuseCodexOverrides = {
  config: { [key: string]: CodexConfigValue };
  /** Full child environment (the Codex SDK's `env` option REPLACES process.env, it does not merge). */
  env: Record<string, string>;
};

/**
 * Codex launch overrides that put a `muse-spark-*` thread on Meta's Responses
 * API with the Muse subscription. Null for every other model, so callers can
 * spread the result unconditionally.
 */
export function museCodexOverrides(
  model: string | null | undefined,
  opts: { env?: NodeJS.ProcessEnv; codexConfig?: Record<string, unknown> | null; key?: string; modelCatalogPath?: string | null } = {},
): MuseCodexOverrides | null {
  if (!isMuseCodexModel(model)) return null;
  const env = opts.env ?? process.env;
  const key = opts.key ?? museSubscriptionKey(env);
  if (!key) {
    throw new Error(`${model} runs on the Muse subscription: run \`muse login\` first (or set META_API_KEY)`);
  }
  const config: { [key: string]: CodexConfigValue } = {
    model_provider: "meta",
    model_providers: {
      meta: {
        name: "Meta Muse Spark (Muse subscription)",
        base_url: META_MODEL_API_BASE_URL,
        env_key: "META_API_KEY",
        wire_api: "responses",
        requires_openai_auth: false,
      },
    },
    model_reasoning_summary: "auto",
    model_context_window: 1_048_576,
    model_supports_reasoning_summaries: true,
    model_auto_compact_token_limit: 900_000,
    features: { apps: false },
  };
  const catalogPath = opts.modelCatalogPath === undefined ? ensureMuseModelCatalogFile() : opts.modelCatalogPath;
  if (catalogPath) config.model_catalog_json = catalogPath;
  const unreachable = unreachableRemoteMcpServers(opts.codexConfig);
  if (unreachable.length) {
    const mcp_servers: { [key: string]: CodexConfigValue } = {};
    for (const name of unreachable) mcp_servers[name] = { enabled: false };
    config.mcp_servers = mcp_servers;
  }
  const child = museChildEnv(env);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(child)) if (v !== undefined) out[k] = v;
  out.META_API_KEY = key;
  if (child.HTTPS_PROXY) {
    // museChildEnv excludes loopback; the executor MCP lives on the tailnet.
    const noProxy = [out.NO_PROXY, "::1", ".ts.net", "100.64.0.0/10"].filter(Boolean).join(",");
    out.NO_PROXY = noProxy;
    out.no_proxy = noProxy;
    out.https_proxy = child.HTTPS_PROXY;
    out.http_proxy = child.HTTPS_PROXY;
  }
  return { config, env: out };
}

/** `new Codex({...})` options for a model: the muse overrides folded into the OMG MCP layer, or the layer unchanged. */
export function codexSdkOptionsForModel(
  model: string | null | undefined,
  base: { config?: { [key: string]: CodexConfigValue } },
  opts: { env?: NodeJS.ProcessEnv; codexConfig?: Record<string, unknown> | null } = {},
): { config?: { [key: string]: CodexConfigValue }; env?: Record<string, string> } {
  const muse = museCodexOverrides(model, opts);
  if (!muse) return base;
  const config = mergeCodexConfig(base.config, muse.config);
  return { ...(config ? { config } : {}), env: muse.env };
}

/**
 * Codex's model catalog has no Meta entry, so every muse thread booted with
 * "Model metadata for `muse-spark-1.3` not found. Defaulting to fallback
 * metadata" as a ⚠️ row in the chat. `model_catalog_json` accepts a catalog in
 * the same shape as ~/.codex/models_cache.json; this derives one from a cached
 * OpenAI entry (instructions template included — the parser refuses an entry
 * without one) with the Meta-specific fields swapped in. Everything Meta's
 * endpoint rejects is off: `custom` tools (freeform apply_patch, code mode's
 * `exec`), `search_content_types` on web search, responses-lite.
 */
export function museModelCatalog(cache: { models?: unknown } | null | undefined): { models: Record<string, unknown>[] } | null {
  const models = Array.isArray(cache?.models) ? (cache!.models as Record<string, unknown>[]) : [];
  const withInstructions = (m: Record<string, unknown>) =>
    typeof (m.model_messages as { instructions_template?: unknown } | null)?.instructions_template === "string";
  const base = models.find((m) => m.slug === "gpt-5.6-sol" && withInstructions(m)) ?? models.find(withInstructions);
  if (!base) return null;
  const messages = base.model_messages as Record<string, unknown>;
  const template = String(messages.instructions_template).replace(
    /^You are Codex, an agent based on [^.]+\./,
    "You are Codex, an agent based on Meta's Muse Spark.",
  );
  const entries = CODEX_MUSE_MODELS.map((slug, index) => ({
    ...base,
    slug,
    display_name: `Muse Spark ${slug.replace("muse-spark-", "")}`,
    description: "Meta Muse Spark via api.meta.ai (Muse subscription)",
    default_reasoning_level: "high",
    supported_reasoning_levels: MUSE_REASONING_LEVELS[slug]!.map((effort) => ({ effort, description: effort })),
    priority: 100 + index,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    model_messages: { ...messages, instructions_template: template },
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    tool_mode: null,
    multi_agent_version: null,
    context_window: 1_048_576,
    max_context_window: 1_048_576,
    effective_context_window_percent: 90,
    input_modalities: ["text", "image"],
    use_responses_lite: false,
    supports_search_tool: false,
    comp_hash: null,
  }));
  return { models: entries };
}

/**
 * Writes the derived catalog next to codex's own cache and returns its path,
 * or undefined when there is no cache to derive from (codex then falls back to
 * its generic metadata, warning included — degraded, not broken).
 */
export function ensureMuseModelCatalogFile(
  codexHome: string = join(process.env.CODEX_HOME?.trim() || join(process.env.HOME ?? homedir(), ".codex")),
): string | undefined {
  let cache: { models?: unknown } | null = null;
  try {
    cache = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8"));
  } catch {
    return undefined;
  }
  const catalog = museModelCatalog(cache);
  if (!catalog) return undefined;
  const path = join(codexHome, "muse-model-catalog.json");
  const next = JSON.stringify(catalog, null, 1);
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current !== next) {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path, next);
  }
  return path;
}
