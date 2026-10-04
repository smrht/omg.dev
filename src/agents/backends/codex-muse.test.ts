import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexSdkOptionsForModel,
  isMuseCodexModel,
  mergeCodexConfig,
  ensureMuseModelCatalogFile,
  museCodexOverrides,
  museModelCatalog,
  museSubscriptionKey,
  unreachableRemoteMcpServers,
} from "./codex-muse.ts";

const CODEX_CONFIG = {
  mcp_servers: {
    omg: { command: "/home/agent/.bun/bin/bun" },
    computer: { url: "http://127.0.0.1:8766/mcp/computer" },
    executor: { url: "https://netcup-vps8000-95-88.tailda028c.ts.net:8443/mcp" },
    cloudflare: { url: "https://mcp.cloudflare.com/mcp" },
    github: { url: "https://api.githubcopilot.com/mcp/" },
  },
};

describe("muse-spark on the codex harness", () => {
  test("only muse-spark ids are routed; OpenAI models stay untouched", () => {
    expect(isMuseCodexModel("muse-spark-1.3")).toBe(true);
    expect(isMuseCodexModel("gpt-5.6-sol")).toBe(false);
    expect(museCodexOverrides("gpt-5.6-sol", { env: {}, key: "x" })).toBeNull();
    expect(codexSdkOptionsForModel("gpt-5.6-sol", { config: { a: 1 } }, { env: {} })).toEqual({ config: { a: 1 } });
  });

  test("the subscription key comes from META_API_KEY or muse login's auth.json, never the OAuth token", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-"));
    const auth = join(dir, "auth.json");
    writeFileSync(auth, JSON.stringify({ providers: { meta: { access_token: "oauth", api_key: "LLM|sub" } } }));
    expect(museSubscriptionKey({}, auth)).toBe("LLM|sub");
    expect(museSubscriptionKey({ META_API_KEY: "env-key" }, auth)).toBe("env-key");
    expect(museSubscriptionKey({}, join(dir, "missing.json"))).toBeUndefined();
  });

  test("without a credential the launch fails loudly instead of hitting Meta unauthenticated", () => {
    expect(() => museCodexOverrides("muse-spark-1.3", { env: { HOME: "/nonexistent" }, codexConfig: null })).toThrow(/muse login/);
  });

  test("remote MCP servers beyond loopback and the tailnet are the only ones disabled", () => {
    expect(unreachableRemoteMcpServers(CODEX_CONFIG)).toEqual(["cloudflare", "github"]);
    expect(unreachableRemoteMcpServers(null)).toEqual([]);
  });

  test("overrides route to Meta's Responses API, drop Apps, and carry the key plus the Muse egress proxy", () => {
    const env = { HOME: "/nonexistent", OMG_MUSE_PROXY: "http://127.0.0.1:18081", NO_PROXY: "example.internal" };
    const out = museCodexOverrides("muse-spark-1.3", { env, key: "LLM|sub", codexConfig: CODEX_CONFIG, modelCatalogPath: null })!;
    expect(out.config.model_provider).toBe("meta");
    expect(out.config.model_providers).toEqual({
      meta: {
        name: "Meta Muse Spark (Muse subscription)",
        base_url: "https://api.meta.ai/v1",
        env_key: "META_API_KEY",
        wire_api: "responses",
        requires_openai_auth: false,
      },
    });
    expect(out.config.features).toEqual({ apps: false });
    expect(out.config.mcp_servers).toEqual({ cloudflare: { enabled: false }, github: { enabled: false } });
    expect(out.env.META_API_KEY).toBe("LLM|sub");
    expect(out.env.HTTPS_PROXY).toBe("http://127.0.0.1:18081");
    expect(out.env.NO_PROXY).toBe("127.0.0.1,localhost,example.internal,::1,.ts.net,100.64.0.0/10");
    expect(out.env.HOME).toBe("/nonexistent");
  });

  test("without OMG_MUSE_PROXY no proxy variables are injected", () => {
    const out = museCodexOverrides("muse-spark-1.2", { env: { HOME: "/x" }, key: "k", codexConfig: null, modelCatalogPath: null })!;
    expect(out.env.HTTPS_PROXY).toBeUndefined();
    expect(out.config.mcp_servers).toBeUndefined();
  });

  test("the OMG MCP session layer survives the merge, per server", () => {
    const base = { config: { mcp_servers: { omg: { env: { OMG_SESSION_ID: "s1" } } }, service_tier: "default" } };
    const out = codexSdkOptionsForModel("muse-spark-1.3", base, { env: { HOME: "/x", META_API_KEY: "k" }, codexConfig: CODEX_CONFIG });
    expect(out.config?.mcp_servers).toEqual({
      omg: { env: { OMG_SESSION_ID: "s1" } },
      cloudflare: { enabled: false },
      github: { enabled: false },
    });
    expect(out.config?.service_tier).toBe("default");
    expect(out.config?.model_provider).toBe("meta");
    expect(out.env?.META_API_KEY).toBe("k");
    expect(mergeCodexConfig(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeCodexConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test("the derived model catalog swaps in Meta fields and drops every tool shape Meta rejects", () => {
    const cache = {
      models: [
        { slug: "gpt-5.4", model_messages: { instructions_template: "You are Codex, an agent based on GPT-5. Hi." }, tool_mode: null },
        {
          slug: "gpt-5.6-sol",
          shell_type: "unified_exec",
          apply_patch_tool_type: "freeform",
          web_search_tool_type: "text_and_image",
          tool_mode: "code_mode_only",
          use_responses_lite: true,
          context_window: 272000,
          model_messages: { instructions_template: "You are Codex, an agent based on GPT-5. Hi.", token_budget: { a: 1 } },
        },
      ],
    };
    const catalog = museModelCatalog(cache)!;
    expect(catalog.models.map((m) => m.slug)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    const m13 = catalog.models[0]!;
    expect(m13.display_name).toBe("Muse Spark 1.3");
    expect(m13.shell_type).toBe("unified_exec");
    expect(m13.apply_patch_tool_type).toBeNull();
    expect(m13.tool_mode).toBeNull();
    expect(m13.web_search_tool_type).toBe("text");
    expect(m13.use_responses_lite).toBe(false);
    expect(m13.context_window).toBe(1_048_576);
    expect((m13.model_messages as { instructions_template: string }).instructions_template).toBe("You are Codex, an agent based on Meta's Muse Spark. Hi.");
    expect((m13.model_messages as { token_budget: unknown }).token_budget).toEqual({ a: 1 });
    expect((m13.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).toContain("max");
    expect((catalog.models[1]!.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).not.toContain("max");
    expect(museModelCatalog({ models: [{ slug: "x" }] })).toBeNull();
    expect(museModelCatalog(null)).toBeNull();
  });

  test("the catalog file is written next to codex's cache and referenced as model_catalog_json", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    expect(ensureMuseModelCatalogFile(home)).toBeUndefined();
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-sol", model_messages: { instructions_template: "You are Codex, an agent based on GPT-5. Hi." } }] }));
    const path = ensureMuseModelCatalogFile(home)!;
    expect(path).toBe(join(home, "muse-model-catalog.json"));
    expect(JSON.parse(readFileSync(path, "utf8")).models[0].slug).toBe("muse-spark-1.3");
    const out = museCodexOverrides("muse-spark-1.3", { env: { HOME: "/x" }, key: "k", codexConfig: null, modelCatalogPath: path })!;
    expect(out.config.model_catalog_json).toBe(path);
  });
});
