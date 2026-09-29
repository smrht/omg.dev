import { describe, expect, test } from "bun:test";
import type { CodingAgentInfo } from "./coding-agents.ts";
import type { ThreadCatalogItem } from "./thread-model.ts";
import {
  checkThreadSelectionForStore,
  normalizeThreadSelection,
  resolveThreadPair,
  resolveThreadTurn,
  threadSelectionOptions,
} from "./thread-model.ts";

function agent(key: string, configured = true): CodingAgentInfo {
  return {
    key,
    label: key,
    visible: true,
    status: { configured, accountConnected: configured, omgCapabilityAccess: "mcp", checks: [], instructions: [], canAutoSetup: false, canLoginInTerminal: false, setupRunning: false },
  } as CodingAgentInfo;
}

function item(key: string, models: string[], extra: Partial<ThreadCatalogItem> = {}): ThreadCatalogItem {
  return { key, label: key, defaultModel: models[0]!, models, thinkingLevels: ["low", "high"], ...extra };
}

const CATALOG: ThreadCatalogItem[] = [
  item("aisdk", ["opus", "sonnet", "haiku"]),
  item("codex-aisdk", ["gpt-6-sol", "gpt-5.5"]),
  item("opencode", ["opencode/nemotron-3.5-lightning-free", "opencode/mimo-v2.5-free"], {
    thinkingLevels: ["low", "medium"],
    thinkingLevelsByModel: { "opencode/nemotron-3.5-lightning-free": ["low"], "opencode/mimo-v2.5-free": ["low", "medium"] },
  }),
  item("grok", ["grok-4.7"]),
  item("claude", ["opus"]),
];

const CODEX_CAPABILITIES: Record<string, import("./model-discovery.ts").CodexModelCapabilities> = {
  "gpt-6-sol": { reasoningEfforts: ["low", "high", "ultra"], cyberAccessPrograms: ["standard", "daybreakBlue"] },
  "gpt-5.5": { reasoningEfforts: ["low", "medium"] },
};

const AGENTS = [agent("aisdk"), agent("codex-aisdk"), agent("opencode"), agent("grok"), agent("jcode", false)];

describe("which agents a thread can pick", () => {
  test("connected chat adapters only: grok and jcode never make the list", () => {
    const options = threadSelectionOptions(CATALOG, AGENTS);
    expect(options.map((row) => row.key)).toEqual(["aisdk", "codex-aisdk", "opencode"]);
    expect(options[0]).toMatchObject({ key: "aisdk", defaultModel: "opus", models: ["opus", "sonnet", "haiku"] });
  });

  test("the picker label follows the box's own label for the agent", () => {
    const options = threadSelectionOptions(CATALOG, [{ ...agent("aisdk"), label: "claude" }]);
    expect(options[0]?.label).toBe("claude");
  });

  test("programs are offered only where live metadata lists them, per model", () => {
    const options = threadSelectionOptions(CATALOG, AGENTS, CODEX_CAPABILITIES);
    const codex = options.find((row) => row.key === "codex-aisdk")!;
    expect(codex.cyberAccessProgramsByModel).toEqual({ "gpt-6-sol": ["standard", "daybreakBlue"] });
    // No metadata at all: no program is ever offered, so none can be claimed.
    expect(threadSelectionOptions(CATALOG, AGENTS)[1]?.cyberAccessProgramsByModel).toBeUndefined();
  });

  test("live reasoning efforts become the model's EXACT level list, static fallback only without metadata", () => {
    const options = threadSelectionOptions(CATALOG, AGENTS, CODEX_CAPABILITIES);
    const codex = options.find((row) => row.key === "codex-aisdk")!;
    // Fresh level from live metadata: offered the moment discovery reports it.
    expect(codex.thinkingLevelsByModel).toEqual({
      "gpt-6-sol": ["low", "high", "ultra"],
      "gpt-5.5": ["low", "medium"],
    });
    // A non-Codex agent keeps its catalog levels untouched.
    expect(options.find((row) => row.key === "aisdk")!.thinkingLevelsByModel).toBeUndefined();
    // No metadata for the family: the catalog's static list stands for every model.
    const fallback = threadSelectionOptions(CATALOG, AGENTS);
    expect(fallback.find((row) => row.key === "codex-aisdk")!.thinkingLevelsByModel).toBeUndefined();
    expect(fallback.find((row) => row.key === "codex-aisdk")!.thinkingLevels).toEqual(["low", "high"]);
  });

  test("storing honors the live per-model vocabulary: ultra in, stale levels out", () => {
    const withMeta = threadSelectionOptions(CATALOG, AGENTS, CODEX_CAPABILITIES);
    expect(checkThreadSelectionForStore({ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "ultra" }, withMeta).ok).toBe(true);
    // "medium" exists in the static vocabulary but NOT for this model anymore.
    const refused = checkThreadSelectionForStore({ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "medium" }, withMeta);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('unknown thinking level "medium" for codex-aisdk gpt-6-sol');
    // Without metadata, the static fallback still applies.
    expect(checkThreadSelectionForStore({ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "low" }, threadSelectionOptions(CATALOG, AGENTS)).ok).toBe(true);
  });
});

describe("storing a selection", () => {
  const options = threadSelectionOptions(CATALOG, AGENTS);

  test("null clears, a good choice stores, thinkingLevel must fit the model", () => {
    expect(checkThreadSelectionForStore(undefined, options)).toEqual({ ok: true, selection: null });
    expect(checkThreadSelectionForStore({ agent: "aisdk", model: "sonnet" }, options)).toEqual({
      ok: true,
      selection: { agent: "aisdk", model: "sonnet" },
    });
    expect(checkThreadSelectionForStore({ agent: "aisdk", model: "sonnet", thinkingLevel: "high" }, options).ok).toBe(true);
    // per-model vocabulary: mimo takes medium, nemotron does not
    expect(
      checkThreadSelectionForStore({ agent: "opencode", model: "opencode/mimo-v2.5-free", thinkingLevel: "medium" }, options).ok,
    ).toBe(true);
    expect(
      checkThreadSelectionForStore({ agent: "opencode", model: "opencode/nemotron-3.5-lightning-free", thinkingLevel: "medium" }, options).ok,
    ).toBe(false);
  });

  test("an agent threads cannot reply with is refused, visibly", () => {
    const checked = checkThreadSelectionForStore({ agent: "grok", model: "grok-4.7" }, options);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain('"grok" is not available for threads');
  });

  test("a model the agent does not offer is refused instead of corrected", () => {
    const checked = checkThreadSelectionForStore({ agent: "aisdk", model: "gpt-6-sol" }, options);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain('unknown model "gpt-6-sol" for aisdk');
  });

  test("garbage never stores", () => {
    expect(checkThreadSelectionForStore("aisdk", options).ok).toBe(false);
    expect(checkThreadSelectionForStore({ agent: "", model: "x" }, options).ok).toBe(false);
    expect(normalizeThreadSelection({ agent: " aisdk ", model: " sonnet " })).toEqual({ agent: "aisdk", model: "sonnet" });
    expect(
      normalizeThreadSelection({ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "high", cyberAccessProgram: "daybreakBlue" }),
    ).toEqual({ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "high", cyberAccessProgram: "daybreakBlue" });
  });

  test("an access program is stored only when live metadata offers it for that model", () => {
    const withPrograms = threadSelectionOptions(CATALOG, AGENTS, CODEX_CAPABILITIES);
    expect(
      checkThreadSelectionForStore({ agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" }, withPrograms).ok,
    ).toBe(true);
    // gpt-5.5 has no programs in metadata: daybreak is not falsely claimable there.
    const refused = checkThreadSelectionForStore({ agent: "codex-aisdk", model: "gpt-5.5", cyberAccessProgram: "daybreakBlue" }, withPrograms);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('does not offer program "daybreakBlue"');
    // Without metadata nothing is offered, so nothing is stored.
    const none = checkThreadSelectionForStore({ agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" }, options);
    expect(none.ok).toBe(false);
    // A program never rides on a non-Codex agent.
    expect(checkThreadSelectionForStore({ agent: "aisdk", model: "opus", cyberAccessProgram: "daybreakBlue" }, options).ok).toBe(false);
  });
});

describe("no selection means defaults, an unavailable selection means an error", () => {
  const options = threadSelectionOptions(CATALOG, AGENTS);

  test("no stored choice: the settings default pair, else the first pickable agent", () => {
    expect(resolveThreadPair({ stored: null, options })).toEqual({ kind: "pair", pair: { agent: "aisdk", model: "opus" } });
    expect(resolveThreadPair({ stored: null, options, defaultAgent: "codex-aisdk", defaultModel: "gpt-5.5" })).toEqual({
      kind: "pair",
      pair: { agent: "codex-aisdk", model: "gpt-5.5" },
    });
    // a default model the default agent does not offer falls back to its own default, not another agent's model
    expect(resolveThreadPair({ stored: null, options, defaultAgent: "codex-aisdk", defaultModel: "opus" })).toEqual({
      kind: "pair",
      pair: { agent: "codex-aisdk", model: "gpt-6-sol" },
    });
    expect(resolveThreadPair({ stored: null, options: [] }).kind).toBe("error");
  });

  test("an explicit choice that is still there is used as-is", () => {
    expect(resolveThreadPair({ stored: { agent: "aisdk", model: "haiku", thinkingLevel: "high" }, options })).toEqual({
      kind: "pair",
      pair: { agent: "aisdk", model: "haiku", thinkingLevel: "high" },
    });
  });

  test("an explicit choice that is gone is an error that names it, never a fallback", () => {
    let resolved = resolveThreadPair({ stored: { agent: "aisdk", model: "fable" }, options });
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") expect(resolved.reason).toContain("fable is not offered by aisdk");

    resolved = resolveThreadPair({ stored: { agent: "grok", model: "grok-4.7" }, options });
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") expect(resolved.reason).toContain("grok is not connected");

    resolved = resolveThreadPair({ stored: { agent: "aisdk", model: "opus", thinkingLevel: "max" }, options });
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") expect(resolved.reason).toContain("thinking level max");
  });
});

describe("the @agent override never mismatches a pair", () => {
  const options = threadSelectionOptions(CATALOG, AGENTS);

  test("the same agent named keeps the thread's own model and level", () => {
    const turn = resolveThreadTurn({
      stored: { agent: "aisdk", model: "haiku", thinkingLevel: "high" },
      options,
      mentioned: { key: "aisdk" },
    });
    expect(turn).toEqual({
      kind: "turn",
      completion: { agent: "aisdk", model: "haiku", thinkingLevel: "high" },
      task: { agent: "aisdk", model: "haiku", thinkingLevel: "high" },
    });
  });

  test("a different chat agent takes its own default model, with no level", () => {
    const turn = resolveThreadTurn({
      stored: { agent: "aisdk", model: "haiku", thinkingLevel: "high" },
      options,
      mentioned: { key: "codex-aisdk" },
    });
    expect(turn).toEqual({
      kind: "turn",
      completion: { agent: "codex-aisdk", model: "gpt-6-sol" },
      task: { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: null },
    });
  });

  test("an agent threads cannot reply with: the thread pair answers, the task runs that agent with its own default", () => {
    const turn = resolveThreadTurn({
      stored: { agent: "aisdk", model: "haiku" },
      options,
      mentioned: { key: "grok" },
    });
    expect(turn).toEqual({
      kind: "turn",
      completion: { agent: "aisdk", model: "haiku" },
      task: { agent: "grok", model: null, thinkingLevel: null },
    });
  });

  test("no mention: reply and task share one pair", () => {
    const turn = resolveThreadTurn({ stored: { agent: "opencode", model: "opencode/mimo-v2.5-free", thinkingLevel: "low" }, options });
    expect(turn).toEqual({
      kind: "turn",
      completion: { agent: "opencode", model: "opencode/mimo-v2.5-free", thinkingLevel: "low" },
      task: { agent: "opencode", model: "opencode/mimo-v2.5-free", thinkingLevel: "low" },
    });
  });

  test("an explicit access program reaches the REPLY only; the task pair stays clean", () => {
    const turn = resolveThreadTurn({
      stored: { agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" },
      options: threadSelectionOptions(CATALOG, AGENTS, CODEX_CAPABILITIES),
    });
    expect(turn).toEqual({
      kind: "turn",
      completion: { agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" },
      task: { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: null },
    });
  });

  test("switching agents by mention drops the other agent's program with its model", () => {
    const turn = resolveThreadTurn({
      stored: { agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" },
      options: threadSelectionOptions(CATALOG, AGENTS, CODEX_CAPABILITIES),
      mentioned: { key: "aisdk" },
    });
    expect(turn).toEqual({
      kind: "turn",
      completion: { agent: "aisdk", model: "opus" },
      task: { agent: "aisdk", model: "opus", thinkingLevel: null },
    });
  });

  test("a stored program the metadata stopped offering is an explicit error, never a silent drop", () => {
    const resolved = resolveThreadPair({
      stored: { agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" },
      options: threadSelectionOptions(CATALOG, AGENTS, { "gpt-6-sol": { reasoningEfforts: ["low"] } }),
    });
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") {
      expect(resolved.reason).toContain("program daybreakBlue is not offered");
      expect(resolved.reason).toContain("pick another access choice");
    }
  });
});
