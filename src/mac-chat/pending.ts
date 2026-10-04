// Pending remote-start journal for Mac-hosted sessions.
//
// Contract (INTEGRATION-BUILD-TASK): a remote start request/session id is
// persisted BEFORE any network activity; an unknown outcome is reconciled by
// the SAME id and never blindly re-sent. This file owns that journal. It lives
// next to the aisdk registry (data/aisdk/<sessionId>.macstart.json) so a boot
// reconciliation can find it without new discovery machinery.
//
// States:
//   pending  — written before the harness spawned; nothing proven.
//   ready    — the stream handshake answered ready (remote pid recorded).
//   failed   — a terminal, safe failure reason was recorded.
//   unknown  — the transport errored after send; the outcome on the Mac is
//              unknown and MUST be reconciled (status <requestId>) before any
//              retry. Never auto-retried by this module.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "../config.ts";
import { isMacStreamUuid } from "./wire.ts";

export type MacStartState = "pending" | "ready" | "failed" | "unknown";

export type MacStartRecord = {
  sessionId: string;
  requestId: string;
  state: MacStartState;
  createdAt: number;
  updatedAt: number;
  contractSha256: string;
  /** Present in ready state. */
  remotePid?: number;
  /** Present in failed/unknown states: sanitized single-line reason. */
  reason?: string;
};

function journalDir(): string {
  return join(PATHS.data, "aisdk");
}

function recordPath(sessionId: string): string {
  return join(journalDir(), `${sessionId}.macstart.json`);
}

function atomicWrite(path: string, record: MacStartRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.macstart-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, path);
}

export type PersistMacStartResult =
  | { ok: true; record: MacStartRecord }
  | { ok: false; error: string };

/**
 * Persist a PENDING remote start before any network. An existing terminal
 * record for the same session with the same contract is returned as-is
 * (reconciliation caller decides); a different contract for the same session
 * while pending/unknown refuses — never a silent second request.
 */
export function persistPendingMacStart(input: {
  sessionId: string;
  requestId: string;
  contractSha256: string;
}): PersistMacStartResult {
  if (!isMacStreamUuid(input.sessionId)) return { ok: false, error: "sessionId must be a UUID" };
  if (!isMacStreamUuid(input.requestId)) return { ok: false, error: "requestId must be a UUID" };
  const existing = readMacStart(input.sessionId);
  if (existing && existing.state !== "failed") {
    if (existing.contractSha256 === input.contractSha256) {
      // Same contract: idempotent — never send a second request for the
      // same start. Reconciliation owns the rest.
      return { ok: true, record: existing };
    }
    return {
      ok: false,
      error: `mac-start for session ${input.sessionId} is ${existing.state} under a different contract; reconcile request ${existing.requestId} first`,
    };
  }
  const now = Date.now();
  const record: MacStartRecord = {
    sessionId: input.sessionId,
    requestId: input.requestId,
    state: "pending",
    createdAt: now,
    updatedAt: now,
    contractSha256: input.contractSha256,
  };
  atomicWrite(recordPath(input.sessionId), record);
  return { ok: true, record };
}

export function readMacStart(sessionId: string): MacStartRecord | null {
  try {
    const raw = readFileSync(recordPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<MacStartRecord>;
    if (
      !parsed ||
      parsed.sessionId !== sessionId ||
      !isMacStreamUuid(parsed.requestId) ||
      (parsed.state !== "pending" && parsed.state !== "ready" && parsed.state !== "failed" && parsed.state !== "unknown")
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      requestId: parsed.requestId,
      state: parsed.state,
      createdAt: Number(parsed.createdAt) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
      contractSha256: typeof parsed.contractSha256 === "string" ? parsed.contractSha256 : "",
      ...(typeof parsed.remotePid === "number" ? { remotePid: parsed.remotePid } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  } catch {
    return null;
  }
}

export function updateMacStart(
  sessionId: string,
  patch: { state: MacStartState; remotePid?: number; reason?: string },
): MacStartRecord | null {
  const existing = readMacStart(sessionId);
  if (!existing) return null;
  const next: MacStartRecord = {
    ...existing,
    state: patch.state,
    updatedAt: Date.now(),
    ...(patch.remotePid !== undefined ? { remotePid: patch.remotePid } : {}),
    ...(patch.reason !== undefined ? { reason: patch.reason.slice(0, 300) } : {}),
  };
  atomicWrite(recordPath(sessionId), next);
  return next;
}

/**
 * Record the stream requestId of the CURRENT (or latest) provider launch.
 * Called on EVERY stream open — claude per session-runtime, codex per turn —
 * so an unknown outcome always reconciles by the id that is actually live on
 * the Mac, across all turns. Creates the record when absent (the harness
 * process may outlive or precede the launcher's journal; the launch-time
 * record with the FIRST id is the normal path).
 */
export function recordMacStartRequest(sessionId: string, requestId: string): void {
  if (!isMacStreamUuid(sessionId) || !isMacStreamUuid(requestId)) return;
  const existing = readMacStart(sessionId);
  if (!existing) {
    const now = Date.now();
    atomicWrite(recordPath(sessionId), {
      sessionId,
      requestId,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      contractSha256: "",
    });
    return;
  }
  if (existing.requestId === requestId) return;
  atomicWrite(recordPath(sessionId), { ...existing, requestId, updatedAt: Date.now() });
}

export function clearMacStart(sessionId: string): void {
  try {
    if (existsSync(recordPath(sessionId))) {
      // Terminal cleanup: keep the file only when it records an unknown
      // outcome (reconciliation may still need it); otherwise remove.
      const record = readMacStart(sessionId);
      if (record?.state !== "unknown") {
        rmSync(recordPath(sessionId), { force: true });
      }
    }
  } catch {}
}

/**
 * All journals still in pending/unknown state — the boot reconciliation set.
 * `ready`/`failed` records are skipped (they are terminal and need no
 * network), and `failed` records are kept on disk purely as audit.
 */
export function listUnreconciledMacStarts(): MacStartRecord[] {
  const out: MacStartRecord[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(journalDir());
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".macstart.json")) continue;
    const sessionId = name.slice(0, -".macstart.json".length);
    const record = readMacStart(sessionId);
    if (record && (record.state === "pending" || record.state === "unknown")) out.push(record);
  }
  return out;
}

/**
 * Reconcile ONE journaled remote start against the Mac (`status <requestId>`).
 * Returns the supervisor's safe state view. NEVER re-sends the request: a
 * terminal state is recorded; an unknown answer stays unknown (the caller
 * reports it; a human/live gate decides). `statusQuery` is injectable so
 * tests never touch the network.
 */
export async function reconcileMacStart(
  sessionId: string,
  statusQuery: (requestId: string) => Promise<{ ok: true; state: string } | { ok: false; error: string }>,
): Promise<{ ok: true; state: "active" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown" } | { ok: false; error: string }> {
  const record = readMacStart(sessionId);
  if (!record) return { ok: false, error: "geen mac-start journaal voor deze sessie" };
  const answer = await statusQuery(record.requestId);
  if (!answer.ok) {
    updateMacStart(sessionId, { state: "unknown", reason: answer.error.slice(0, 300) });
    return { ok: true, state: "unknown" };
  }
  const state = answer.state;
  if (state === "active" || state === "admitting") {
    updateMacStart(sessionId, { state: "pending" });
    return { ok: true, state: "active" };
  }
  // Terminal supervisor states (completed/failed/cancelled/timeout/
  // disconnected/memory-*/policy-*): record the fact, never retry.
  updateMacStart(sessionId, { state: state === "completed" ? "ready" : "failed", reason: `remote ${state}` });
  return { ok: true, state: state === "completed" ? "completed" : "failed" };
}
