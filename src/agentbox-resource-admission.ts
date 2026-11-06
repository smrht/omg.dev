/**
 * Agentbox shared-memory admission policy (reviewed memory admission).
 *
 * A normal self-hosted launch — including a count-unlimited (`limit: 0`)
 * setting — must not bypass the box's configured shared-memory safety. When
 * `AGENTBOX_RESOURCE_STATE` points at the controller's state file, this module
 * is the single reader/validator for it; when the variable is unset, every
 * caller keeps the unchanged upstream semantics (Mac/default included).
 *
 * The state file is written by an external controller as JSON version 1:
 *
 *   { "version": 1,
 *     "measuredAtEpochMs": number,
 *     "host": { "totalBytes": number, "availableBytes": number, "psiFullAvg10": number },
 *     "slices": { "computer" | "agents" | "control": {
 *         "path": string, "memoryCurrent": number,
 *         "memoryHigh": number | null, "memoryMax": number | null,
 *         "psiFullAvg10": number } } }
 *
 * Every numeric value is finite and nonnegative; `memoryHigh`/`memoryMax` may
 * be null for an unlimited slice. Anything else is malformed, and a malformed,
 * unreadable, stale or future-dated state FAILS CLOSED: the launch is refused
 * with `resource_pressure` and a retry-later message, never admitted on a
 * guess, and never silently downgraded to the unmanaged path.
 */
import { readFileSync } from "node:fs";
import type { AgentMemoryBudget } from "./agent-admission.ts";

export const AGENTBOX_RESOURCE_STATE_ENV = "AGENTBOX_RESOURCE_STATE";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Kept free for the interactive surface (LFG, OS, tunnel) under policy. */
export const AGENTBOX_INTERACTIVE_RESERVE_BYTES = 4 * GIB;
/** Background schedule/bot launches must leave more headroom. */
export const AGENTBOX_BACKGROUND_RESERVE_BYTES = 6 * GIB;
/** What one admitted-but-not-yet-started launch books against the budget. */
export const AGENTBOX_LAUNCH_BYTES = GIB;

/** Any relevant PSI full-avg10 at or above this refuses a background launch. */
export const AGENTBOX_PSI_BACKGROUND_REFUSE = 10;
/** Any relevant PSI full-avg10 at or above this refuses an interactive launch. */
export const AGENTBOX_PSI_INTERACTIVE_REFUSE = 20;

/** A state older than this is stale and fails closed. */
export const AGENTBOX_STATE_MAX_AGE_MS = 45_000;
/** A state dated further into the future than this is rejected. */
export const AGENTBOX_STATE_FUTURE_TOLERANCE_MS = 5_000;

export type AgentboxResourceSlice = {
  path: string;
  memoryCurrent: number;
  memoryHigh: number | null;
  memoryMax: number | null;
  psiFullAvg10: number;
};

export type AgentboxResourceStateV1 = {
  version: 1;
  measuredAtEpochMs: number;
  host: { totalBytes: number; availableBytes: number; psiFullAvg10: number };
  slices: {
    computer: AgentboxResourceSlice;
    agents: AgentboxResourceSlice;
    control: AgentboxResourceSlice;
  };
};

export type AgentboxResourceReading =
  | { status: "configured"; state: AgentboxResourceStateV1 }
  | { status: "unconfigured" }
  | {
      status: "invalid";
      reason: "unreadable" | "malformed" | "stale" | "future";
      detail?: string;
    };

export type AgentboxLaunchKind = "interactive" | "schedule" | "bot";

export type AgentboxPressureReading = { source: string; psiFullAvg10: number };

export type AgentboxPressureVerdict =
  | { refused: false }
  | {
      refused: true;
      threshold: number;
      readings: AgentboxPressureReading[];
    };

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** null means "unlimited"; any other non-number is malformed. */
function limitOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (!finiteNonnegative(value)) return undefined;
  return value;
}

function parseSlice(name: string, raw: unknown): AgentboxResourceSlice | null {
  if (!raw || typeof raw !== "object") return null;
  const slice = raw as Record<string, unknown>;
  if (typeof slice.path !== "string" || !slice.path.startsWith("/sys/fs/cgroup/") || slice.path.split("/").includes("..")) return null;
  if (!finiteNonnegative(slice.memoryCurrent)) return null;
  const memoryHigh = limitOrNull(slice.memoryHigh);
  if (memoryHigh === undefined) return null;
  const memoryMax = limitOrNull(slice.memoryMax);
  if (memoryMax === undefined) return null;
  if (!finiteNonnegative(slice.psiFullAvg10) || slice.psiFullAvg10 > 100) return null;
  return {
    path: slice.path,
    memoryCurrent: slice.memoryCurrent,
    memoryHigh,
    memoryMax,
    psiFullAvg10: slice.psiFullAvg10,
  };
}

function parseState(source: string): AgentboxResourceStateV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) return null;
  if (!finiteNonnegative(root.measuredAtEpochMs)) return null;
  const host = root.host;
  if (!host || typeof host !== "object") return null;
  const hostFields = host as Record<string, unknown>;
  if (!finiteNonnegative(hostFields.totalBytes) || hostFields.totalBytes === 0) return null;
  if (!finiteNonnegative(hostFields.availableBytes)) return null;
  if (hostFields.availableBytes > hostFields.totalBytes) return null;
  if (!finiteNonnegative(hostFields.psiFullAvg10) || hostFields.psiFullAvg10 > 100) return null;
  const slices = root.slices;
  if (!slices || typeof slices !== "object") return null;
  const sliceFields = slices as Record<string, unknown>;
  const computer = parseSlice("computer", sliceFields.computer);
  const agents = parseSlice("agents", sliceFields.agents);
  const control = parseSlice("control", sliceFields.control);
  if (!computer || !agents || !control) return null;
  return {
    version: 1,
    measuredAtEpochMs: root.measuredAtEpochMs,
    host: {
      totalBytes: hostFields.totalBytes,
      availableBytes: hostFields.availableBytes,
      psiFullAvg10: hostFields.psiFullAvg10,
    },
    slices: { computer, agents, control },
  };
}

let warnedInvalid = false;

function warnInvalid(reason: string, detail: string): void {
  if (warnedInvalid) return;
  warnedInvalid = true;
  console.warn(`[agentbox-admission] resource state ${reason}: ${detail.slice(0, 200)}`);
}

export function readAgentboxResourceState(options?: {
  env?: Record<string, string | undefined>;
  stateFile?: string;
  nowMs?: number;
}): AgentboxResourceReading {
  const env = options?.env ?? process.env;
  const configured = options?.stateFile ?? env[AGENTBOX_RESOURCE_STATE_ENV];
  if (configured === undefined || configured.trim() === "") {
    return { status: "unconfigured" };
  }
  let source: string;
  try {
    source = readFileSync(configured, "utf8");
  } catch (error) {
    const detail = `${configured}: ${(error as NodeJS.ErrnoException).code ?? "read error"}`;
    warnInvalid("unreadable", detail);
    return { status: "invalid", reason: "unreadable", detail };
  }
  const state = parseState(source);
  if (!state) {
    const detail = `${configured}: invalid resource-state schema`;
    warnInvalid("malformed", detail);
    return { status: "invalid", reason: "malformed", detail };
  }
  const now = options?.nowMs ?? Date.now();
  const age = now - state.measuredAtEpochMs;
  if (age > AGENTBOX_STATE_MAX_AGE_MS) {
    const detail = `${configured}: ${Math.round(age / 1000)}s old`;
    warnInvalid("stale", detail);
    return { status: "invalid", reason: "stale", detail };
  }
  if (state.measuredAtEpochMs - now > AGENTBOX_STATE_FUTURE_TOLERANCE_MS) {
    const detail = `${configured}: dated ${Math.round((state.measuredAtEpochMs - now) / 1000)}s ahead`;
    warnInvalid("future-dated", detail);
    return { status: "invalid", reason: "future", detail };
  }
  return { status: "configured", state };
}

/** True when the operator configured the policy, even if its state is broken. */
export function agentboxResourcePolicyConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[AGENTBOX_RESOURCE_STATE_ENV];
  return value !== undefined && value.trim() !== "";
}

export function isBackgroundLaunch(kind: AgentboxLaunchKind): boolean {
  return kind === "schedule" || kind === "bot";
}

/**
 * The controller's snapshot `availableBytes` may be up to 45s old; /proc's
 * MemAvailable is the trusted fresh reading. Admit against whichever is more
 * pessimistic, so a launch can never lean on a stale rosier number.
 */
export function agentboxEffectiveAvailableBytes(
  state: AgentboxResourceStateV1,
  freshAvailableBytes: number,
): number {
  const fresh = Number.isFinite(freshAvailableBytes) ? Math.max(0, freshAvailableBytes) : 0;
  return Math.max(0, Math.min(state.host.availableBytes, fresh));
}

export function agentboxMemoryBudget(
  kind: AgentboxLaunchKind,
  state: AgentboxResourceStateV1,
  freshAvailableBytes: number,
): AgentMemoryBudget {
  return {
    availableBytes: agentboxEffectiveAvailableBytes(state, freshAvailableBytes),
    reserveBytes: isBackgroundLaunch(kind)
      ? AGENTBOX_BACKGROUND_RESERVE_BYTES
      : AGENTBOX_INTERACTIVE_RESERVE_BYTES,
    launchBytes: AGENTBOX_LAUNCH_BYTES,
  };
}

/**
 * Pressure gate over host + computer + agents + control. A cgroup slice can
 * sit at full pressure while the host still reports free memory, so every
 * relevant PSI is checked independently. Refusal is at-or-above the threshold.
 */
export function agentboxPressureVerdict(
  kind: AgentboxLaunchKind,
  state: AgentboxResourceStateV1,
): AgentboxPressureVerdict {
  const threshold = isBackgroundLaunch(kind)
    ? AGENTBOX_PSI_BACKGROUND_REFUSE
    : AGENTBOX_PSI_INTERACTIVE_REFUSE;
  const relevant: AgentboxPressureReading[] = [
    { source: "host", psiFullAvg10: state.host.psiFullAvg10 },
    { source: "computer", psiFullAvg10: state.slices.computer.psiFullAvg10 },
    { source: "agents", psiFullAvg10: state.slices.agents.psiFullAvg10 },
    { source: "control", psiFullAvg10: state.slices.control.psiFullAvg10 },
  ];
  if (relevant.some((reading) => reading.psiFullAvg10 >= threshold)) {
    return {
      refused: true,
      threshold,
      readings: relevant.filter((reading) => reading.psiFullAvg10 >= threshold),
    };
  }
  return { refused: false };
}

export type AgentboxResourceGate =
  | { status: "off" }
  | { status: "refused"; code: "resource_pressure"; message: string }
  | { status: "allow"; memory: AgentMemoryBudget };

/**
 * The complete policy decision for one new launch. `off` (variable unset)
 * leaves every existing upstream behavior untouched. `refused` carries the
 * 429 `resource_pressure` copy: retry later, never an upgrade or close
 * recommendation. `allow` carries the budget the count-free path must still
 * enforce.
 */
export function agentboxResourceGate(
  kind: AgentboxLaunchKind,
  options?: {
    env?: Record<string, string | undefined>;
    stateFile?: string;
    nowMs?: number;
    freshAvailableBytes: number;
  },
): AgentboxResourceGate {
  const reading = readAgentboxResourceState(options);
  if (reading.status === "unconfigured") return { status: "off" };
  if (reading.status === "invalid") {
    return {
      status: "refused",
      code: "resource_pressure",
      message:
        `this box's shared-memory safety state is ${reading.reason === "unreadable" ? "unreadable" : reading.reason === "malformed" ? "malformed" : reading.reason === "stale" ? "too old" : "dated in the future"}; ` +
        "new agents are refused until it is fresh again — retry in a moment",
    };
  }
  const verdict = agentboxPressureVerdict(kind, reading.state);
  if (verdict.refused) {
    const worst = verdict.readings[verdict.readings.length - 1]!;
    return {
      status: "refused",
      code: "resource_pressure",
      message:
        `memory pressure is too high to start another agent ` +
        `(${worst.source} PSI full avg10 ${worst.psiFullAvg10.toFixed(1)}%, threshold ${verdict.threshold}%); ` +
        "retry when pressure has dropped",
    };
  }
  return {
    status: "allow",
    memory: agentboxMemoryBudget(kind, reading.state, options?.freshAvailableBytes ?? 0),
  };
}

export class AgentboxResourceRefusal extends Error {}

/** Call inside the admission controller's serialized inspect, after awaits. */
export function agentboxAdmissionMemory(
  kind: AgentboxLaunchKind,
  options: NonNullable<Parameters<typeof agentboxResourceGate>[1]>,
): AgentMemoryBudget | undefined {
  const gate = agentboxResourceGate(kind, options);
  if (gate.status === "refused") throw new AgentboxResourceRefusal(gate.message);
  return gate.status === "allow" ? gate.memory : undefined;
}
