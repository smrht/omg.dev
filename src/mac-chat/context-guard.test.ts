// Item 35: REQUIRED central instruction failures REFUSE before any provider
// input. This suite tests the ACTUAL shared guard (validatedCentralContext)
// both harnesses and the launcher call: unreadable/over-size instructions
// refuse with path+reason (never content); OPTIONAL omissions (missing skill
// or memory roots, non-transportable manifest paths) stay non-fatal.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validatedCentralContext } from "./context.ts";

const BUILD_TMP = process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests";
let base: string;
let goodCwd: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(BUILD_TMP, "ctx-guard-")));
  goodCwd = join(base, "good");
  mkdirSync(join(goodCwd, ".claude"), { recursive: true });
  writeFileSync(join(goodCwd, "AGENTS.md"), "REPO NONCE OK");
});

afterAll(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* cache residue cosmetic */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* retry */ }
});

describe("validatedCentralContext (item 35 shared guard)", () => {
  test("healthy context passes and carries the instructions", () => {
    const v = validatedCentralContext("claude", goodCwd, { home: join(base, "no-home") });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.context.complete).toBe(true);
    expect(v.context.instructions.some((i) => i.content === "REPO NONCE OK")).toBe(true);
  });

  test("unreadable REQUIRED instruction (AGENTS.md is a directory) refuses with path+reason", () => {
    const bad = join(base, "bad-unreadable");
    mkdirSync(join(bad, "sub"), { recursive: true });
    mkdirSync(join(bad, "sub", "AGENTS.md")); // exists, but not a regular file
    const v = validatedCentralContext("claude", join(bad, "sub"), { home: join(base, "no-home") });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toContain(join(bad, "sub", "AGENTS.md"));
    expect(v.error).toContain("not-a-regular-file");
    // Actionable reason, never content: no file content can leak.
    expect(v.omissions.length).toBeGreaterThan(0);
  });

  test("over-size REQUIRED instruction refuses (too-large cap)", () => {
    const big = join(base, "big");
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, "CLAUDE.md"), "x".repeat(1000));
    const v = validatedCentralContext("claude", big, { home: join(base, "no-home"), maxFileBytes: 100 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toContain("too-large");
    expect(v.error).toContain(join(big, "CLAUDE.md"));
  });

  test("missing OPTIONAL skill/memory roots are NOT fatal", () => {
    const v = validatedCentralContext("claude", goodCwd, {
      home: join(base, "no-home"),
      skillRoots: [join(base, "absent-skills")],
      memoryRoots: [join(base, "absent-memories")],
    });
    expect(v.ok).toBe(true);
  });

  test("absent global candidates stay normal (missing ≠ unreadable)", () => {
    const v = validatedCentralContext("codex", goodCwd, { home: join(base, "no-home") });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Missing globals are simply absent (no fabricated instructions); the
    // repo chain may legitimately carry REAL ancestors of the fixture cwd
    // (e.g. the box's own ~/AGENTS.md) — that is production behavior.
    expect(v.context.instructions.some((i) => i.content === "REPO NONCE OK")).toBe(true);
    expect(v.context.complete).toBe(true);
  });
});
