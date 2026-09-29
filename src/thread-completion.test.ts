import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeThreadQueryOptions,
  codexDaybreakInput,
  codexFamilyCapabilities,
  codexThreadEffort,
  dispatchThreadCompletion,
  opencodeConfiguredMcpServers,
  opencodeModelRef,
  opencodeThreadPromptBody,
  opencodeThreadServerConfig,
  scanOpencodeMcpSources,
  setCodexTurnRunnerForTests,
  threadCompletionNeedsIsolation,
  visibleCompletionError,
  type CodexDaybreakTurnInput,
  type ThreadCompletionAdapters,
  type ThreadCompletionInput,
} from "./thread-completion.ts";

const INPUT: ThreadCompletionInput = {
  agent: "aisdk",
  model: "sonnet",
  thinkingLevel: "high",
  system: "You are omg in a thread.",
  user: "The thread, and the message.",
};

/** Adapters that record what they were called with and answer with their family name. */
function recordingAdapters(): ThreadCompletionAdapters & { calls: Array<[string, ThreadCompletionInput]> } {
  const calls: Array<[string, ThreadCompletionInput]> = [];
  const record = (family: string) => (input: ThreadCompletionInput) => {
    calls.push([family, input]);
    return Promise.resolve(`${family} answered`);
  };
  return {
    calls,
    claude: record("claude"),
    codex: record("codex"),
    opencode: record("opencode"),
  };
}

/** A spy fetch that records calls and rejects, proving nothing dials out in tests. */
function poisonedFetch(): { fetch: typeof fetch; attempts: string[] } {
  const attempts: string[] = [];
  const spy = (async (input: Parameters<typeof fetch>[0]) => {
    attempts.push(String(input));
    throw new Error("hosted call attempted");
  }) as unknown as typeof fetch;
  return { fetch: spy, attempts };
}

describe("the dispatch table", () => {
  test("each connected agent family reaches its own adapter with provider, model and reasoning", async () => {
    const adapters = recordingAdapters();
    const families: Array<[string, string]> = [
      ["claude", "claude"],
      ["aisdk", "claude"],
      ["codex", "codex"],
      ["codex-aisdk", "codex"],
      ["opencode", "opencode"],
      ["omg", "opencode"],
    ];
    for (const [agent, family] of families) {
      await dispatchThreadCompletion({ ...INPUT, agent }, { adapters, platform: "darwin", contained: true });
      expect(adapters.calls.at(-1)).toEqual([family, { ...INPUT, agent }]);
    }
    expect(new Set(adapters.calls.map(([family]) => family))).toEqual(new Set(["claude", "codex", "opencode"]));
  });

  test("an agent with no adapter is a visible error, never a detour to another provider", async () => {
    const adapters = recordingAdapters();
    await expect(dispatchThreadCompletion({ ...INPUT, agent: "grok" }, { adapters, platform: "darwin", contained: true })).rejects.toThrow(
      '"grok" cannot answer thread replies',
    );
    expect(adapters.calls).toEqual([]);
  });

  test("a failed adapter surfaces its error; there is no fallback adapter behind it, and no fetch happens", async () => {
    const original = globalThis.fetch;
    const poison = poisonedFetch();
    globalThis.fetch = poison.fetch;
    try {
      const adapters: ThreadCompletionAdapters = {
        ...recordingAdapters(),
        claude: () => Promise.reject(new Error("claude account not logged in")),
      };
      const text = await dispatchThreadCompletion({ ...INPUT, agent: "omg" }, { adapters, platform: "darwin", contained: true });
      expect(text).toBe("opencode answered");
      await expect(dispatchThreadCompletion({ ...INPUT, agent: "aisdk" }, { adapters, platform: "darwin", contained: true })).rejects.toThrow(
        "claude account not logged in",
      );
      expect(poison.attempts).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("containment: Linux runs isolated, the worker inside does not recurse", () => {
  test("the guard is exactly: Linux and not contained", () => {
    expect(threadCompletionNeedsIsolation("linux", false)).toBe(true);
    expect(threadCompletionNeedsIsolation("linux", true)).toBe(false);
    expect(threadCompletionNeedsIsolation("darwin", false)).toBe(false);
    expect(threadCompletionNeedsIsolation("darwin", true)).toBe(false);
  });

  test("a Linux dispatch without contained goes through the isolation runner, not the adapter", async () => {
    const adapters = recordingAdapters();
    const isolated: ThreadCompletionInput[] = [];
    const text = await dispatchThreadCompletion(INPUT, {
      adapters,
      platform: "linux",
      contained: false,
      isolate: async (task) => {
        isolated.push(task);
        return "isolated answer";
      },
    });
    expect(text).toBe("isolated answer");
    expect(isolated).toEqual([INPUT]);
    expect(adapters.calls).toEqual([]);
  });

  test("the worker's own dispatch (contained) runs the adapter directly on Linux — no second worker", async () => {
    const adapters = recordingAdapters();
    let isolatedRuns = 0;
    const text = await dispatchThreadCompletion(INPUT, {
      adapters,
      platform: "linux",
      contained: true,
      isolate: async () => {
        isolatedRuns += 1;
        return "recursed";
      },
    });
    expect(text).toBe("claude answered");
    expect(isolatedRuns).toBe(0);
    expect(adapters.calls).toHaveLength(1);
  });

  test("offline: the real chat-mode worker answers an unsupported agent with a visible error, exit 1", async () => {
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "omg-isolation-worker.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    worker.stdin.write(
      JSON.stringify({
        mode: "chat",
        completion: { agent: "grok", model: "grok-4.7", system: "s", user: "u" },
      }),
    );
    await worker.stdin.end();
    const [out, code] = await Promise.all([new Response(worker.stdout).text(), worker.exited]);
    expect(code).toBe(1);
    const line = out.split("\n").findLast((row) => row.startsWith("OMG_ISOLATION_RESULT "));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!.slice("OMG_ISOLATION_RESULT ".length)).error).toContain(
      '"grok" cannot answer thread replies',
    );
  }, 20_000);
});

describe("the claude adapter's options are the proof it is tool-less", () => {
  test("no tools, no MCP servers (strict, so settings cannot add any), one turn, the chosen model and effort", () => {
    const options = claudeThreadQueryOptions("haiku", "xhigh", "You are omg.");
    expect(options).toMatchObject({
      model: "haiku",
      systemPrompt: "You are omg.",
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 1,
      effort: "xhigh",
    });
  });

  test("effort collapses only the levels Claude does not take", () => {
    expect(claudeThreadQueryOptions("opus", "none", "s").effort).toBe("low");
    expect(claudeThreadQueryOptions("opus", undefined, "s").effort).toBeUndefined();
    expect(claudeThreadQueryOptions("opus", "bogus", "s").effort).toBeUndefined();
  });
});

describe("the codex adapter runs one Daybreak turn", () => {
  const CAPABILITIES: Record<string, import("./model-discovery.ts").CodexModelCapabilities> = {
    "gpt-6-sol": { reasoningEfforts: ["low", "medium", "high"], cyberAccessPrograms: ["standard", "daybreakBlue"] },
  };

  test("the routing instructions lead the prompt; model and effort ride along", () => {
    const input = codexDaybreakInput(
      { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "high", system: "You are omg.", user: "the message" },
      CAPABILITIES,
    );
    expect(input.prompt).toBe("You are omg.\n\n---\n\nthe message");
    expect(input.model).toBe("gpt-6-sol");
    expect(input.effort).toBe("high");
    expect(input.cyberAccessProgram).toBeUndefined();
  });

  test("no program field unless one was explicitly chosen: automatic keeps the account default", () => {
    expect("cyberAccessProgram" in codexDaybreakInput({ agent: "codex", model: "gpt-6-sol", system: "s", user: "u" }, CAPABILITIES)).toBe(false);
  });

  test("an explicit program is validated against live metadata and serialized exactly into the turn", () => {
    const input = codexDaybreakInput(
      {
        agent: "codex-aisdk",
        model: "gpt-6-sol",
        system: "You are omg.",
        user: "the message",
        cyberAccessProgram: "daybreakBlue",
      },
      CAPABILITIES,
    );
    expect(input.cyberAccessProgram).toBe("daybreakBlue");
    expect(input.capabilities).toBe(CAPABILITIES);
  });

  test("effort follows live metadata exactly: fresh levels like ultra work, unsupported ones are visible errors", () => {
    const caps: Record<string, import("./model-discovery.ts").CodexModelCapabilities> = {
      "gpt-6-sol": { reasoningEfforts: ["low", "high", "ultra"] },
    };
    expect(codexThreadEffort("gpt-6-sol", "high", caps)).toBe("high");
    expect(codexThreadEffort("gpt-6-sol", "ultra", caps)).toBe("ultra");
    // An explicit level the model does not offer is NEVER silently downgraded.
    expect(() => codexThreadEffort("gpt-6-sol", "max", caps)).toThrow(
      'thinking level "max" is not offered by gpt-6-sol (offered: low, high, ultra)',
    );
    expect(() => codexThreadEffort("gpt-6-sol", "none", caps)).toThrow("is not offered by gpt-6-sol");
    // No metadata at all: the documented CLI vocabulary applies, ultra included.
    expect(codexThreadEffort("gpt-6-sol", "ultra", undefined)).toBe("ultra");
    expect(codexThreadEffort("gpt-6-sol", "medium", undefined)).toBe("medium");
    expect(() => codexThreadEffort("gpt-6-sol", "bogus", undefined)).toThrow("is not supported by codex");
    expect(codexThreadEffort("gpt-6-sol", null, caps)).toBeUndefined();
  });

  test("an unsupported explicit level stops the Daybreak input before any turn is built", () => {
    const caps: Record<string, import("./model-discovery.ts").CodexModelCapabilities> = {
      "gpt-6-sol": { reasoningEfforts: ["low"] },
    };
    expect(() =>
      codexDaybreakInput({ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "high", system: "s", user: "u" }, caps),
    ).toThrow('thinking level "high" is not offered by gpt-6-sol');
    expect(codexDaybreakInput({ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "low", system: "s", user: "u" }, caps)).toMatchObject({ effort: "low" });
  });

  test("capabilities come from the codex-aisdk discovery slot only", () => {
    expect(codexFamilyCapabilities({ providers: { "codex-aisdk": { modelCapabilities: CAPABILITIES } } })).toBe(CAPABILITIES);
    expect(codexFamilyCapabilities({ providers: {} })).toBeUndefined();
    expect(codexFamilyCapabilities(null)).toBeUndefined();
  });

  test("the adapter hands the exact serialized turn to the Daybreak runner (fake runner, no codex spawned)", async () => {
    const seen: CodexDaybreakTurnInput[] = [];
    setCodexTurnRunnerForTests(async (input) => {
      seen.push(input);
      return { text: "daybreak answered" };
    });
    try {
      const text = await dispatchThreadCompletion(
        {
          agent: "codex-aisdk",
          model: "gpt-6-sol",
          thinkingLevel: "high",
          system: "You are omg.",
          user: "the message",
          cyberAccessProgram: "daybreakBlue",
        },
        { platform: "darwin", contained: true },
      );
      expect(text).toBe("daybreak answered");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ model: "gpt-6-sol", effort: "high", cyberAccessProgram: "daybreakBlue" });
      expect(seen[0]!.prompt).toContain("You are omg.");
      expect(seen[0]!.prompt.endsWith("the message")).toBe(true);
      // An empty Daybreak reply is an honest failure, not a blank answer.
      setCodexTurnRunnerForTests(async () => ({ text: "  " }));
      await expect(
        dispatchThreadCompletion({ agent: "codex", model: "gpt-6-sol", system: "s", user: "u" }, { platform: "darwin", contained: true }),
      ).rejects.toThrow("codex (gpt-6-sol) returned no text");
    } finally {
      setCodexTurnRunnerForTests(null);
    }
  });
});

describe("the opencode adapter runs a server it owns, with nothing allowed", () => {
  test("every permission is denied, wildcard included, and every known tool is off", () => {
    const config = opencodeThreadServerConfig([]);
    expect(config.permission).toEqual({
      "*": "deny",
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      doom_loop: "deny",
      external_directory: "deny",
    });
    expect(config.tools).toMatchObject({ bash: false, edit: false, write: false, read: false, webfetch: false });
    expect(config.share).toBe("disabled");
    expect(config.mcp).toBeUndefined();
  });

  test("every MCP server the box configures is disabled by name, so no MCP child spawns", () => {
    expect(
      opencodeConfiguredMcpServers(JSON.stringify({ mcp: { lfg: { type: "local", command: ["x"] }, remote: { type: "remote", url: "https://r" } } })),
    ).toEqual({ servers: ["lfg", "remote"], unsafe: null });
    expect(opencodeConfiguredMcpServers("{}")).toEqual({ servers: [], unsafe: null });
    expect(opencodeConfiguredMcpServers(null)).toEqual({ servers: [], unsafe: null });
    const config = opencodeThreadServerConfig(["lfg", "remote"]);
    expect(config.mcp).toEqual({ lfg: { enabled: false }, remote: { enabled: false } });
  });

  test("JSONC comments and trailing commas preserve quoted URLs and MCP names", () => {
    expect(opencodeConfiguredMcpServers(`// heading
{"mcp":{"quoted/*name*/":{"url":"https://example.test/a//b",},},}`)).toEqual({ servers: ["quoted/*name*/"], unsafe: null });
  });

  test("an unparseable or oversized config is UNSAFE — fail closed, never assume no MCP", () => {
    expect(opencodeConfiguredMcpServers("not json")).toMatchObject({ servers: [], unsafe: expect.stringContaining("could not be parsed") });
    expect(opencodeConfiguredMcpServers("{ broken")).toMatchObject({ unsafe: expect.any(String) });
    expect(opencodeConfiguredMcpServers("x".repeat(300 * 1024))).toMatchObject({
      unsafe: expect.stringContaining("larger than the read bound"),
    });
  });

  test("every actual config source is scanned: all three global files, OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT", () => {
    const home = mkdtempSync(join(tmpdir(), "omg-oc-scan-"));
    try {
      const configRoot = join(home, "opencode");
      mkdirSync(configRoot, { recursive: true });
      writeFileSync(join(configRoot, "config.json"), JSON.stringify({ mcp: { one: { command: ["a"] } } }));
      writeFileSync(join(configRoot, "opencode.json"), JSON.stringify({ mcp: { two: { command: ["b"] } } }));
      // jsonc with comments, same file OpenCode itself reads
      writeFileSync(join(configRoot, "opencode.jsonc"), `// comment\n{"mcp": {"three": {"command": ["c"]}}}`);
      const explicit = join(home, "extra.json");
      writeFileSync(explicit, JSON.stringify({ mcp: { four: { command: ["d"] } } }));
      const scanned = scanOpencodeMcpSources({
        XDG_CONFIG_HOME: home,
        OPENCODE_CONFIG: explicit,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { five: { command: ["e"] } } }),
      });
      expect(scanned).toEqual({ servers: ["one", "two", "three", "four", "five"], unsafe: null });
      // Every merged name is disabled, so no MCP child is spawned.
      expect(opencodeThreadServerConfig(scanned.servers).mcp).toEqual({
        one: { enabled: false },
        two: { enabled: false },
        three: { enabled: false },
        four: { enabled: false },
        five: { enabled: false },
      });

      // One unreadable source fails the whole scan closed, with a label only — never config text.
      writeFileSync(join(configRoot, "opencode.json"), "{ not json");
      const unsafe = scanOpencodeMcpSources({ XDG_CONFIG_HOME: home });
      expect(unsafe.servers).toEqual([]);
      expect(unsafe.unsafe).toContain("global config opencode.json");
      expect(unsafe.unsafe).not.toContain("not json");

      // A valid explicit OPENCODE_CONFIG content that is broken fails closed too.
      const badContent = scanOpencodeMcpSources({ XDG_CONFIG_HOME: join(home, "empty"), OPENCODE_CONFIG_CONTENT: "{ broken" });
      expect(badContent.unsafe).toContain("OPENCODE_CONFIG_CONTENT");

      // Missing files are simply absent sources, not failures.
      const empty = mkdtempSync(join(tmpdir(), "omg-oc-empty-"));
      try {
        expect(scanOpencodeMcpSources({ XDG_CONFIG_HOME: empty })).toEqual({ servers: [], unsafe: null });
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the prompt carries the routing instructions in `system`, the model, its variant, and the runtime's tools off", () => {
    expect(opencodeModelRef("omg/z-ai/glm-5.2")).toEqual({ providerID: "omg", modelID: "z-ai/glm-5.2" });
    expect(
      opencodeThreadPromptBody("opencode/mimo-v2.5-free", "low", "You are omg.", "hi there", ["bash", "read"]),
    ).toEqual({
      model: { providerID: "opencode", modelID: "mimo-v2.5-free" },
      variant: "low",
      system: "You are omg.",
      tools: { bash: false, read: false },
      parts: [{ type: "text", text: "hi there" }],
    });
    expect(opencodeThreadPromptBody("somemodel", null, "You are omg.", "hi")).toEqual({
      system: "You are omg.",
      parts: [{ type: "text", text: "hi" }],
    });
  });
});

describe("error text a thread may show", () => {
  test("short, and stripped of anything secret-shaped", () => {
    expect(visibleCompletionError(new Error("model overloaded"))).toBe("model overloaded");
    expect(visibleCompletionError(new Error("x".repeat(500))).length).toBe(300);
    expect(visibleCompletionError(new Error("auth failed for sk-abc123defg456 on host"))).not.toContain("sk-abc123defg456");
    expect(visibleCompletionError(new Error("header: Bearer abc123defg456hij"))).not.toContain("Bearer abc123defg456hij");
    expect(visibleCompletionError(new Error("api_key=ZXhhbXBsZTEyMw"))).not.toContain("ZXhhbXBsZTEyMw");
    expect(visibleCompletionError(null, "the reply failed")).toBe("the reply failed");
  });

  test("redaction runs BEFORE truncation, so a secret straddling the cap leaves no fragment", () => {
    // 290 filler characters, then a secret that crosses the 300-char cap.
    const filler = "x".repeat(290);
    const error = new Error(`${filler} key sk-supersecretvalue99 trailing`);
    const shown = visibleCompletionError(error);
    expect(shown.length).toBeLessThanOrEqual(300);
    expect(shown).not.toContain("sk-supersecretvalue99");
    // No truncated prefix of the token survives either.
    expect(shown).not.toMatch(/sk-super/);
    expect(shown).not.toMatch(/sk-/);
  });
});
