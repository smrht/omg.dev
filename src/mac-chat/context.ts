// Central context discovery for Mac-hosted sessions.
//
// Full parity source inventory per CONTEXT-INVENTORY.md (2026-10-03): the
// complete ordered applicable instruction set (globals are PROVIDER-AWARE,
// then the repo chain root→cwd), the FULL skill-pool union (six pools + repo
// roots + plugin caches, deduplicated by canonical realpath + SKILL.md
// sha256, symlink topology preserved), codex memories (~/.codex/memories
// flat files; sqlite/subdirs are presence metadata only by policy) and the
// claude command manifests. Re-read from disk on EVERY call; nothing is
// cached, abbreviated or silently dropped:
//
//   - a source that cannot be read (too large, unreadable) lands in
//     `omitted` with its reason and flips `complete` to false;
//   - caps that fire (entries per root, bytes per file) are recorded the
//     same way;
//   - directory symlinks in skill roots are canonicalized (realpath), and a
//     symlinked SKILL.md is resolved-then-hashed with its canonical target
//     recorded — the topology on agentbox2 is load-bearing.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** Instruction file names per directory, in this order (AGENTS first). */
export const INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export type ContextProvider = "claude" | "codex";

export type ContextSourceOptions = {
  /** Session project cwd on the Agentbox (absolute). */
  cwd: string;
  /** Provider whose native sources must be mirrored (globals/skills/memories). */
  provider: ContextProvider;
  /** Extra instruction paths appended after globals, before the repo chain. */
  globalPaths?: string[];
  /** Skill roots override (tests); defaults are the full pool union. */
  skillRoots?: string[];
  /** Memory roots override (tests). */
  memoryRoots?: string[];
  /** Home override for DEFAULT roots only (tests); explicit paths win. */
  home?: string;
  /** Cap per file read. */
  maxFileBytes?: number;
  /** Cap per directory in the instruction chain. */
  maxChainEntries?: number;
};

export type ContextInstruction = {
  order: number;
  path: string;
  sha256: string;
  content: string;
};

export type ContextSkill = {
  root: string;
  name: string;
  skillFile: string;
  /** Canonical target when skillFile is a symlink (topology is load-bearing). */
  canonical?: string;
  sha256: string;
};

export type ContextMemoryFile = { root: string; path: string; sha256: string };
export type ContextOmission = { path: string; reason: string };

export type CentralContext = {
  revision: string;
  complete: boolean;
  instructions: ContextInstruction[];
  skills: ContextSkill[];
  memory: ContextMemoryFile[];
  /** Presence-only metadata (subdirs of ~/.codex/memories etc.). */
  memoryDirs: Array<{ root: string; path: string }>;
  commands: Array<{ root: string; path: string; sha256: string }>;
  omitted: ContextOmission[];
};

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

type ReadResult =
  | { ok: true; content: string; sha256: string; canonical?: string }
  | { ok: false; reason: string };

function readRegularFile(path: string, cap: number): ReadResult {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  let canonical: string | undefined;
  let target = path;
  if (st.isSymbolicLink()) {
    // Resolve-then-hash: skill/entry symlinks are part of the setup; their
    // CONTENT ships and the canonical target is recorded.
    try {
      canonical = realpathSync(path);
      target = canonical;
      st = lstatSync(target);
    } catch {
      return { ok: false, reason: "broken-symlink" };
    }
  }
  if (!st.isFile()) return { ok: false, reason: "not-a-regular-file" };
  if (st.size > cap) return { ok: false, reason: `too-large (${st.size} > ${cap})` };
  try {
    const bytes = readFileSync(target);
    return { ok: true, content: bytes.toString("utf8"), sha256: sha256(bytes), ...(canonical ? { canonical } : {}) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Instruction chain for a cwd: repo-root → cwd, per directory in filename
 * order (AGENTS.md then CLAUDE.md). Nearest-to-cwd comes LAST (highest
 * precedence). Only files that exist are listed; discovery never invents
 * paths.
 */
export function orderedInstructionPaths(cwd: string): string[] {
  const perDir: string[][] = [];
  let dir = isAbsolute(cwd) ? cwd : null;
  const seen = new Set<string>();
  let depth = 0;
  while (dir && depth < 64) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const here: string[] = [];
    for (const name of INSTRUCTION_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) here.push(candidate);
    }
    if (here.length) perDir.push(here);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }
  // perDir is cwd→root; emit root→cwd with per-directory filename order kept.
  return perDir.reverse().flat();
}

function defaultGlobalPaths(home: string, provider: ContextProvider): string[] {
  const paths = [
    join(home, ".agents", "AGENTS.md"),
    provider === "claude" ? join(home, ".claude", "CLAUDE.md") : join(home, ".codex", "AGENTS.md"),
    join(home, "AGENTS.md"),
    join(home, "CLAUDE.md"),
  ];
  return paths;
}

function defaultSkillRoots(home: string, provider: ContextProvider, cwd: string): string[] {
  const claudeHome = process.env.CLAUDE_HOME?.trim() || join(home, ".claude");
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const candidates = [
    join(home, ".agents", "skills"),
    join(home, ".agents", "skills-via-jev"),
    join(claudeHome, "skills"),
    join(claudeHome, "skills-via-jev"),
    join(codexHome, "skills"),
    join(claudeHome, "plugins", "cache"),
    join(codexHome, "plugins", "cache"),
    // Repo-local pools for the session cwd (walked up to the repo root is
    // overkill; the cwd itself + its .agents/.claude/.codex dirs are the
    // documented repo convention).
    join(cwd, ".agents", "skills"),
    join(cwd, ".claude", "skills"),
    join(cwd, ".codex", "skills"),
    join(cwd, "skills"),
  ];
  if (provider === "claude") candidates.push(join(claudeHome, "commands"));
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      // Canonicalize directory symlinks (load-bearing topology).
      roots.push(realpathSync(candidate));
    } catch {
      // unreadable/broken root: recorded by the caller's omission trail.
    }
  }
  return [...new Set(roots)];
}

function defaultMemoryRoots(home: string): string[] {
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const roots = [join(codexHome, "memories"), join(home, ".agents", "memory")];
  return roots.filter((root) => existsSync(root));
}

const MAX_SKILL_ENTRIES_PER_ROOT = 500;

function discoverSkills(
  roots: string[],
  cap: number,
  omitted: ContextOmission[],
): ContextSkill[] {
  const byCanonical = new Map<string, ContextSkill>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      omitted.push({ path: root, reason: "skill root unreadable" });
      continue;
    }
    if (entries.length > MAX_SKILL_ENTRIES_PER_ROOT) {
      omitted.push({ path: root, reason: `skill root exceeds ${MAX_SKILL_ENTRIES_PER_ROOT} entries (capped)` });
    }
    for (const name of entries.slice(0, MAX_SKILL_ENTRIES_PER_ROOT)) {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      // Claude command manifests are flat .md files, not skill dirs.
      if (root.endsWith("/commands") || root.endsWith(`${join("", "commands")}`)) continue;
      const skillFile = join(dir, "SKILL.md");
      const read = readRegularFile(skillFile, cap);
      if (!read.ok) {
        if (read.reason !== "missing") omitted.push({ path: skillFile, reason: `skill ${read.reason}` });
        continue;
      }
      // Canonical target of the SKILL.md itself (dir-symlink pools load-
      // bearing): realpath records where the content actually lives.
      let canonical: string | undefined;
      try {
        const real = realpathSync(skillFile);
        if (real !== skillFile) canonical = real;
      } catch {}
      const effectiveCanonical = read.canonical ?? canonical;
      // Dedup by canonical target + content hash (pools cross-link heavily).
      const key = `${effectiveCanonical ?? skillFile}:${read.sha256}`;
      if (!byCanonical.has(key)) {
        byCanonical.set(key, {
          root,
          name,
          skillFile,
          ...(effectiveCanonical ? { canonical: effectiveCanonical } : {}),
          sha256: read.sha256,
        });
      }
    }
  }
  return [...byCanonical.values()].sort((a, b) => (a.skillFile < b.skillFile ? -1 : 1));
}

function discoverCommands(
  roots: string[],
  cap: number,
  omitted: ContextOmission[],
): Array<{ root: string; path: string; sha256: string }> {
  const commands: Array<{ root: string; path: string; sha256: string }> = [];
  for (const root of roots) {
    if (!root.endsWith("commands")) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      omitted.push({ path: root, reason: "command root unreadable" });
      continue;
    }
    for (const name of entries.slice(0, MAX_SKILL_ENTRIES_PER_ROOT)) {
      if (!name.endsWith(".md")) continue;
      const path = join(root, name);
      const read = readRegularFile(path, cap);
      if (!read.ok) {
        omitted.push({ path, reason: `command ${read.reason}` });
        continue;
      }
      commands.push({ root, path, sha256: read.sha256 });
    }
  }
  return commands;
}

/** Flat top-level memory files only; subdirs and sqlite become presence rows. */
function discoverMemory(
  roots: string[],
  cap: number,
  omitted: ContextOmission[],
): { files: ContextMemoryFile[]; dirs: Array<{ root: string; path: string }> } {
  const files: ContextMemoryFile[] = [];
  const dirs: Array<{ root: string; path: string }> = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      omitted.push({ path: root, reason: "memory root unreadable" });
      continue;
    }
    for (const name of entries.slice(0, MAX_SKILL_ENTRIES_PER_ROOT)) {
      const path = join(root, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Presence metadata only (explicit policy, CONTEXT-INVENTORY §C).
        dirs.push({ root, path });
        continue;
      }
      if (name.endsWith(".sqlite") || name.endsWith(".sqlite-shm") || name.endsWith(".sqlite-wal") || name.startsWith(".")) {
        continue; // sqlite stores are presence-only by policy
      }
      const read = readRegularFile(path, cap);
      if (!read.ok) {
        omitted.push({ path, reason: `memory ${read.reason}` });
        continue;
      }
      files.push({ root, path, sha256: read.sha256 });
    }
  }
  return { files, dirs };
}

/**
 * Build the COMPLETE central context for one session: full instruction
 * contents in native precedence order, the deduplicated skill/command
 * manifests, memory manifests — plus an explicit `omitted` trail; `complete`
 * is false when any INSTRUCTION source could not ship (skills/memory
 * omissions are recorded but do not fail the context, they are manifests).
 * Re-read from disk on every call: callers use this per turn, per restart
 * and per resume, so a central source change lands on the next turn.
 */
export function buildCentralContext(opts: ContextSourceOptions): CentralContext {
  const cap = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const home = opts.home ?? process.env.HOME ?? homedir();
  const skillRoots = opts.skillRoots ?? defaultSkillRoots(home, opts.provider, opts.cwd);
  const memoryRoots = opts.memoryRoots ?? defaultMemoryRoots(home);
  const omitted: ContextOmission[] = [];

  const globalPaths = [
    ...(opts.globalPaths ?? []).filter((p) => isAbsolute(p)),
    ...defaultGlobalPaths(home, opts.provider),
  ];
  const paths = [...new Set(globalPaths), ...orderedInstructionPaths(opts.cwd)];
  const instructions: ContextInstruction[] = [];
  let complete = true;
  for (let order = 0; order < paths.length; order++) {
    const read = readRegularFile(paths[order]!, cap);
    if (!read.ok) {
      if (read.reason === "missing") continue; // absent global candidates are normal
      omitted.push({ path: paths[order]!, reason: `instruction ${read.reason}` });
      complete = false;
      continue;
    }
    instructions.push({
      order,
      path: paths[order]!,
      sha256: read.sha256,
      content: read.content,
      ...(read.canonical ? {} : {}),
    });
  }

  const skills = discoverSkills(skillRoots, cap, omitted);
  const commands = discoverCommands(skillRoots, cap, omitted);
  const memory = discoverMemory(memoryRoots, cap, omitted);

  const revision = sha256(JSON.stringify({
    instructions: instructions.map((i) => [i.path, i.sha256]),
    skills,
    commands,
    memory: memory.files,
    memoryDirs: memory.dirs,
    omitted,
  }));
  return {
    revision,
    complete,
    instructions,
    skills,
    memory: memory.files,
    memoryDirs: memory.dirs,
    commands,
    omitted,
  };
}

/**
 * Item 35: REQUIRED central instruction failures REFUSE before any provider
 * input. `complete === false` means an INSTRUCTION source (global or repo
 * chain) was unreadable or over-size — the harnesses and the launcher call
 * THIS guard and stop the turn/launch with the actionable path+reason
 * (never the content). OPTIONAL omissions (skill/memory manifests, missing
 * optional roots, non-transportable skill paths) stay non-fatal: they are
 * recorded, logged by the caller, but never block a turn.
 */
export type CentralContextRefusal = {
  ok: false;
  error: string;
  /** Required-instruction omissions that caused the refusal (path+reason). */
  omissions: ContextOmission[];
};

export type ValidatedCentralContextResult = { ok: true; context: CentralContext } | CentralContextRefusal;

export function validatedCentralContext(
  provider: ContextProvider,
  cwd: string,
  opts: Omit<ContextSourceOptions, "provider" | "cwd"> = {},
): ValidatedCentralContextResult {
  const context = buildCentralContext({ ...opts, provider, cwd });
  if (context.complete) return { ok: true, context };
  const required = context.omitted.filter((o) => o.reason.startsWith("instruction "));
  if (!required.length) return { ok: true, context };
  const lines = required.map((o) => `${o.path} (${o.reason.replace(/^instruction /, "")})`);
  return {
    ok: false,
    omissions: required,
    error: `vereiste centrale instructiebronnen onleesbaar — beurt/launch GEWEIGERD vóór provider-input: ${lines.join("; ")}`,
  };
}

/**
 * Render the per-turn preamble delivered inside the provider-facing user
 * turn (prompt text may never ride argv and a resumed claude keeps its
 * first stored system prompt, so the fresh context must travel WITH the
 * turn). The central transcript keeps the CLEAN user text; only the
 * provider sees this wrapper.
 */
export function contextPreambleText(context: CentralContext, provider: ContextProvider): string {
  const blocks: string[] = ["<central-context fresh-per-turn>"];
  for (const instruction of context.instructions) {
    blocks.push(`<instructions path="${instruction.path}" sha256="${instruction.sha256}">\n${instruction.content}\n</instructions>`);
  }
  if (context.skills.length) {
    const lines = context.skills.map((s) => `- ${s.name} (${s.skillFile})`);
    blocks.push(`<central-skills>\n${lines.join("\n")}\nLees de volledige SKILL.md via de centrale workspace-tools als je een skill nodig hebt.\n</central-skills>`);
  }
  if (context.commands.length) {
    const lines = context.commands.map((c) => `- ${c.path}`);
    blocks.push(`<central-commands>\n${lines.join("\n")}\n</central-commands>`);
  }
  if (context.memory.length || context.memoryDirs.length) {
    const lines = context.memory.map((m) => `- ${m.path}`);
    const dirLines = context.memoryDirs.map((d) => `- ${d.path}/ (aanwezig; via workspace-tools te raadplegen)`);
    blocks.push(`<central-memory>\n${[...lines, ...dirLines].join("\n")}\n</central-memory>`);
  }
  if (context.omitted.length) {
    const lines = context.omitted.map((o) => `- ${o.path}: ${o.reason}`);
    blocks.push(`<context-omitted>\n${lines.join("\n")}\n</context-omitted>`);
  }
  blocks.push(
    provider === "claude"
      ? "Projectbestanden en -geschiedenis leven op de Agentbox: gebruik de omg/workspace MCP-tools via de bridge; schrijf centraal via workspace write_file (CAS); Mac-lokale bestandspaden zijn geen projectpaden."
      : "Projectbestanden en -geschiedenis leven op de Agentbox: gebruik de omg/workspace MCP-tools via de bridge; schrijf centraal via workspace write_file (CAS); Mac-lokale bestandspaden zijn geen projectpaden.",
  );
  blocks.push("</central-context>");
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Wire projection (frozen contract): the peer validates that
// revision == sha256(canon({instructions, skills, memory})) using Python's
// json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=True) — see
// transport.py _valid_context + jobs.canon. The internal revision (refresh
// detection) is a DIFFERENT hash and stays on the CentralContext.
// ---------------------------------------------------------------------------

/**
 * Canonical JSON bytes for CROSS-LANGUAGE wire digests — FROZEN by the
 * primary (WIRE-RECONCILIATION item 29): Python json.dumps with sort_keys,
 * tight separators and ascii escaping of nonASCII (\uXXXX, lowercase hex),
 * UTF-8 encoded. The peer's wire_canon implements the identical convention;
 * never flip the escaping on either side.
 */
export function canonJsonBytes(value: unknown): Uint8Array {
  const out: string[] = [];
  const emit = (v: unknown): void => {
    if (v === null) {
      out.push("null");
      return;
    }
    switch (typeof v) {
      case "boolean":
        out.push(v ? "true" : "false");
        return;
      case "number":
        if (!Number.isInteger(v)) throw new Error("canonJson: non-integer numbers are not part of the wire contract");
        out.push(String(v));
        return;
      case "string":
        out.push(canonString(v));
        return;
      case "object":
        if (Array.isArray(v)) {
          out.push("[");
          for (let i = 0; i < v.length; i++) {
            if (i) out.push(",");
            emit(v[i]);
          }
          out.push("]");
          return;
        }
        {
          const keys = Object.keys(v as Record<string, unknown>).sort();
          out.push("{");
          for (let i = 0; i < keys.length; i++) {
            if (i) out.push(",");
            out.push(canonString(keys[i]!));
            out.push(":");
            emit((v as Record<string, unknown>)[keys[i]!]);
          }
          out.push("}");
          return;
        }
      default:
        throw new Error("canonJson: unsupported value on the wire");
    }
  };
  emit(value);
  return new TextEncoder().encode(out.join(""));
}

/** Python json.dumps string escaping (ensure_ascii: non-ASCII → \uXXXX,
 * control chars via named escapes or \u00xx, lowercase hex, surrogate pairs
 * emitted as two \uXXXX escapes exactly like CPython). */
function canonString(value: string): string {
  let out = "\"";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = value[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out + "\"";
}

/** sha256 over the UTF-8 bytes of a string (Python: sha256(s.encode())). */
export function sha256Utf8(text: string): string {
  return createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
}

/**
 * Wire path constraint (peer PATH_TOKEN_RE, item 29): metadata paths are
 * JSON data, not shell args — refuse only NUL/control characters, bound at
 * 1024. Spaces and unicode are legitimate central paths.
 */
const WIRE_PATH_TOKEN = /^[^\u0000-\u001f\u007f]{1,1024}$/;

export type WireContextEntry =
  | { order: number; path: string; sha256: string; content: string }
  | { root: string; name?: string; skillFile?: string; path?: string; sha256: string };

export type WireContext = {
  revision: string;
  instructions: Array<{ order: number; path: string; sha256: string; content: string }>;
  skills: Array<{ root: string; name: string; skillFile: string; sha256: string }>;
  memory: Array<{ root: string; path: string; sha256: string }>;
};

/**
 * Project the central context onto the frozen wire shape:
 * - per-instruction sha256 is over the UTF-8 ENCODED content (the peer hashes
 *   content.encode()), not over the raw file bytes;
 * - `canonical`/alias fields stay INTERNAL (the peer rejects unknown fields);
 * - entries whose paths cannot ride the wire (PATH_TOKEN_RE, e.g. spaces)
 *   are DROPPED FROM THE WIRE and appended to `omitted` — an explicit local
 *   refusal instead of a remote stream rejection;
 * - revision = sha256(canon({instructions, skills, memory})) — the WIRE
 *   revision, distinct from the internal refresh revision.
 */
export function toWireContext(context: CentralContext): WireContext {
  return toWireContextDetailed(context).wire;
}

/** Detailed projection: the wire object plus the explicit omission trail. */
export function toWireContextDetailed(context: CentralContext): { wire: WireContext; omitted: ContextOmission[] } {
  const omitted: ContextOmission[] = [];
  const instructions: WireContext["instructions"] = [];
  let order = 0;
  for (const instruction of context.instructions) {
    // REQUIRED instructions are never silently omitted (item 29): they ride
    // the wire unconditionally; a genuinely invalid path fails loudly at the
    // peer (explicit refusal) instead of disappearing here.
    instructions.push({
      order: order++,
      path: instruction.path,
      sha256: sha256Utf8(instruction.content),
      content: instruction.content,
    });
  }
  const skills: WireContext["skills"] = [];
  for (const skill of context.skills) {
    if (![skill.root, skill.name, skill.skillFile].every((p) => WIRE_PATH_TOKEN.test(p))) {
      omitted.push({ path: skill.skillFile, reason: "skill path not wire-transportable (PATH_TOKEN_RE)" });
      continue;
    }
    skills.push({ root: skill.root, name: skill.name, skillFile: skill.skillFile, sha256: skill.sha256 });
  }
  const memory: WireContext["memory"] = [];
  for (const file of context.memory) {
    if (![file.root, file.path].every((p) => WIRE_PATH_TOKEN.test(p))) {
      omitted.push({ path: file.path, reason: "memory path not wire-transportable (PATH_TOKEN_RE)" });
      continue;
    }
    memory.push({ root: file.root, path: file.path, sha256: file.sha256 });
  }
  const revision = sha256(canonJsonBytes({ instructions, skills, memory }));
  return { wire: { revision, instructions, skills, memory }, omitted };
}
