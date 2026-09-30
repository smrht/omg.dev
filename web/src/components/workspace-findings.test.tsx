import { afterEach, beforeEach, expect, test } from "bun:test";
import { mount, type Mounted } from "../test-support/render";

const { WorkspaceFindingsMenu } = await import("./workspace-findings");

// The global document, not the harness module's window: the popover portals
// into document.body, outside the mounted host.
const body = () => document.body;
const trigger = () =>
  body().querySelector('[data-testid="workspace-findings-trigger"]') as HTMLButtonElement | null;
const popup = () => body().querySelector('[data-testid="workspace-findings-popover"]');

type Finding = { id: string; agentId: string; title: string; severity: "high" | "med" | "low"; createdAt: number };

const now = 1_700_000_000_000;
const findings: Finding[] = [
  { id: "f1", agentId: "watcher", title: "Fleet Health degraded", severity: "high", createdAt: now },
  { id: "f2", agentId: "watcher", title: "Disk almost full", severity: "med", createdAt: now - 5_000 },
  { id: "f3", agentId: "deployer", title: "Deploy failed", severity: "low", createdAt: now - 9_000 },
];
const nameFor = (id: string) => (id === "watcher" ? "Fleet Health" : id);

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

type Calls = {
  opened: string[];
  triaged: (Finding[] | undefined)[];
  cleared: Finding[][];
  triageHeader: number[];
};

function renderMenu(calls: Calls) {
  ui.render(
    <WorkspaceFindingsMenu<Finding>
      findings={findings}
      nameFor={nameFor}
      onOpenReport={(agentId) => calls.opened.push(agentId)}
      onTriageFindings={(targets) => calls.triaged.push(targets)}
      onClearFindings={(targets) => calls.cleared.push(targets)}
      actions={
        <button type="button" data-testid="header-triage" onClick={() => calls.triageHeader.push(1)}>
          Triage
        </button>
      }
    />,
  );
}

async function openMenu(calls: Calls) {
  renderMenu(calls);
  expect(popup()).toBeNull();
  ui.flush(() => trigger()!.click());
  await ui.flushAsync();
  expect(popup()).not.toBeNull();
}

test("the trigger names the count and the popover lists one row per agent", async () => {
  const calls: Calls = { opened: [], triaged: [], cleared: [], triageHeader: [] };
  await openMenu(calls);
  expect(trigger()!.textContent).toContain("3 updates");
  // Grouped by agent, worst severity first: watcher (high) leads deployer (low).
  expect(popup()!.textContent).toContain("3 open");
  expect(popup()!.textContent).toContain("Fleet Health");
  expect(popup()!.textContent!.indexOf("Fleet Health")).toBeLessThan(
    popup()!.textContent!.indexOf("deployer"),
  );
});

test("Escape closes the popover and the trigger toggles it closed", async () => {
  const calls: Calls = { opened: [], triaged: [], cleared: [], triageHeader: [] };
  await openMenu(calls);
  ui.flush(() => body().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await ui.flushAsync();
  expect(popup()).toBeNull();

  ui.flush(() => trigger()!.click());
  await ui.flushAsync();
  expect(popup()).not.toBeNull();
  ui.flush(() => trigger()!.click());
  await ui.flushAsync();
  expect(popup()).toBeNull();
});

test("opening a report closes the popover and reports the agent", async () => {
  const calls: Calls = { opened: [], triaged: [], cleared: [], triageHeader: [] };
  await openMenu(calls);
  // The row's open button is the one carrying the agent's name.
  const row = Array.from(popup()!.querySelectorAll("button")).find((b) =>
    b.textContent!.includes("Fleet Health"),
  )!;
  ui.flush(() => row.click());
  await ui.flushAsync();
  expect(calls.opened).toEqual(["watcher"]);
  expect(popup()).toBeNull();
});

test("clear runs the two-step confirm and hands over every finding; triage reaches both callbacks", async () => {
  const calls: Calls = { opened: [], triaged: [], cleared: [], triageHeader: [] };
  await openMenu(calls);
  // Header triage is the caller's own control (AutoTriageButton in App.tsx).
  ui.flush(() => (body().querySelector('[data-testid="header-triage"]') as HTMLButtonElement).click());
  expect(calls.triageHeader.length).toBe(1);

  // Per-row triage passes only that agent's findings.
  const rowTriage = body().querySelector(
    'button[aria-label^="Triage and execute"]',
  ) as HTMLButtonElement;
  ui.flush(() => rowTriage.click());
  expect(calls.triaged.length).toBe(1);
  expect(calls.triaged[0]!.every((f) => f.agentId === "watcher")).toBe(true);
  expect(calls.triaged[0]!.length).toBe(2);

  // Clear is two-step in ClearFindingsButton; the second click delivers all.
  const clear = () =>
    Array.from(popup()!.querySelectorAll("button")).find((b) =>
      b.textContent!.startsWith("Clear all"),
    ) as HTMLButtonElement;
  ui.flush(() => clear().click());
  expect(calls.cleared).toEqual([]);
  ui.flush(() => clear().click());
  expect(calls.cleared.length).toBe(1);
  expect(calls.cleared[0]!.length).toBe(3);
});

test("the popup is a labelled dialog portalled outside the header box", async () => {
  const calls: Calls = { opened: [], triaged: [], cleared: [], triageHeader: [] };
  await openMenu(calls);
  // Screen readers get a name for the dialog.
  expect(popup()!.getAttribute("aria-label")).toBe("Updates");
  // The whole point of the popover: it lives in document.body, not inside
  // the 48px header that clipped the rail's inline panel. Real geometry is
  // proven by the live bounds check, not mirrored here.
  expect(body().contains(popup()!)).toBe(true);
  expect(popup()!.closest("header")).toBeNull();
});

test("a triage run in flight disables the per-report triage buttons", async () => {
  const calls: Calls = { opened: [], triaged: [], cleared: [], triageHeader: [] };
  ui.render(
    <WorkspaceFindingsMenu<Finding>
      findings={findings}
      nameFor={nameFor}
      onOpenReport={(agentId) => calls.opened.push(agentId)}
      onTriageFindings={(targets) => calls.triaged.push(targets)}
      onClearFindings={(targets) => calls.cleared.push(targets)}
      triageBusy
    />,
  );
  ui.flush(() => trigger()!.click());
  await ui.flushAsync();
  const rowTriage = body().querySelectorAll('button[aria-label^="Triage and execute"]');
  expect(rowTriage.length).toBeGreaterThan(0);
  for (const button of Array.from(rowTriage)) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  ui.flush(() => (rowTriage[0] as HTMLButtonElement).click());
  expect(calls.triaged).toEqual([]);
});
