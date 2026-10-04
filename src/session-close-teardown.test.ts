// Regression: POST /close on a command-file harness must actually stop its
// workers before any control-plane state is removed.
//
// Live smoke 2026-10-03: a contained harness (transient systemd unit
// lfg-agent-<name>.service) whose registry row said supervisor "tmux" hit the
// tmuxKillSession branch, no tmux session existed, and close still returned
// 200 after removing registry/cmd/roster — both bun harnesses stayed alive
// for 2+ minutes. These tests pin the three invariants of the fix:
//
//   1. terminateHarnessProcess stops ONLY the entry's own lfg-agent unit when
//      the harness pid's cgroup proves it; a foreign unit or an unreadable
//      identity on Linux signals nothing (fail closed).
//   2. closeLiveSession proves the harness exit BEFORE removing the registry
//      entry or command file; unprovable exit ⇒ 409 with everything intact.
//   3. A mac-hosted session's bridge lease is revoked strictly AFTER the
//      confirmed exit (own leased stdio children + durable lease).
//
// The supervisors here are real spawned processes; the systemd cgroup/stop
// layer is injected through setHarnessTerminateDepsForTests because darwin
// has no /proc or transient units — the hooks simulate exactly what the live
// Agentbox produces.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLiveSession } from "./commands/serve.ts";
import {
  cmdPath,
  isPidAlive,
  readEntry,
  setHarnessTerminateDepsForTests,
  terminateHarnessProcess,
  writeEntry,
  type AisdkEntry,
} from "./aisdk-registry.ts";
import { agentUnitName } from "./agent-unit-oom.ts";
import { PATHS } from "./config.ts";
import { MacBridgeHost, setMacBridgeHost } from "./mac-chat/bridge-host.ts";
import { persistPendingMacStart } from "./mac-chat/pending.ts";
import { resetResumeCacheConnectionForTests } from "./resume-cache.ts";
import type { Session } from "./sessions.ts";

const originalData = PATHS.data;
const KEY = "11111111-2222-4333-8444-555555555555";
const NAME = "lfg-closetest01";

let root = "";
const spawned: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-close-teardown-"));
  PATHS.data = join(root, "data");
  resetResumeCacheConnectionForTests();
});

afterEach(() => {
  for (const pid of spawned) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  spawned.length = 0;
  setHarnessTerminateDepsForTests(null);
  setMacBridgeHost(null);
  resetResumeCacheConnectionForTests();
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

// A real child that dies on SIGTERM (the default disposition), like a bun
// harness whose close command or force-stop signal is honoured.
function spawnObedientHarness(): number {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  spawned.push(child.pid!);
  return child.pid!;
}

// A real child that installs a SIGTERM handler and ignores it, like the live
// Claude harness that kept streaming mid-turn past its close command.
function spawnStuckHarness(): number {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  spawned.push(child.pid!);
  return child.pid!;
}

function harnessEntry(pid: number, over: Partial<AisdkEntry> = {}): AisdkEntry {
  const entry: AisdkEntry = {
    sessionId: KEY,
    harnessPid: pid,
    tmuxName: NAME,
    supervisor: "tmux", // the live shape: contained unit, mislabelled row
    cwd: root,
    model: "test-model",
    busy: false,
    createdAt: Date.now() - 60_000,
    ...over,
  };
  writeEntry(entry);
  return entry;
}

function sessionRow(pid: number, over: Partial<Session> = {}): Session {
  return {
    agent: "aisdk",
    runtime: "command-file",
    pid,
    cmd: "",
    cwd: root,
    project: "close-teardown",
    title: "close teardown test",
    lastUserText: null,
    sessionId: KEY,
    startedAt: Date.now() - 60_000,
    transcriptPath: null,
    lastActivityAt: Date.now() - 1_000,
    last: null,
    tmuxTarget: null,
    tmuxName: NAME,
    managed: true,
    assignedUser: null,
    model: null,
    status: "ok",
    statusReason: null,
    statusDetail: null,
    ...over,
  } as Session;
}

const OWN_CGROUP = `/lfg-agents.slice/lfg-agent-${NAME}.service`;
const OWN_UNIT = agentUnitName(NAME);

// Bounded async wait: a reaped child can lag a scheduler tick behind its
// signal, and a busy-wait cannot yield to let the runtime reap it.
async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(10);
  }
  return check();
}

// Deterministic "plain local harness": a readable cgroup with NO lfg-agent
// unit. Used instead of no hooks at all so the suite is platform- and
// environment-independent (a Linux runner itself inside an lfg-agent unit
// would otherwise show a foreign unit in the child's inherited cgroup).
const PLAIN_LOCAL_DEPS = { readCgroup: () => "" };

describe("terminateHarnessProcess safety", () => {
  test("stops exactly the entry's own unit when the pid's cgroup proves it", () => {
    const pid = spawnObedientHarness();
    const stoppedUnits: string[] = [];
    setHarnessTerminateDepsForTests({
      readCgroup: () => OWN_CGROUP,
      systemctlStop: (unit) => {
        stoppedUnits.push(unit);
        process.kill(pid, "SIGKILL"); // what a real stop does to the cgroup
        return 0;
      },
    });
    expect(terminateHarnessProcess(harnessEntry(pid))).toBe(true);
    expect(stoppedUnits).toEqual([OWN_UNIT]);
  });

  test("a pid inside a FOREIGN lfg-agent unit is never stopped and never signalled", () => {
    const pid = spawnObedientHarness();
    const stoppedUnits: string[] = [];
    setHarnessTerminateDepsForTests({
      readCgroup: () => "/lfg-agents.slice/lfg-agent-lfg-somebodyelse.service",
      systemctlStop: (unit) => {
        stoppedUnits.push(unit);
        return 0;
      },
    });
    expect(terminateHarnessProcess(harnessEntry(pid))).toBe(false);
    expect(stoppedUnits).toEqual([]);
    expect(isPidAlive(pid)).toBe(true); // no direct signal either
  });

  test("an alive pid with an unreadable cgroup fails closed (Linux reuse risk)", () => {
    const pid = spawnObedientHarness();
    setHarnessTerminateDepsForTests({ readCgroup: () => null });
    expect(terminateHarnessProcess(harnessEntry(pid))).toBe(false);
    expect(isPidAlive(pid)).toBe(true);
  });

  test("a dead pid needs no stop", async () => {
    const pid = spawnObedientHarness();
    process.kill(pid, "SIGKILL");
    expect(await waitUntil(() => !isPidAlive(pid))).toBe(true);
    setHarnessTerminateDepsForTests({ readCgroup: () => null });
    expect(terminateHarnessProcess(harnessEntry(pid))).toBe(true);
  });

  test("plain local baseline: no containment, SIGTERM reaches the harness", async () => {
    const pid = spawnObedientHarness();
    setHarnessTerminateDepsForTests(PLAIN_LOCAL_DEPS);
    expect(terminateHarnessProcess(harnessEntry(pid, { supervisor: "process" }))).toBe(true);
    expect(await waitUntil(() => !isPidAlive(pid))).toBe(true);
  });
});

describe("closeLiveSession harness teardown", () => {
  test("contained harness with supervisor 'tmux': own unit stopped, exit proven, registry removed", async () => {
    const pid = spawnObedientHarness();
    harnessEntry(pid, { supervisor: "tmux" });
    const stoppedUnits: string[] = [];
    setHarnessTerminateDepsForTests({
      readCgroup: () => OWN_CGROUP,
      systemctlStop: (unit) => {
        stoppedUnits.push(unit);
        process.kill(pid, "SIGKILL"); // the real stop reaps the cgroup
        return 0;
      },
    });
    const outcome = await closeLiveSession(sessionRow(pid), KEY, { source: "test" });
    expect(outcome).toEqual({ ok: true, mode: "harness" });
    expect(stoppedUnits).toEqual([OWN_UNIT]);
    expect(readEntry(KEY)).toBeNull();
    expect(existsSync(cmdPath(KEY))).toBe(false);
  });

  // ~5.4s of real waits (300ms graceful + 5s proof window) — over bun's
  // default per-test timeout, hence the explicit budget.
  test("stuck harness: 409, registry entry AND command file intact, nothing removed early", async () => {
    const pid = spawnStuckHarness();
    harnessEntry(pid, { supervisor: "tmux" });
    const revoked: string[] = [];
    setMacBridgeHost({
      revoke: (key: string) => revoked.push(key),
    } as unknown as MacBridgeHost);
    setHarnessTerminateDepsForTests({
      readCgroup: () => OWN_CGROUP,
      systemctlStop: () => 0, // stop claims success but the process survives
    });
    const outcome = await closeLiveSession(sessionRow(pid), KEY, { source: "test" });
    expect(outcome).toEqual({ ok: false, status: 409, reason: "Harness reageert niet op afsluiten; sessie blijft geregistreerd" });
    expect(isPidAlive(pid)).toBe(true); // negative control: it really survived
    expect(readEntry(KEY)).not.toBeNull(); // registry not removed
    expect(existsSync(cmdPath(KEY))).toBe(true); // cmd file not removed
    expect(revoked).toEqual([]); // lease not revoked before confirmed exit
  }, 15_000);

  test("plain local baseline close: SIGTERM path, entry removed, ok", async () => {
    const pid = spawnObedientHarness();
    harnessEntry(pid, { supervisor: "process" });
    setHarnessTerminateDepsForTests(PLAIN_LOCAL_DEPS);
    const outcome = await closeLiveSession(sessionRow(pid), KEY, { source: "test" });
    expect(outcome).toEqual({ ok: true, mode: "harness" });
    expect(isPidAlive(pid)).toBe(false);
    expect(readEntry(KEY)).toBeNull();
    expect(existsSync(cmdPath(KEY))).toBe(false);
  });

  test("mac session: lease revoked exactly once, strictly after the harness died", async () => {
    const pid = spawnObedientHarness();
    harnessEntry(pid, { supervisor: "process", executionHost: "mac" });
    const revokes: { key: string; harnessAliveAtRevoke: boolean }[] = [];
    setMacBridgeHost({
      revoke: (key: string) => revokes.push({ key, harnessAliveAtRevoke: isPidAlive(pid) }),
    } as unknown as MacBridgeHost);
    setHarnessTerminateDepsForTests(PLAIN_LOCAL_DEPS);
    const outcome = await closeLiveSession(sessionRow(pid, { executionHost: "mac" }), KEY, { source: "test" });
    expect(outcome).toEqual({ ok: true, mode: "harness" });
    expect(revokes).toEqual([{ key: KEY, harnessAliveAtRevoke: false }]);
  });

  test("mac session: a real MacBridgeHost durable lease and its stdio specs are released", async () => {
    const pid = spawnObedientHarness();
    harnessEntry(pid, { supervisor: "process", executionHost: "mac" });
    setHarnessTerminateDepsForTests(PLAIN_LOCAL_DEPS);
    const host = new MacBridgeHost({
      bindAddress: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:1",
      trustedUpstreamHosts: [],
      log: () => {},
    });
    const leaseId = `mac-${KEY}`;
    const stdioKey = `${leaseId}|testdaemon`;
    host.mintLease({
      sessionId: KEY,
      provider: "claude",
      cwd: root,
      roots: [{ path: root, read: true, write: true }],
      instructions: [],
      skillRoots: [],
      memoryRoots: [],
      namespaceMap: {
        targets: {},
        stdioSpecs: { [stdioKey]: { name: "testdaemon", key: stdioKey, command: "/bin/sleep", args: ["60"], env: {} } },
        mcpNames: ["workspace", "testdaemon"],
        provider: "claude",
      },
    });
    const leaseFile = join(PATHS.data, "mac-chat-leases", `${leaseId}.json`);
    expect(existsSync(leaseFile)).toBe(true);
    expect(host.registry.lookup(leaseId, Date.now())).toBeDefined();
    setMacBridgeHost(host);
    const outcome = await closeLiveSession(sessionRow(pid, { executionHost: "mac" }), KEY, { source: "test" });
    expect(outcome).toEqual({ ok: true, mode: "harness" });
    await Bun.sleep(50); // revoke's stdio close is fire-and-forget
    expect(existsSync(leaseFile)).toBe(false);
    expect(host.registry.lookup(leaseId, Date.now())).toBeUndefined();
  });

  // Live 2026-10-04 (codex fc8bb1c6): the mac launcher's remote-start journal
  // <sid>.macstart.json shares data/aisdk, carries the same sessionId and no
  // harnessPid. The registry blind-cast it, findEntryByAnyId — called with the
  // CONTROL-PLANE key, which the journal also claims — picked the journal over
  // the real entry, close saw "no live pid", removed the registry and
  // returned 200 in 194ms while the real harness, lease and 7 stdio children
  // stayed alive. Journal staged FIRST, close by the session key: the live
  // shape. (The registry-level order-independent discriminators live in
  // src/aisdk-registry-sidecar.test.ts.)
  test("codex shape: journal sidecar cannot shadow the real entry on close", async () => {
    const pid = spawnObedientHarness();
    const thread = "44444444-5555-4666-8777-888888888888";
    const pending = persistPendingMacStart({
      sessionId: KEY,
      requestId: "13131313-3535-4575-8787-919191919191",
      contractSha256: "c".repeat(64),
    });
    expect(pending.ok).toBe(true);
    harnessEntry(pid, { supervisor: "tmux", agent: "codex", threadId: thread, executionHost: "mac" });
    const stoppedUnits: string[] = [];
    setHarnessTerminateDepsForTests({
      readCgroup: () => OWN_CGROUP,
      systemctlStop: (unit) => {
        stoppedUnits.push(unit);
        process.kill(pid, "SIGKILL"); // the real stop reaps the cgroup
        return 0;
      },
    });
    const revokes: { key: string; alive: boolean }[] = [];
    setMacBridgeHost({
      revoke: (key: string) => revokes.push({ key, alive: isPidAlive(pid) }),
    } as unknown as MacBridgeHost);
    const outcome = await closeLiveSession(sessionRow(pid), KEY, { source: "test" });
    expect(outcome).toEqual({ ok: true, mode: "harness" });
    expect(stoppedUnits).toEqual([OWN_UNIT]);
    expect(revokes).toEqual([{ key: KEY, alive: false }]);
    expect(readEntry(KEY)).toBeNull();
    expect(existsSync(cmdPath(KEY))).toBe(false);
    expect(await waitUntil(() => !isPidAlive(pid))).toBe(true);
  });

  // Missing/truncated registry (writeEntry is a plain non-atomic
  // writeFileSync): with ONLY the sidecar journal and no main entry, the row's
  // harness pid is still alive. Close must fail closed — 409, nothing
  // removed, nothing synthesized, no lease revoke, no blind kill.
  test("missing registry entry with live harness: 409, control plane retained", async () => {
    const pid = spawnObedientHarness();
    const pending = persistPendingMacStart({
      sessionId: KEY,
      requestId: "14141414-3636-4585-8787-929292929292",
      contractSha256: "d".repeat(64),
    });
    expect(pending.ok).toBe(true); // journal present, NO main entry
    const revokes: string[] = [];
    setMacBridgeHost({
      revoke: (key: string) => revokes.push(key),
    } as unknown as MacBridgeHost);
    setHarnessTerminateDepsForTests({
      readCgroup: () => OWN_CGROUP,
      systemctlStop: () => {
        throw new Error("no entry ⇒ no unit stop may be attempted");
      },
    });
    const outcome = await closeLiveSession(sessionRow(pid), KEY, { source: "test" });
    expect(outcome).toEqual({ ok: false, status: 409, reason: "Registratierecord ontbreekt maar de agent draait nog — sessie blijft geregistreerd" });
    expect(isPidAlive(pid)).toBe(true); // negative control: nothing killed it
    expect(readEntry(KEY)).toBeNull(); // nothing synthesized
    expect(existsSync(join(PATHS.data, "aisdk", `${KEY}.json`))).toBe(false);
    expect(existsSync(cmdPath(KEY))).toBe(false); // not even appended
    expect(revokes).toEqual([]); // lease untouched
    expect(existsSync(join(PATHS.data, "aisdk", `${KEY}.macstart.json`))).toBe(true); // sidecar intact
  });
});
