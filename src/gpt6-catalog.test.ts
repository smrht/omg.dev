import { expect, test } from "bun:test";
import { curateCodexModels } from "./agent-catalog.ts";
test("Codex retains both GPT-6 tiers only when discovered", () => {
  const models = curateCodexModels(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]);
  expect(models).toContain("gpt-6-sol");
  expect(models).toContain("gpt-6-luna");
  const absent = curateCodexModels(["gpt-5.6-sol"]);
  expect(absent).not.toContain("gpt-6-sol");
  expect(absent).not.toContain("gpt-6-luna");
});
