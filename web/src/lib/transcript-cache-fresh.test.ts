import { beforeEach, expect, test } from "bun:test";
import { clearTranscriptCache, prefetchTranscripts, readTranscriptCache } from "./transcript-cache";

const tick = () => new Promise((r) => setTimeout(r, 700));
const page = (text: string) => ({
  messages: [{ id: text, role: "assistant", parts: [{ type: "text", text }] } as never],
  nextBefore: null,
});

beforeEach(() => clearTranscriptCache());

test("a session prefetched while busy is fetched again once it goes idle", async () => {
  let calls = 0;
  let answer = "half";
  const load = async () => { calls += 1; return page(answer); };
  prefetchTranscripts(["s1@busy"], load);
  await tick();
  expect(calls).toBe(1);
  // Still running: more activity, same stamp, no refetch.
  prefetchTranscripts(["s1@busy"], load);
  await tick();
  expect(calls).toBe(1);
  // Finished: new stamp, one refetch, and the cache now holds the final page.
  answer = "final";
  prefetchTranscripts(["s1@1794040000000"], load);
  await tick();
  expect(calls).toBe(2);
  expect((readTranscriptCache("s1")?.messages[0] as { id: string }).id).toBe("final");
  // Same idle stamp again: nothing to do.
  prefetchTranscripts(["s1@1794040000000"], load);
  await tick();
  expect(calls).toBe(2);
});

test("plain ids without a stamp keep the old once-per-session behaviour", async () => {
  let calls = 0;
  const load = async () => { calls += 1; return page("x"); };
  prefetchTranscripts(["s2"], load);
  await tick();
  prefetchTranscripts(["s2"], load);
  await tick();
  expect(calls).toBe(1);
});
