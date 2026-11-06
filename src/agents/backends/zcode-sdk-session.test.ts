import { describe, expect, test } from "bun:test";
import {
  applyZcodeEvent,
  finalZcodeText,
  newZcodeTurnState,
  splitZcodeModel,
  zcodeProviderConfig,
  zcodeTurnArgv,
} from "./zcode-sdk-session.ts";

function recordingSink() {
  const calls: Array<[string, ...unknown[]]> = [];
  const sink = {
    draft: (t: string) => calls.push(["draft", t]),
    thinking: (t: string) => calls.push(["thinking", t]),
    commitText: (t: string) => calls.push(["commit", t]),
    toolStart: (id: string, name: string, input: unknown) => calls.push(["toolStart", id, name, input]),
    toolEnd: (id: string, name: string, out: unknown, isError: boolean) => calls.push(["toolEnd", id, name, out, isError]),
  } as any;
  return { sink, calls };
}

describe("zcode sdk session", () => {
  test("model ids split into provider + model", () => {
    expect(splitZcodeModel("zaiplan/glm-5.3")).toEqual({ providerId: "zaiplan", modelId: "glm-5.3" });
    expect(splitZcodeModel("glm-5.3-flash")).toEqual({ providerId: "zaiplan", modelId: "glm-5.3-flash" });
    expect(splitZcodeModel("auto")).toBeNull();
  });

  test("provider config selects model and reasoning without touching the key", () => {
    const shared = {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{ providerId: "zaiplan", config: { access: { apiKey: "K" } } }] },
        defaultModelSelection: { providerId: "zaiplan", modelId: "glm-5.3-flash" },
      },
    };
    const out = zcodeProviderConfig(shared, "zaiplan/glm-5.3", "low") as any;
    expect(out.config.defaultModelSelection).toEqual({ providerId: "zaiplan", modelId: "glm-5.3", options: { reasoningLevel: "low" } });
    expect(out.config.providerConfigRules.providerRules[0].config.access.apiKey).toBe("K");
    expect((shared.config.defaultModelSelection as any).options).toBeUndefined();
  });

  test("turn argv is headless yolo stream-json and resumes", () => {
    expect(zcodeTurnArgv("zcode", "hi", "/w", null)).toEqual(["zcode", "--prompt", "hi", "--cwd", "/w", "--mode", "yolo", "--output-format", "stream-json", "--no-color"]);
    expect(zcodeTurnArgv("zcode", "hi", "/w", "sess_1").slice(-2)).toEqual(["--resume", "sess_1"]);
  });

  test("stream events map onto the sink", () => {
    const { sink, calls } = recordingSink();
    const state = newZcodeTurnState(null);
    const ev = (type: string, payload: Record<string, unknown>) => applyZcodeEvent({ type, sessionId: "sess_9", payload }, sink, state);
    ev("model.streaming", { kind: "reasoning_delta", delta: "hmm" });
    ev("model.streaming", { kind: "text_delta", delta: "Ik kijk " });
    ev("tool.updated", { kind: "scheduled", toolCallId: "t1", toolName: "bash", input: { command: "ls" } });
    ev("tool.updated", { kind: "result", toolCallId: "t1", result: { success: true, content: "a.txt" } });
    ev("model.streaming", { kind: "text_delta", delta: "Klaar." });
    ev("turn.completed", { resultType: "success", response: "Klaar." });
    expect(state.sessionId).toBe("sess_9");
    expect(calls).toContainEqual(["thinking", "hmm"]);
    expect(calls).toContainEqual(["commit", "Ik kijk "]);
    expect(calls).toContainEqual(["toolStart", "t1", "bash", { command: "ls" }]);
    expect(calls).toContainEqual(["toolEnd", "t1", "bash", "a.txt", false]);
    expect(finalZcodeText(state)).toBe("Klaar.");
    expect(state.resultType).toBe("success");
  });

  test("final text falls back to the response only when nothing was streamed", () => {
    const { sink } = recordingSink();
    const state = newZcodeTurnState("sess_1");
    applyZcodeEvent({ type: "result", response: "ready" }, sink, state);
    expect(finalZcodeText(state)).toBe("ready");
  });
});

import { mergeZcodeUsage } from "./zcode-sdk-session.ts";
import { zaiUsageFromQuota } from "../../usage.ts";

describe("zcode usage", () => {
  test("result usage separates cache reads and keeps the context projection", () => {
    const { sink } = recordingSink();
    const state = newZcodeTurnState("sess_1");
    applyZcodeEvent({
      type: "result",
      response: "ok",
      usage: { inputTokens: 49898, outputTokens: 3, totalTokens: 49901, cacheReadTokens: 7296, cacheWriteTokens: 0, reasoningTokens: 0 },
      projection: { contextUsed: 49901, contextWindow: 200000 },
    } as any, sink, state);
    expect(state.usage).toEqual({ input: 42602, output: 3, cacheRead: 7296, cacheWrite: 0, reasoning: 0, total: 49901, contextUsed: 49901, contextWindow: 200000 });
  });

  test("turn usage accumulates into the stored session snapshot", () => {
    const turn = { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, reasoning: 2, total: 115, contextUsed: 115, contextWindow: 200000 };
    const first = mergeZcodeUsage(null, turn, "zaiplan/glm-5.3-flash", 1);
    const second = mergeZcodeUsage(first, { ...turn, contextUsed: 300 }, "zaiplan/glm-5.3-flash", 2);
    expect(second.totals).toEqual({ input: 20, output: 10, cacheRead: 200, cacheWrite: 0, reasoning: 4, total: 230, costUsd: null });
    expect(second.context?.totalTokens).toBe(300);
    expect(second.context?.maxTokens).toBe(200000);
    expect(second.reporter).toBe("ZCode");
  });

  test("Z.ai quota maps to a 5-hour window first, then the monthly MCP allowance", () => {
    const out = zaiUsageFromQuota({
      level: "max",
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 4000, currentValue: 15, percentage: 1, nextResetTime: 2000 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 3, nextResetTime: 1000 },
      ],
    });
    expect(out.plan).toBe("max");
    expect(out.windows).toEqual([
      { label: "5-hour", pct: 3, resetsAt: 1000 },
      { label: "monthly · MCP tools", pct: 0.375, resetsAt: 2000 },
    ]);
    expect(out.note).toContain("MCP tools 15/4000");
  });

  test("an empty quota payload yields no windows", () => {
    expect(zaiUsageFromQuota(null).windows).toEqual([]);
  });
});
