import { describe, expect, test } from "bun:test";
import {
  claudeResetCredits,
  mapClaudeResetResult,
  parseClaudeResetBlock,
} from "./claude-web-resets.ts";

// Shape recorded from claude.ai /usage?cedar_ember=1&skip_spend=1 on 2026-09-23.
const block = {
  eligible: true,
  ineligible_reason: null,
  at_limit: false,
  exhausted: [],
  grants: [{
    id: "opus55-launch-promax-20260921",
    label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-09-22T16:00:00+00:00",
    ends_at: "2026-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
  }],
  next_grant_id: "opus55-launch-promax-20260921",
  weekly_resets_at: "2026-09-27T16:00:00+00:00",
  cooldown_until: null,
};

describe("claude web resets", () => {
  test("maps a live grant to one available full reset", () => {
    const state = parseClaudeResetBlock(block)!;
    const out = claudeResetCredits(state, Date.parse("2026-09-23T00:00:00Z") / 1000);
    expect(out.availableCount).toBe(1);
    expect(out.credits).toEqual([{
      id: "opus55-launch-promax-20260921",
      resetType: "full",
      status: "available",
      grantedAt: Date.parse("2026-09-22T16:00:00Z") / 1000,
      expiresAt: Date.parse("2026-10-22T16:00:00Z") / 1000,
      title: "Full reset (5 hr + 7 day)",
      description: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
    }]);
  });

  test("an expired or spent grant is not offered", () => {
    const state = parseClaudeResetBlock(block)!;
    expect(claudeResetCredits(state, Date.parse("2026-10-23T00:00:00Z") / 1000).credits).toEqual([]);
    const spent = parseClaudeResetBlock({ ...block, grants: [{ ...block.grants[0], resets_left: 0 }] })!;
    expect(claudeResetCredits(spent).availableCount).toBe(0);
  });

  test("the OAuth surface answer (ineligible) yields no credits", () => {
    const state = parseClaudeResetBlock({ eligible: false, ineligible_reason: "surface", grants: [] })!;
    expect(state.ineligibleReason).toBe("surface");
    expect(claudeResetCredits(state).credits).toEqual([]);
  });

  test("a null program block means not evaluated", () => {
    expect(parseClaudeResetBlock(null)).toBeNull();
  });

  test("maps claude.ai's result enum", () => {
    expect(mapClaudeResetResult({ result: "reset", reset: true })).toBe("reset");
    expect(mapClaudeResetResult({ result: "already_used" })).toBe("alreadyRedeemed");
    expect(mapClaudeResetResult({ result: "not_limited" })).toBe("nothingToReset");
    expect(mapClaudeResetResult({ result: "cooldown" })).toBe("cooldown");
    expect(mapClaudeResetResult({ result: "ineligible" })).toBe("noCredit");
    expect(mapClaudeResetResult({ result: "unavailable" })).toBe("unavailable");
    expect(() => mapClaudeResetResult({ result: "weird" })).toThrow();
  });
});
