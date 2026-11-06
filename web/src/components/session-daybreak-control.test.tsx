import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { mount, type Mounted } from "../test-support/render";

// Toasts are sonner + sound/haptics; neither belongs in a component test.
// Silence them at the module boundary so no async store update escapes act.
mock.module("@/lib/notify", () => ({
  toast: { success: mock(() => {}), error: mock(() => {}) },
}));
window.localStorage.setItem("lfg_ui_feedback", JSON.stringify({ sound: false, haptics: false }));

const { DaybreakProgramSelect, SessionDaybreakMenuBody, SessionDaybreakSubmenu } = await import(
  "./session-daybreak-control"
);
const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } = await import(
  "@/components/ui/dropdown-menu"
);

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

const ALL: ("standard" | "daybreakBlue" | "daybreakRed")[] = ["standard", "daybreakBlue", "daybreakRed"];

function click(el: Element | null | undefined) {
  if (!el) throw new Error("missing element");
  act(() => {
    (el as HTMLElement).click();
  });
}

/** A click whose async handler (save → toast → settle) must land inside act. */
async function clickAsync(el: Element | null | undefined) {
  if (!el) throw new Error("missing element");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

function choose(el: Element | null | undefined, value: string) {
  if (!el) throw new Error("missing select");
  act(() => {
    (el as HTMLSelectElement).value = value;
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  });
}

describe("DaybreakProgramSelect", () => {
  test("is a native select with an explicit Daybreak label and ordered options", () => {
    ui.render(<DaybreakProgramSelect automatic value={null} programs={ALL} onChange={() => {}} />);
    const select = ui.query("select")!;
    const label = select.closest("label");
    expect(label?.textContent).toContain("Daybreak:");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Automatisch",
      "Uit",
      "Blue",
      "Red",
    ]);
    expect((select as HTMLSelectElement).value).toBe("");
  });

  test("without the automatic option every choice is explicit", () => {
    ui.render(<DaybreakProgramSelect value="standard" programs={ALL} onChange={() => {}} />);
    const select = ui.query("select") as HTMLSelectElement;
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Uit", "Blue", "Red"]);
    expect(select.value).toBe("standard");
  });

  test("choosing reports the program; choosing Automatisch reports null", () => {
    const onChange = mock((_value: string | null) => {});
    ui.render(<DaybreakProgramSelect automatic value={null} programs={ALL} onChange={onChange} />);
    const select = ui.query("select")!;
    choose(select, "daybreakBlue");
    expect(onChange.mock.calls).toEqual([["daybreakBlue"]]);
    ui.render(<DaybreakProgramSelect automatic value="daybreakBlue" programs={ALL} onChange={onChange} />);
    choose(ui.query("select"), "");
    expect(onChange.mock.calls).toEqual([["daybreakBlue"], [null]]);
  });

  test("a stale value the model no longer offers displays as automatic", () => {
    const onChange = mock((_value: string | null) => {});
    ui.render(
      <DaybreakProgramSelect automatic value="daybreakRed" programs={["standard", "daybreakBlue"]} onChange={onChange} />,
    );
    const select = ui.query("select") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(onChange.mock.calls).toEqual([]);
  });

  test("can be disabled for the launch", () => {
    ui.render(<DaybreakProgramSelect automatic value={null} programs={ALL} onChange={() => {}} disabled />);
    expect((ui.query("select") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("SessionDaybreakMenuBody", () => {
  test("lists the offered programs with the current one checked", () => {
    ui.render(
      <SessionDaybreakMenuBody
        program="daybreakBlue"
        offered={ALL}
        control
        onSave={async () => {}}
      />,
    );
    const group = ui.query('[role="group"][aria-label="Daybreak-programma"]')!;
    const items = [...group.querySelectorAll('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Uit", "Blue", "Red"]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  test("picking a program awaits the save", async () => {
    const onSave = mock(async (_program: string) => {});
    ui.render(
      <SessionDaybreakMenuBody program={null} offered={ALL} control onSave={onSave} />,
    );
    await clickAsync(ui.queryAll('[role="menuitemradio"]')[2]);
    expect(onSave.mock.calls).toEqual([["daybreakRed"]]);
  });

  test("a busy session disables every choice", () => {
    const onSave = mock(async (_program: string) => {});
    ui.render(
      <SessionDaybreakMenuBody program={null} offered={ALL} control busy onSave={onSave} />,
    );
    for (const item of ui.queryAll('[role="menuitemradio"]')) {
      expect((item as HTMLButtonElement).disabled).toBe(true);
      click(item);
    }
    expect(onSave.mock.calls).toEqual([]);
  });

  test("re-picking the current program changes nothing", () => {
    const onSave = mock(async (_program: string) => {});
    ui.render(
      <SessionDaybreakMenuBody program="daybreakBlue" offered={ALL} control onSave={onSave} />,
    );
    click(ui.queryAll('[role="menuitemradio"]')[1]);
    expect(onSave.mock.calls).toEqual([]);
  });

  test("a failed save keeps the previous program and raises a readable alert", async () => {
    const onSave = mock(async () => {
      throw new Error("Session is busy");
    });
    const onError = mock((_message: string | null) => {});
    ui.render(
      <SessionDaybreakMenuBody program="standard" offered={ALL} control onSave={onSave} onError={onError} />,
    );
    await clickAsync(ui.queryAll('[role="menuitemradio"]')[2]);
    const alert = ui.query('[role="alert"]');
    expect(alert?.textContent).toContain("Session is busy");
    expect(onError.mock.calls.at(-1)).toEqual(["Session is busy"]);
    // The checked state is still what the session reports, not the failed pick.
    const checked = ui
      .queryAll('[role="menuitemradio"]')
      .find((item) => item.getAttribute("aria-checked") === "true");
    expect(checked?.textContent).toBe("Uit");
  });

  test("a model without nonstandard programs gets a concise metadata-only note", () => {
    const onSave = mock(async (_program: string) => {});
    ui.render(<SessionDaybreakMenuBody program={null} offered={[]} control onSave={onSave} />);
    expect(ui.text()).toContain("Dit model biedt geen Daybreak.");
    expect(ui.queryAll('[role="menuitemradio"]')).toEqual([]);
  });

  test("an older harness explains the resume requirement and never posts", () => {
    const onSave = mock(async (_program: string) => {});
    ui.render(
      <SessionDaybreakMenuBody program={null} offered={["standard", "daybreakBlue"]} control={false} onSave={onSave} />,
    );
    expect(ui.text()).toContain("Stop deze sessie en open haar via Resume.");
    expect(ui.queryAll('[role="menuitemradio"]')).toEqual([]);
  });
});

describe("SessionDaybreakSubmenu", () => {
  const eligible = {
    sessionId: "abc",
    agent: "codex-aisdk",
    model: "gpt-6-sol",
    cyberAccessProgram: "daybreakBlue",
    cyberAccessProgramControl: true,
  };

  test("renders nothing for sessions that cannot carry the control", () => {
    ui.render(<SessionDaybreakSubmenu session={{ ...eligible, agent: "claude" }} offered={ALL} onSave={async () => {}} />);
    expect(ui.host.textContent).toBe("");
    ui.render(<SessionDaybreakSubmenu session={{ ...eligible, sessionId: null }} offered={ALL} onSave={async () => {}} />);
    expect(ui.host.textContent).toBe("");
    ui.render(<SessionDaybreakSubmenu session={{ ...eligible, shippedReview: true }} offered={ALL} onSave={async () => {}} />);
    expect(ui.host.textContent).toBe("");

  });

  test("an eligible session gets a Daybreak section showing the current mode", async () => {
    ui.render(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<button type="button">menu</button>} />
        <DropdownMenuContent>
          <SessionDaybreakSubmenu session={eligible} offered={ALL} onSave={async () => {}} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await ui.flushAsync();
    expect(document.body.textContent).toContain("Daybreak");
    expect(document.body.textContent).toContain("Blue");
  });
});
