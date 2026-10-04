import { afterEach, beforeEach, expect, test } from "bun:test";
import { mount, type Mounted } from "../test-support/render";
const { DesktopWorkspace } = await import("./desktop-workspace");

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

const base = {
  brand: <span data-testid="ws-brand">omg</span>,
  surface: "sessions" as const,
  onOpenSessions: () => {},
  onOpenBots: () => {},
  onOpenAuto: () => {},
  onOpenComputer: () => {},
  onOpenSettings: () => {},
  projectFilter: "__all",
  projectOptions: ["__no_project", "/repos/alpha", "/repos/beta"],
  onProjectChange: (_v: string) => {},
  projectLabel: (v: string) => (v === "__all" ? "All projects" : v === "__no_project" ? "No project" : v.split("/").pop()!),
  composer: <div data-testid="ws-composer">composer</div>,
  onOpenStage: (_sid: string) => {},
  listScrollMemory: { current: 0 },
};

const navButton = (label: string) =>
  ui.query(`nav button[title="${label}"]`) as HTMLButtonElement | null;

test("renders the shell: header, broad composer, toolbar above list and summary", () => {
  ui.render(
    <DesktopWorkspace {...base} conversationsToolbar={<div data-testid="ws-toolbar">toolbar</div>}>
      <div data-testid="ws-row">row</div>
    </DesktopWorkspace>,
  );
  expect(ui.text()).toContain("Werkruimte");
  expect(ui.query('[data-testid="ws-composer"]')).not.toBeNull();
  expect(ui.query('[data-testid="ws-toolbar"]')).not.toBeNull();
  expect(ui.query('[data-testid="ws-row"]')).not.toBeNull();
  // The toolbar sits above BOTH columns: it precedes the list container in
  // the tree, and the summary aside comes after it too.
  const toolbar = ui.query('[data-testid="ws-toolbar"]')!;
  const list = ui.query('[data-testid="workspace-conversations"]')!;
  const aside = ui.query('aside[aria-label="Geselecteerd gesprek"]')!;
  expect(toolbar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(toolbar.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("global nav marks the active surface and wires Computer and Instellingen", () => {
  const opened: string[] = [];
  ui.render(
    <DesktopWorkspace
      {...base}
      surface="sessions"
      onOpenBots={() => opened.push("bots")}
      onOpenComputer={() => opened.push("computer")}
      onOpenSettings={() => opened.push("settings")}
    >
      <div>rows</div>
    </DesktopWorkspace>,
  );
  expect(navButton("Chats")?.getAttribute("aria-current")).toBe("page");
  expect(navButton("Bots")?.getAttribute("aria-current")).toBeNull();
  ui.flush(() => navButton("Bots")!.click());
  ui.flush(() => navButton("Computer")!.click());
  ui.flush(() => navButton("Instellingen")!.click());
  expect(opened).toEqual(["bots", "computer", "settings"]);
});

test("a hidden surface stays out of sight: showBots=false removes the Bots door", () => {
  ui.render(
    <DesktopWorkspace {...base} showBots={false}>
      <div>rows</div>
    </DesktopWorkspace>,
  );
  expect(navButton("Bots")).toBeNull();
  expect(navButton("Chats")).not.toBeNull();
});

test("the project selector shows the current scope and reports a new one", () => {
  const changes: string[] = [];
  ui.render(
    <DesktopWorkspace {...base} projectFilter="/repos/alpha" onProjectChange={(v) => changes.push(v)}>
      <div>rows</div>
    </DesktopWorkspace>,
  );
  const select = ui.query('select[aria-label="Project"]') as HTMLSelectElement;
  expect(select).not.toBeNull();
  // Trigger shows the sentinel-aware label of the active scope.
  expect(ui.query('label[title="Project"]')?.textContent).toContain("alpha");
  expect([...select.options].map((o) => o.value)).toEqual([
    "__all",
    "__no_project",
    "/repos/alpha",
    "/repos/beta",
  ]);
  ui.flush(() => {
    select.value = "/repos/beta";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(changes).toEqual(["/repos/beta"]);
});

test("without a selection the summary pane is a placeholder with no Open gesprek", () => {
  ui.render(
    <DesktopWorkspace {...base} selectedSid={null} summary={null}>
      <div>rows</div>
    </DesktopWorkspace>,
  );
  const aside = ui.query('aside[aria-label="Geselecteerd gesprek"]')!;
  expect(aside.textContent).toContain("Kies een gesprek");
  expect(ui.text()).not.toContain("Open gesprek");
});

test("a selection renders the roster summary and Open gesprek promotes it to the stage", () => {
  const opened: string[] = [];
  ui.render(
    <DesktopWorkspace
      {...base}
      selectedSid="sess-1"
      summary={{
        title: "Fix the login flow",
        meta: "alpha · claude · 2m",
        status: "Bezig",
        body: "Ik heb de test gefixt en draai de suite opnieuw.",
      }}
      onOpenStage={(sid) => opened.push(sid)}
    >
      <div>rows</div>
    </DesktopWorkspace>,
  );
  const aside = ui.query('aside[aria-label="Geselecteerd gesprek"]')!;
  expect(aside.textContent).toContain("Fix the login flow");
  expect(aside.textContent).toContain("alpha · claude · 2m");
  expect(aside.textContent).toContain("Bezig");
  expect(aside.textContent).toContain("Ik heb de test gefixt");
  const open = [...aside.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Open gesprek"),
  ) as HTMLButtonElement;
  expect(open).toBeTruthy();
  // The button sits UNDER the summary text, not as a chrome row above it.
  const body = [...aside.querySelectorAll("p")].find((p) =>
    p.textContent?.includes("Ik heb de test"),
  )!;
  expect(open.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  ui.flush(() => open.click());
  expect(opened).toEqual(["sess-1"]);
});

test("the list mirrors its scroll offset into the parent-owned memory", () => {
  ui.render(
    <DesktopWorkspace {...base}>
      <div>rows</div>
    </DesktopWorkspace>,
  );
  const list = ui.query('[data-testid="workspace-conversations"]') as HTMLElement;
  let top = 0;
  Object.defineProperty(list, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  ui.flush(() => {
    top = 140;
    list.dispatchEvent(new Event("scroll"));
  });
  expect(base.listScrollMemory.current).toBe(140);
});

test("returning to the workspace restores the remembered scroll offset", () => {
  const memory = { current: 96 };
  const props = { ...base, listScrollMemory: memory };
  // Hidden while the full stage is up (active=false must not touch scroll).
  ui.render(
    <DesktopWorkspace {...props} active={false}>
      <div>rows</div>
    </DesktopWorkspace>,
  );
  const list = ui.query('[data-testid="workspace-conversations"]') as HTMLElement;
  const written: number[] = [];
  let top = 0;
  Object.defineProperty(list, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = v;
      written.push(v);
    },
    configurable: true,
  });
  expect(written).toEqual([]);
  // "← Gesprekken": the same mounted tree becomes active again, and the
  // remembered offset lands back on the scroll container.
  ui.render(
    <DesktopWorkspace {...props} active>
      <div>rows</div>
    </DesktopWorkspace>,
  );
  expect(written).toEqual([96]);
  expect(memory.current).toBe(96);
});

test("a hidden container's zero-scroll event cannot erase the return position", () => {
  const memory = { current: 144 };
  ui.render(<DesktopWorkspace {...base} active={false} listScrollMemory={memory}><div>rows</div></DesktopWorkspace>);
  const list = ui.query('[data-testid="workspace-conversations"]') as HTMLElement;
  ui.flush(() => { list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); });
  expect(memory.current).toBe(144);
  ui.render(<DesktopWorkspace {...base} active listScrollMemory={memory}><div>rows</div></DesktopWorkspace>);
  expect(list.scrollTop).toBe(144);
});
