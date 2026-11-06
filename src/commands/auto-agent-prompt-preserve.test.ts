// Regression guard for omg_save_auto_agent edit-in-place: the list tool
// deliberately returns a 200-char prompt preview, and the store persists
// `prompt` verbatim — so an update that copies fields back from the list
// used to cut a long prompt to the preview (03-11-2026: 1732 → 200 chars on
// air-x-accountfix-check-20261103). resolveEditPrompt carries the stored
// text forward unless the caller sends genuinely different text.
import { describe, expect, test } from "bun:test";
import { resolveEditPrompt } from "./mcp.ts";

describe("resolveEditPrompt", () => {
  const stored = "x".repeat(1732);
  const preview = stored.slice(0, 200);

  test("omitted prompt keeps the stored text", () => {
    expect(resolveEditPrompt(stored, undefined)).toEqual({ prompt: stored, keptStored: true });
  });

  test("the truncated list preview does not overwrite the stored text", () => {
    expect(resolveEditPrompt(stored, preview)).toEqual({ prompt: stored, keptStored: true });
  });

  test("genuinely different text is used as-is", () => {
    expect(resolveEditPrompt(stored, "heel andere prompt")).toEqual({
      prompt: "heel andere prompt",
      keptStored: false,
    });
  });

  test("identical text is used as-is (no preview confusion)", () => {
    expect(resolveEditPrompt(stored, stored)).toEqual({ prompt: stored, keptStored: false });
  });

  test("a short stored row with identical prompt is a normal save", () => {
    expect(resolveEditPrompt("kort", "kort")).toEqual({ prompt: "kort", keptStored: false });
  });
});
