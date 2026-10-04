// Pending remote-start journal tests: persist-before-network, idempotency,
// per-turn requestId recording, reconciliation by the same id.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { join as pathJoin } from "node:path";
import {
  listUnreconciledMacStarts,
  persistPendingMacStart,
  readMacStart,
  reconcileMacStart,
  recordMacStartRequest,
  updateMacStart,
} from "./pending.ts";

let dataDir: string;
let baseDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "mac-chat-pending-"));
  dataDir = pathJoin(baseDir, "data");
  process.env.OMG_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.OMG_DATA_DIR;
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch { /* retry below */ }
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch { /* empty-dir residue in the cache tmp namespace is cosmetic */ }
});

describe("pending remote-start journal", () => {
  test("persist pending before network; same contract is idempotent; different contract refuses", () => {
    const sessionId = crypto.randomUUID();
    const a = persistPendingMacStart({ sessionId, requestId: crypto.randomUUID(), contractSha256: "a".repeat(64) });
    expect(a.ok).toBe(true);
    const again = persistPendingMacStart({ sessionId, requestId: crypto.randomUUID(), contractSha256: "a".repeat(64) });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.record.state).toBe("pending"); // no second request
    const conflict = persistPendingMacStart({ sessionId, requestId: crypto.randomUUID(), contractSha256: "b".repeat(64) });
    expect(conflict.ok).toBe(false);
  });

  test("every stream launch records its requestId (reconciliation across all turns)", () => {
    const sessionId = crypto.randomUUID();
    persistPendingMacStart({ sessionId, requestId: crypto.randomUUID(), contractSha256: "c".repeat(64) });
    const turnTwoId = crypto.randomUUID();
    recordMacStartRequest(sessionId, turnTwoId);
    expect(readMacStart(sessionId)?.requestId).toBe(turnTwoId);
    const turnThreeId = crypto.randomUUID();
    recordMacStartRequest(sessionId, turnThreeId);
    expect(readMacStart(sessionId)?.requestId).toBe(turnThreeId);
  });

  test("listUnreconciledMacStarts returns only pending/unknown", () => {
    const s1 = crypto.randomUUID();
    persistPendingMacStart({ sessionId: s1, requestId: crypto.randomUUID(), contractSha256: "d".repeat(64) });
    const s2 = crypto.randomUUID();
    persistPendingMacStart({ sessionId: s2, requestId: crypto.randomUUID(), contractSha256: "e".repeat(64) });
    updateMacStart(s2, { state: "ready", remotePid: 42 });
    const ids = listUnreconciledMacStarts().map((r) => r.sessionId);
    expect(ids).toContain(s1);
    expect(ids).not.toContain(s2);
  });

  test("reconcile: terminal remote state is recorded; unknown stays unknown; NEVER re-sent", async () => {
    const s = crypto.randomUUID();
    const rid = crypto.randomUUID();
    persistPendingMacStart({ sessionId: s, requestId: rid, contractSha256: "f".repeat(64) });
    const queries: string[] = [];
    const done = await reconcileMacStart(s, async (requestId) => {
      queries.push(requestId);
      return { ok: true, state: "completed" };
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.state).toBe("completed");
    expect(queries).toEqual([rid]); // reconciled by the SAME id
    expect(readMacStart(s)?.state).toBe("ready");

    const s2 = crypto.randomUUID();
    persistPendingMacStart({ sessionId: s2, requestId: crypto.randomUUID(), contractSha256: "1".repeat(64) });
    const unknown = await reconcileMacStart(s2, async () => ({ ok: false, error: "ssh unreachable" }));
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.state).toBe("unknown");
    expect(readMacStart(s2)?.state).toBe("unknown");
  });

  test("reconcile: active remote state keeps pending (no auto-retry, no double send)", async () => {
    const s = crypto.randomUUID();
    persistPendingMacStart({ sessionId: s, requestId: crypto.randomUUID(), contractSha256: "2".repeat(64) });
    const result = await reconcileMacStart(s, async () => ({ ok: true, state: "active" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("active");
    expect(readMacStart(s)?.state).toBe("pending");
  });
});
