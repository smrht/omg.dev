import { describe, expect, test } from "bun:test";
import { AutoRunTimeout, DEFAULT_AUTO_MAX_RUNTIME_MINUTES, autoRunMaxRuntimeMs, workerCommand } from "./omg-isolation-runtime.ts";

describe("auto run max runtime", () => {
  test("defaults to 60 minutes", () => {
    expect(DEFAULT_AUTO_MAX_RUNTIME_MINUTES).toBe(60);
    expect(autoRunMaxRuntimeMs({ id: "a" }, {})).toBe(60 * 60_000);
  });
  test("agent override wins over env and default", () => {
    expect(autoRunMaxRuntimeMs({ maxRuntimeMinutes: 300 }, { OMG_AUTO_MAX_RUNTIME_MINUTES: "90" })).toBe(300 * 60_000);
    expect(autoRunMaxRuntimeMs({}, { OMG_AUTO_MAX_RUNTIME_MINUTES: "90" })).toBe(90 * 60_000);
  });
  test("bad values never switch the limit off", () => {
    for (const v of [0, -5, NaN, "x", null, undefined]) {
      expect(autoRunMaxRuntimeMs({ maxRuntimeMinutes: v }, { OMG_AUTO_MAX_RUNTIME_MINUTES: "nope" })).toBe(60 * 60_000);
    }
    expect(autoRunMaxRuntimeMs({ maxRuntimeMinutes: 0.1 }, {})).toBe(60_000);
    expect(autoRunMaxRuntimeMs({ maxRuntimeMinutes: 1e9 }, {})).toBe(24 * 60 * 60_000);
  });
  test("non-object agents fall back to the default", () => {
    expect(autoRunMaxRuntimeMs(undefined, {})).toBe(60 * 60_000);
    expect(autoRunMaxRuntimeMs("x", {})).toBe(60 * 60_000);
  });
  test("timeout error names the limit", () => {
    const e = new AutoRunTimeout(300 * 60_000);
    expect(e.message).toContain("300 min");
    expect(e).toBeInstanceOf(Error);
  });
  test.if(process.platform === "linux")("systemd backstop is set only when asked", () => {
    const withLimit = workerCommand(["true"], "omg-auto-test-1", "/tmp", undefined, 3660);
    expect(withLimit).toContain("--property=RuntimeMaxSec=3660");
    expect(withLimit).toContain("--slice=lfg-agents.slice");
    const without = workerCommand(["true"], "omg-auto-test-2", "/tmp");
    expect(without.some((a) => a.startsWith("--property=RuntimeMaxSec"))).toBe(false);
  });
});
