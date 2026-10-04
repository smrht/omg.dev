// Path guards for the Mac main-chat bridge workspace tools.
//
// Every path a remote session names is resolved here before any fs call:
// inside an approved root, no forbidden segment (.git, .env, credentials,
// keys), no symlink anywhere on the walk. These checks run even when a root is
// broad, because "the root is approved" never implies "everything under it is
// readable" — a checkout contains .git and sometimes stray .env files.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { BridgeRoot } from "./lease.ts";

export type GuardReason =
  | "invalid"
  | "escape"
  | "forbidden-name"
  | "symlink"
  | "root-missing"
  | "no-root-access";

export type GuardResult =
  | { ok: true; absolute: string; relative: string; rootPath: string }
  | { ok: false; reason: GuardReason; detail?: string };

const FORBIDDEN_EXACT = new Set([".ssh", ".aws", ".gnupg", ".git", ".env", "id_rsa", "id_dsa", "id_ed25519"]);
const FORBIDDEN_SUFFIX = [".pem", ".key", ".keystore", ".kdbx"];
const FORBIDDEN_NAME_RE = /(^|[._-])(credentials?|secrets?)([._-]|$)/i;

/** True when one path segment may never be touched by a bridge tool. */
export function forbiddenPathSegment(segment: string): boolean {
  if (!segment) return false;
  const s = segment.toLowerCase();
  if (FORBIDDEN_EXACT.has(s)) return true;
  if (s === ".git" || s.startsWith(".git")) return true;
  if (s === ".env" || s.startsWith(".env") || s.endsWith(".env")) return true;
  if (s.startsWith("id_rsa")) return true;
  if (FORBIDDEN_SUFFIX.some((suffix) => s.endsWith(suffix))) return true;
  if (FORBIDDEN_NAME_RE.test(s)) return true;
  return false;
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Walk from the root's realpath down to the target, refusing at the first
 * symlink. The final component may legitimately not exist yet (new file).
 */
function walkWithoutSymlinks(rootReal: string, absolute: string): GuardResult {
  const rel = absolute.slice(rootReal.length);
  const segments = rel.split(sep).filter(Boolean);
  let cur = rootReal;
  for (let i = 0; i < segments.length; i++) {
    cur = cur + sep + segments[i];
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      // Missing intermediate: invalid for anything but the final component.
      if (i < segments.length - 1) return { ok: false, reason: "invalid", detail: "parent missing" };
      return { ok: true, absolute, relative: segments.join(sep), rootPath: rootReal };
    }
    if (st.isSymbolicLink()) return { ok: false, reason: "symlink", detail: cur };
  }
  return { ok: true, absolute, relative: segments.join(sep), rootPath: rootReal };
}

export type RootMode = "read" | "write" | "list";

/**
 * Resolve one caller-named path against the lease roots.
 *
 * `input` may be absolute (must fall inside a root) or relative to `cwd`.
 * The deepest matching root wins, and the mode must be granted by that root.
 */
export function resolveWithinRoots(
  roots: BridgeRoot[],
  cwd: string,
  input: string,
  mode: RootMode,
): GuardResult {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    return { ok: false, reason: "invalid" };
  }
  const lexical = isAbsolute(input) ? resolve(input) : resolve(cwd, input);

  // Deepest root that lexically contains the path and grants the mode.
  const candidates = roots
    .filter((r) => (mode === "write" ? r.write : r.read) && isWithin(lexical, r.path))
    .sort((a, b) => b.path.length - a.path.length);
  const root = candidates[0];
  if (!root) {
    return { ok: false, reason: mode === "write" ? "no-root-access" : "escape" };
  }

  const rel = lexical.slice(root.path.length).split(sep).filter(Boolean);
  if (rel.some((s) => s === "..")) return { ok: false, reason: "escape" };
  if (rel.some((s) => forbiddenPathSegment(s))) {
    return { ok: false, reason: "forbidden-name" };
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(root.path);
  } catch {
    return { ok: false, reason: "root-missing", detail: root.path };
  }
  if (rootReal !== root.path) {
    // The root itself moved (bind mount, symlinked checkout). Resolve the
    // target against the real root so prefix checks stay honest.
    const realLexical = rootReal + lexical.slice(root.path.length);
    return walkWithoutSymlinks(rootReal, realLexical);
  }
  return walkWithoutSymlinks(rootReal, lexical);
}

/** Guard one explicitly listed context path (instruction/skill/memory root). */
export function guardListedPath(path: string): GuardResult {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    return { ok: false, reason: "invalid" };
  }
  if (path.split(sep).some((s) => forbiddenPathSegment(s))) {
    return { ok: false, reason: "forbidden-name" };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, reason: "root-missing", detail: path };
  }
  if (real !== path) return { ok: false, reason: "symlink", detail: path };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, reason: "invalid", detail: "not a directory" };
  } catch {
    return { ok: false, reason: "root-missing" };
  }
  return { ok: true, absolute: path, relative: "", rootPath: path };
}

export interface ListEntry {
  path: string;
  type: "file" | "dir";
  bytes: number;
}

/** Bounded walk under `dir`, skipping forbidden segments, never following symlinks. */
export function listBounded(dir: string, maxEntries: number, maxDepth: number): ListEntry[] {
  const out: ListEntry[] = [];
  const walk = (current: string, depth: number): void => {
    if (out.length >= maxEntries || depth > maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= maxEntries) return;
      if (forbiddenPathSegment(name)) continue;
      const full = current + sep + name;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        out.push({ path: full, type: "dir", bytes: 0 });
        walk(full, depth + 1);
      } else if (st.isFile()) {
        out.push({ path: full, type: "file", bytes: st.size });
      }
    }
  };
  walk(dir, 1);
  return out;
}
