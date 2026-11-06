// Semantics, concurrency and migration tests for the compact v3 codex-head
// cache. Everything runs against throwaway temp dirs — no live stores, no
// live services, no network. The parity targets are verbatim copies of the
// v2-era implementations from sessions.ts, pinned here so a regression in
// the compact projection is caught against the exact behavior it replaced.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "./config.ts";
import {
  CodexHeadStore,
  deriveCodexHead,
  derivePromptProjection,
  displayTextOf,
  samePromptHashed,
  titleMatches,
  DISPLAY_PREVIEW_CHARS,
  TITLE_PREVIEW_CHARS,
  type CodexHeadEntry,
} from "./codex-head-cache.ts";

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `lfg-v3-heads-${label}-`));
  roots.push(root);
  return root;
}

function storeFor(dir: string, opts: Partial<ConstructorParameters<typeof CodexHeadStore>[0]> = {}) {
  mkdirSync(dir, { recursive: true });
  return new CodexHeadStore({
    v3Path: () => join(dir, "codex-heads-v3.jsonl"),
    v2Path: () => join(dir, "codex-heads.json"),
    ...opts,
  });
}

const head = (id: string, prompt: string | null) =>
  deriveCodexHead({ id, cwd: "/w/" + id, createdAt: 1700000000000, originator: "codex_cli_rs", sourceKind: "cli" }, prompt);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---- pinned v2-era reference implementations (copied from sessions.ts) ----
function refSamePrompt(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  return clean(a) === clean(b);
}
function refPromptStartsWithTitle(prompt: string | null, title: string | null | undefined): boolean {
  if (!prompt || !title) return false;
  const clean = (s: string) => s.replace(/^(?:Human|User):[ \t]+/i, "").replace(/\s+/g, " ").trim();
  const p = clean(prompt);
  const t = clean(title);
  return !!t && (p === t || p.startsWith(t));
}
function refPromptDisplayText(text: string): string {
  // stripOmgRuntimeContract is exercised through displayTextOf below; the
  // reference here pins the envelope-free path (prefix + collapse).
  return text.replace(/^(?:Human|User):[ \t]+/i, "").trim().replace(/\s+/g, " ");
}

const CONTRACT =
  "=== omg.dev RUNTIME CONTRACT (capability v1) ===\nrules rules rules\n=== END omg.dev RUNTIME CONTRACT ===\n\n=== USER TASK ===\n";

describe("compact prompt projection semantics", () => {
  test("samePromptHashed is exactly the old samePrompt, including whitespace and unicode", () => {
    const cases: Array<[string | null, string | null]> = [
      [null, "x"],
      ["x", null],
      ["", "x"],
      ["x", ""],
      ["   \n\t ", "x"],
      ["ship it", "ship it"],
      ["ship  it", "ship it"],
      ["\n\tship   it\n", "ship it"],
      ["Ship it", "ship it"],
      ["emoji 🚀🚀 vs emoji 🚀🚀", "emoji 🚀🚀 vs emoji 🚀🚀"],
      ["emoji 🚀🚀", "emoji 🚀🚀 "],
      ["中文 测试", "中文  测试"],
      ["a".repeat(5000), "a".repeat(5000)],
      ["a".repeat(5000), "a".repeat(4999)],
    ];
    for (const [a, b] of cases) {
      const hashed = samePromptHashed(derivePromptProjection(a).promptHash, b);
      expect([JSON.stringify(a?.slice(0, 20)), JSON.stringify(b?.slice(0, 20)), hashed]).toEqual([
        JSON.stringify(a?.slice(0, 20)),
        JSON.stringify(b?.slice(0, 20)),
        refSamePrompt(a, b),
      ]);
    }
  });

  test("two long prompts sharing the whole preview window remain distinct", () => {
    const shared = "S".repeat(DISPLAY_PREVIEW_CHARS + 500);
    const a = shared + " — alpha ending";
    const b = shared + " — beta ending";
    const pa = derivePromptProjection(a);
    const pb = derivePromptProjection(b);
    expect(pa.displayPreview).toBe(pb.displayPreview); // previews genuinely collide
    expect(pa.titlePreview.slice(0, TITLE_PREVIEW_CHARS)).toBe(pb.titlePreview.slice(0, TITLE_PREVIEW_CHARS));
    expect(samePromptHashed(pa.promptHash, b)).toBe(false); // and still distinct
    expect(samePromptHashed(pa.promptHash, a)).toBe(true);
    expect(samePromptHashed(pb.promptHash, a)).toBe(false);
  });

  test("titleMatches is exactly the old prefix test; long titles defer as unknown", () => {
    const prompt = CONTRACT + "User: rebuild the  cache   carefully\nplease";
    const p = derivePromptProjection(prompt);
    const titles = [
      null,
      "",
      "rebuild the cache carefully please",
      "User: rebuild the cache carefully please",
      "rebuild the cache",
      "REBUILD THE CACHE",
      "rebuild the cache carefully please and more",
      "x".repeat(TITLE_PREVIEW_CHARS),
      "x".repeat(TITLE_PREVIEW_CHARS + 1),
      "x".repeat(600),
      "rebuild the cache carefully please" + "y".repeat(400),
    ];
    // This prompt's cleaned form is short, so every title is decidable from
    // the preview — and each decision must equal the v2-era reference.
    for (const t of titles) {
      expect(titleMatches(p, t)).toBe(refPromptStartsWithTitle(prompt, t));
    }
  });

  test("titles longer than the preview defer exactly when the answer is out of window", () => {
    const prompt = "z".repeat(400) + " tail"; // cleaned length 405 > preview
    const p = derivePromptProjection(prompt);
    // Matching prefix beyond the preview: not decidable from stored data.
    expect(titleMatches(p, "z".repeat(250))).toBe("unknown");
    // Divergence beyond the preview: equally not decidable…
    expect(titleMatches(p, "z".repeat(250) + "q")).toBe("unknown");
    // …and the sessions fallback answers both exactly from the full prompt.
    expect(refPromptStartsWithTitle(prompt, "z".repeat(250))).toBe(true);
    expect(refPromptStartsWithTitle(prompt, "z".repeat(250) + "q")).toBe(false);
    // Whole-prompt equality beyond preview stays decidable via hash+length.
    expect(titleMatches(p, prompt)).toBe(true);
    // A title longer than the prompt can never match: decidable false.
    expect(titleMatches(p, prompt + "!")).toBe(false);
    expect(titleMatches(p, "q".repeat(TITLE_PREVIEW_CHARS + 1))).toBe(false);
  });

  test("display preview strips the runtime contract from the FULL prompt before truncating", () => {
    const task = "fix the flaky deploy check";
    // Long boilerplate INSIDE the envelope (between header and END marker):
    // everything up to USER TASK is stripped before the preview is cut.
    const longContract =
      "=== omg.dev RUNTIME CONTRACT (capability v1) ===\n" +
      "preamble ".repeat(200) +
      "\n=== END omg.dev RUNTIME CONTRACT ===\n\n=== USER TASK ===\n";
    const p = derivePromptProjection(longContract + task);
    expect(p.displayPreview.startsWith("=== ")).toBe(false);
    expect(p.displayPreview.startsWith(task)).toBe(true);
    expect(p.displayTruncated).toBe(false);
    // A short envelope-free prompt with a speaker prefix loses the prefix.
    expect(derivePromptProjection("User: hello there").displayPreview).toBe("hello there");
    // A prompt longer than the preview keeps a prefix and is flagged truncated.
    const long = "w".repeat(DISPLAY_PREVIEW_CHARS + 10);
    const pl = derivePromptProjection(long);
    expect(pl.displayPreview.length).toBe(DISPLAY_PREVIEW_CHARS);
    expect(pl.displayTruncated).toBe(true);
    // Truncation never happens before stripping: envelope + long task.
    const p2 = derivePromptProjection(CONTRACT + "t".repeat(DISPLAY_PREVIEW_CHARS + 5));
    expect(p2.displayPreview.startsWith("t")).toBe(true);
    expect(p2.displayTruncated).toBe(true);
    // displayTextOf matches the display half of sessions.promptDisplayText.
    expect(displayTextOf("User: a \n b")).toBe(refPromptDisplayText("User: a \n b"));
  });
});

describe("v2 → v3 migration", () => {
  const v2Body = (heads: Record<string, unknown>) => JSON.stringify({ version: 2, heads });

  test("preserves entries, negatives and long prompts; never touches the v2 file", async () => {
    const root = tempRoot("migrate");
    const dir = join(root, "data");
    mkdirSync(dir, { recursive: true });
    const longA = "alpha " + "x".repeat(120_000) + " end";
    const longB = "beta\n\twith \"quotes\" and \\backslashes\\ and 中文 🚀\n" + "y".repeat(90_000);
    const v2 = v2Body({
      "/p/one": { id: "11111111-1111-4111-8111-111111111111", cwd: "/w/1", createdAt: 1690000000000, firstUserText: longA, originator: "codex_exec", sourceKind: "exec" },
      "/p/two": { id: "22222222-2222-4222-8222-222222222222", cwd: "/w/2", createdAt: null, firstUserText: longB, originator: null, sourceKind: null },
      "/p/none": null,
      "/p/empty": { id: "44444444-4444-4444-8444-444444444444", cwd: null, createdAt: null, firstUserText: null, originator: null, sourceKind: null },
    });
    const v2Path = join(dir, "codex-heads.json");
    writeFileSync(v2Path, v2);
    const before = createHash("sha256").update(v2).digest("hex");

    const store = storeFor(dir);
    await store.ready();
    const one = store.get("/p/one");
    const two = store.get("/p/two");
    expect(one?.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(two?.cwd).toBe("/w/2");
    expect(store.get("/p/none")).toBeNull(); // negative preserved: no re-parse
    expect(store.get("/p/empty")?.prompt.promptHash).toBeNull();
    // Matching semantics survived the migration byte-for-byte.
    expect(samePromptHashed(one?.prompt.promptHash ?? null, longA)).toBe(true);
    expect(samePromptHashed(one?.prompt.promptHash ?? null, longA + "!")).toBe(false);
    expect(samePromptHashed(two?.prompt.promptHash ?? null, longB)).toBe(true);
    expect(titleMatches(one!.prompt, "alpha")).toBe(true);
    // The v2 file is byte-identical.
    expect(createHash("sha256").update(readFileSync(v2Path)).digest("hex")).toBe(before);
    // And v3 stands alone: a fresh store with no v2 present sees everything.
    const v3 = readFileSync(join(dir, "codex-heads-v3.jsonl"), "utf8");
    expect(v3.trimEnd().endsWith('{"v":3,"end":1}')).toBe(true);
    const solo = new CodexHeadStore({
      v3Path: () => join(dir, "codex-heads-v3.jsonl"),
      v2Path: () => join(dir, "deleted.json"),
    });
    await solo.ready();
    expect(solo.get("/p/two")?.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(solo.get("/p/none")).toBeNull();
  });

  test("rejects non-v2 headers outright (future versions, foreign shapes)", async () => {
    const root = tempRoot("reject");
    const bodies = [
      JSON.stringify({ version: 999, heads: { "/f": { id: "f" } } }),
      JSON.stringify({ heads: { "/f": { id: "f" } }, version: 2 }),
      JSON.stringify({ version: "2", heads: { "/f": { id: "f" } } }),
      "{ this is not json",
    ];
    for (const body of bodies) {
      const dir = join(root, bodies.indexOf(body).toString());
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "codex-heads.json"), body);
      const store = storeFor(dir);
      await store.ready();
      expect(store.get("/f")).toBeUndefined();
      expect(store.stats().migrated).toBe(false);
    }
  });

  test("tolerates whitespace in the header but nothing else", async () => {
    const dir = join(tempRoot("ws-header"), "d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "codex-heads.json"), '{ "version" : 2 , "heads" : { "/k": {"id":"kk","cwd":null,"createdAt":null,"firstUserText":"hi","originator":null,"sourceKind":null} } }');
    const store = storeFor(dir);
    await store.ready();
    expect(store.get("/k")?.id).toBe("kk");
  });

  test("streams correctly with tiny chunks (escapes, unicode and structure split everywhere)", async () => {
    const dir = join(tempRoot("tinychunks"), "d");
    mkdirSync(dir, { recursive: true });
    const tricky = 'quote " backslash \\ newline \n tab \t emoji 🚀 中文 "nested { braces }" done ' + "z".repeat(3000);
    const heads: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      heads[`/p/${i}`] =
        i % 3 === 0
          ? null
          : { id: `id-${i}`, cwd: `/w/${i}`, createdAt: i, firstUserText: tricky + " " + i, originator: null, sourceKind: null };
    }
    writeFileSync(join(dir, "codex-heads.json"), JSON.stringify({ version: 2, heads }));
    const store = storeFor(dir, { chunkBytes: 64 });
    await store.ready();
    expect(store.stats().migrated).toBe(true);
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 0) expect(store.get(`/p/${i}`)).toBeNull();
      else {
        const e = store.get(`/p/${i}`);
        expect(e?.id).toBe(`id-${i}`);
        expect(samePromptHashed(e?.prompt.promptHash ?? null, tricky + " " + i)).toBe(true);
      }
    }
  });

  test("a truncated v2 never completes; a truncated v3 migration resumes", async () => {
    // Truncated v2: no end marker, entries still usable.
    const d1 = join(tempRoot("trunc-v2"), "d");
    mkdirSync(d1, { recursive: true });
    const good = JSON.stringify({ version: 2, heads: { "/a": { id: "a", cwd: null, createdAt: null, firstUserText: "x", originator: null, sourceKind: null } } });
    writeFileSync(join(d1, "codex-heads.json"), good.slice(0, -2)); // cut the closing braces, keep the entry
    const s1 = storeFor(d1, { chunkBytes: 32 });
    await s1.ready();
    expect(s1.get("/a")?.id).toBe("a");
    expect(s1.stats().migrated).toBe(false);

    // Interrupted migration: v3 cut in half, v2 intact → next boot completes.
    const d2 = join(tempRoot("resume"), "d");
    mkdirSync(d2, { recursive: true });
    const heads: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) heads[`/r/${i}`] = { id: `r-${i}`, cwd: null, createdAt: null, firstUserText: "p".repeat(400) + i, originator: null, sourceKind: null };
    writeFileSync(join(d2, "codex-heads.json"), JSON.stringify({ version: 2, heads }));
    const first = storeFor(d2);
    await first.ready();
    const v3Path = join(d2, "codex-heads-v3.jsonl");
    const full = readFileSync(v3Path, "utf8");
    const lines = full.split("\n").filter(Boolean);
    writeFileSync(v3Path, lines.slice(0, Math.floor(lines.length / 2)).join("\n") + "\n"); // simulate a crash
    const resumed = storeFor(d2);
    await resumed.ready();
    expect(resumed.stats().migrated).toBe(true);
    for (let i = 0; i < 40; i++) expect(resumed.get(`/r/${i}`)?.id).toBe(`r-${i}`);
  });
});

describe("v3 loading and fallback", () => {
  test("garbage lines are skipped without losing the good ones", async () => {
    const dir = join(tempRoot("garbage"), "d");
    mkdirSync(dir, { recursive: true });
    const good = deriveCodexHead({ id: "g1", cwd: null, createdAt: 1, originator: null, sourceKind: null }, "good prompt");
    const lines = [
      JSON.stringify({ v: 3, p: "/g", h: { i: "g1", c: null, a: 1, o: null, s: null, ph: good.prompt.promptHash, th: good.prompt.titleHash, tp: good.prompt.titlePreview, tl: good.prompt.titleLen, dp: good.prompt.displayPreview, dtr: false } }),
      "{ not json",
      JSON.stringify({ v: 4, p: "/wrong", h: null }),
      JSON.stringify({ v: 3, p: "/bad-head", h: { i: 42 } }),
      JSON.stringify({ v: 3, p: "/null", h: null }),
    ];
    writeFileSync(join(dir, "codex-heads-v3.jsonl"), lines.join("\n") + "\n");
    const store = storeFor(dir);
    await store.ready();
    expect(store.get("/g")?.id).toBe("g1");
    expect(store.get("/null")).toBeNull();
    expect(store.get("/wrong")).toBeUndefined();
    expect(store.get("/bad-head")).toBeUndefined();
    expect(store.stats().malformedLines).toBeGreaterThanOrEqual(1);
  });

  test("last record wins per path and tombstones hold across reloads", async () => {
    const dir = join(tempRoot("ordering"), "d");
    mkdirSync(dir, { recursive: true });
    const a = storeFor(dir);
    await a.ready();
    a.set("/x", head("x1", "first version"));
    expect(await a.flushNow()).toBe(true);
    a.set("/x", head("x2", "second version"));
    a.delete("/gone");
    a.set("/gone", head("g", "to be deleted"));
    a.delete("/gone");
    expect(await a.flushNow()).toBe(true);
    const b = storeFor(dir);
    await b.ready();
    expect(b.get("/x")?.id).toBe("x2");
    expect(b.get("/gone")).toBeUndefined();
    expect(samePromptHashed(b.get("/x")?.prompt.promptHash ?? null, "second version")).toBe(true);
  });
});

describe("concurrency and durability", () => {
  test("overlapping stores never lose each other's entries", async () => {
    const dir = join(tempRoot("overlap"), "d");
    mkdirSync(dir, { recursive: true });
    const a = storeFor(dir);
    const b = storeFor(dir);
    await a.ready();
    await b.ready();
    a.set("/a/1", head("a1", "from a"));
    b.set("/b/1", head("b1", "from b"));
    expect(await a.flushNow()).toBe(true);
    expect(await b.flushNow()).toBe(true); // b never saw a's entry in memory
    a.set("/a/2", head("a2", "from a again"));
    expect(await a.flushNow()).toBe(true);
    b.set("/b/2", head("b2", "from b again"));
    expect(await b.flushNow()).toBe(true);
    const c = storeFor(dir);
    await c.ready();
    for (const [p, id] of [
      ["/a/1", "a1"],
      ["/a/2", "a2"],
      ["/b/1", "b1"],
      ["/b/2", "b2"],
    ] as const) {
      expect([p, c.get(p)?.id]).toEqual([p, id]);
    }
    // And truly concurrent flushes both land.
    const d1 = storeFor(dir);
    const d2 = storeFor(dir);
    await d1.ready();
    await d2.ready();
    d1.set("/c/1", head("c1", "concurrent one"));
    d2.set("/c/2", head("c2", "concurrent two"));
    const [r1, r2] = await Promise.all([d1.flushNow(), d2.flushNow()]);
    expect(r1 && r2).toBe(true);
    const e = storeFor(dir);
    await e.ready();
    expect(e.get("/c/1")?.id).toBe("c1");
    expect(e.get("/c/2")?.id).toBe("c2");
  });

  test("flush retries after a lock obstruction and never steals an aged lock", async () => {
    const dir = join(tempRoot("retry"), "d");
    mkdirSync(dir, { recursive: true });
    const store = storeFor(dir);
    await store.ready();
    store.set("/p", head("p", "pending"));
    // Foreign object squatting on the lock path with an old mtime: a live
    // owner we cannot prove dead — writes must fail closed, not steal.
    const lockDir = join(dir, "codex-heads-v3.jsonl.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner"), `${process.pid}-live-owner`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockDir, old, old);
    expect(await store.flushNow()).toBe(false);
    expect(store.stats().dirty).toBe(1); // still pending, not dropped
    expect(existsSync(join(dir, "codex-heads-v3.jsonl"))).toBe(false);
    // Obstruction cleared → the retry succeeds and the entry lands.
    rmSync(lockDir, { recursive: true, force: true });
    expect(await store.flushNow()).toBe(true);
    const check = storeFor(dir);
    await check.ready();
    expect(check.get("/p")?.id).toBe("p");
  });

  test("records changed during an in-flight append stay dirty (update/delete races)", async () => {
    const dir = join(tempRoot("revrace"), "d");
    mkdirSync(dir, { recursive: true });
    let once = false;
    const store = storeFor(dir, {
      beforeAppend: async () => {
        if (once) return;
        once = true;
        // Simulate a concurrent write landing while the batch is being appended.
        store.set("/hot", head("hot2", "newer value"));
        store.delete("/doomed");
      },
    });
    await store.ready();
    store.set("/hot", head("hot1", "older value"));
    store.set("/doomed", head("doomed", "delete me after"));
    expect(await store.flushNow()).toBe(true);
    expect(await store.flushNow()).toBe(true); // the raced records flush now
    const check = storeFor(dir);
    await check.ready();
    expect(check.get("/hot")?.id).toBe("hot2"); // newer value won
    expect(samePromptHashed(check.get("/hot")?.prompt.promptHash ?? null, "newer value")).toBe(true);
    expect(check.get("/doomed")).toBeUndefined(); // tombstone held
  });

  test("compaction actually runs, dedupes, and survives a concurrent append", async () => {
    const dir = join(tempRoot("compact"), "d");
    mkdirSync(dir, { recursive: true });
    const v3Path = join(dir, "codex-heads-v3.jsonl");
    // A bloated file: three paths rewritten a thousand times each.
    const bloated: string[] = [];
    for (let i = 0; i < 1000; i++) {
      for (const p of ["/c/1", "/c/2", "/c/3"]) {
        const h = head(p.slice(1) + "-" + i, "v" + i);
        bloated.push(JSON.stringify({ v: 3, p, h: { i: h.id, c: h.cwd, a: h.createdAt, o: h.originator, s: h.sourceKind, ph: h.prompt.promptHash, th: h.prompt.titleHash, tp: h.prompt.titlePreview, tl: h.prompt.titleLen, dp: h.prompt.displayPreview, dtr: h.prompt.displayTruncated } }));
      }
    }
    writeFileSync(v3Path, bloated.join("\n") + "\n");
    expect(bloated.length).toBe(3000);

    const a = storeFor(dir);
    await a.ready();
    const b = storeFor(dir);
    await b.ready();
    // Inject a concurrent append during a's UNLOCKED compaction read (once).
    // compact() re-reads under the lock after the change check; the hook must
    // pass the FRESH result through on that second call, or the re-read would
    // be discarded — exactly the lost-append bug this test guards against.
    let injected = false;
    const original = (a as unknown as { readV3Map: () => Promise<{ map: Map<string, CodexHeadEntry | null> }> }).readV3Map.bind(a);
    (a as unknown as Record<string, unknown>).readV3Map = async () => {
      const loaded = await original();
      if (!injected) {
        injected = true;
        b.set("/concurrent", head("concurrent", "written during compaction"));
        expect(await b.flushNow()).toBe(true);
      }
      return loaded;
    };
    await (a as unknown as { compact: () => Promise<void> }).compact();
    const text = readFileSync(v3Path, "utf8");
    const lineCount = text.trimEnd() === "" ? 0 : text.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(6); // 3 live + concurrent (+ marker): truly compacted
    const check = storeFor(dir);
    await check.ready();
    expect(check.get("/concurrent")?.id).toBe("concurrent"); // nothing lost
    expect(check.get("/c/1")?.id).toBe("c/1-999"); // last-wins kept the newest rewrite
  });

  test("negative control: a lock-free read-merge-rename compaction DOES lose the concurrent append", async () => {
    // Proves the test above can fail: the classic lost-update bug it guards
    // against (merge from a snapshot taken outside the lock, then rename).
    const dir = join(tempRoot("negative"), "d");
    mkdirSync(dir, { recursive: true });
    const v3Path = join(dir, "codex-heads-v3.jsonl");
    writeFileSync(v3Path, JSON.stringify({ v: 3, p: "/keep", h: { i: "keep", c: null, a: null, o: null, s: null, ph: null, th: null, tp: "", tl: 0, dp: "", dtr: false } }) + "\n");
    const a = storeFor(dir);
    await a.ready();
    const b = storeFor(dir);
    await b.ready();
    const original = (a as unknown as { readV3Map: () => Promise<{ map: Map<string, CodexHeadEntry | null> }> }).readV3Map.bind(a);
    (a as unknown as Record<string, unknown>).readV3Map = async () => {
      const loaded = await original();
      if (!loaded) return loaded;
      if (!(a as unknown as Record<string, unknown>)["__injected"]) {
        (a as unknown as Record<string, unknown>)["__injected"] = true;
        b.set("/concurrent", head("concurrent", "written during broken compaction"));
        expect(await b.flushNow()).toBe(true);
      }
      return loaded;
    };
    // The broken variant: rename from the pre-lock snapshot with no lock and
    // no change detection — exactly the bug the review flagged.
    const brokenCompact = async () => {
      const { map } = await (a as unknown as { readV3Map: () => Promise<{ map: Map<string, CodexHeadEntry | null> }> }).readV3Map();
      const tmp = v3Path + ".broken.tmp";
      const lines = [...map.entries()].map(([p, e]) =>
        e === null ? JSON.stringify({ v: 3, p, h: null }) : JSON.stringify({ v: 3, p, h: { i: e.id, c: e.cwd, a: e.createdAt, o: e.originator, s: e.sourceKind, ph: e.prompt.promptHash, th: e.prompt.titleHash, tp: e.prompt.titlePreview, tl: e.prompt.titleLen, dp: e.prompt.displayPreview, dtr: e.prompt.displayTruncated } }),
      );
      writeFileSync(tmp, lines.join("\n") + "\n");
      await import("node:fs/promises").then((m) => m.rename(tmp, v3Path));
    };
    await brokenCompact();
    const check = storeFor(dir);
    await check.ready();
    expect(check.get("/concurrent")).toBeUndefined(); // the bug: entry lost
  });

  test("stale-map compaction never resurrects older values, tombstones or negatives (parent review scenario)", async () => {
    const dir = join(tempRoot("stale"), "d");
    mkdirSync(dir, { recursive: true });
    // A commits an old value, a to-be-deleted path and a negative entry.
    const a = storeFor(dir);
    await a.ready();
    a.set("/same", head("old", "old value"));
    a.set("/gone", head("gone", "delete me"));
    a.set("/neg", null);
    expect(await a.flushNow()).toBe(true);
    // B — which loaded A's state — commits newer records for all three.
    const b = storeFor(dir);
    await b.ready();
    b.set("/same", head("new", "new value"));
    b.delete("/gone");
    b.set("/neg", head("revived", "actually parseable now"));
    expect(await b.flushNow()).toBe(true);
    // A's memory is now stale on every path; its compaction must be a
    // representation-only cleanup of DISK state and change nothing semantic.
    await (a as unknown as { compact: () => Promise<void> }).compact();
    const c = storeFor(dir);
    await c.ready();
    expect(c.get("/same")?.id).toBe("new"); // newer record survived
    expect(samePromptHashed(c.get("/same")?.prompt.promptHash ?? null, "new value")).toBe(true);
    expect(c.get("/gone")).toBeUndefined(); // tombstone not resurrected
    expect(c.get("/neg")?.id).toBe("revived"); // stale negative not resurrected
    // Dedup happened too: this really was a rewrite (the tombstone is gone,
    // so exactly the two live records remain).
    const lines = readFileSync(join(dir, "codex-heads-v3.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(2);
  });

  test("negative control: merging the whole in-memory map into compaction DOES resurrect stale state", async () => {
    // Proves the test above can fail: the original defect — compact() writing
    // its entire (stale) entries map over newer committed disk records.
    const dir = join(tempRoot("stale-neg"), "d");
    mkdirSync(dir, { recursive: true });
    const a = storeFor(dir);
    await a.ready();
    a.set("/same", head("old", "old value"));
    a.set("/gone", head("gone", "delete me"));
    expect(await a.flushNow()).toBe(true);
    const b = storeFor(dir);
    await b.ready();
    b.set("/same", head("new", "new value"));
    b.delete("/gone");
    expect(await b.flushNow()).toBe(true);
    // Broken variant: pre-lock read, overlay the stale memory, rename.
    const brokenCompact = async () => {
      const { map } = await (a as unknown as { readV3Map: () => Promise<{ map: Map<string, CodexHeadEntry | null> }> }).readV3Map();
      for (const [p, e] of (a as unknown as { entries: Map<string, CodexHeadEntry | null> }).entries) map.set(p, e);
      const tmp = join(dir, "broken.tmp");
      const lines = [...map.entries()].map(([p, e]) =>
        e === null ? JSON.stringify({ v: 3, p, h: null }) : JSON.stringify({ v: 3, p, h: { i: e.id, c: e.cwd, a: e.createdAt, o: e.originator, s: e.sourceKind, ph: e.prompt.promptHash, th: e.prompt.titleHash, tp: e.prompt.titlePreview, tl: e.prompt.titleLen, dp: e.prompt.displayPreview, dtr: e.prompt.displayTruncated } }),
      );
      writeFileSync(tmp, lines.join("\n") + "\n");
      await import("node:fs/promises").then((m) => m.rename(tmp, join(dir, "codex-heads-v3.jsonl")));
    };
    await brokenCompact();
    const c = storeFor(dir);
    await c.ready();
    expect(c.get("/same")?.id).toBe("old"); // the bug: stale value resurrected
    expect(c.get("/gone")).toBeDefined(); // the bug: deletion undone
  });

  test("compaction preserves the disk END marker regardless of this instance's stale flag", async () => {
    const dir = join(tempRoot("endmark"), "d");
    mkdirSync(dir, { recursive: true });
    const v3Path = join(dir, "codex-heads-v3.jsonl");
    const h = head("e1", "end marker test");
    writeFileSync(v3Path, JSON.stringify({ v: 3, p: "/e", h: { i: h.id, c: h.cwd, a: h.createdAt, o: h.originator, s: h.sourceKind, ph: h.prompt.promptHash, th: h.prompt.titleHash, tp: h.prompt.titlePreview, tl: h.prompt.titleLen, dp: h.prompt.displayPreview, dtr: h.prompt.displayTruncated } }) + "\n");
    // A loads BEFORE the marker exists (stale endMarked=false)…
    const a = storeFor(dir);
    await a.ready();
    expect(a.stats().migrated).toBe(false);
    // …then another process completes the migration on disk.
    const appender = storeFor(dir);
    await appender.ready();
    appender.set("/late", head("late", "late entry"));
    expect(await appender.flushNow()).toBe(true);
    await import("node:fs/promises").then((m) => m.appendFile(v3Path, JSON.stringify({ v: 3, end: 1 }) + "\n"));
    await (a as unknown as { compact: () => Promise<void> }).compact();
    const c = storeFor(dir);
    await c.ready();
    expect(c.stats().migrated).toBe(true); // marker survived the rewrite
    expect(c.get("/e")?.id).toBe("e1");
    expect(c.get("/late")?.id).toBe("late");
  });

  test("a torn tail after a crash never swallows the next appended record", async () => {
    const dir = join(tempRoot("torntail"), "d");
    mkdirSync(dir, { recursive: true });
    const v3Path = join(dir, "codex-heads-v3.jsonl");
    const h1 = head("t1", "first record");
    const h2 = head("t2", "second record");
    const line = (h: ReturnType<typeof head>, p: string) => JSON.stringify({ v: 3, p, h: { i: h.id, c: h.cwd, a: h.createdAt, o: h.originator, s: h.sourceKind, ph: h.prompt.promptHash, th: h.prompt.titleHash, tp: h.prompt.titlePreview, tl: h.prompt.titleLen, dp: h.prompt.displayPreview, dtr: h.prompt.displayTruncated } });
    const whole = line(h1, "/t1") + "\n" + line(h2, "/t2") + "\n";
    // Simulate a crash mid-write: the last line is truncated, no newline.
    writeFileSync(v3Path, whole.slice(0, whole.length - 40));
    const store = storeFor(dir);
    await store.ready();
    expect(store.get("/t1")?.id).toBe("t1"); // first record intact
    expect(store.get("/t2")).toBeUndefined(); // torn record skipped
    // The next flush must not concatenate into the torn fragment.
    store.set("/fresh", head("fresh", "fresh after crash"));
    expect(await store.flushNow()).toBe(true);
    const reloaded = storeFor(dir);
    await reloaded.ready();
    expect(reloaded.get("/t1")?.id).toBe("t1");
    expect(reloaded.get("/fresh")?.id).toBe("fresh"); // not lost to concatenation
    expect(reloaded.get("/t2")).toBeUndefined();
    // And the record right after the torn line is well-formed on disk.
    const text = readFileSync(v3Path, "utf8");
    const lastLine = text.trimEnd().split("\n").pop() ?? "";
    expect(() => JSON.parse(lastLine)).not.toThrow();
  });
});

describe("event-loop responsiveness during migration", () => {
  test("a ~40MB v2 migrates without a long event-loop stall", async () => {
    const dir = join(tempRoot("responsive"), "d");
    mkdirSync(dir, { recursive: true });
    const heads: Record<string, unknown> = {};
    const filler = "f".repeat(64 * 1024); // 64KB filler per prompt
    for (let i = 0; i < 600; i++) {
      heads[`/big/${i}`] = { id: `big-${i}`, cwd: `/w/${i}`, createdAt: i, firstUserText: `prompt ${i} ` + filler, originator: null, sourceKind: null };
    }
    const v2Path = join(dir, "codex-heads.json");
    writeFileSync(v2Path, JSON.stringify({ version: 2, heads }));
    const size = readFileSync(v2Path).length;
    expect(size).toBeGreaterThan(30 * 1024 * 1024);

    let maxGap = 0;
    let last = performance.now();
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 5);
    (timer as unknown as { unref?: () => void }).unref?.();

    const t0 = performance.now();
    const store = storeFor(dir);
    await store.ready();
    const wall = performance.now() - t0;
    clearInterval(timer);
    expect(store.get("/big/599")?.id).toBe("big-599");
    expect(store.stats().migrated).toBe(true);
    expect(ticks).toBeGreaterThan(10); // the loop really kept running
    expect(maxGap).toBeLessThan(150); // no long stall (baseline JSON.parse blocks for seconds)
    const v3Size = readFileSync(join(dir, "codex-heads-v3.jsonl")).length;
    expect(v3Size).toBeLessThan(600 * 1024); // ≤1KB per entry, prompt-free
    expect(v3Size).toBeLessThan(size / 50); // compact by orders of magnitude
    console.log(`[v3-responsiveness] v2=${(size / 1e6).toFixed(1)}MB wall=${wall.toFixed(0)}ms maxGap=${maxGap.toFixed(1)}ms ticks=${ticks} v3=${(v3Size / 1024).toFixed(0)}KB`);
  }, 60_000);
});

describe("integration through sessions.codexThreads", () => {
  test("the live session history serves cached heads and still parses uncached rollouts", async () => {
    const root = tempRoot("integration");
    const dataDir = join(root, "data");
    const rolloutRoot = join(root, "codex-sessions");
    const dayDir = join(rolloutRoot, "2026", "11", "02");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dayDir, { recursive: true });

    const cachedId = "cached-id-not-in-any-file"; // only the cache knows it
    const parsedId = "12345678-1234-4781-8234-123456789abc";
    const historyId = "history-cache-id";
    const cachedPath = join(dayDir, "rollout-2026-11-02T10-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
    const parsedPath = join(dayDir, `rollout-2026-11-02T11-00-00-${parsedId}.jsonl`);
    const historyPath = join(dayDir, "rollout-2026-11-02T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl");
    // Keyword and tail sit well past the 280-char display preview.
    const longPrompt = "H".repeat(300) + " needlepastpreview " + "T".repeat(120) + " tailend789";
    const metaLine = (id: string) =>
      JSON.stringify({ timestamp: "2026-11-02T10:00:05.000Z", type: "session_meta", payload: { id, cwd: "/w/integration", originator: "codex_cli_rs", source: "cli" } });
    const userLine = (msg: string) =>
      JSON.stringify({ timestamp: "2026-11-02T10:00:06.000Z", type: "event_msg", payload: { type: "user_message", message: msg } });
    writeFileSync(cachedPath, metaLine("ffffffff-ffff-4fff-8fff-ffffffffffff") + "\n" + userLine("cached rollout prompt") + "\n");
    writeFileSync(parsedPath, metaLine(parsedId) + "\n" + userLine("live parsed prompt") + "\n");
    writeFileSync(historyPath, metaLine("bbbbbbbb-cccc-4ccc-8ccc-cccccccccccc") + "\n" + userLine(longPrompt) + "\n");
    // Portable fingerprint: pin a whole-second mtime BEFORE the first index,
    // so the value captured in the fingerprint store is identical on Linux
    // (Bun truncates fractional ms) and macOS for the unchanged-fingerprint
    // probe below.
    const { statSync } = await import("node:fs");
    const wholeMs = Math.floor(Date.parse("2026-11-02T12:30:00.000Z") / 1000) * 1000;
    utimesSync(historyPath, new Date(wholeMs), new Date(wholeMs));

    // Seed the v3 cache: the cached rollout is claimed under an id that ONLY
    // exists in the cache — if codexThreads reparsed the file, that id would
    // never surface. The uncached rollout must come from a live parse.
    const seeding = storeFor(dataDir);
    await seeding.ready();
    seeding.set(cachedPath, head(cachedId, "cached rollout prompt"));
    seeding.set(historyPath, head(historyId, longPrompt));
    expect(await seeding.flushNow()).toBe(true);
    const seededHistory = seeding.get(historyPath);
    expect(seededHistory?.prompt.displayTruncated).toBe(true);
    expect(seededHistory?.prompt.displayPreview.includes("needlepastpreview")).toBe(false); // genuinely past the cap

    const realHome = process.env.HOME;
    const realData = PATHS.data;
    const realCodexSessions = PATHS.codexSessions;
    process.env.HOME = root; // keep every other scan (claude/grok/cursor) empty
    const tag = Math.random().toString(36).slice(2);
    try {
      // Mutate the CANONICAL config instance: a fresh sessions.ts import
      // reuses it (only the sessions module itself is cache-busted).
      PATHS.data = dataDir;
      PATHS.codexSessions = rolloutRoot;
      const mod = (await import(`./sessions.ts?it-${tag}`)) as typeof import("./sessions.ts");
      const { sessions } = await mod.queryResumable({});
      const ids = new Set(sessions.map((s) => s.sessionId));
      expect(ids.has(cachedId)).toBe(true); // served from the v3 cache
      expect(ids.has("ffffffff-ffff-4fff-8fff-ffffffffffff")).toBe(false); // file's own id never surfaced ⇒ no reparse
      expect(ids.has(parsedId)).toBe(true); // uncached rollout parsed on demand
      const parsedRow = sessions.find((s) => s.sessionId === parsedId);
      expect(parsedRow?.lastUserText).toBe("live parsed prompt");
      const cachedRow = sessions.find((s) => s.sessionId === cachedId);
      expect(cachedRow?.lastUserText).toBe("cached rollout prompt");

      // History-search regression: a keyword past the 280-char preview must
      // still match, the row keeps the FULL prompt, and the persisted cache
      // stays compact (no full-prompt bytes on disk).
      const found = await mod.queryResumable({ search: "needlepastpreview" });
      const row = found.sessions.find((s) => s.sessionId === historyId);
      expect(row).toBeDefined();
      expect(row?.lastUserText).toContain("needlepastpreview");
      expect(row?.lastUserText).toContain("tailend789"); // full prompt, not the preview
      expect(row!.lastUserText!.length).toBeGreaterThan(280);
      expect(row!.lastUserText!.endsWith("…")).toBe(false);
      const v3Bytes = readFileSync(join(dataDir, "codex-heads-v3.jsonl"), "utf8");
      expect(v3Bytes.includes("needlepastpreview")).toBe(false);
      expect(v3Bytes.includes("tailend789")).toBe(false);
      expect(v3Bytes.includes("T".repeat(40))).toBe(false);

      // Unchanged fingerprint ⇒ no re-read: swap the file's content but keep
      // its exact whole-second mtime; a fingerprint-gated refresh must not
      // pick it up.
      const mtime1 = statSync(historyPath).mtimeMs;
      expect(mtime1).toBe(wholeMs); // precondition: the pinned value stuck
      writeFileSync(historyPath, metaLine("bbbbbbbb-cccc-4ccc-8ccc-cccccccccccc") + "\n" + userLine("Z".repeat(300) + " differentneedle999") + "\n");
      utimesSync(historyPath, new Date(wholeMs), new Date(wholeMs));
      expect(statSync(historyPath).mtimeMs).toBe(wholeMs); // precondition: the probe is valid
      await mod.refreshResumableCache({ force: true });
      expect((await mod.queryResumable({ search: "needlepastpreview" })).sessions.some((s) => s.sessionId === historyId)).toBe(true); // skip kept the row
      expect((await mod.queryResumable({ search: "differentneedle999" })).sessions.some((s) => s.sessionId === historyId)).toBe(false); // …and did not re-read

      // Changed fingerprint + promptless rollout ⇒ careful fallback keeps the
      // stored full text. The body is rewritten to a readable but promptless
      // transcript (session_meta only — no first user message), so
      // firstUserTextFromTop returns null regardless of UID; chmod-based
      // unreadability is not portable under root or user namespaces.
      writeFileSync(historyPath, metaLine("bbbbbbbb-cccc-4ccc-8ccc-cccccccccccc") + "\n");
      utimesSync(historyPath, new Date(wholeMs + 5000), new Date(wholeMs + 5000));
      await mod.refreshResumableCache({ force: true });
      const preserved = await mod.queryResumable({ search: "needlepastpreview" });
      const prow = preserved.sessions.find((s) => s.sessionId === historyId);
      expect(prow).toBeDefined(); // still searchable…
      expect(prow?.lastUserText).toContain("tailend789"); // …with the FULL stored text
      expect(prow!.lastUserText!.endsWith("…")).toBe(false); // not the preview
    } finally {
      process.env.HOME = realHome;
      PATHS.data = realData;
      PATHS.codexSessions = realCodexSessions;
    }
  }, 30_000);

});
