import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "../config.ts";

const originalData = PATHS.data;
let testData = "";
let store: typeof import("./store.ts");

beforeAll(async () => {
  testData = await mkdtemp(join(tmpdir(), "omg-auto-store-concurrency-"));
  PATHS.data = testData;
  store = await import("./store.ts");
});

afterAll(async () => {
  PATHS.data = originalData;
  await rm(testData, { recursive: true, force: true });
});

describe("auto-agent store concurrency", () => {
  test("parallel saves retain every distinct schedule", async () => {
    const count = 64;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.saveAutoAgent({
          id: `parallel-${index}`,
          name: `Parallel ${index}`,
          prompt: "test",
          schedule: "0 9 * * *",
          enabled: true,
        }),
      ),
    );

    const rows = await store.listAutoAgents();
    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((row) => row.id)).size).toBe(count);
  });
});
