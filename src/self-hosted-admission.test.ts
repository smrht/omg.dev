// Issue 521 — self-hosted admission: separate schedule pool + transparent
// idle-reclaim at the interactive cap.
//
// On a self-hosted box (no Computer entitlement) the live-agent cap is the
// owner's own preference. Two failures this file pins:
//   1. A schedule launch was refused because INTERACTIVE residents filled the
//      cap — cron work starved by someone else's chat roster.
//   2. At the cap, the honest answer for the owner is to trade the oldest safe
//      idle durable session for the slot, not a 429 (issue #521 seam 1).
import { describe, expect, test } from "bun:test";
import {
  AgentAdmissionController,
  admissionResidentPool,
} from "./agent-admission.ts";

function sessionsOf(count: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: count }, () => ({ busy: false, ...extra }));
}

describe("self-hosted admission pools (issue 521)", () => {
  test("interactive and schedule launches count disjoint resident pools", () => {
    const sessions = [
      ...sessionsOf(12), // 12 interactive residents — the cap, fully used
      { busy: false, spawnedBy: "schedule" },
      { busy: false, spawnedBy: "schedule", launching: true },
      { persistent: true, spawnedBy: "bot" },
    ];
    // Interactive pool: schedule runs and persistent bots hold no slot.
    expect(admissionResidentPool("interactive", sessions)).toHaveLength(12);
    // Schedule pool: ONLY schedule runs count; interactive chatter is noise,
    // and a persistent bot never fills the schedule pool either.
    expect(admissionResidentPool("schedule", sessions)).toHaveLength(2);
  });

  test("a schedule launch is not refused because interactive residents hit the cap", () => {
    const admission = new AgentAdmissionController();
    const roster = sessionsOf(12); // self-hosted cap of 12, all interactive
    const scheduleLaunch = admission.tryAcquire(
      12,
      admissionResidentPool("schedule", roster),
    );
    expect(scheduleLaunch.ok).toBe(true);
    // And the interactive pool is still full for an interactive 13th launch.
    expect(admission.tryAcquire(12, admissionResidentPool("interactive", roster)).ok).toBe(
      false,
    );
  });
});

describe("transparent idle-reclaim at the interactive cap (issue 521)", () => {
  function inspectWith(state: { sessions: { busy: boolean }[] }) {
    return async () => ({ sessions: state.sessions });
  }

  test("a capped launch closes one idle session through reclaim and starts anyway", async () => {
    const admission = new AgentAdmissionController();
    const state = { sessions: sessionsOf(12) as { busy: boolean }[] };
    let reclaimed = 0;
    const reservation = await admission.acquire(
      12,
      inspectWith(state),
      async () => {
        state.sessions.pop(); // closeLiveSession removed the oldest resident
        reclaimed += 1;
        return 1;
      },
      { reclaimOnLimit: true },
    );
    expect(reservation.ok).toBe(true);
    if (reservation.ok) expect(reservation.reclaimed).toBe(1);
    expect(reclaimed).toBe(1);
    expect(state.sessions).toHaveLength(11);
  });

  test("without reclaimOnLimit the cap still refuses (preference, not a promise)", async () => {
    const admission = new AgentAdmissionController();
    const state = { sessions: sessionsOf(12) as { busy: boolean }[] };
    let reclaimCalls = 0;
    const reservation = await admission.acquire(
      12,
      inspectWith(state),
      async () => {
        reclaimCalls += 1;
        return 1;
      },
    );
    expect(reservation).toMatchObject({ ok: false, reason: "limit", resident: 12 });
    expect(reclaimCalls).toBe(0);
  });

  test("reclaim that frees nothing still refuses, with the cap reason", async () => {
    const admission = new AgentAdmissionController();
    // Nothing safe to close: every resident is busy.
    const state = { sessions: sessionsOf(12, { busy: true }) as { busy: boolean }[] };
    const reservation = await admission.acquire(
      12,
      inspectWith(state),
      async () => 0, // capReclaimCandidate found no safe idle session
      { reclaimOnLimit: true },
    );
    expect(reservation).toMatchObject({ ok: false, reason: "limit", resident: 12 });
  });

  test("the memory-pressure reclaim path keeps working without the flag", async () => {
    const admission = new AgentAdmissionController();
    const gib = 1024 ** 3;
    const budget = { availableBytes: 0.5 * gib, reserveBytes: 768 * 1024 ** 2, launchBytes: gib };
    let state = { sessions: [] as { busy: boolean }[], enforceMemory: true as boolean };
    let reclaimed = 0;
    const reservation = await admission.acquire(
      10,
      async () => ({ sessions: state.sessions, memory: budget, enforceMemory: state.enforceMemory }),
      async () => {
        reclaimed += 1;
        state = { ...state, enforceMemory: false }; // memory freed elsewhere
        return 1;
      },
    );
    expect(reservation.ok).toBe(true);
    expect(reclaimed).toBe(1);
  });
});
