import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedWorkerCapacityReason } from "./omg-isolation-runtime.ts";
import {
  AgentAdmissionController,
  NO_AGENT_LIMIT,
  agentLaunchMemoryBudget,
} from "./agent-admission.ts";
import {
  AGENTBOX_BACKGROUND_RESERVE_BYTES,
  AGENTBOX_INTERACTIVE_RESERVE_BYTES,
  AGENTBOX_LAUNCH_BYTES,
  agentboxMemoryBudget,
  agentboxPressureVerdict,
  agentboxResourceGate,
  agentboxResourcePolicyConfigured,
  readAgentboxResourceState,
  agentboxAdmissionMemory,
  AgentboxResourceRefusal,
  type AgentboxResourceStateV1,
} from "./agentbox-resource-admission.ts";

const GIB = 1024 ** 3;

test("scheduled backends defer while thread replies retain interactive capacity", () => {
  withStateFile(JSON.stringify(state({ host: { availableBytes: 6 * GIB } })), (file) => {
    expect(sharedWorkerCapacityReason("auto", { stateFile: file, freshAvailableBytes: 6 * GIB, pending: 0 })).not.toBeNull();
    expect(sharedWorkerCapacityReason("chat", { stateFile: file, freshAvailableBytes: 6 * GIB, pending: 0 })).toBeNull();
    expect(sharedWorkerCapacityReason("chat", { stateFile: file, freshAvailableBytes: 6 * GIB, pending: 2 })).not.toBeNull();
  });
});

test("a queued admission reads changed pressure inside its serialized inspect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "resource-race-"));
  const file = join(dir, "state.json");
  let unblock!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { unblock = r; });
  const started = new Promise<void>((r) => { entered = r; });
  const controller = new AgentAdmissionController();
  try {
    writeFileSync(file, JSON.stringify(state()));
    const first = controller.acquire(NO_AGENT_LIMIT, async () => {
      entered(); await waiting;
      return { sessions: [], memory: agentboxAdmissionMemory("interactive", { stateFile: file, freshAvailableBytes: 20 * GIB }) };
    });
    const firstResult = first.catch((e) => e);
    await started;
    const second = controller.acquire(NO_AGENT_LIMIT, async () => ({
      sessions: [], memory: agentboxAdmissionMemory("interactive", { stateFile: file, freshAvailableBytes: 20 * GIB }),
    }));
    const secondResult = second.catch((e) => e);
    writeFileSync(file, JSON.stringify(state({ host: { psiFullAvg10: 25 } })));
    unblock();
    expect(await firstResult).toBeInstanceOf(AgentboxResourceRefusal);
    expect(await secondResult).toBeInstanceOf(AgentboxResourceRefusal);
    expect(controller.reserved).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory refusal cannot trigger ordinary-session reclamation under shared policy", async () => {
  const controller = new AgentAdmissionController();
  let reclaimed = 0;
  const result = await controller.acquire(NO_AGENT_LIMIT,
    async () => ({ sessions: [], memory: { availableBytes: GIB, reserveBytes: 4 * GIB, launchBytes: GIB } }),
    async () => { reclaimed++; return 1; }, { reclaimOnMemory: false, reclaimOnLimit: true });
  expect(result).toMatchObject({ ok: false, reason: "memory" });
  expect(reclaimed).toBe(0);
  expect(controller.reservedBytes).toBe(0);
});

test("invalid host and cgroup metrics fail closed without echoing file contents", () => {
  for (const patch of [state({ host: { availableBytes: 40 * GIB } }), state({ host: { psiFullAvg10: 101 } }), state({ host: { totalBytes: 0 } })]) {
    withStateFile(JSON.stringify(patch), (file) => expect(readAgentboxResourceState({ stateFile: file }).status).toBe("invalid"));
  }
  withStateFile('TOP_SECRET_NOT_A_POLICY', (file) => {
    const result = readAgentboxResourceState({ stateFile: file });
    expect(result.status).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET_NOT_A_POLICY");
  });
});

function state(overrides?: {
  measuredAtEpochMs?: number;
  host?: Partial<AgentboxResourceStateV1["host"]>;
  slices?: Partial<AgentboxResourceStateV1["slices"]>;
}): AgentboxResourceStateV1 {
  const now = Date.now();
  const slice = (name: string) => ({
    path: `/sys/fs/cgroup/${name}.slice`,
    memoryCurrent: 1,
    memoryHigh: null,
    memoryMax: null,
    psiFullAvg10: 0,
    ...(overrides?.slices?.[name as keyof AgentboxResourceStateV1["slices"]] ?? {}),
  });
  return {
    version: 1,
    measuredAtEpochMs: overrides?.measuredAtEpochMs ?? now,
    host: { totalBytes: 32 * GIB, availableBytes: 20 * GIB, psiFullAvg10: 0, ...overrides?.host },
    slices: { computer: slice("computer"), agents: slice("agents"), control: slice("control") },
  };
}

function withStateFile(body: string, run: (file: string, dir: string) => void | Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-admission-"));
  const file = join(dir, "state.json");
  writeFileSync(file, body);
  try {
    return run(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("agentbox resource state reading", () => {
  test("unset variable is unconfigured and the policy is off (Mac/default untouched)", () => {
    expect(readAgentboxResourceState({ env: {} })).toEqual({ status: "unconfigured" });
    expect(agentboxResourcePolicyConfigured({})).toBe(false);
    expect(agentboxResourcePolicyConfigured({ AGENTBOX_RESOURCE_STATE: "  " })).toBe(false);
    expect(
      agentboxResourceGate("interactive", { env: {}, freshAvailableBytes: 0 }),
    ).toEqual({ status: "off" });
  });

  test("reads and validates a well-formed version 1 state", () => {
    withStateFile(JSON.stringify(state()), (file) => {
      const reading = readAgentboxResourceState({ env: { AGENTBOX_RESOURCE_STATE: file } });
      expect(reading.status).toBe("configured");
    });
  });

  test("missing file fails closed as unreadable", () => {
    const reading = readAgentboxResourceState({
      env: { AGENTBOX_RESOURCE_STATE: "/nonexistent/agentbox-state.json" },
    });
    expect(reading).toMatchObject({ status: "invalid", reason: "unreadable" });
  });

  test("malformed states fail closed: bad JSON, wrong version, bad numbers, missing slice", () => {
    const cases = [
      "{not json",
      JSON.stringify({ ...state(), version: 2 }),
      JSON.stringify({ ...state(), host: { ...state().host, availableBytes: -1 } }),
      JSON.stringify({ ...state(), slices: { ...state().slices, agents: { path: "a", memoryCurrent: "lots", memoryHigh: null, memoryMax: null, psiFullAvg10: 0 } } }),
      JSON.stringify({ ...state(), slices: { computer: state().slices.computer, control: state().slices.control } }),
      JSON.stringify({ ...state(), measuredAtEpochMs: "yesterday" }),
    ];
    for (const body of cases) {
      withStateFile(body, (file) => {
        expect(
          readAgentboxResourceState({ env: { AGENTBOX_RESOURCE_STATE: file } }),
        ).toMatchObject({ status: "invalid", reason: "malformed" });
      });
    }
  });

  test("null memoryHigh/memoryMax mean unlimited and stay valid", () => {
    const unlimited = state();
    unlimited.slices.agents.memoryHigh = null;
    unlimited.slices.agents.memoryMax = null;
    withStateFile(JSON.stringify(unlimited), (file) => {
      expect(
        readAgentboxResourceState({ env: { AGENTBOX_RESOURCE_STATE: file } }),
      ).toMatchObject({ status: "configured" });
    });
  });

  test("freshness: 45s old is the last acceptable age, 46s is stale", () => {
    const now = Date.now();
    withStateFile(JSON.stringify(state({ measuredAtEpochMs: now - 45_000 })), (file) => {
      expect(
        readAgentboxResourceState({ env: { AGENTBOX_RESOURCE_STATE: file }, nowMs: now }),
      ).toMatchObject({ status: "configured" });
    });
    withStateFile(JSON.stringify(state({ measuredAtEpochMs: now - 45_001 })), (file) => {
      expect(
        readAgentboxResourceState({ env: { AGENTBOX_RESOURCE_STATE: file }, nowMs: now }),
      ).toMatchObject({ status: "invalid", reason: "stale" });
    });
  });

  test("future dating: 5s ahead is tolerated, 6s ahead is rejected", () => {
    const now = Date.now();
    withStateFile(JSON.stringify(state({ measuredAtEpochMs: now + 5_000 })), (file) => {
      expect(
        readAgentboxResourceState({ env: { AGENTBOX_RESOURCE_STATE: file }, nowMs: now }),
      ).toMatchObject({ status: "configured" });
    });
    withStateFile(JSON.stringify(state({ measuredAtEpochMs: now + 6_000 })), (file) => {
      expect(
        readAgentboxResourceState({ env: { AGENTBOX_RESOURCE_STATE: file }, nowMs: now }),
      ).toMatchObject({ status: "invalid", reason: "future" });
    });
  });
});

describe("agentbox memory budget", () => {
  test("interactive reserves 4 GiB, background 6 GiB, launch is 1 GiB", () => {
    const snapshot = state();
    const interactive = agentboxMemoryBudget("interactive", snapshot, 99 * GIB);
    const schedule = agentboxMemoryBudget("schedule", snapshot, 99 * GIB);
    const bot = agentboxMemoryBudget("bot", snapshot, 99 * GIB);
    expect(interactive.reserveBytes).toBe(AGENTBOX_INTERACTIVE_RESERVE_BYTES);
    expect(interactive.reserveBytes).toBe(4 * GIB);
    expect(schedule.reserveBytes).toBe(AGENTBOX_BACKGROUND_RESERVE_BYTES);
    expect(bot.reserveBytes).toBe(6 * GIB);
    expect(bot.launchBytes).toBe(AGENTBOX_LAUNCH_BYTES);
    expect(bot.launchBytes).toBe(GIB);
  });

  test("effective availability is the minimum of fresh /proc reading and snapshot", () => {
    const snapshot = state({ host: { availableBytes: 20 * GIB } });
    expect(agentboxMemoryBudget("interactive", snapshot, 8 * GIB).availableBytes).toBe(8 * GIB);
    expect(agentboxMemoryBudget("interactive", snapshot, 30 * GIB).availableBytes).toBe(20 * GIB);
  });
});

describe("agentbox pressure verdict", () => {
  test("interactive refuses at PSI full avg10 >= 20, passes just under", () => {
    expect(agentboxPressureVerdict("interactive", state({ host: { psiFullAvg10: 19.9 } })).refused)
      .toBe(false);
    const refused = agentboxPressureVerdict("interactive", state({ host: { psiFullAvg10: 20 } }));
    expect(refused.refused).toBe(true);
    if (refused.refused) expect(refused.threshold).toBe(20);
  });

  test("background schedule/bot refuse at >= 10, pass just under", () => {
    expect(agentboxPressureVerdict("schedule", state({ host: { psiFullAvg10: 9.9 } })).refused)
      .toBe(false);
    expect(agentboxPressureVerdict("bot", state({ host: { psiFullAvg10: 10 } })).refused)
      .toBe(true);
  });

  test("a pressured cgroup slice refuses even with a healthy host", () => {
    const s = state({ slices: { agents: { path: "/sys/fs/cgroup/agent-batch.slice", memoryCurrent: 5 * GIB, memoryHigh: 6 * GIB, memoryMax: 6 * GIB, psiFullAvg10: 14.2 } } });
    expect(agentboxPressureVerdict("interactive", s).refused).toBe(false);
    const verdict = agentboxPressureVerdict("schedule", s);
    expect(verdict.refused).toBe(true);
    if (verdict.refused) {
      expect(verdict.readings.map((r) => r.source)).toContain("agents");
    }
  });

  test("computer and control slices are also checked", () => {
    for (const name of ["computer", "control"] as const) {
      const s = state({ slices: { [name]: { path: "/x", memoryCurrent: 0, memoryHigh: null, memoryMax: null, psiFullAvg10: 25 } } });
      expect(agentboxPressureVerdict("interactive", s).refused).toBe(true);
    }
  });
});

describe("agentbox resource gate", () => {
  test("healthy state allows and carries the enforced budget", () => {
    withStateFile(JSON.stringify(state({ host: { availableBytes: 12 * GIB } })), (file) => {
      const env = { AGENTBOX_RESOURCE_STATE: file };
      expect(agentboxResourcePolicyConfigured(env)).toBe(true);
      const gate = agentboxResourceGate("interactive", { env, freshAvailableBytes: 10 * GIB });
      expect(gate.status).toBe("allow");
      if (gate.status === "allow") {
        expect(gate.memory.availableBytes).toBe(10 * GIB);
        expect(gate.memory.reserveBytes).toBe(4 * GIB);
      }
    });
  });

  test("refusals are 429 resource_pressure with retry copy, no close/upgrade advice", () => {
    const cases: Array<ReturnType<typeof state>> = [
      state({ host: { psiFullAvg10: 31 } }),
      state({ measuredAtEpochMs: Date.now() - 60_000 }),
    ];
    const now = Date.now();
    for (const snapshot of cases) {
      withStateFile(JSON.stringify(snapshot), (file) => {
        const gate = agentboxResourceGate("interactive", {
          env: { AGENTBOX_RESOURCE_STATE: file },
          nowMs: now,
          freshAvailableBytes: 10 * GIB,
        });
        expect(gate.status).toBe("refused");
        if (gate.status === "refused") {
          expect(gate.code).toBe("resource_pressure");
          expect(gate.message).toMatch(/retry/i);
          expect(gate.message).not.toMatch(/close an agent/i);
          expect(gate.message).not.toMatch(/upgrade/i);
        }
      });
    }
  });

  test("unreadable/malformed/stale/future states all refuse (fail closed)", () => {
    const now = Date.now();
    const bodies = [
      "{broken",
      JSON.stringify(state({ host: { ...state().host, totalBytes: -5 } })),
      JSON.stringify(state({ measuredAtEpochMs: now - 120_000 })),
      JSON.stringify(state({ measuredAtEpochMs: now + 60_000 })),
    ];
    for (const body of bodies) {
      withStateFile(body, (file) => {
        expect(
          agentboxResourceGate("schedule", {
            env: { AGENTBOX_RESOURCE_STATE: file },
            nowMs: now,
            freshAvailableBytes: 10 * GIB,
          }).status,
        ).toBe("refused");
      });
    }
  });
});

describe("admission controller under the agentbox policy", () => {
  test("count-only path enforces memory when the policy supplies the budget", () => {
    const controller = new AgentAdmissionController();
    // Exactly one interactive launch fits: 5 GiB available, 4 + 1 required.
    const memory = { availableBytes: 5 * GIB, reserveBytes: 4 * GIB, launchBytes: GIB };
    const first = controller.tryAcquire(8, [], memory, { enforceMemory: true });
    expect(first.ok).toBe(true);
    const second = controller.tryAcquire(8, [], memory, { enforceMemory: true });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "memory") {
      expect(second.requiredBytes).toBe(5 * GIB);
      expect(second.availableBytes).toBe(4 * GIB);
    }
    if (first.ok) first.release();
    const retry = controller.tryAcquire(8, [], memory, { enforceMemory: true });
    expect(retry.ok).toBe(true);
    if (retry.ok) retry.release();
  });

  test("cap 0 under a configured policy still gates via NO_AGENT_LIMIT and books a reservation", () => {
    const controller = new AgentAdmissionController();
    // Healthy budget: admitted despite "unlimited" count...
    const healthy = { availableBytes: 12 * GIB, reserveBytes: 6 * GIB, launchBytes: GIB };
    const ok = controller.tryAcquire(NO_AGENT_LIMIT, [], healthy, { enforceMemory: true });
    expect(ok.ok).toBe(true);
    expect(controller.reservedBytes).toBe(GIB);
    if (ok.ok) ok.release();
    // ...and refused when the shared box is full. Unlimited count must not be
    // a zero-reservation bypass.
    const tight = { availableBytes: 5 * GIB, reserveBytes: 6 * GIB, launchBytes: GIB };
    const refused = controller.tryAcquire(NO_AGENT_LIMIT, [], tight, { enforceMemory: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("memory");
    expect(controller.reservedBytes).toBe(0);
  });

  test("pending reservations stay atomic across serialized acquires", async () => {
    const controller = new AgentAdmissionController();
    const memory = { availableBytes: 5 * GIB, reserveBytes: 4 * GIB, launchBytes: GIB };
    const inspect = async () => ({ sessions: [] as [], memory, enforceMemory: true as const });
    const [a, b] = await Promise.all([
      controller.acquire(NO_AGENT_LIMIT, inspect),
      controller.acquire(NO_AGENT_LIMIT, inspect),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    if (a.ok) a.release();
    if (b.ok) b.release();
    const retry = await controller.acquire(NO_AGENT_LIMIT, inspect);
    expect(retry.ok).toBe(true);
    if (retry.ok) retry.release();
  });

  test("off-policy (Mac/default) semantics unchanged: budget shape and account-without-refusal", () => {
    // The upstream budget is untouched: 10% reserve with a 768 MiB floor, 1 GiB launch.
    const budget = agentLaunchMemoryBudget(16 * GIB, 15 * GIB);
    expect(budget.reserveBytes).toBe(Math.ceil((16 * GIB) * 0.1));
    expect(budget.launchBytes).toBe(GIB);
    // A count-capped self-hosted launch without the policy still accounts the
    // reservation without refusing on a shortfall.
    const controller = new AgentAdmissionController();
    const scarce = { availableBytes: 0, reserveBytes: budget.reserveBytes, launchBytes: GIB };
    const admitted = controller.tryAcquire(4, [], scarce, { enforceMemory: false });
    expect(admitted.ok).toBe(true);
    expect(controller.reservedBytes).toBe(GIB);
    if (admitted.ok) admitted.release();
  });
});
