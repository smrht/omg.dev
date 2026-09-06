// Manual only. The usage report is accounting, never authority to kill.
import { readFile, readdir, readlink } from 'node:fs/promises';
import { scanProcs, type ProcInfo, type SessionUsageRow } from './session-usage';

export type CleanupTarget = { pid: number; startTicks: number; label: string; bytes: number; reason: string | null };
export type CleanupPlan = { key: string; sessionId: string | null; title: string; live: boolean; busy: boolean; targets: CleanupTarget[]; blocked: string | null };
type Owner = { sessionId: string | null; tmuxName: string | null; cwd: string | null; pid?: number; busy?: boolean; managed?: boolean; persistent?: boolean; botId?: string; sourceKind?: string; parentSessionId?: string | null; parentNativeSessionId?: string | null; nativeSessionId?: string | null };

const infrastructure = /^(systemd|tmux|tmux-server|sshd|init|login|dbus-daemon|chrome|chromium|chromium-browser|chrome_crashpad_handler|headless_shell|firefox|firefox-bin)$/;
const nameOf = (p: ProcInfo) => p.argv[0]?.split('/').pop() ?? '';

// Any listening TCP/UDP socket is conservatively shared. Failure to inspect
// sockets fails closed, including when a descriptor cannot be read.
async function listeningPids(procs: ProcInfo[]): Promise<Set<number>> {
  const inodes = new Set<string>();
  for (const table of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const rows = (await readFile(`/proc/net/${table}`, 'utf8')).trim().split('\n').slice(1);
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (table.startsWith('udp') || fields[3] === '0A') inodes.add(fields[9]!);
    }
  }
  const blocked = new Set<number>();
  await Promise.all(procs.map(async p => {
    try {
      const fds = await readdir(`/proc/${p.pid}/fd`);
      for (const fd of fds) {
        let link: string;
        try { link = await readlink(`/proc/${p.pid}/fd/${fd}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') blocked.add(p.pid); continue; }
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
        if (inode && inodes.has(inode)) blocked.add(p.pid);
      }
    } catch { blocked.add(p.pid); }
  }));
  return blocked;
}

export function planCleanup(row: SessionUsageRow, owners: Owner[], procs: ProcInfo[], listeners: Set<number>, serverPid = process.pid): CleanupPlan {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const owner = row.live ? owners.find(s => (row.sessionId && s.sessionId === row.sessionId) || (row.managedName && s.tmuxName === row.managedName)) : undefined;
  const selfAncestors = new Set<number>();
  for (let p = byPid.get(serverPid); p && !selfAncestors.has(p.pid); p = byPid.get(p.ppid)) selfAncestors.add(p.pid);
  selfAncestors.add(serverPid);
  const otherOwners = owners.filter(s => s !== owner);
  const protectedPids = new Set<number>();
  const ownerPids = new Map(owners.filter(s => s.pid).map(s => [s.pid!, s]));
  const belongsToOtherLiveOwner = (p: ProcInfo): boolean => {
    const seen = new Set<number>();
    for (let cursor: ProcInfo | undefined = p; cursor && !seen.has(cursor.pid); cursor = byPid.get(cursor.ppid)) {
      seen.add(cursor.pid);
      const liveOwner = ownerPids.get(cursor.pid);
      if (liveOwner) return liveOwner !== owner;
    }
    return false;
  };
  const exactScope = `/lfg-agent-${row.managedName}.service`;
  const inOwnedScope = (p: ProcInfo) => p.cgroup.endsWith(exactScope) || p.cgroup.includes(exactScope + '/');
  const strong = (p: ProcInfo): boolean => {
    // Conflicting identifiers win over matching ones. No cwd/argv fallback.
    const scope = /\/lfg-agent-([^/]+)\.service(?:\/|$)/.exec(p.cgroup)?.[1];
    if (scope && scope !== row.managedName) return false;
    if (p.env.managedName && p.env.managedName !== row.managedName) return false;
    if (p.env.sessionId && p.env.sessionId !== row.sessionId) return false;
    return !!((scope && scope === row.managedName) || (row.sessionId && p.env.sessionId === row.sessionId) || (row.managedName && p.env.managedName === row.managedName));
  };
  for (const p of procs) {
    if (!strong(p) || belongsToOtherLiveOwner(p) || selfAncestors.has(p.pid) || infrastructure.test(nameOf(p)) || listeners.has(p.pid) || otherOwners.some(s => s.pid === p.pid)) protectedPids.add(p.pid);
  }
  // A parent's termination (or its systemd MainPID exiting) can kill children
  // and cgroup peers. Protect those parents/scopes too, not just the leaf.
  const protectedScopes = new Set<string>();
  for (const pid of [...protectedPids]) {
    const original = byPid.get(pid);
    if (original && inOwnedScope(original)) protectedScopes.add(exactScope);
    const visited = new Set<number>();
    for (let p = original; p && !visited.has(p.pid); p = byPid.get(p.ppid)) {
      visited.add(p.pid); protectedPids.add(p.pid);
    }
  }
  const targets = row.procs.map(item => {
    const p = byPid.get(item.pid);
    let reason: string | null = null;
    if (!p || !p.startTicks) reason = 'Proces verdwenen of niet leesbaar';
    else if (!strong(p)) reason = 'Eigenaarschap niet bewezen';
    else if (belongsToOtherLiveOwner(p)) reason = 'Hoort bij een andere actieve sessie';
    else if (protectedPids.has(p.pid) || (protectedScopes.has(exactScope) && inOwnedScope(p))) reason = 'Gedeelde dienst, browser, netwerkserver of beschermde afhankelijkheid';
    else if (otherOwners.some(s => s.cwd && s.cwd === row.worktreePath)) reason = 'Werkmap wordt ook door een andere sessie gebruikt';
    return { pid: item.pid, startTicks: p?.startTicks ?? 0, label: item.component, bytes: item.pssBytes ?? item.rssBytes, reason };
  });
  let blocked: string | null = null;
  if (!row.managedName || !/^lfg-[a-zA-Z0-9-]+$/.test(row.managedName)) blocked = 'Geen exclusieve beheerde sessie';
  if (row.live && (!owner?.managed || !targets.some(t => t.pid === owner.pid && !t.reason))) blocked = 'De agent kan niet veilig worden afgesloten';
  if (row.live && targets.some(t => t.reason)) blocked = 'Deze sessie heeft beschermde processen; afsluiten is hier geblokkeerd';
  if (row.live && otherOwners.some(s => s.parentSessionId === row.sessionId || (owner?.nativeSessionId && s.parentNativeSessionId === owner.nativeSessionId))) blocked = "Deze sessie heeft nog een open deelsessie. Sluit die eerst af.";
  if (owner?.persistent || owner?.botId || owner?.sourceKind === "routine") blocked = "Vaste bots en routines beheer je bij hun eigen instellingen";
  return { key: row.key, sessionId: row.sessionId, title: row.title ?? row.managedName ?? row.key, live: row.live, busy: !!owner?.busy, targets, blocked };
}

export async function inspectCleanup(row: SessionUsageRow, owners: Owner[]) {
  const procs = await scanProcs();
  return planCleanup(row, owners, procs, await listeningPids(procs));
}

export function cleanupFingerprint(plan: CleanupPlan): string {
  return JSON.stringify([plan.key, plan.sessionId, plan.live, plan.busy, plan.blocked, plan.targets.map(t => [t.pid, t.startTicks, t.reason]).sort((a, b) => Number(a[0]) - Number(b[0]))]);
}

// Linux pidfds bind the signal to the actual process, even if its PID is reused
// between inspection and signalling. No shell, no argv/environ in output.
export async function terminateTargets(targets: CleanupTarget[]) {
  const child = Bun.spawn(['python3', '-c', `
import os, sys, json, signal
results=[]
for t in json.load(sys.stdin):
    fd=None
    try:
        fd=os.pidfd_open(t['pid'])
        with open('/proc/%s/stat'%t['pid']) as f: raw=f.read()
        ticks=int(raw[raw.rfind(')')+2:].split()[19])
        if ticks != t['startTicks']: raise ValueError('identity changed')
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        results.append({'pid':t['pid'],'sent':True})
    except Exception:
        results.append({'pid':t['pid'],'sent':False})
    finally:
        if fd is not None: os.close(fd)
print(json.dumps(results))
`], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(JSON.stringify(targets.filter(t => !t.reason)));
  child.stdin.end();
  const output = await new Response(child.stdout).text();
  if (await child.exited) throw new Error('Veilige processtop niet beschikbaar');
  return JSON.parse(output) as { pid: number; sent: boolean }[];
}

type CleanupSnapshot = { rows: SessionUsageRow[]; owners: Owner[] };
export function createCleanupHandler(deps: {
  snapshot: () => Promise<CleanupSnapshot>;
  inspect?: typeof inspectCleanup;
  terminate?: typeof terminateTargets;
  close: (sessionId: string, owner: Owner) => Promise<void>;
  refresh: () => Promise<unknown>;
}) {
  const plans = new Map<string, { fingerprint: string; key: string; expires: number }>();
  let stopping = false;
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  return async (req: Request, action: 'preview' | 'confirm') => {
    try {
      if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return reply({ error: "JSON vereist" }, 415);
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return reply({ error: 'Ongeldig verzoek' }, 400);
      for (const [key, value] of plans) if (value.expires < Date.now()) plans.delete(key);
      let key: string;
      let expected: string | undefined;
      if (action === 'confirm') {
        if (stopping) return reply({ error: 'Er wordt al een sessie gestopt' }, 409);
        const stored = typeof body.token === 'string' ? plans.get(body.token) : undefined;
        if (!stored) return reply({ error: 'Controle verlopen. Controleer opnieuw.' }, 409);
        plans.delete(body.token as string); // one use, including rejected confirmations
        key = stored.key; expected = stored.fingerprint;
      } else {
        if (typeof body.key !== 'string' || body.key.length > 200) return reply({ error: 'Ongeldige sessie' }, 400);
        key = body.key;
      }
      const snapshot = await deps.snapshot(); // roster failure must fail closed
      const row = snapshot.rows.find(r => r.key === key);
      if (!row) return reply({ error: 'Sessie niet meer in het overzicht. Vernieuw de meting.' }, 409);
      const plan = await (deps.inspect ?? inspectCleanup)(row, snapshot.owners);
      const fingerprint = cleanupFingerprint(plan);
      if (action === 'preview') {
        if (plans.size >= 200) plans.delete(plans.keys().next().value!);
        const token = crypto.randomUUID();
        plans.set(token, { fingerprint, key, expires: Date.now() + 60_000 });
        return reply({ plan, token });
      }
      if (expected !== fingerprint) return reply({ error: 'De sessie of processen zijn veranderd. Controleer opnieuw.' }, 409);
      if (plan.blocked || !plan.targets.some(t => !t.reason)) return reply({ error: plan.blocked ?? 'Geen veilig te stoppen processen' }, 409);
      // Another confirmation may have passed its first guard during the scan.
      if (stopping) return reply({ error: 'Er wordt al een sessie gestopt' }, 409);
      stopping = true;
      try {
        const signals = await (deps.terminate ?? terminateTargets)(plan.targets);
        await Bun.sleep(1200);
        const remaining = new Map((await scanProcs()).map(p => [p.pid, p.startTicks]));
        const stopped = plan.targets.filter(t => !t.reason && remaining.get(t.pid) !== t.startTicks);
        let closed = false;
        if (plan.live && plan.sessionId && stopped.some(t => t.pid === snapshot.owners.find(s => s.sessionId === plan.sessionId)?.pid)) {
          await deps.close(plan.sessionId, snapshot.owners.find(s => s.sessionId === plan.sessionId)!);
          closed = true;
        }
        const usage = await deps.refresh();
        return reply({ closed, stopped: stopped.length, requested: signals.filter(s => s.sent).length, remaining: plan.targets.filter(t => remaining.get(t.pid) === t.startTicks).length, releasedBytes: stopped.reduce((n, t) => n + t.bytes, 0), usage });
      } finally { stopping = false; }
    } catch {
      return reply({ error: 'Controle of afsluiten mislukt. Vernieuw het overzicht; er wordt niet hard gestopt.' }, 503);
    }
  };
}
