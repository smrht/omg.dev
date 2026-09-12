import type { ShipProvenance } from './ship-provenance.ts';

// Explicit result commits scope the dirty check in a shared checkout. The
// unscoped collector retains its original semantics for automatic fix landing.
export function collectCommittedShipProvenance(
  managed: { cwd?: string; worktreeBranch?: string } | undefined,
  refs: unknown,
): ShipProvenance {
  if (!managed?.cwd || !Array.isArray(refs) || !refs.length || refs.length > 100 ||
      refs.some(ref => typeof ref !== 'string' || !/^[a-f0-9]{7,40}$/i.test(ref))) {
    throw new Error('commitRefs requires 1-100 commit SHAs and a known session checkout');
  }
  function git(...args: string[]) {
    const result = Bun.spawnSync({ cmd: ['git', '-C', managed!.cwd!, ...args], stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(`Cannot verify ship commit evidence: git ${args[0]} failed`);
    return result.stdout.toString();
  }
  function ancestor(commit: string, target: string) {
    const result = Bun.spawnSync({ cmd: ['git', '-C', managed!.cwd!, 'merge-base', '--is-ancestor', commit, target], stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error('Cannot verify commit ancestry');
    return result.exitCode === 0;
  }
  git('fetch', '--quiet', 'origin', 'main');
  const main = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}').trim();
  const head = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
  const commits = [...new Set(refs.map(ref => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim()))];
  const paths = new Set<string>();
  let ahead = 0;
  for (const commit of commits) {
    if (!ancestor(commit, head)) throw new Error('Result commit is not in the session HEAD');
    if (!ancestor(commit, main)) ahead++;
    for (const path of git('diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', '--no-renames', '-z', commit).split('\0')) {
      if (path) paths.add(path);
    }
  }
  // -z preserves spaces/newlines in names. Rename/copy records carry both
  // destination and source paths; either can intersect the result commits.
  const entries = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0');
  let dirty = 0;
  let workspaceDirty = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    workspaceDirty++;
    const changed = [entry.slice(3)];
    if (/[RC]/.test(entry.slice(0, 2))) changed.push(entries[++i]);
    if (changed.some(path => paths.has(path))) dirty++;
  }
  return {
    state: dirty ? 'uncommitted' : ahead ? 'unlanded' : 'landed',
    branch: git('branch', '--show-current').trim() || managed.worktreeBranch,
    head: head.slice(0, 12), dirty, workspaceDirty, ahead,
    commits: commits.length, commitRefs: commits,
  };
}
