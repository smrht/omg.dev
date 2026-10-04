// Regression (live 2026-10-04): the mac launcher's remote-start journal
// (<sessionId>.macstart.json, src/mac-chat/pending.ts) shares data/aisdk with
// the registry and carries the SAME sessionId but no harnessPid/tmuxName.
// listEntries accepted every *.json and readEntryAt blind-casted, so
// findEntryByAnyId could return the journal as a phantom entry depending on
// directory order — a codex close then saw harnessPid undefined, skipped the
// force stop, removed the registry and returned 200 while the real harness
// kept running (close 194ms vs a healthy 569ms).
//
// The registry now (a) accepts a file as an entry only when its name is
// exactly the row's own sessionId (any key format — the established cache
// fixtures use non-UUID keys) and the row carries a positive integer
// harnessPid, and (c) answers the exact control-plane key by a direct read
// before any alias scan. These tests pin all of it, using the journal's OWN
// writer to stage the sidecar.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findEntryByAnyId,
  listEntries,
  patchEntry,
  readEntry,
  writeEntry,
  type AisdkEntry,
} from "./aisdk-registry.ts";
import { PATHS } from "./config.ts";
import { persistPendingMacStart } from "./mac-chat/pending.ts";

const originalData = PATHS.data;
const KEY = "33333333-4444-4555-8666-777777777777";
const ALIAS_KEY = "88888888-9999-4aaa-8bbb-cccccccccccc";
const REQUEST_ID = "12121212-3434-4565-8787-909090909090";

let root = "";

// The journal is deliberately staged BEFORE the real entry: the live failure
// was exactly this directory order, and every lookup below must be order-
// independent anyway.
function stageJournalFirst(sessionId = KEY) {
  const pending = persistPendingMacStart({ sessionId, requestId: REQUEST_ID, contractSha256: "a".repeat(64) });
  if (!pending.ok) throw new Error(`journal staging failed: ${pending.error}`);
  const journal = join(PATHS.data, "aisdk", `${sessionId}.macstart.json`);
  expect(existsSync(journal)).toBe(true);
  return journal;
}

function realEntry(over: Partial<AisdkEntry> = {}): AisdkEntry {
  return {
    sessionId: KEY,
    harnessPid: 4242,
    tmuxName: "lfg-sidecar01",
    cwd: root,
    model: "test-model",
    busy: false,
    createdAt: Date.now() - 60_000,
    ...over,
  };
}

describe("aisdk registry vs auxiliary sidecar journals", () => {
  test("sidecar BEFORE real entry: lookup still returns the real entry", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-sidecar-"));
    PATHS.data = join(root, "data");
    try {
      stageJournalFirst();
      writeEntry(realEntry());
      const found = findEntryByAnyId(KEY);
      expect(found).not.toBeNull();
      expect(found?.harnessPid).toBe(4242); // the real harness row, not the journal
      expect(listEntries()).toHaveLength(1);
      expect(listEntries()[0]?.sessionId).toBe(KEY);
    } finally {
      PATHS.data = originalData;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("main absent (journal only): no phantom entry from any lookup", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-sidecar-"));
    PATHS.data = join(root, "data");
    try {
      stageJournalFirst();
      expect(readEntry(KEY)).toBeNull();
      expect(findEntryByAnyId(KEY)).toBeNull();
      expect(listEntries()).toEqual([]);
      // patchEntry must stay a no-op, never merge the journal into an entry file.
      patchEntry(KEY, { busy: true });
      expect(existsSync(join(PATHS.data, "aisdk", `${KEY}.json`))).toBe(false);
      expect(existsSync(join(PATHS.data, "aisdk", `${KEY}.macstart.json`))).toBe(true);
    } finally {
      PATHS.data = originalData;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("alias lookup prefers the exact control-plane key over a threadId match", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-sidecar-"));
    PATHS.data = join(root, "data");
    try {
      // ALIAS_KEY's own entry does not exist; KEY's entry claims ALIAS_KEY as
      // its threadId. Written after the journal, in either order the answer
      // must be the same deterministic row.
      stageJournalFirst(ALIAS_KEY);
      writeEntry(realEntry({ threadId: ALIAS_KEY }));
      const found = findEntryByAnyId(ALIAS_KEY);
      expect(found?.sessionId).toBe(KEY);
      expect(found?.harnessPid).toBe(4242);
      // Exact key still wins directly.
      expect(findEntryByAnyId(KEY)?.sessionId).toBe(KEY);
    } finally {
      PATHS.data = originalData;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mtime cache stays honest with a sidecar present", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-sidecar-"));
    PATHS.data = join(root, "data");
    try {
      stageJournalFirst();
      writeEntry(realEntry({ busy: false }));
      expect(readEntry(KEY)?.busy).toBe(false);
      // Rewrite the real entry directly (as a harness process would); the
      // mtime-keyed cache must pick up the new content, and the journal next
      // to it must never be served for the entry's path.
      writeFileSync(
        join(PATHS.data, "aisdk", `${KEY}.json`),
        JSON.stringify(realEntry({ busy: true }), null, 2),
      );
      expect(readEntry(KEY)?.busy).toBe(true);
      expect(listEntries()).toHaveLength(1);
      expect(listEntries()[0]?.busy).toBe(true);
    } finally {
      PATHS.data = originalData;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy entry shapes are preserved (no supervisor/agent/executionHost, no tmuxName)", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-sidecar-"));
    PATHS.data = join(root, "data");
    try {
      const legacy = realEntry(); // oldest backend shape: only the core fields
      writeEntry(legacy);
      const found = findEntryByAnyId(KEY)!;
      expect(found).toEqual(legacy);
      expect(found.supervisor).toBeUndefined();
      expect(found.executionHost).toBeUndefined();
      // Fixture parity with aisdk-registry-cache.test.ts: a non-UUID key and
      // a row WITHOUT tmuxName is still a perfectly valid entry.
      const bareKey = `cache-b-${crypto.randomUUID()}`;
      const bare = {
        sessionId: bareKey,
        cwd: root,
        model: "opus",
        harnessPid: 4242,
        createdAt: 1,
      } as AisdkEntry;
      writeEntry(bare);
      expect(readEntry(bareKey)).toEqual(bare);
      expect(findEntryByAnyId(bareKey)?.sessionId).toBe(bareKey);
      expect(listEntries()).toHaveLength(2);
    } finally {
      PATHS.data = originalData;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a well-shaped row filed under the WRONG filename is not an entry", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-sidecar-"));
    PATHS.data = join(root, "data");
    try {
      const other = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
      // Valid shape, but its sessionId does not match the filename it sits in.
      mkdirSync(join(PATHS.data, "aisdk"), { recursive: true });
      writeFileSync(
        join(PATHS.data, "aisdk", `${other}.json`),
        JSON.stringify(realEntry(), null, 2),
      );
      expect(readEntry(KEY)).toBeNull(); // direct lookup by the content id
      expect(findEntryByAnyId(KEY)).toBeNull(); // scan lookup
      expect(findEntryByAnyId(other)).toBeNull(); // the filename's own id
      expect(listEntries()).toEqual([]);
    } finally {
      PATHS.data = originalData;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("journal written by the real pending module parses as the live record", () => {
    // Positive control for the staging itself: the sidecar really is the
    // live journal shape (sessionId + requestId + state, no harnessPid), so
    // the exclusions above defend against the actual producer's output.
    root = mkdtempSync(join(tmpdir(), "lfg-sidecar-"));
    PATHS.data = join(root, "data");
    try {
      const journal = stageJournalFirst();
      const raw = JSON.parse(readFileSync(journal, "utf8")) as Record<string, unknown>;
      expect(raw.sessionId).toBe(KEY);
      expect(raw.state).toBe("pending");
      expect("harnessPid" in raw).toBe(false);
      expect("tmuxName" in raw).toBe(false);
    } finally {
      PATHS.data = originalData;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
