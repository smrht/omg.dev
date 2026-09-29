import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { resolveSessionCyberAccessProgram, applySessionCyberAccessProgram } from "./session-cyber-access.ts";
import { managedCodexAisdkSessionArgv } from "./tmux.ts";
import { upsertResumableRows, getCachedResumableSession, resetResumeCacheConnectionForTests, type ResumableCacheRow } from "./resume-cache.ts";
import type { AisdkEntry } from "./aisdk-registry.ts";
const caps = { "gpt-6-sol": { reasoningEfforts: ["low"], cyberAccessPrograms: ["standard", "daybreakBlue"] as ("standard" | "daybreakBlue")[] }, "gpt-6.1-sol": { reasoningEfforts: ["low"], cyberAccessPrograms: ["standard"] as "standard"[] } };
describe("ordinary Codex program control", () => {
  test("default remains automatic; unsupported/backend/fake program rejected", () => {
    expect(resolveSessionCyberAccessProgram({ agent: "aisdk", model: "opus", capabilities: caps })).toEqual({ ok: true });
    for (const input of [{ agent: "aisdk", model: "opus", requested: "daybreakBlue" }, { agent: "codex-aisdk", model: "gpt-6.1-sol", requested: "daybreakBlue" }, { agent: "codex-aisdk", model: "gpt-6-sol", requested: "unknown" }, { agent: "codex-aisdk", model: "gpt-6-sol", requested: true }]) {
      expect(resolveSessionCyberAccessProgram({ ...input, capabilities: caps }).ok).toBe(false);
    }
    expect(resolveSessionCyberAccessProgram({ agent: "codex-aisdk", model: "gpt-6-sol", requested: "daybreakBlue", capabilities: caps })).toEqual({ ok: true, program: "daybreakBlue" });
  });
  function fixture() {
    const effects: unknown[] = [];
    const entry = { agent: "codex", sessionId: "key", model: "gpt-6-sol", busy: false, cyberAccessProgramControl: true } as AisdkEntry;
    const input = { session: { agent: "codex-aisdk", model: "gpt-6-sol", tmuxName: "name" }, entry,
      requested: "daybreakBlue", capabilities: caps, append: (...v: unknown[]) => effects.push(v), patchEntry: (...v: unknown[]) => effects.push(v), patchManaged: (...v: unknown[]) => effects.push(v) };
    return { input, effects, entry };
  }
  test("legacy/unavailable/busy processes never accept a false choice", () => {
    for (const variant of ["legacy", "missing", "busy"]) {
      const { input, effects, entry } = fixture();
      if (variant === "legacy") entry.cyberAccessProgramControl = false;
      if (variant === "busy") entry.busy = true;
      const result = applySessionCyberAccessProgram({ ...input, entry: variant === "missing" ? null : entry });
      expect(result.ok).toBe(false); expect(effects).toEqual([]);
    }
  });
  test("command, registry and durable owner agree; off is explicit standard", () => {
    for (const program of ["daybreakBlue", "standard"] as const) {
      const { input, effects } = fixture();
      expect(applySessionCyberAccessProgram({ ...input, requested: program })).toEqual({ ok: true, program });
      expect(effects).toEqual([["key", { type: "set_cyber_access_program", cyberAccessProgram: program }], ["key", { cyberAccessProgram: program }], ["name", { cyberAccessProgram: program }]]);
    }
  });
  test("launcher transports the program without changing effort or identity", () => {
    const args = managedCodexAisdkSessionArgv({ name: "n", key: "k", cwd: "/Users/samht", model: "gpt-6-sol", thinkingLevel: "high", cyberAccessProgram: "daybreakBlue", resume: "native" });
    expect(args.slice(args.indexOf("--cyber-access-program"), args.indexOf("--cyber-access-program") + 2)).toEqual(["--cyber-access-program", "daybreakBlue"]);
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "native"]);
  });
});
const saved = PATHS.data;
let scratch = "";
afterEach(() => { resetResumeCacheConnectionForTests(); PATHS.data = saved; if (scratch) rmSync(scratch, { recursive: true, force: true }); });
test("Daybreak and explicit off survive archive refresh and cold resume cache", () => {
  scratch = mkdtempSync(join(tmpdir(), "omg-daybreak-cache-")); PATHS.data = scratch; resetResumeCacheConnectionForTests();
  const row: ResumableCacheRow = { sessionId: "key", agent: "codex", backend: "codex-aisdk", resumeHandle: "native", cwd: "/Users/samht", project: "p", title: "t", lastUserText: null, lastActivityAt: 1, path: null, mtimeMs: 1, model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" };
  upsertResumableRows([row]); expect(getCachedResumableSession("key")?.cyberAccessProgram).toBe("daybreakBlue");
  upsertResumableRows([{ ...row, cyberAccessProgram: undefined }]); expect(getCachedResumableSession("key")?.cyberAccessProgram).toBe("daybreakBlue");
  upsertResumableRows([{ ...row, cyberAccessProgram: "standard" }]); expect(getCachedResumableSession("key")?.cyberAccessProgram).toBe("standard");
});
