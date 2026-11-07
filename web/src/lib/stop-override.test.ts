import { describe, expect, test } from "bun:test";
import { applyStopOverrides, clearStopped, isStopped, markStopped, STOP_OVERRIDE_MS } from "./stop-override";

describe("stop override", () => {
  test("a stopped chat reads idle while the server still says busy", () => {
    markStopped("a");
    expect(applyStopOverrides({ a: true, b: true }, { a: true, b: true })).toEqual({ a: false, b: true });
    clearStopped("a");
  });
  test("the server reporting idle retires the override", () => {
    markStopped("c");
    applyStopOverrides({ c: false }, { c: false });
    expect(isStopped("c")).toBe(false);
  });
  test("sending again clears it, and it expires on its own", () => {
    markStopped("d");
    clearStopped("d");
    expect(applyStopOverrides({ d: true }, { d: true })).toEqual({ d: true });
    markStopped("e", Date.now() - STOP_OVERRIDE_MS - 1);
    expect(applyStopOverrides({ e: true }, { e: true })).toEqual({ e: true });
  });
});
