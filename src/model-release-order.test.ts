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

test("parseCodexModels keeps a newly named release that carries no version digits", async () => {
  // Fixture trimmed from ~/.codex/models_cache.json (captured 2026-09-29):
  // Codex listed Daybreak Blue as an ordinary `visibility: "list"` slug, so
  // the parser keeps it with its display name. The drop happened later, in
  // curateCodexModels.
  const { parseCodexModels } = await import("./model-discovery.ts");
  const parsed = parseCodexModels(
    JSON.stringify({
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list" },
        { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list" },
        { slug: "gpt-reserve", visibility: "hide" },
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
        { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
        { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" },
        { slug: "gpt-daybreak-blue-latest", display_name: "Daybreak Blue", visibility: "list" },
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
        { slug: "codex-auto-review", visibility: "hide" },
      ],
    }),
  );
  expect(parsed.models).toEqual([
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-daybreak-blue-latest",
    "gpt-5.5",
  ]);
  expect(parsed.labels["gpt-daybreak-blue-latest"]).toBe("Daybreak Blue");
});
