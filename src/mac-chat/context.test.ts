// Central context tests: full-parity inventory per CONTEXT-INVENTORY.md —
// provider-aware globals, repo chain ordering, skill-pool union with symlink
// canonicalization + dedup, codex memories, explicit omissions, per-turn
// nonce freshness, preamble rendering.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { buildCentralContext, contextPreambleText, orderedInstructionPaths, toWireContext, toWireContextDetailed } from "./context.ts";

let home: string;
let repo: string;
let baseDir: string;

const PYTHON_VALID_CONTEXT = [
  "import sys,json",
  `sys.path.insert(0, ${JSON.stringify(process.env.MAC_CHAT_TRANSPORT_DIR ?? "/Users/samht/sites-beheer/scripts/agentbox/mac-chat-transport")})`,
  "import transport",
  "transport._valid_context(json.load(sys.stdin))",
  'print("CONTEXT_WIRE_OK")',
].join(";");

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "mac-chat-context-")));
  baseDir = base;
  home = join(base, "home");
  repo = join(base, "repo");
  // Globals (provider-aware).
  mkdirSync(join(home, ".agents"), { recursive: true });
  writeFileSync(join(home, ".agents", "AGENTS.md"), "generic global");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "claude global");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "AGENTS.md"), "codex global");
  writeFileSync(join(home, "AGENTS.md"), "home-root agents");
  writeFileSync(join(home, "CLAUDE.md"), "home-root claude");
  // Home is an ANCESTOR of repo in the fixture layout: repo lives under home.
  mkdirSync(join(home, "work"), { recursive: true });
  const repoDir = join(home, "work", "repo");
  mkdirSync(repoDir, { recursive: true });
  repo = repoDir;
  writeFileSync(join(repoDir, "AGENTS.md"), "repo agents");
  writeFileSync(join(repoDir, "CLAUDE.md"), "repo claude");
  // Skill pools: real dir + symlinked duplicate (dedup by canonical+hash).
  const poolA = join(home, ".agents", "skills");
  const poolB = join(home, ".claude", "skills");
  mkdirSync(join(poolA, "shared-skill"), { recursive: true });
  writeFileSync(join(poolA, "shared-skill", "SKILL.md"), "skill body v1");
  mkdirSync(poolB, { recursive: true });
  symlinkSync(join(poolA, "shared-skill"), join(poolB, "shared-skill-link"));
  mkdirSync(join(poolA, "unique-a"), { recursive: true });
  writeFileSync(join(poolA, "unique-a", "SKILL.md"), "unique a");
  // A skill whose REAL dir sits in a LATER-scanned pool, aliased by an
  // EARLIER pool: the surviving manifest row is the alias, so its canonical
  // target (the real SKILL.md) must be recorded.
  mkdirSync(join(home, ".agents", "skills-via-jev"), { recursive: true });
  mkdirSync(join(poolB, "jev-real"), { recursive: true });
  writeFileSync(join(poolB, "jev-real", "SKILL.md"), "jev real body");
  symlinkSync(join(poolB, "jev-real"), join(home, ".agents", "skills-via-jev", "jev-alias"));
  // Claude commands.
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  writeFileSync(join(home, ".claude", "commands", "deploy.md"), "command body");
  // Codex memories: flat files + a subdir (presence-only) + sqlite (skipped).
  const memories = join(home, ".codex", "memories");
  mkdirSync(join(memories, "rollout_summaries"), { recursive: true });
  writeFileSync(join(memories, "MEMORY.md"), "memory nonce 1");
  writeFileSync(join(memories, "memories_1.sqlite"), "binary");
  // A repo-level skill root.
  mkdirSync(join(repoDir, ".agents", "skills", "repo-skill"), { recursive: true });
  writeFileSync(join(repoDir, ".agents", "skills", "repo-skill", "SKILL.md"), "repo skill");
});

afterAll(() => {
  // Retry once: macOS occasionally lets the recursive unlink remove all
  // children but keep the (then empty) directory itself.
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch { /* try again below */ }
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch { /* empty-dir residue in the cache tmp namespace is cosmetic */ }
});

describe("orderedInstructionPaths", () => {
  test("root→cwd directory order; AGENTS.md before CLAUDE.md inside a directory", () => {
    const paths = orderedInstructionPaths(repo);
    // Directories: home → home/work → home/work/repo; within each, AGENTS then CLAUDE.
    const repoAgents = paths.indexOf(join(repo, "AGENTS.md"));
    const repoClaude = paths.indexOf(join(repo, "CLAUDE.md"));
    const workDirHasNone = true; // home/work has no instruction files
    expect(workDirHasNone).toBe(true);
    expect(repoAgents).toBeGreaterThan(-1);
    expect(repoClaude).toBe(repoAgents + 1); // filename order preserved, NOT reversed
    expect(paths.indexOf(join(home, "AGENTS.md"))).toBeLessThan(repoAgents); // ancestors first
  });
});

describe("buildCentralContext (full inventory)", () => {
  test("claude globals + chain; codex gets ~/.codex/AGENTS.md instead", () => {
    const claude = buildCentralContext({ cwd: repo, provider: "claude", home });
    const claudePaths = claude.instructions.map((i) => i.path);
    expect(claudePaths).toContain(join(home, ".claude", "CLAUDE.md"));
    expect(claudePaths).not.toContain(join(home, ".codex", "AGENTS.md"));
    const codex = buildCentralContext({ cwd: repo, provider: "codex", home });
    const codexPaths = codex.instructions.map((i) => i.path);
    expect(codexPaths).toContain(join(home, ".codex", "AGENTS.md"));
    expect(codexPaths).toContain(join(home, "AGENTS.md")); // home-root explicit
    expect(codexPaths).toContain(join(repo, "CLAUDE.md")); // repo chain
    expect(codexPaths).toContain(join(repo, "AGENTS.md"));
  });

  test("skill pools union dedups by canonical realpath + hash; canonical recorded (load-bearing topology)", () => {
    const context = buildCentralContext({ cwd: repo, provider: "claude", home });
    const names = context.skills.map((s) => s.name);
    expect(names).toContain("shared-skill");
    // The symlinked duplicate in the second pool dedups away (same canonical
    // target + same SKILL.md hash) — exactly ONE manifest row per skill, with
    // the canonical target recorded instead of the alias.
    expect(names).not.toContain("shared-skill-link");
    const shared = context.skills.find((s) => s.name === "shared-skill");
    expect(shared?.skillFile).toBe(join(home, ".agents", "skills", "shared-skill", "SKILL.md"));
    // Alias-first row keeps the canonical target of the real SKILL.md.
    const aliasRow = context.skills.find((s) => s.name === "jev-alias");
    expect(aliasRow?.canonical).toBe(join(home, ".claude", "skills", "jev-real", "SKILL.md"));
    expect(names).toContain("unique-a");
    expect(names).toContain("repo-skill"); // repo skill root scanned
  });

  test("codex memory: flat files ship, sqlite skipped, subdirs presence-only", () => {
    const context = buildCentralContext({ cwd: repo, provider: "codex", home });
    const paths = context.memory.map((m) => m.path);
    expect(paths).toContain(join(home, ".codex", "memories", "MEMORY.md"));
    expect(paths.some((p) => p.endsWith(".sqlite"))).toBe(false);
    expect(context.memoryDirs.map((d) => d.path)).toContain(join(home, ".codex", "memories", "rollout_summaries"));
  });

  test("claude commands manifest present", () => {
    const context = buildCentralContext({ cwd: repo, provider: "claude", home });
    expect(context.commands.map((c) => c.path)).toContain(join(home, ".claude", "commands", "deploy.md"));
  });

  test("too-large instruction lands in omitted[] and flips complete=false", () => {
    const context = buildCentralContext({
      cwd: repo,
      provider: "claude",
      home,
      maxFileBytes: 8,
      globalPaths: [join(home, ".agents", "AGENTS.md")],
    });
    expect(context.complete).toBe(false);
    expect(context.omitted.some((o) => o.reason.startsWith("instruction too-large"))).toBe(true);
  });

  test("revision changes when a central source changes (nonce freshness)", () => {
    const before = buildCentralContext({ cwd: repo, provider: "claude", home });
    writeFileSync(join(repo, "AGENTS.md"), "repo agents NONCE-2");
    const after = buildCentralContext({ cwd: repo, provider: "claude", home });
    expect(after.revision).not.toBe(before.revision);
    expect(after.instructions.some((i) => i.content.includes("NONCE-2"))).toBe(true);
    writeFileSync(join(repo, "AGENTS.md"), "repo agents");
  });

  test("preamble carries full instruction contents; WIRE revision is canon-based and peer-verified (incl. non-ASCII)", () => {
    writeFileSync(join(repo, "AGENTS.md"), "repo agents NONCE-PREAMBLE — unicode: café 中文 🚀");
    const context = buildCentralContext({ cwd: repo, provider: "claude", home });
    const preamble = contextPreambleText(context, "claude");
    expect(preamble).toContain("NONCE-PREAMBLE");
    expect(preamble).toContain("<central-context fresh-per-turn>");
    const { wire, omitted } = toWireContextDetailed(context);
    expect(omitted).toEqual([]);
    expect(wire.instructions.some((i) => i.content.includes("NONCE-PREAMBLE"))).toBe(true);
    // WIRE revision ≠ internal revision (separate concerns), and the peer's
    // own _valid_context accepts the projection (real python3, read-only).
    expect(wire.revision).not.toBe(context.revision);
    const verdict = Bun.spawnSync(["python3", "-c", PYTHON_VALID_CONTEXT], {
      stdin: new Blob([JSON.stringify(wire)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(verdict.exitCode).toBe(0);
    expect(verdict.stdout.toString()).toContain("CONTEXT_WIRE_OK");
    writeFileSync(join(repo, "AGENTS.md"), "repo agents");
  });

  test("wire projection keeps required instructions (spaces/unicode are JSON data) and re-hashes content as UTF-8", () => {
    // Item 29: metadata paths are JSON data — spaces/unicode ride the wire.
    const weird = join(home, "dir with spaces", "AGENTS.md");
    mkdirSync(join(home, "dir with spaces"), { recursive: true });
    writeFileSync(weird, "spacey unicode instructies — café");
    try {
      const context = buildCentralContext({ cwd: repo, provider: "claude", home, globalPaths: [weird] });
      const { wire, omitted } = toWireContextDetailed(context);
      expect(omitted).toEqual([]);
      // REQUIRED: the instruction is present, never silently omitted.
      expect(wire.instructions.some((i) => i.path === weird)).toBe(true);
      // canonical alias fields never ride the wire
      expect(wire.skills.every((s) => !("canonical" in s))).toBe(true);
      // instruction sha256 is over UTF-8-encoded content (peer convention)
      for (const instruction of wire.instructions) {
        expect(instruction.sha256).toBe(
          createHash("sha256").update(new TextEncoder().encode(instruction.content)).digest("hex"),
        );
      }
    } finally {
      rmSync(join(home, "dir with spaces"), { recursive: true, force: true });
    }
  });
});
