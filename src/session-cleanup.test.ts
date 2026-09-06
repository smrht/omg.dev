import { expect, test } from 'bun:test';
import { planCleanup, terminateTargets, cleanupFingerprint, createCleanupHandler } from './session-cleanup';
import { scanProcs, type ProcInfo, type SessionUsageRow } from './session-usage';
const sid = '11111111-1111-4111-8111-111111111111';
const proc = (pid: number, extra: Partial<ProcInfo> = {}): ProcInfo => ({ pid, ppid: 1, startTicks: 1, argv: ['worker'], env: { sessionId: sid, managedName: 'lfg-test' }, cwd: '/tmp/lfg-test', cgroup: '', ageSec: 1, rssBytes: 100, pssBytes: 100, ...extra });
const row = (pids = [10]): SessionUsageRow => ({ key: sid, sessionId: sid, managedName: 'lfg-test', title: 'Test', live: false, orphan: true, procs: pids.map(pid => ({ pid, component: 'other', label: 'worker', rssBytes: 100, pssBytes: 100, ageSec: 1 })), worktreePath: '/tmp/lfg-test' } as SessionUsageRow);
test('cwd alone, conflicting identities, shared services and listeners are protected', () => {
  for (const extra of [{ env: {} }, { env: { sessionId: 'other' } }, { argv: ['tmux'] }, { argv: ['chromium'] }, { cgroup: '/lfg-agent-other.service' }]) {
    expect(planCleanup(row(), [], [proc(10, extra)], new Set(), 999).targets[0]!.reason).not.toBeNull();
  }
  expect(planCleanup(row(), [], [proc(10)], new Set([10]), 999).targets[0]!.reason).not.toBeNull();
  expect(planCleanup(row(), [], [proc(10)], new Set(), 999).targets[0]!.reason).toBeNull();
});
test('protect listener parent and systemd cgroup peers, plus server ancestor', () => {
  const procs = [proc(10, { cgroup: '/lfg-agent-lfg-test.service' }), proc(11, { ppid: 10, cgroup: '/lfg-agent-lfg-test.service' }), proc(12, { cgroup: '/lfg-agent-lfg-test.service' })];
  expect(planCleanup(row([10, 11, 12]), [], procs, new Set([11]), 999).targets.every(t => t.reason)).toBe(true);
  expect(planCleanup(row(), [], [proc(10), proc(999, { ppid: 10 })], new Set(), 999).targets[0]!.reason).not.toBeNull();
});
test('other live owner using directory blocks cleanup and busy affects fingerprint', () => {
  expect(planCleanup(row(), [{ sessionId: 'other', tmuxName: 'lfg-other', cwd: '/tmp/lfg-test', pid: 44 }], [proc(10)], new Set()).targets[0]!.reason).not.toBeNull();
  const plan = planCleanup(row(), [], [proc(10)], new Set());
  expect(cleanupFingerprint(plan)).not.toBe(cleanupFingerprint({ ...plan, busy: true }));
});
test('preview does not signal; changed identity and replay are rejected', async () => {
  let ticks = 1, signals = 0;
  const handler = createCleanupHandler({ snapshot: async () => ({ rows: [row()], owners: [] }), inspect: async r => planCleanup(r, [], [proc(10, { startTicks: ticks })], new Set()), terminate: async () => { signals++; return []; }, close: async () => {}, refresh: async () => ({}) });
  const request = (body: unknown) => new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const p = await (await handler(request({ key: sid }), 'preview')).json() as { token: string };
  expect(signals).toBe(0); ticks++;
  expect((await handler(request({ token: p.token }), 'confirm')).status).toBe(409);
  expect((await handler(request({ token: p.token }), 'confirm')).status).toBe(409);
  expect(signals).toBe(0);
});
test('real pidfd stop: changed birth time cannot signal another process', async () => {
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    const p = (await scanProcs()).find(p => p.pid === child.pid)!;
    const target = { pid: child.pid, startTicks: p.startTicks, label: 'test', bytes: 1, reason: null };
    expect((await terminateTargets([{ ...target, startTicks: p.startTicks + 1 }]))[0]!.sent).toBe(false);
    expect(child.exitCode).toBeNull();
    expect((await terminateTargets([target]))[0]!.sent).toBe(true);
    await child.exited;
    expect(child.signalCode).toBe('SIGTERM');
  } finally { if (child.exitCode === null) child.kill(); }
});
test('real preview/confirm stops only isolated child and returns new measurement', async () => {
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore', env: { PATH: '/usr/bin', LFG_SESSION_ID: sid, AGENT_BROWSER_SESSION: 'lfg-test' } });
  try {
    const handler = createCleanupHandler({ snapshot: async () => ({ rows: [row([child.pid])], owners: [] }), close: async () => { throw new Error('orphan must not close live session'); }, refresh: async () => ({ verified: true }) });
    const request = (body: unknown) => new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const preview = await (await handler(request({ key: sid }), 'preview')).json() as { token: string; plan: ReturnType<typeof planCleanup> };
    expect(preview.plan.targets[0]!.reason).toBeNull();
    const response = await handler(request({ token: preview.token }), 'confirm');
    expect(response.status).toBe(200);
    const result = await response.json() as { stopped: number; remaining: number; usage: { verified: boolean } };
    expect(result.stopped).toBe(1); expect(result.remaining).toBe(0); expect(result.usage.verified).toBe(true);
  } finally { if (child.exitCode === null) child.kill(); }
});
test('a child of another live agent is protected even with stale matching labels', () => {
  const owners = [{ sessionId: 'other', tmuxName: 'lfg-other', cwd: '/other', pid: 44 }];
  const procs = [proc(44, { env: {} }), proc(10, { ppid: 44 })];
  expect(planCleanup(row(), owners, procs, new Set(), 999).targets[0]!.reason).toBe('Hoort bij een andere actieve sessie');
});
test('Chrome MCP client is not a shared Chrome browser', () => {
  const procs = [proc(10, { argv: ['chrome-devtools-mcp'] })];
  expect(planCleanup(row(), [], procs, new Set(), 999).targets[0]!.reason).toBeNull();
});
test('unowned child protects its parent and cgroup against indirect termination', () => {
  const group = '/lfg-agent-lfg-test.service';
  const procs = [proc(10, { cgroup: group }), proc(11, { ppid: 10, env: {}, cgroup: '' })];
  expect(planCleanup(row(), [], procs, new Set(), 999).targets[0]!.reason).not.toBeNull();
});
test('persistent bots and parents with live child sessions cannot close here', () => {
  const liveRow = { ...row(), live: true };
  const owner = { sessionId: sid, tmuxName: 'lfg-test', cwd: '/tmp/lfg-test', pid: 10, managed: true };
  expect(planCleanup(liveRow, [{ ...owner, persistent: true }], [proc(10)], new Set(), 999).blocked).toContain('Vaste bots');
  expect(planCleanup(liveRow, [owner, { sessionId: 'child', tmuxName: 'lfg-child', cwd: '/child', parentSessionId: sid }], [proc(10)], new Set(), 999).blocked).toContain('deelsessie');
});
