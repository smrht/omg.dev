import { describe, expect, test } from "bun:test";

describe("Sam fork: restart-safe headless schedules", () => {
  test("headless runs stamp lastRunAt in finally, while bot delivery stamps before dispatch", async () => {
    const source = await Bun.file(new URL("./scheduler.ts", import.meta.url)).text();
    const botBranch = source.indexOf('if (a.owner.kind === "bot") {');
    const headlessRun = source.indexOf("await runAutoAgent(a, onLog)");
    const finallyBlock = source.indexOf("} finally {", headlessRun);
    const botStamp = source.indexOf("await setLastRun(a.id, now.getTime())", botBranch);
    const headlessStamp = source.indexOf("await setLastRun(a.id, Date.now())", finallyBlock);

    expect(botBranch).toBeGreaterThanOrEqual(0);
    expect(botStamp).toBeGreaterThan(botBranch);
    expect(botStamp).toBeLessThan(headlessRun);
    expect(finallyBlock).toBeGreaterThan(headlessRun);
    expect(headlessStamp).toBeGreaterThan(finallyBlock);
  });
});
