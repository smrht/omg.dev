/**
 * Integration coverage for the explicit execution host in the new-session
 * composer: the default per composer (Agentbox, nothing remembered), the
 * default per LAUNCH (an accepted create and a close/reopen both retire an
 * explicit pick in the same mounted composer), the captured host for a
 * pending request and its agent-cap retry, the
 * POST /api/sessions/new payload, the visible disabled Mac with its reason,
 * and the no-silent-fallback rule when a status change arrives while Mac is
 * the explicit choice. The transport is stubbed through the same seam an
 * embedded host uses (configureOmgTransport), so these run against the real
 * composer, not a mock of it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { mount, type Mounted } from "./test-support/render";

const { configureOmgTransport } = await import("./lib/omg-client");
const { NewSessionDialog } = await import("./App");
const { createSameOriginTransport } = await import("@omg-dev/client");
const { Toaster } = await import("./components/ui/sonner");

let ui: Mounted;
beforeEach(() => {
  ui = mount();
  // Portaled leftovers from the previous test (Base UI popovers mid-exit,
  // sonner regions) sit directly under body and outlive the unmounted root.
  // Drop them so the body-wide queries below (the drawer portals through
  // Vaul, so host-scoped queries cannot see its composer) stay scoped to
  // THIS test's tree.
  for (const child of [...document.body.children]) {
    if (child !== ui.host) child.remove();
  }
});
afterEach(() => {
  ui.cleanup();
  configureOmgTransport(createSameOriginTransport());
  localStorage.clear();
});

type Recorded = { path: string; body: Record<string, unknown> };

function installTransport(handlers: {
  executionHosts: unknown | ((path: string) => unknown | Promise<unknown>);
  /** Scripted /api/sessions/new answers, in call order. Return an Error
   * instance to reject that call; without a script every call succeeds. */
  create?: (call: number) => unknown | Promise<unknown>;
  onRequest?: (entry: Recorded) => void;
}) {
  const entries: Recorded[] = [];
  let createCalls = 0;
  const transport = {
    fetch: async () => new Response("{}"),
    request: async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const entry = { path, body };
      entries.push(entry);
      if (path.startsWith("/api/execution-hosts")) {
        const answer =
          typeof handlers.executionHosts === "function"
            ? await (handlers.executionHosts as (p: string) => unknown | Promise<unknown>)(path)
            : handlers.executionHosts;
        if (answer instanceof Error) throw answer;
        return answer as T;
      }
      if (path === "/api/sessions/new" || path === "/api/sessions/new-unassigned") {
        createCalls += 1;
        const answer = handlers.create
          ? await handlers.create(createCalls)
          : { sessionId: `s-${entries.length}` };
        if (answer instanceof Error) throw answer;
        return answer as T;
      }
      return {} as T;
    },
    openSocket: async () => {
      throw new Error("no socket in this test");
    },
    openLiveSocket: async () => {
      throw new Error("no live socket in this test");
    },
  };
  configureOmgTransport(transport as never);
  return {
    entries,
    setExecutionHosts(payload: unknown) {
      handlers.executionHosts = payload;
    },
  };
}

const BOTH_AVAILABLE = {
  hosts: [
    { id: "agentbox", label: "Agentbox", available: true },
    { id: "mac", label: "Mac", available: true },
  ],
  defaultHost: "agentbox",
};

const MAC_UNAVAILABLE = {
  hosts: [
    { id: "agentbox", label: "Agentbox", available: true },
    { id: "mac", label: "Mac", available: false, reason: "op batterij" },
  ],
  defaultHost: "agentbox",
};

function renderComposer() {
  ui.render(
    <NewSessionDialog
      variant="stage"
      open
      repos={[{ name: "demo", cwd: "/Users/samht/.cache/mac-headchat-build-20261003/demo" }]}
      users={[]}
      defaultUser=""
      scopedProject="__all"
      onClose={() => {}}
      onCreated={async () => {}}
      onReposChanged={async () => {}}
    />,
  );
}

// The drawer variant: the component STAYS MOUNTED while closed (it renders
// null), which is exactly the lifecycle the reset has to survive. Re-render
// into the same root, like the parent flipping `newOpen`.
function renderDrawer(newOpen: boolean, withToaster = false) {
  ui.render(
    <>
      {withToaster ? <Toaster position="bottom-center" /> : null}
      <NewSessionDialog
        variant="drawer"
        open={newOpen}
        repos={[{ name: "demo", cwd: "/Users/samht/.cache/mac-headchat-build-20261003/demo" }]}
        users={[]}
        defaultUser=""
        scopedProject="__all"
        onClose={() => {}}
        onCreated={async () => {}}
        onReposChanged={async () => {}}
      />
    </>,
  );
}

// Body-wide, not host-scoped: the drawer variant portals its sheet through
// Vaul into document.body, so host queries miss the composer it owns.
function pickerTrigger(): HTMLButtonElement {
  const trigger = document.body.querySelector(
    'button[aria-haspopup="dialog"]',
  ) as HTMLButtonElement | null;
  if (!trigger) throw new Error("agent/model picker trigger not found");
  return trigger;
}

function openPicker() {
  act(() => {
    pickerTrigger().click();
  });
}

// The trigger toggles: close what openPicker opened.
function closePicker() {
  act(() => {
    pickerTrigger().click();
  });
}

function hostOption(id: string): HTMLButtonElement {
  const option = document.body.querySelector(
    `[data-testid="execution-host-${id}"]`,
  ) as HTMLButtonElement | null;
  if (!option) throw new Error(`host option ${id} not rendered`);
  return option;
}

function refreshButton(): HTMLButtonElement {
  const button = document.body.querySelector(
    '[data-testid="execution-host-refresh"]',
  ) as HTMLButtonElement | null;
  if (!button) throw new Error("execution host refresh button not rendered");
  return button;
}

function typePrompt(text: string) {
  const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement;
  if (!textarea) throw new Error("composer textarea not found");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(textarea),
      "value",
    )!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function startButton(): HTMLButtonElement {
  const button = document.body.querySelector(
    'button[type="submit"]',
  ) as HTMLButtonElement | null;
  if (!button) throw new Error("start button not found");
  return button;
}

function createBodies(entries: Recorded[]) {
  return entries
    .filter((entry) => entry.path === "/api/sessions/new")
    .map((entry) => entry.body);
}

test("a fresh composer starts on Agentbox and the payload says so explicitly", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderComposer();
  await ui.flushAsync();
  // The default is visible on the picker itself before anything is chosen.
  expect(pickerTrigger().title).toContain("Agentbox");

  typePrompt(" doe iets ");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();

  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.executionHost).toBe("agentbox");
  // The rest of the launch payload is untouched.
  expect(bodies[0]!.agent).toBe("aisdk");
  expect(bodies[0]!.prompt).toBe("doe iets");
});

test("choosing Mac sends Mac — and the next fresh composer is Agentbox again", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderComposer();
  await ui.flushAsync();

  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("MacBook M1");

  typePrompt("draai dit op de mac");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  expect(createBodies(transport.entries)[0]!.executionHost).toBe("mac");

  // A new composer never inherits the Mac pick: no global remember.
  const second = installTransport({ executionHosts: BOTH_AVAILABLE });
  ui.remount();
  renderComposer();
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("Agentbox");
  typePrompt("nog een chat");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  expect(createBodies(second.entries)[0]!.executionHost).toBe("agentbox");
});

test("an unavailable Mac is visibly disabled with its reason", async () => {
  installTransport({ executionHosts: MAC_UNAVAILABLE });
  renderComposer();
  await ui.flushAsync();

  openPicker();
  const mac = hostOption("mac");
  expect(mac.disabled).toBe(true);
  expect(document.body.textContent).toContain("op batterij");
  // Explicitly disabled: clicking it cannot select it.
  act(() => {
    mac.click();
  });
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("Agentbox");
});

test("a status change keeps the explicit Mac choice and blocks Start — no fallback", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderComposer();
  await ui.flushAsync();

  // Explicit Mac choice while Mac is available.
  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  typePrompt("mac alsjeblieft");
  expect(startButton().disabled).toBe(false);

  // The status flips: the next availability read (an agent switch) reports
  // Mac unavailable. The choice must survive; only Start blocks.
  transport.setExecutionHosts(MAC_UNAVAILABLE);
  openPicker();
  act(() => {
    (document.body.querySelector('button[aria-label="codex"]') as HTMLElement).click();
  });
  closePicker();
  await ui.flushAsync();

  expect(pickerTrigger().title).toContain("MacBook M1");
  expect(startButton().disabled).toBe(true);
  expect(ui.text()).toContain("MacBook M1 kan niet starten: op batterij");

  // A submit attempt through the form (Enter path) must not create anything.
  typePrompt("nog een poging");
  act(() => {
    ui.query("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await ui.flushAsync();
  expect(createBodies(transport.entries)).toHaveLength(0);

  // Mac returns: same composer, same choice, Start unblocked again.
  transport.setExecutionHosts(BOTH_AVAILABLE);
  openPicker();
  act(() => {
    (document.body.querySelector('button[aria-label="claude"]') as HTMLElement).click();
  });
  closePicker();
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("MacBook M1");
  expect(startButton().disabled).toBe(false);
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.executionHost).toBe("mac");
});

test("an endpoint fault leaves only Agentbox enabled, with a concrete Mac status", async () => {
  const transport = installTransport({
    executionHosts: new Error("endpoint down"),
  });
  renderComposer();
  await ui.flushAsync();

  openPicker();
  const mac = hostOption("mac");
  expect(mac.disabled).toBe(true);
  expect(document.body.textContent).toContain("Uitvoerstatus kon niet worden geladen");

  // Agentbox remains launchable: the default start still works.
  typePrompt("lokaal dan maar");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.executionHost).toBe("agentbox");
});

test("a server-side Mac default never becomes the composer's default", async () => {
  const transport = installTransport({
    executionHosts: {
      hosts: [
        { id: "agentbox", label: "Agentbox", available: true },
        { id: "mac", label: "MacBook M1", available: true },
      ],
      defaultHost: "mac",
    },
  });
  renderComposer();
  await ui.flushAsync();

  // The fresh composer selects Agentbox even though the endpoint answered
  // defaultHost: mac — and the actual POST carries that explicit choice.
  expect(pickerTrigger().title).toContain("Agentbox");
  typePrompt("gewoon een chat");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.executionHost).toBe("agentbox");
});

test("the explicit refresh keeps Mac selected through an availability flip — Start blocked, no POST, then through", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderComposer();
  await ui.flushAsync();

  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  typePrompt("op de mac");
  expect(startButton().disabled).toBe(false);

  // Mac drops out (battery, sleep, queue): the picker's refresh is what
  // surfaces that without an agent switch or a page reload. The choice
  // stays Mac; Start blocks with the concrete reason; nothing POSTs.
  transport.setExecutionHosts(MAC_UNAVAILABLE);
  openPicker();
  act(() => {
    refreshButton().click();
  });
  await ui.flushAsync();
  expect(hostOption("mac").disabled).toBe(true);
  expect(document.body.textContent).toContain("op batterij");
  expect(pickerTrigger().title).toContain("MacBook M1");
  closePicker();
  await ui.flushAsync();
  expect(startButton().disabled).toBe(true);
  expect(ui.text()).toContain("MacBook M1 kan niet starten: op batterij");
  act(() => {
    ui.query("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await ui.flushAsync();
  expect(createBodies(transport.entries)).toHaveLength(0);

  // Mac is back: one refresh, same composer, same choice, real POST.
  transport.setExecutionHosts(BOTH_AVAILABLE);
  openPicker();
  act(() => {
    refreshButton().click();
  });
  await ui.flushAsync();
  expect(hostOption("mac").disabled).toBe(false);
  closePicker();
  await ui.flushAsync();
  expect(startButton().disabled).toBe(false);
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.executionHost).toBe("mac");
});

test("a provider switch blocks Mac until the new provider's status lands — no carried-over availability", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderComposer();
  await ui.flushAsync();

  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  typePrompt("mac voor codex");
  expect(startButton().disabled).toBe(false);

  // Switch provider; the new agent's availability answer hangs. The old
  // agent's "Mac available" must not speak for the new one: Mac reads
  // blocked with the loading reason while the answer is in flight.
  let answer: ((value: unknown) => void) | null = null;
  transport.setExecutionHosts(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  openPicker();
  act(() => {
    (document.body.querySelector('button[aria-label="codex"]') as HTMLElement).click();
  });
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("MacBook M1");
  expect(hostOption("mac").disabled).toBe(true);
  expect(document.body.textContent).toContain("Uitvoerstatus wordt geladen");
  closePicker();
  await ui.flushAsync();
  expect(startButton().disabled).toBe(true);

  // The provider's answer lands: Mac is available again for THIS provider,
  // the explicit choice never moved, and the real POST runs on Mac.
  await ui.flushAsync(() => answer!(BOTH_AVAILABLE));
  expect(startButton().disabled).toBe(false);
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.executionHost).toBe("mac");
  expect(bodies[0]!.agent).toBe("codex-aisdk");
});

test("an accepted Mac launch retires the pick: the next create in the SAME mounted composer is Agentbox again", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderComposer();
  await ui.flushAsync();

  // First launch: explicit Mac, accepted by the box.
  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  typePrompt("eerste op de mac");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const first = createBodies(transport.entries);
  expect(first).toHaveLength(1);
  expect(first[0]!.executionHost).toBe("mac");

  // No remount, no close: the same mounted composer must present its Agentbox
  // default again the moment the launch is accepted, and the second create
  // must SAY so in the payload.
  expect(pickerTrigger().title).toContain("Agentbox");
  typePrompt("tweede chat");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const second = createBodies(transport.entries);
  expect(second).toHaveLength(2);
  expect(second[1]!.executionHost).toBe("agentbox");

  // The reset is a default, not a lock: Mac stays explicitly choosable and a
  // third launch with the explicit pick again carries Mac.
  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  typePrompt("derde weer op de mac");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const third = createBodies(transport.entries);
  expect(third).toHaveLength(3);
  expect(third[2]!.executionHost).toBe("mac");
});

test("a refused Mac create keeps Mac selected — same composer, next POST still Mac", async () => {
  const transport = installTransport({
    executionHosts: BOTH_AVAILABLE,
    create: (call) =>
      call === 1 ? new Error("Mac-werker onverwacht niet bereikbaar") : { sessionId: "s-retry" },
  });
  renderComposer();
  await ui.flushAsync();

  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  typePrompt("mac poging");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();

  // The create failed: the error shows and the explicit Mac choice survives
  // it — a failure must not silently move the person to Agentbox.
  expect(ui.text()).toContain("Mac-werker onverwacht niet bereikbaar");
  expect(pickerTrigger().title).toContain("MacBook M1");
  expect(createBodies(transport.entries)).toHaveLength(1);

  typePrompt("mac nog een keer");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.executionHost).toBe("mac");
});

test("closing and reopening the same mounted drawer starts the next chat on Agentbox", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderDrawer(true);
  await ui.flushAsync();

  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("MacBook M1");

  // Close: the drawer renders null but stays MOUNTED — exactly the state a
  // useState initializer cannot reset. Reopen is a fresh composer boundary.
  renderDrawer(false);
  await ui.flushAsync();
  renderDrawer(true);
  await ui.flushAsync();

  expect(pickerTrigger().title).toContain("Agentbox");
  typePrompt("na heropen");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();
  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.executionHost).toBe("agentbox");
});

test("the agent-cap Start-anyway retry sends the captured Mac — even after a close/reopen reset", async () => {
  const transport = installTransport({
    executionHosts: BOTH_AVAILABLE,
    create: (call) =>
      call === 1
        ? Object.assign(new Error("Cap bereikt: te veel live agents"), { code: "agent_limit" })
        : { sessionId: "s-anyway" },
  });
  renderDrawer(true, true);
  await ui.flushAsync();

  openPicker();
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  typePrompt("mac ondanks de cap");
  act(() => {
    startButton().click();
  });
  await ui.flushAsync();

  // Refused on the local cap: the offer waits, Mac stays the explicit choice.
  expect(createBodies(transport.entries)).toHaveLength(1);
  expect(pickerTrigger().title).toContain("MacBook M1");

  // The person closes and reopens first — the composer resets to its
  // Agentbox default for the NEXT chat. The waiting offer belongs to the
  // launch it was raised for: its retry must still send the captured Mac
  // with overLimit, never the reset default. (The app's Toaster sits at the
  // root and survives the drawer closing; keep it mounted here too.)
  renderDrawer(false, true);
  await ui.flushAsync();
  renderDrawer(true, true);
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("Agentbox");

  // Sonner paints its toasts on a real timer, not a microtask; give the
  // offer its tick before hunting the button.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await ui.flushAsync();
  const anyway = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Start anyway",
  ) as HTMLButtonElement | undefined;
  if (!anyway) throw new Error("Start anyway offer not rendered");
  act(() => {
    anyway.click();
  });
  await ui.flushAsync();

  const bodies = createBodies(transport.entries);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.executionHost).toBe("mac");
  expect(bodies[1]!.overLimit).toBe(true);
});

test("refreshing from the open popover keeps it open and usable", async () => {
  const transport = installTransport({ executionHosts: BOTH_AVAILABLE });
  renderComposer();
  await ui.flushAsync();

  openPicker();
  act(() => {
    refreshButton().click();
  });
  await ui.flushAsync();

  // The refresh must not dismiss the popover it lives in: the trigger stays
  // expanded, the host rows stay mounted and a second refresh still works.
  expect(pickerTrigger().getAttribute("aria-expanded")).toBe("true");
  expect(hostOption("agentbox")).toBeTruthy();
  act(() => {
    refreshButton().click();
  });
  await ui.flushAsync();
  expect(pickerTrigger().getAttribute("aria-expanded")).toBe("true");

  // And the picker still picks after refreshing: focus stayed usable.
  act(() => {
    hostOption("mac").click();
  });
  closePicker();
  await ui.flushAsync();
  expect(pickerTrigger().title).toContain("MacBook M1");
  expect(createBodies(transport.entries)).toHaveLength(0);
});
