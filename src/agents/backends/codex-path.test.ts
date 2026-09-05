import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCodexPathOverride, resolveCodexPathOverride } from "./codex-aisdk-session.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executable(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omg-codex-path-"));
  scratch.push(dir);
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("Codex runtime path", () => {
  test("prefers the explicit managed override", () => {
    const explicit = executable("codex-explicit");
    const installed = executable("codex-installed");
    expect(resolveCodexPathOverride({ LFG_CODEX_PATH: explicit }, () => installed)).toBe(explicit);
  });

  test("uses the installed Codex CLI when no override is configured", () => {
    const installed = executable("codex-installed");
    expect(resolveCodexPathOverride({}, () => installed)).toBe(installed);
    expect(resolveCodexPathOverride({ LFG_CODEX_PATH: "  " }, () => installed)).toBe(installed);
  });

  test("fails loudly instead of falling back to the SDK bundle", () => {
    expect(resolveCodexPathOverride({}, () => null)).toBeUndefined();
    expect(() => requireCodexPathOverride({}, () => null)).toThrow(
      "installed Codex CLI not found; refusing bundled SDK fallback",
    );
  });
});
