import { describe, expect, test } from "bun:test";
import { buildSystem } from "./runner.ts";

describe("buildSystem", () => {
  test("a read-only agent is framed as read-only and is never told to act", () => {
    const s = buildSystem([]);
    expect(s).toContain("You have read-only tools (Read, Grep, Glob, WebSearch, WebFetch)");
    expect(s).not.toContain("you can ACT");
    expect(s).toContain('{"findings": []}');
  });

  test("an agent granted acting tools is told it has them and reports finished work", () => {
    const s = buildSystem(["Bash", "Skill"]);
    expect(s).toContain("Bash, Skill — so you can ACT");
    expect(s).toContain('never file "someone should do X"');
    expect(s).toContain("report it as ONE low-severity finding whose title says what you did");
    expect(s).toContain('{"findings": []}');
  });

  test("read-only grants do not flip the agent into acting mode", () => {
    expect(buildSystem(["Read", "Grep"])).not.toContain("you can ACT");
  });
});
