// argv-adapter tests, including the REAL captured SDK argv fixture
// (buildroot sdk-argv-fixture.json) and a cross-language validation against
// the transport worker's actual schema.py (python3, read-only import).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adaptClaudeArgv, adaptCodexConfigArgv } from "./argv-adapter.ts";

// Item 18: the captured SDK fixture lives in the REPO (committed, portable);
// the peer schema path is env-driven (primary gate sets/keeps the default).
const BUILDROOT = process.env.MAC_CHAT_BUILD_ROOT ?? "/Users/samht/.cache/mac-headchat-build-20261003";
const REPO_FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/sdk-argv-fixture.json");
const PEER_DIR = process.env.MAC_CHAT_TRANSPORT_DIR ?? "/Users/samht/sites-beheer/scripts/agentbox/mac-chat-transport";
const PEER_SCHEMA = join(PEER_DIR, "schema.py");

const CLAUDE_PREFIX = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

function pythonValidate(argv: string[], provider: "claude" | "codex"): { ok: boolean; error?: string } {
  const script = provider === "claude"
    ? `import sys,json;sys.path.insert(0,${JSON.stringify(PEER_DIR)});import schema;schema.validate_claude(json.loads(sys.argv[1]), "/private/tmp/fixture-scratch")`
    : `import sys,json;sys.path.insert(0,${JSON.stringify(PEER_DIR)});import schema;schema.validate_codex(json.loads(sys.argv[1]))`;
  const proc = Bun.spawnSync(["python3", "-c", script, JSON.stringify(argv)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: proc.exitCode === 0, error: proc.stderr.toString().trim().slice(0, 4000) };
}

describe("adaptClaudeArgv", () => {
  test("real captured SDK argv (sdk-argv-fixture.json): --settings EXTRACTED, never forwarded", () => {
    const fixture = JSON.parse(readFileSync(existsSync(REPO_FIXTURE) ? REPO_FIXTURE : join(BUILDROOT, "sdk-argv-fixture.json"), "utf8")) as string[];
    const result = adaptClaudeArgv(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.argv).not.toContain("--settings");
    expect(result.extraction.settingsJson?.parsed).toEqual({ fastMode: true });
    // Everything else survives verbatim, in order. The captured fixture is
    // the MAC-ROUTE form (item 33): settingSources:[] emits the EMPTY
    // `--setting-sources=` token, which the peer transport accepts and
    // enforces (non-empty sources are a standing-context collision there).
    expect(result.extraction.argv).toContain("--model");
    expect(result.extraction.argv).toContain("opus");
    expect(result.extraction.argv).toContain("--setting-sources=");
    expect(result.extraction.argv).not.toContain("--setting-sources=user,project");
    expect(result.extraction.argv).toContain("--permission-mode");
    expect(result.extraction.argv.join(" ")).not.toContain("fastMode");
    expect(result.extraction.notes.join(" ")).toContain("--settings extracted");
  });

  test("the ADAPTED fixture argv passes the peer's REAL schema.py validator (cross-language)", () => {
    const fixture = JSON.parse(readFileSync(existsSync(REPO_FIXTURE) ? REPO_FIXTURE : join(BUILDROOT, "sdk-argv-fixture.json"), "utf8")) as string[];
    const result = adaptClaudeArgv(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdict = pythonValidate(result.extraction.argv, "claude");
    expect(verdict.ok).toBe(true);
  });

  test("prompt/mcp-config flags are extracted, never forwarded", () => {
    const argv = [
      ...CLAUDE_PREFIX,
      "--append-system-prompt", "SECRET INSTRUCTIONS",
      "--mcp-config", "/tmp/omg-mcp-123.json",
      "--model", "opus",
    ];
    const result = adaptClaudeArgv(argv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.argv.join(" ")).not.toContain("SECRET INSTRUCTIONS");
    expect(result.extraction.argv).not.toContain("--mcp-config");
    expect(result.extraction.systemPromptAppend).toBe("SECRET INSTRUCTIONS");
    expect(result.extraction.mcpConfigPath).toBe("/tmp/omg-mcp-123.json");
  });

  test("unknown flags and untransportable modes are EXPLICIT refusals, never silent drops", () => {
    expect(!adaptClaudeArgv([...CLAUDE_PREFIX, "--print"]).ok).toBe(true);
    expect(!adaptClaudeArgv([...CLAUDE_PREFIX, "--dangerously-skip-permissions"]).ok).toBe(true);
    expect(!adaptClaudeArgv([...CLAUDE_PREFIX, "--future-flag", "x"]).ok).toBe(true);
    const missingPrefix = adaptClaudeArgv(["--model", "opus"]);
    expect(!missingPrefix.ok).toBe(true);
  });
});

describe("adaptClaudeArgv equals-form canonicalization (--flag=value)", () => {
  const UUID = "47c48a29-0200-4011-a388-edeb9b3d9d5c";

  test("--session-id=<uuid> (the production failure shape) canonicalizes to the separated form and passes the REAL schema.py", () => {
    const result = adaptClaudeArgv([...CLAUDE_PREFIX, `--session-id=${UUID}`, "--model", "opus"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.argv).toContain("--session-id");
    expect(result.extraction.argv[result.extraction.argv.indexOf("--session-id") + 1]).toBe(UUID);
    expect(result.extraction.argv).not.toContain(`--session-id=${UUID}`);
    expect(pythonValidate(result.extraction.argv, "claude").ok).toBe(true);
  });

  test("equals splits for other allowed value flags too; empty --setting-sources= stays verbatim (its canonical form)", () => {
    const result = adaptClaudeArgv([...CLAUDE_PREFIX, "--model=opus", "--effort=high", "--setting-sources="]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.argv).toEqual([...CLAUDE_PREFIX, "--model", "opus", "--effort", "high", "--setting-sources="]);
    expect(pythonValidate(result.extraction.argv, "claude").ok).toBe(true);
  });

  test("duplicates are refused HERE (schema.py validates pairwise and would let them through): same-form and mixed-form", () => {
    const sameSeparated = adaptClaudeArgv([...CLAUDE_PREFIX, "--session-id", UUID, "--session-id", UUID]);
    expect(!sameSeparated.ok).toBe(true);
    if (!sameSeparated.ok) expect(sameSeparated.error).toContain("--session-id appears twice");
    const mixed = adaptClaudeArgv([...CLAUDE_PREFIX, `--session-id=${UUID}`, "--session-id", UUID]);
    expect(!mixed.ok).toBe(true);
    const doubledSources = adaptClaudeArgv([...CLAUDE_PREFIX, "--setting-sources=", "--setting-sources="]);
    expect(!doubledSources.ok).toBe(true);
  });

  test("unknown equals flags and equals on non-canonicalizable flags are refused BY NAME (no allowlist widening)", () => {
    const unknown = adaptClaudeArgv([...CLAUDE_PREFIX, "--future-flag=x"]);
    expect(!unknown.ok).toBe(true);
    if (!unknown.ok) expect(unknown.error).toContain("--future-flag=x");
    // --settings is an EXTRACT flag in separated form only; its equals form
    // is not an SDK emission and must not sneak past as a value flag.
    const settings = adaptClaudeArgv([...CLAUDE_PREFIX, '--settings={"fastMode":true}']);
    expect(!settings.ok).toBe(true);
    if (!settings.ok) expect(settings.error).toContain('unknown or unsupported flag --settings=');
    // a value that starts with -- is a missing value in either syntax
    const missing = adaptClaudeArgv([...CLAUDE_PREFIX, "--model=--verbose"]);
    expect(!missing.ok).toBe(true);
    if (!missing.ok) expect(missing.error).toContain("--model missing value");
  });

  test("invalid UUID VALUE is the schema's authority: the client canonicalizes the shape, the REAL schema.py refuses the value", () => {
    const result = adaptClaudeArgv([...CLAUDE_PREFIX, "--session-id=not-a-uuid", "--model", "opus"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.argv).toContain("not-a-uuid");
    const verdict = pythonValidate(result.extraction.argv, "claude");
    expect(verdict.ok).toBe(false);
    // the traceback's LAST line is the SchemaError detail from schema.py
    expect((verdict.error ?? "").split("\n").at(-1) ?? "").toContain("bad uuid");
  });
});

describe("adaptCodexConfigArgv", () => {
  test("whitelisted keys build wire-legal -c pairs that pass the REAL schema.py validator", () => {
    const result = adaptCodexConfigArgv({
      model: "gpt-5.5-codex",
      model_reasoning_effort: "high",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.argv).toEqual([
      "app-server", "--stdio",
      "-c", 'model="gpt-5.5-codex"',
      "-c", 'model_reasoning_effort="high"',
    ]);
    const verdict = pythonValidate(result.extraction.argv, "codex");
    expect(verdict.ok).toBe(true);
  });

  test("the EXACT current OMG service-tier.ts Fast emission passes and is schema-valid (item 17)", () => {
    const result = adaptCodexConfigArgv({ service_tier: "fast", features: { fast_mode: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.argv).toEqual([
      "app-server", "--stdio",
      "-c", 'service_tier="fast"',
      "-c", "features.fast_mode=true",
    ]);
    const verdict = pythonValidate(result.extraction.argv, "codex");
    expect(verdict.ok).toBe(true);
  });

  test("every OTHER service_tier value and features.* key is still refused (narrow allow)", () => {
    expect(!adaptCodexConfigArgv({ service_tier: "priority" }).ok).toBe(true);
    expect(!adaptCodexConfigArgv({ features: { fast_mode: false } }).ok).toBe(true);
    expect(!adaptCodexConfigArgv({ features: { other: true } }).ok).toBe(true);
    expect(!adaptCodexConfigArgv({ service_tier: "fast", features: { fast_mode: true, extra: 1 } }).ok).toBe(true);
  });

  test("null config yields the bare app-server argv (still schema-valid)", () => {
    const result = adaptCodexConfigArgv(null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pythonValidate(result.extraction.argv, "codex").ok).toBe(true);
  });
});
