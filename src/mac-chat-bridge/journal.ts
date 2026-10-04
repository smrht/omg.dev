// Write idempotency for the Mac main-chat bridge (CONTEXT-CONTRACT v1, rule 7).
//
// Every mutating workspace call carries a caller-generated UUID (callId).
// Before any file changes, the claim is written with O_EXCL so exactly one
// process can own a callId. The journal is append-of-state per call: claimed
// (in-flight) -> done, with the final result recorded verbatim. Replays of the
// same callId with the same payload return the recorded result; a different
// payload is a conflict; a claim that never finished (crash) is reported as
// outcome_unknown and never re-executed. File-backed so a bridge restart
// still knows which writes already happened.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./lease.ts";

export type JournalOutcome =
  | { kind: "written"; path: string; sha256: string; bytes: number }
  | { kind: "cas-mismatch"; path: string; expected: string | null; actual: string | null }
  | { kind: "denied"; reason: string; detail?: string }
  | { kind: "outcome_unknown"; detail: string };

export interface JournalRecord {
  v: 1;
  leaseId: string;
  callId: string;
  payloadHash: string;
  path: string;
  state: "in-flight" | "done";
  startedAt: number;
  finishedAt?: number;
  isError?: boolean;
  outcome?: JournalOutcome;
}

export type ClaimResult =
  | { kind: "claimed"; finish: (outcome: JournalOutcome, isError: boolean) => void }
  | { kind: "replay"; record: JournalRecord }
  | { kind: "conflict"; record: JournalRecord }
  | { kind: "unknown"; record: JournalRecord };

export function payloadHashOf(input: { path: string; content: string; expectedSha256: string | null }): string {
  return sha256Hex(JSON.stringify([input.path, input.expectedSha256, input.content]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** File-backed idempotency journal, one directory per bridge instance. */
export class IdempotencyJournal {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(leaseId: string, callId: string): string {
    const leaseDir = join(this.dir, encodeURIComponent(leaseId));
    mkdirSync(leaseDir, { recursive: true });
    return join(leaseDir, `${callId}.json`);
  }

  /**
   * Claim a callId. Exactly one caller gets "claimed" and must call finish().
   * Everyone else learns what happened instead of re-running the mutation.
   */
  claim(leaseId: string, callId: string, payloadHash: string, path: string): ClaimResult {
    const file = this.fileFor(leaseId, callId);
    const record: JournalRecord = {
      v: 1,
      leaseId,
      callId,
      payloadHash,
      path,
      state: "in-flight",
      startedAt: Date.now(),
    };
    try {
      writeFileSync(file, JSON.stringify(record), { flag: "wx" });
    } catch {
      let existing: JournalRecord | null = null;
      try {
        existing = JSON.parse(readFileSync(file, "utf8")) as JournalRecord;
      } catch {
        return { kind: "unknown", record };
      }
      if (!existing || existing.state !== "done") return { kind: "unknown", record: existing ?? record };
      if (existing.payloadHash !== payloadHash) return { kind: "conflict", record: existing };
      return { kind: "replay", record: existing };
    }
    const finish = (outcome: JournalOutcome, isError: boolean): void => {
      const done: JournalRecord = {
        ...record,
        state: "done",
        finishedAt: Date.now(),
        isError,
        outcome,
      };
      // Atomic swap so a reader never sees a half-written done record.
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(done));
      renameSync(tmp, file);
    };
    return { kind: "claimed", finish };
  }

  /** Serialize mutations to one absolute path (in-process single writer). */
  withPathLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
    const previous: Promise<unknown> = this.locks.get(absolutePath) ?? Promise.resolve();
    const run: Promise<T> = previous.then(fn, fn);
    const settled: Promise<void> = run.then(
      () => this.clearLock(absolutePath, settled),
      () => this.clearLock(absolutePath, settled),
    );
    this.locks.set(absolutePath, settled);
    return run;
  }

  private clearLock(path: string, token: Promise<unknown>): void {
    if (this.locks.get(path) === token) this.locks.delete(path);
  }

  /** Test seam: forge an in-flight claim exactly like a crash would leave. */
  forgeInFlight(leaseId: string, callId: string, payloadHash: string, path: string): void {
    writeFileSync(this.fileFor(leaseId, callId), JSON.stringify({
      v: 1,
      leaseId,
      callId,
      payloadHash,
      path,
      state: "in-flight",
      startedAt: Date.now(),
    } satisfies JournalRecord), { flag: "wx" });
  }
}
