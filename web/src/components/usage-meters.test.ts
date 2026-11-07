import { beforeEach, expect, setSystemTime, test, afterEach } from "bun:test";
import type { ProviderUsage } from "@/lib/usage";
import "../test-support/render"; // installeert happy-dom (localStorage)

const { metLaatsteStand, leftPct, tightestWindow } = await import("./usage-meters");

const goed: ProviderUsage = {
  id: "claude",
  kind: "claude",
  label: "Claude",
  available: true,
  windows: [
    { label: "5 h", pct: 40, resetsAt: null },
    { label: "7 day", pct: 80, resetsAt: null },
  ],
} as ProviderUsage;

const kapot: ProviderUsage = {
  ...goed,
  windows: [
    { label: "5 h", pct: null, resetsAt: null },
    { label: "7 day", pct: null, resetsAt: null },
  ],
  note: "Usage endpoint returned 429",
} as ProviderUsage;

beforeEach(() => localStorage.clear());
afterEach(() => setSystemTime());

test("a good reading is shown as is and saved", () => {
  const shown = metLaatsteStand(goed);
  expect(shown.standVan).toBeUndefined();
  expect(shown.windows).toEqual(goed.windows);
  expect(localStorage.getItem("agentbox:usage-stand")).toContain("claude");
});

test("a failed source falls back to the last good reading, marked with its time", () => {
  setSystemTime(new Date("2026-11-07T14:02:00"));
  metLaatsteStand(goed);
  setSystemTime(new Date("2026-11-07T14:20:00"));
  const shown = metLaatsteStand(kapot);
  expect(shown.windows).toEqual(goed.windows);
  expect(shown.standVan).toBe(new Date("2026-11-07T14:02:00").getTime());
  expect(shown.note).toBe("Usage endpoint returned 429");
  // het venster dat het eerst op is: week, 20% over
  const w = tightestWindow(shown.windows)!;
  expect(leftPct(w)).toBe(20);
});

test("a reading older than 12 hours is not shown; the dash stays", () => {
  setSystemTime(new Date("2026-11-07T01:00:00"));
  metLaatsteStand(goed);
  setSystemTime(new Date("2026-11-07T13:30:00"));
  const shown = metLaatsteStand(kapot);
  expect(shown.standVan).toBeUndefined();
  expect(shown.windows?.every((w) => w.pct == null)).toBe(true);
});

test("a source that never reported keeps its dash", () => {
  const shown = metLaatsteStand(kapot);
  expect(shown.standVan).toBeUndefined();
  expect(tightestWindow(shown.windows)).toBeNull();
});
