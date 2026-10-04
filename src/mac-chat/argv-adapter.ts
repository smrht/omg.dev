// Client-side native-argv adaptation for the Mac stream transport.
//
// The Mac supervisor (schema.py) validates native argv against EXACT
// allowlists and refuses prompt/settings/MCP flags ON ARGV — because argv is
// world-readable and local temp paths do not exist on the Mac. This module
// adapts what the SDK/app-server builders produce BEFORE it goes on the wire:
//
//   - EXTRACT flags whose VALUES must not ride argv and deliver them through
//     their supported native channel instead (--settings → SDK
//     applyFlagSettings; --append-system-prompt/--system-prompt → per-turn
//     context preamble; --mcp-config local temp path → lease provisioning);
//     extraction is REPORTED, never silent.
//   - a client-side screen mirroring schema.py's rules (prefix, refused
//     flags, value-flag shape) so a bad argv fails HERE with the flag name,
//     before any network.
//
// The screen intentionally duplicates schema.py's semantics; the cross-
// language fixture test (mac-chat/argv-schema.test.ts) runs BOTH against the
// same argv arrays, so the two validators cannot drift silently.
export type ArgvExtraction = {
  argv: string[];
  settingsJson: { raw: string; parsed: Record<string, unknown> } | null;
  systemPromptAppend: string | null;
  systemPrompt: string | null;
  mcpConfigPath: string | null;
  debugFile: string | null;
  notes: string[];
};

const CLAUDE_PREFIX = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

/** Claude flags the supervisor refuses ON ARGV; extracted, never forwarded. */
const CLAUDE_EXTRACT_VALUE_FLAGS = new Set(["--settings", "--append-system-prompt", "--system-prompt", "--mcp-config", "--debug-file"]);

/** Claude flags the supervisor hard-refuses and we cannot re-provision: fatal. */
const CLAUDE_FATAL_FLAGS = new Map<string, string>([
  ["-p", "one-shot print mode is not transportable"],
  ["--print", "one-shot print mode is not transportable"],
  ["--dangerously-skip-permissions", "permission bypass is not transportable"],
  ["--allow-dangerously-skip-permissions", "permission bypass is not transportable"],
  ["--managed-settings", "arbitrary settings file is not transportable"],
  ["--plugin-dir", "plugins are not provisioned"],
  ["--plugin-dir-no-mcp", "plugins are not provisioned"],
  ["--plugin-url", "plugins are not provisioned"],
  ["--agents", "custom agents are not provisioned"],
  ["--file", "startup downloads are not provisioned"],
  ["--cloud", "cloud sessions are not transportable"],
  ["--teleport", "teleport sessions are not transportable"],
  ["--remote-control", "remote control is not transportable"],
  ["--client-data-url", "signed config url is not transportable"],
  ["--bg", "background mode is not transportable"],
  ["--tmux", "tmux mode is not transportable"],
  ["-w", "worktree mode is not transportable"],
  ["--worktree", "worktree mode is not transportable"],
]);

const CLAUDE_VALUE_FLAG_NAMES = new Set([
  "--model", "--fallback-model", "--effort", "--permission-mode", "--permission-prompt-tool",
  "--max-turns", "--max-budget-usd", "--agent", "--betas", "--json-schema", "--debug-file",
  "--resume", "--allowedTools", "--disallowedTools", "--tools", "--session-id", "--add-dir",
  "--setting-sources",
]);

const CLAUDE_BOOL_FLAGS = new Set([
  "--continue", "--strict-mcp-config", "--include-partial-messages", "--include-hook-events",
  "--fork-session", "--no-session-persistence", "--replay-user-messages", "--verbose",
  "--restricted",
]);

export type ArgvAdaptResult =
  | { ok: true; extraction: ArgvExtraction }
  | { ok: false; error: string };

/**
 * Canonicalize `--flag=value` equals syntax into the separated
 * `--flag value` form for EXPLICITLY ALLOWED value flags only.
 *
 * Why: SDK builds differ in what they emit as equals — the production
 * harness failed the Mac stream with `unknown or unsupported flag
 * --session-id=<uuid>` (that SDK build emits equals), while this repo's
 * 0.3.206 emits the same flag separated. The Mac schema (schema.py) accepts
 * ONLY the separated form for value flags, plus the special
 * `--setting-sources=` empty canonical token; the schema is NOT widened to
 * equals (M1 pins untouched). Rules, mirroring schema.py:
 *   - `--setting-sources=…` stays VERBATIM — its canonical form IS the
 *     equals token (empty value = hermetic no-sources, item 33);
 *   - equals for a flag in CLAUDE_VALUE_FLAG_NAMES splits at the FIRST `=`;
 *     a value starting with `--` is refused as a missing value, exactly like
 *     the native separated form (schema rejects such values too);
 *   - equals for anything else (`--settings={…}`, `--verbose=1`, unknowns)
 *     is NOT canonicalized — the main loop below refuses it by its exact
 *     name, so this can never widen the allowlist;
 *   - a value flag may appear ONCE across BOTH forms. schema.py validates
 *     tokens pairwise and lets a duplicate through silently, so the
 *     duplicate refusal (including mixed equals/separated masking) is owned
 *     HERE, before any network.
 * Value CONTENT (uuid syntax, effort vocabulary, …) stays the schema's
 * authority: the client screens shape, the Mac screen rejects bad values.
 */
function canonicalizeEqualsValueFlags(argv: string[]): { ok: true; argv: string[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const count = (name: string): string | null => {
    if (seen.has(name)) return `${name} appears twice (duplicate value flag refused)`;
    seen.add(name);
    return null;
  };
  const out: string[] = [...CLAUDE_PREFIX];
  for (let at = CLAUDE_PREFIX.length; at < argv.length; at++) {
    const tok = argv[at]!;
    if (tok.startsWith("--setting-sources=")) {
      const dupe = count("--setting-sources");
      if (dupe) return { ok: false, error: dupe };
      out.push(tok);
      continue;
    }
    if (tok.startsWith("--") && tok.includes("=")) {
      const eq = tok.indexOf("=");
      const name = tok.slice(0, eq);
      if (CLAUDE_VALUE_FLAG_NAMES.has(name)) {
        const dupe = count(name);
        if (dupe) return { ok: false, error: dupe };
        const value = tok.slice(eq + 1);
        if (value.startsWith("--")) {
          return { ok: false, error: `${name} missing value (equals form)` };
        }
        out.push(name, value);
        continue;
      }
      out.push(tok);
      continue;
    }
    if (CLAUDE_VALUE_FLAG_NAMES.has(tok)) {
      const dupe = count(tok);
      if (dupe) return { ok: false, error: dupe };
    }
    out.push(tok);
  }
  return { ok: true, argv: out };
}

/**
 * Adapt a Claude Agent SDK argv (executable excluded) for the wire. Unknown
 * flags are FATAL here exactly as they are on the Mac — a setting we cannot
 * transport must fail loudly, never silently drop.
 */
export function adaptClaudeArgv(input: readonly string[]): ArgvAdaptResult {
  const argv = [...input];
  if (argv.length < CLAUDE_PREFIX.length || !CLAUDE_PREFIX.every((t, i) => argv[i] === t)) {
    return { ok: false, error: `argv must start with the SDK streaming prefix (${CLAUDE_PREFIX.join(" ")})` };
  }
  const canonicalized = canonicalizeEqualsValueFlags(argv);
  if (!canonicalized.ok) return { ok: false, error: canonicalized.error };
  const scanned = canonicalized.argv;
  const out: string[] = [...CLAUDE_PREFIX];
  const extraction: ArgvExtraction = {
    argv: [],
    settingsJson: null,
    systemPromptAppend: null,
    systemPrompt: null,
    mcpConfigPath: null,
    debugFile: null,
    notes: [],
  };
  let i = CLAUDE_PREFIX.length;
  while (i < scanned.length) {
    const tok = scanned[i]!;
    const fatal = CLAUDE_FATAL_FLAGS.get(tok);
    if (fatal) return { ok: false, error: `${tok}: ${fatal}` };
    if (CLAUDE_EXTRACT_VALUE_FLAGS.has(tok)) {
      if (i + 1 >= scanned.length || scanned[i + 1]!.startsWith("--")) {
        return { ok: false, error: `${tok} missing value` };
      }
      const value = scanned[i + 1]!;
      switch (tok) {
        case "--settings": {
          let parsed: Record<string, unknown>;
          try {
            const decoded = JSON.parse(value) as unknown;
            if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
              return { ok: false, error: "--settings value must be a JSON object" };
            }
            parsed = decoded as Record<string, unknown>;
          } catch {
            return { ok: false, error: "--settings value is not valid JSON" };
          }
          extraction.settingsJson = { raw: value, parsed };
          extraction.notes.push("--settings extracted from argv; re-applied natively via applyFlagSettings");
          break;
        }
        case "--append-system-prompt":
          extraction.systemPromptAppend = value;
          extraction.notes.push("--append-system-prompt extracted from argv; central context rides the per-turn preamble instead");
          break;
        case "--system-prompt":
          extraction.systemPrompt = value;
          extraction.notes.push("--system-prompt extracted from argv; central context rides the per-turn preamble instead");
          break;
        case "--mcp-config":
          extraction.mcpConfigPath = value;
          extraction.notes.push(`--mcp-config local path (${value.split("/").pop()}) not forwarded; MCP is provisioned in the Mac session lease`);
          break;
        case "--debug-file":
          extraction.debugFile = value;
          extraction.notes.push("--debug-file local path not forwarded (remote debug files stay under the Mac scratch)");
          break;
      }
      i += 2;
      continue;
    }
    if (tok.startsWith("--setting-sources=")) {
      out.push(tok);
      i += 1;
      continue;
    }
    if (CLAUDE_BOOL_FLAGS.has(tok)) {
      out.push(tok);
      i += 1;
      continue;
    }
    if (CLAUDE_VALUE_FLAG_NAMES.has(tok)) {
      if (i + 1 >= scanned.length || scanned[i + 1]!.startsWith("--")) {
        return { ok: false, error: `${tok} missing value` };
      }
      out.push(tok, scanned[i + 1]!);
      i += 2;
      continue;
    }
    if (tok.startsWith("-")) {
      return {
        ok: false,
        error: `unknown or unsupported flag ${tok} (refused, not dropped; add via Mac config schema override after CLI upgrade)`,
      };
    }
    return { ok: false, error: `unexpected non-flag argv token` };
  }
  extraction.argv = out;
  return { ok: true, extraction };
}

/** Codex config keys the supervisor whitelists (schema.py CODEX_CONFIG_KEYS). */
export const CODEX_ALLOWED_CONFIG_KEYS = new Set(["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity"]);

/**
 * Narrowly-allowed Fast config — the EXACT emission of omg
 * src/service-tier.ts withCodexServiceTierConfig(_, "fast") (peer schema:
 * service_tier must be "fast"; features must be exactly {fast_mode: true};
 * every other service_tier value and features.* key stays refused).
 */
export function isExactCodexFastConfig(codexConfig: Record<string, unknown>): boolean {
  return codexConfig.service_tier === "fast"
    && !!codexConfig.features
    && typeof codexConfig.features === "object"
    && !Array.isArray(codexConfig.features)
    && Object.keys(codexConfig.features as Record<string, unknown>).length === 1
    && (codexConfig.features as Record<string, unknown>).fast_mode === true;
}

/**
 * Adapt a Codex app-server config override table into wire-legal
 * `-c key=value` argv tokens. Whitelisted keys plus the exact Fast emission
 * pass; everything else is an explicit error (refused, never silently
 * dropped). NOTE the conflict rule: when the caller passes Fast via
 * metadata settings (the harness route), it must NOT also ride argv.
 */
export function adaptCodexConfigArgv(codexConfig: Record<string, unknown> | null | undefined): ArgvAdaptResult {
  const argv: string[] = ["app-server", "--stdio"];
  if (!codexConfig) return { ok: true, extraction: emptyExtraction(argv) };
  const exactFast = isExactCodexFastConfig(codexConfig);
  for (const [key, value] of Object.entries(codexConfig)) {
    if (key === "service_tier" && value === "fast" && exactFast) {
      argv.push("-c", 'service_tier="fast"');
      continue;
    }
    if (key === "features" && exactFast) {
      argv.push("-c", "features.fast_mode=true");
      continue;
    }
    if (!CODEX_ALLOWED_CONFIG_KEYS.has(key)) {
      return {
        ok: false,
        error: `codex config key "${key}" is not in the Mac transport whitelist (refused, not dropped)`,
      };
    }
    if (value === undefined) continue;
    if (typeof value === "string") {
      argv.push("-c", `${key}=${JSON.stringify(value)}`);
    } else if (typeof value === "boolean" || typeof value === "number") {
      argv.push("-c", `${key}=${String(value)}`);
    } else {
      return { ok: false, error: `codex config key "${key}" must be a TOML scalar` };
    }
  }
  return { ok: true, extraction: emptyExtraction(argv) };
}

function emptyExtraction(argv: string[]): ArgvExtraction {
  return {
    argv,
    settingsJson: null,
    systemPromptAppend: null,
    systemPrompt: null,
    mcpConfigPath: null,
    debugFile: null,
    notes: [],
  };
}
