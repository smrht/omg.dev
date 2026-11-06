import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { mount, type Mounted } from "../test-support/render";
const { ExecutionHostChoice } = await import("./execution-host-control");

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

const bothAvailable = [
  { id: "agentbox", label: "Agentbox", selected: true, disabled: false },
  { id: "mac", label: "MacBook M1", selected: false, disabled: false },
];

test("offers exactly the two contract hosts, labelled Uitvoeren op — no Auto", () => {
  ui.render(<ExecutionHostChoice options={bothAvailable} onPick={() => {}} />);
  const root = ui.query('[data-testid="execution-host-choice"]')!;
  expect(root.textContent).toContain("Uitvoeren op");
  expect(root.textContent).toContain("Agentbox");
  expect(root.textContent).toContain("Mac");
  expect(root.textContent).not.toContain("Auto");
  const radios = ui.queryAll('[role="radio"]');
  expect(radios.map((radio) => radio.getAttribute("aria-label") ?? radio.textContent)).toHaveLength(2);
});

test("an unavailable Mac is visibly disabled with its reason", () => {
  ui.render(
    <ExecutionHostChoice
      options={[
        { id: "agentbox", label: "Agentbox", selected: false, disabled: false },
        { id: "mac", label: "MacBook M1", selected: true, disabled: true, note: "op batterij" },
      ]}
      onPick={() => {}}
    />,
  );
  const mac = ui.query('[data-testid="execution-host-mac"]') as HTMLButtonElement;
  expect(mac.disabled).toBe(true);
  expect(mac.getAttribute("aria-disabled")).toBe("true");
  expect(mac.getAttribute("aria-checked")).toBe("true");
  // The reason is visible text, not a tooltip-only hint.
  expect(ui.query('[data-testid="execution-host-choice"]')!.textContent).toContain("op batterij");
});

test("the blocked reason wraps in full — never truncated without an expansion", () => {
  const longReason =
    "staat op netstroom bij gesloten klep maar wacht nog op voldoende idle-tijd na de vorige encode-klus";
  ui.render(
    <ExecutionHostChoice
      options={[
        { id: "agentbox", label: "Agentbox", selected: false, disabled: false },
        { id: "mac", label: "MacBook M1", selected: true, disabled: true, note: longReason },
      ]}
      onPick={() => {}}
    />,
  );
  const note = ui.query('[data-testid="execution-host-choice"] p span')!;
  expect(note.textContent).toContain("idle-tijd na de vorige encode-klus");
  // A mobile reader gets the whole line: it wraps, it does not clip.
  expect(note.className).not.toContain("truncate");
  expect(note.className).toContain("break-words");
});

test("an explicit refresh control appears only when the composer provides one", () => {
  const refreshed: number[] = [];
  ui.render(<ExecutionHostChoice options={bothAvailable} onPick={() => {}} />);
  expect(ui.query('[data-testid="execution-host-refresh"]')).toBeNull();

  ui.render(
    <ExecutionHostChoice options={bothAvailable} onPick={() => {}} onRefresh={() => refreshed.push(1)} />,
  );
  const button = ui.query('[data-testid="execution-host-refresh"]') as HTMLButtonElement;
  expect(button.getAttribute("aria-label")).toBe("Uitvoerstatus verversen");
  act(() => {
    button.click();
  });
  expect(refreshed).toHaveLength(1);
});

test("picking a launchable host reports its id; a disabled host cannot be picked", () => {
  const picked: string[] = [];
  ui.render(
    <ExecutionHostChoice
      options={[
        { id: "agentbox", label: "Agentbox", selected: false, disabled: false },
        { id: "mac", label: "Mac", selected: true, disabled: true, note: "bezig" },
      ]}
      onPick={(id) => picked.push(id)}
    />,
  );
  act(() => {
    (ui.query('[data-testid="execution-host-agentbox"]') as HTMLElement).click();
  });
  expect(picked).toEqual(["agentbox"]);
  act(() => {
    (ui.query('[data-testid="execution-host-mac"]') as HTMLElement).click();
  });
  // Still only the Agentbox pick: the disabled Mac swallows the click.
  expect(picked).toEqual(["agentbox"]);
});
