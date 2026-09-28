import { expect, test } from "bun:test";
import { CLAUDE_MODELS, AISDK_MODELS, sortClaudeModelsByRelease } from "./agent-catalog.ts";

test("Claude pickers list the newest release first", () => {
  // Agentbox: one row per family alias plus the Sonnet 5.5 pin, newest first.
  expect(CLAUDE_MODELS).toEqual(["claude-sonnet-5-5", "opus", "fable", "sonnet", "haiku"]);
  expect(AISDK_MODELS).toEqual(CLAUDE_MODELS);
});

test("an alias sorts on the release it lands on, not on a newer pin", () => {
  // `sonnet` still resolves to Sonnet 5 (claude 2.1.284, 28-09-2026).
  expect(sortClaudeModelsByRelease(["sonnet", "claude-sonnet-5-5", "opus"])).toEqual([
    "claude-sonnet-5-5",
    "opus",
    "sonnet",
  ]);
});

test("an alias takes its family's newest date and ties keep list order", () => {
  expect(sortClaudeModelsByRelease(["haiku", "sonnet", "fable", "claude-fable-5-1", "opus", "claude-opus-5-5"])).toEqual([
    "opus",
    "claude-opus-5-5",
    "fable",
    "claude-fable-5-1",
    "sonnet",
    "haiku",
  ]);
});

test("ids without a known date stay after the dated ones", () => {
  expect(sortClaudeModelsByRelease(["mystery", "haiku", "opus"])).toEqual(["opus", "haiku", "mystery"]);
});

test("Codex hidden models never reach the picker and discovery order is kept", async () => {
  const { parseCodexModels } = await import("./model-discovery.ts");
  const parsed = parseCodexModels(
    JSON.stringify({
      models: [
        { slug: "gpt-6-astra", visibility: "list" },
        { slug: "gpt-6-sol", visibility: "list" },
        { slug: "gpt-reserve", visibility: "hide" },
        { slug: "gpt-5.5", visibility: "list" },
        { slug: "codex-auto-review", visibility: "hide" },
      ],
    }),
  );
  expect(parsed.models).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.5"]);
});
