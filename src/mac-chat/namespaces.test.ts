// Item 24: deterministic namespace discovery through the env test seam —
// expected CENTRAL headers (bearer_token_env_var, env_http_headers, literal
// http_headers) resolved per entry, name-specific identity preserved,
// provider-specific sets, and auth-availability evidence (names/booleans
// only — never header values).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverCentralNamespaces, namespaceAuthStatus, namespaceManifest } from "./namespaces.ts";

let base: string;
let claudeJson: string;
let codexToml: string;

beforeAll(() => {
  base = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "ns-"));
  claudeJson = join(base, "claude.json");
  codexToml = join(base, "codex.toml");
  writeFileSync(claudeJson, JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      headered: { type: "http", url: "https://h.example/mcp", headers: { "x-api-key": "claude-literal-key" } },
      oauthUrlOnly: { type: "http", url: "https://oauth.example/mcp" },
      // Exact LIVE central shape (tmux.ts AUTH_HEADER_REJECTED evidence): the
      // Claude-side Executor entry carries its bearer as a header VALUE with
      // an env reference, not as codex bearer_token_env_var.
      executor: {
        type: "http",
        url: "https://executor.example/mcp",
        headers: { authorization: "Bearer ${EXECUTOR_MCP_TOKEN}" },
      },
      defaulted: {
        type: "http",
        url: "https://d.example/mcp",
        headers: { "x-api-key": "Bearer ${MISSING_TOK:-fallback-key}" },
      },
      mixed: {
        type: "http",
        url: "https://m.example/mcp",
        headers: { "x-combined": "org-${ORG_ENV_VAR}-${EXECUTOR_MCP_TOKEN}", "x-unclosed": "keep ${UNCLOSED", "x-weird": "keep ${} and $PLAIN" },
      },
    },
  }));
  writeFileSync(codexToml, [
    '[mcp_servers.executor]',
    'url = "https://executor.example/mcp"',
    'bearer_token_env_var = "EXECUTOR_MCP_TOKEN"',
    "",
    "[mcp_servers.envheader]",
    'url = "https://eh.example/mcp"',
    "bearer_token_env_var = \"EXECUTOR_MCP_TOKEN\"",
    "",
    "[mcp_servers.envheader.env_http_headers]",
    "X-Org = \"ORG_ENV_VAR\"",
    "",
    "[mcp_servers.chrome-work]",
    'command = "/usr/local/bin/chrome-work-mcp"',
    'args = ["mcp", "--stdio"]',
    "",
  ].join("\n"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function discover(provider: "claude" | "codex", env: Record<string, string | undefined>) {
  return discoverCentralNamespaces({
    provider,
    home: base,
    claudeUserConfigPath: claudeJson,
    codexUserConfigPath: codexToml,
    env,
  });
}

describe("namespace discovery through the env seam (item 24)", () => {
  test("codex bearer_token_env_var resolves the CENTRAL bearer; env_http_headers map by name", () => {
    const map = discover("codex", { EXECUTOR_MCP_TOKEN: "executor-bearer-central", ORG_ENV_VAR: "org-42" });
    const executor = map.executor;
    expect(executor).toBeDefined();
    expect(executor!.headers.authorization).toBe("Bearer executor-bearer-central");
    const envheader = map.envheader;
    expect(envheader!.headers.authorization).toBe("Bearer executor-bearer-central");
    expect(envheader!.headers["X-Org"]).toBe("org-42");
    expect(envheader!.bearerTokenEnvVar).toBe("EXECUTOR_MCP_TOKEN");
    // stdio entries carry command/args (adapted centrally), never auth.
    expect(map["chrome-work"]?.kind).toBe("stdio");
    expect(map["chrome-work"]?.command).toBe("/usr/local/bin/chrome-work-mcp");
  });

  test("unresolved env credentials do NOT silently vanish — auth evidence shows false (URL-only OAuth state)", () => {
    const map = discover("codex", {}); // no EXECUTOR_MCP_TOKEN in this env
    const status = namespaceAuthStatus(map);
    expect(status.executor.authResolved).toBe(false); // explicit degraded state
    expect(status["chrome-work"].authResolved).toBe(false); // stdio: no bearer by definition
    const mapResolved = discover("codex", { EXECUTOR_MCP_TOKEN: "tok" });
    expect(namespaceAuthStatus(mapResolved).executor.authResolved).toBe(true);
  });

  test("literal http_headers supported when encountered; manifests never carry values", () => {
    const map = discover("claude", {});
    expect(map.headered?.headers["x-api-key"]).toBe("claude-literal-key");
    const manifest = namespaceManifest(map);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("claude-literal-key");
    expect(serialized).not.toContain("executor-bearer-central");
    expect(manifest.some((m) => m.name === "headered" && m.kind === "https")).toBe(true);
  });

  test("provider-specific sets: claude entries never appear for codex and vice versa", () => {
    const claude = discover("claude", {});
    const codex = discover("codex", {});
    expect(claude.github).toBeDefined();
    expect(codex.github).toBeUndefined();
    expect(codex.executor).toBeDefined();
    expect(claude.executor).toBeDefined(); // claude-side executor entry now exists too
    // runtime namespaces win over same-named user entries
    const withRuntime = discoverCentralNamespaces({
      provider: "claude",
      home: base,
      claudeUserConfigPath: claudeJson,
      codexUserConfigPath: codexToml,
      env: {},
      runtime: { github: "http://127.0.0.1:8766/mcp?session=x" },
    });
    expect(withRuntime.github?.source).toBe("omg-runtime");
  });

  describe("claude-standard env expansion in config header values", () => {
    test("exact live shape: Bearer ${EXECUTOR_MCP_TOKEN} expands from the supplied env", () => {
      const map = discover("claude", { EXECUTOR_MCP_TOKEN: "executor-bearer-central" });
      expect(map.executor).toBeDefined();
      expect(map.executor!.headers.authorization).toBe("Bearer executor-bearer-central");
      expect(map.executor!.bearerTokenEnvVar).toBeNull(); // header form, not codex bearer form
      expect(namespaceAuthStatus(map).executor.authResolved).toBe(true);
    });

    test("missing/unset variable fails closed: header omitted, never the literal ref, never empty auth", () => {
      const map = discover("claude", {}); // EXECUTOR_MCP_TOKEN absent
      expect(map.executor!.headers.authorization).toBeUndefined();
      const serialized = JSON.stringify(map.executor!.headers);
      expect(serialized).not.toContain("EXECUTOR_MCP_TOKEN");
      expect(serialized).not.toContain("${");
      expect(namespaceAuthStatus(map).executor.authResolved).toBe(false); // explicit degraded state
      // set-but-EMPTY is also unresolved (no `Bearer ` with empty credential)
      const emptyEnv = discover("claude", { EXECUTOR_MCP_TOKEN: "" });
      expect(emptyEnv.executor!.headers.authorization).toBeUndefined();
      expect(namespaceAuthStatus(emptyEnv).executor.authResolved).toBe(false);
    });

    test("official ${VAR:-default} syntax: default when unset or empty, value wins when set", () => {
      const unset = discover("claude", {});
      expect(unset.defaulted!.headers["x-api-key"]).toBe("Bearer fallback-key");
      const empty = discover("claude", { MISSING_TOK: "" }); // bash :- semantics: empty uses default
      expect(empty.defaulted!.headers["x-api-key"]).toBe("Bearer fallback-key");
      const set = discover("claude", { MISSING_TOK: "real-key" });
      expect(set.defaulted!.headers["x-api-key"]).toBe("Bearer real-key");
      expect(namespaceAuthStatus(unset).defaulted.authResolved).toBe(true);
    });

    test("multiple refs expand in one value; malformed refs and literals stay verbatim", () => {
      const map = discover("claude", { ORG_ENV_VAR: "org-42", EXECUTOR_MCP_TOKEN: "tok" });
      expect(map.mixed!.headers["x-combined"]).toBe("org-org-42-tok");
      expect(map.mixed!.headers["x-unclosed"]).toBe("keep ${UNCLOSED");
      expect(map.mixed!.headers["x-weird"]).toBe("keep ${} and $PLAIN");
      // one unresolved ref in a value fails that whole header closed
      const partial = discover("claude", { EXECUTOR_MCP_TOKEN: "tok" });
      expect(partial.mixed!.headers["x-combined"]).toBeUndefined();
      // literal headers without refs are preserved byte-for-byte
      expect(map.headered?.headers["x-api-key"]).toBe("claude-literal-key");
    });

    test("expanded header values never leak into the audit manifest", () => {
      const map = discover("claude", { EXECUTOR_MCP_TOKEN: "executor-bearer-central" });
      const serialized = JSON.stringify(namespaceManifest(map));
      expect(serialized).not.toContain("executor-bearer-central");
      expect(serialized).not.toContain("EXECUTOR_MCP_TOKEN");
    });
  });
});
