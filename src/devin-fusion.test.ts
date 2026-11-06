// Fork layer "devin-fusion" (15-09-2026): Devin's Fusion family (lead model +
// sidekick) is one picker entry per lead+sidekick combo with the thinking
// level and fast mode pickable, plus a local usage ledger for the picker rings.
import { describe, expect, test } from "bun:test";
import { devinFusionComboId, parseDevinCostSummary, parseDevinModels, DEVIN_FUSION_UID_RE } from "./model-discovery.ts";
import { composeDevinFusionModel, composeDevinModel, isDevinFusionCombo } from "./agent-catalog.ts";
import { devinTurnCostUsd, summarizeDevinLedger } from "./usage.ts";

const sample = JSON.stringify({
  families: [
    { slug: "claude-opus-5", family_label: "Claude Opus 5", aliases: ["opus"], variants: [
      { model_uid: "claude-opus-5-high", label: "Claude Opus 5 High", cost_summary: "$5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output" },
    ] },
    { slug: "swe-2", family_label: "SWE-2", variants: [{ model_uid: "swe-2-medium", label: "SWE-2 Medium", cost_tier: "Free" }] },
    { slug: "fusion", family_label: "Fusion", variants: [
      { model_uid: "fusion-claude-opus-5-medium-sidekick-swe-2-medium", label: "Fusion (Claude Opus 5 Medium + SWE-2 Medium)", cost_summary: "$5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output" },
      { model_uid: "fusion-claude-opus-5-high-sidekick-swe-2-medium", label: "x", cost_summary: "$5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output" },
      { model_uid: "fusion-claude-opus-5-high-fast-sidekick-gpt-5-6-luna-high-priority", label: "x", cost_summary: "$10 / 1M Input · $1 / 1M Cached input · $50 / 1M Output" },
      { model_uid: "fusion-claude-opus-5-high-sidekick-gpt-5-6-luna-high", label: "x", cost_summary: "$5 / 1M Input · $0.5 / 1M Cached input · $25 / 1M Output" },
      { model_uid: "fusion-gpt-5-6-sol-low-sidekick-glm-5-2", label: "x", cost_summary: "$1.2 / 1M Input · $0.12 / 1M Cached input · $6 / 1M Output" },
    ] },
  ],
});

describe("devin fusion discovery", () => {
  const parsed = parseDevinModels(sample);
  test("one picker entry per lead+sidekick, no bare 'fusion'", () => {
    expect(parsed.models).not.toContain("fusion");
    // Short ids (the picker truncates ~30 chars); glm-5-2 sidekick hidden (Sam).
    expect(parsed.models.filter((m) => m.startsWith("fusion"))).toEqual([
      "fusion:opus-5+luna-high",
      "fusion:opus-5+swe-2-med",
    ]);
  });
  test("levels come from the uids in the middle, fast sidekick -priority folds in", () => {
    expect(parsed.thinkingLevelsByModel?.["fusion:opus-5+swe-2-med"]).toEqual(["medium", "high"]);
    expect(parsed.thinkingLevelsByModel?.["fusion:opus-5+luna-high"]).toEqual(["high"]);
    expect(parsed.variants?.["fusion:opus-5+luna-high"]).toHaveLength(2);
    expect(parsed.labels["fusion:opus-5+swe-2-med"]).toBe("Fusion: claude-opus-5 + swe-2-medium");
    expect(devinFusionComboId("gpt-6-astra", "gpt-5-6-luna-high")).toBe("fusion:astra-6+luna-high");
    expect(devinFusionComboId("claude-fable-5-1", "swe-2-high")).toBe("fusion:fable-5-1+swe-2-high");
  });
  test("pricing per raw uid, Free via cost_tier", () => {
    expect(parsed.pricing?.["fusion-gpt-5-6-sol-low-sidekick-glm-5-2"]).toEqual({ input: 1.2, cached: 0.12, output: 6 });
    expect(parsed.pricing?.["swe-2-medium"]).toEqual({ input: 0, cached: 0, output: 0 });
    expect(parseDevinCostSummary("nonsense")).toBeNull();
  });
  test("uid regex", () => {
    expect("fusion-gpt-6-astra-xhigh-fast-sidekick-gpt-5-6-sol-high-priority".match(DEVIN_FUSION_UID_RE)?.slice(1)).toEqual([
      "gpt-6-astra", "xhigh", "-fast", "gpt-5-6-sol-high-priority",
    ]);
  });
});

describe("composeDevinFusionModel", () => {
  test("level in the middle, medium by default, plain models untouched", () => {
    expect(isDevinFusionCombo("fusion:opus-5+swe-2-med")).toBe(true);
    expect(isDevinFusionCombo("fusion-claude-opus-5-sidekick-swe-2-medium")).toBe(true);
    expect(isDevinFusionCombo("claude-opus-5")).toBe(false);
    // Regression 15-09-2026: the harness re-composed "…-low-sidekick-…" into "…-low-medium-sidekick-…".
    expect(isDevinFusionCombo("fusion-gpt-5-6-sol-low-sidekick-swe-2-medium")).toBe(false);
    expect(composeDevinModel("fusion-gpt-5-6-sol-low-sidekick-swe-2-medium", "medium")).toBe("fusion-gpt-5-6-sol-low-sidekick-swe-2-medium");
    expect(composeDevinFusionModel("fusion-claude-opus-5-sidekick-swe-2-medium")).toBe("fusion-claude-opus-5-medium-sidekick-swe-2-medium");
    expect(composeDevinFusionModel("fusion-claude-opus-5-sidekick-swe-2-medium", "xhigh")).toBe("fusion-claude-opus-5-xhigh-sidekick-swe-2-medium");
    expect(composeDevinFusionModel("fusion-gpt-5-6-sol-sidekick-glm-5-2", "low", true)).toMatch(/^fusion-gpt-5-6-sol-low-(fast|priority)-sidekick-glm-5-2/);
  });
});

describe("devin usage ledger", () => {
  test("cost = uncached input + cached + output, windows by span", () => {
    const pricing = { input: 5, cached: 0.5, output: 25 };
    expect(devinTurnCostUsd({ at: 0, inputTokens: 100_000, outputTokens: 2_000, cachedReadTokens: 80_000 }, pricing)).toBeCloseTo(0.19, 5);
    expect(devinTurnCostUsd({ at: 0, inputTokens: 10 }, null)).toBeNull();
    const now = Date.parse("2026-09-15T12:00:00");
    const s = summarizeDevinLedger(
      [
        { at: now - 3_600_000, model: "m", inputTokens: 100_000, outputTokens: 2_000, cachedReadTokens: 80_000 },
        { at: now - 3 * 86_400_000, model: "m", inputTokens: 100_000, outputTokens: 2_000, cachedReadTokens: 80_000 },
        { at: now - 20 * 86_400_000, model: "zonder-prijs", inputTokens: 5_000, outputTokens: 0 },
      ],
      { m: pricing },
      now,
    );
    expect(s.windows.map((w) => w.label)).toEqual([
      "Vandaag ≈ $0.19 · 102.0K tokens",
      "7 dagen ≈ $0.38 · 204.0K tokens",
      "30 dagen ≈ $0.38 · 209.0K tokens",
    ]);
    expect(s.unpricedModels).toEqual(["zonder-prijs"]);
    expect(s.windows.every((w) => w.pct === null)).toBe(true);
  });
});
