import { describe, expect, test } from "bun:test";
import { collectorBlocker } from "./runner.ts";

describe("agent run data gates", () => {
  test("returns no blocker only for a clean collector set", () => {
    expect(collectorBlocker([])).toBeNull();
    expect(collectorBlocker([{ kind: "github_prs", warning: "gh auth failed" }])).toContain("github_prs");
  });
});
