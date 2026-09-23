import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "../config.ts";

const originalData = PATHS.data;
let testData = "";
let store: typeof import("./store.ts");

beforeAll(async () => {
  testData = await mkdtemp(join(tmpdir(), "omg-auto-project-cwd-"));
  PATHS.data = testData;
  store = await import("./store.ts");
});

afterAll(async () => {
  PATHS.data = originalData;
  await rm(testData, { recursive: true, force: true });
});

describe("auto-agent logical project cwd", () => {
  test("project assignment survives an execution-only edit", async () => {
    await store.saveAutoAgent({
      id: "separate",
      name: "Separate",
      prompt: "p",
      schedule: "0 9 * * *",
      enabled: true,
      cwd: "/small/control-plane",
      projectCwd: "/large/portfolio",
    });
    const edited = await store.saveAutoAgent({
      id: "separate",
      name: "Separate",
      prompt: "p2",
      schedule: "0 10 * * *",
      enabled: true,
      cwd: "/other/control-plane",
    });
    expect(edited.cwd).toBe("/other/control-plane");
    expect(edited.projectCwd).toBe("/large/portfolio");
  });
});
