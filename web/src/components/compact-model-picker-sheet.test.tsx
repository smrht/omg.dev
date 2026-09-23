import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { mount, type Mounted } from "../test-support/render";
const { CompactModelPickerSheet } = await import("./compact-model-picker-sheet");

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

const agents = [
  { id: "aisdk", label: "Claude", iconSrc: "/claude.svg", selected: true },
  { id: "codex", label: "Codex", iconSrc: "/codex.svg", selected: false },
  { id: "gemini", label: "Gemini", iconSrc: "/gemini.svg", selected: false, locked: true },
];

const favorites = [
  { id: "omg/z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", sublabel: "Z.ai", selected: true },
  { id: "omg/openai/gpt-5.5", label: "GPT-5.5", sublabel: "OpenAI", selected: false },
];

const thinking = {
  options: [
    { id: "low", label: "Low", selected: false },
    { id: "high", label: "High", selected: true },
    { id: "xhigh", label: "Max", selected: false },
  ],
  onPick: (_id: string) => {},
};

function renderSheet(overrides: Record<string, unknown> = {}) {
  ui.render(
    <CompactModelPickerSheet
      open
      onOpenChange={() => {}}
      agentLabel="Claude"
      agentIconSrc="/claude.svg"
      agents={agents}
      onSelectAgent={() => {}}
      favorites={favorites}
      onChooseModel={() => {}}
      onToggleFavorite={() => {}}
      renderModels={(done: () => void) => (
        <button type="button" onClick={done}>
          pick glm
        </button>
      )}
      thinking={thinking}
      fast={{ enabled: false, onToggle: () => {} }}
      usage={{ summary: "5h window resets 14:00", details: <div>usage breakdown</div> }}
      {...overrides}
    />,
  );
}

function body() {
  return document.body;
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error("missing element");
  act(() => {
    (el as HTMLElement).click();
  });
}

function keydown(el: Element | null | undefined, key: string) {
  if (!el) throw new Error("missing element");
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

test("closed sheet renders nothing", () => {
  renderSheet({ open: false });
  expect(body().querySelector('[data-testid="compact-model-picker"]')).toBeNull();
});

test("root shows favorites with labels, provider sublabel, stars and the checked selection", () => {
  renderSheet();
  const card = body().querySelector('[data-testid="compact-model-picker"]')!;
  expect(card.getAttribute("role")).toBe("dialog");
  expect(card.textContent).toContain("Claude");
  expect(card.textContent).toContain("GLM 5.3 Flash");
  expect(card.textContent).toContain("Z.ai");
  expect(card.textContent).toContain("GPT-5.5");
  expect(card.textContent).toContain("OpenAI");
  expect(body().querySelector('[aria-label^="Model GLM 5.3 Flash"]')!.getAttribute("aria-label")).toContain(
    "Selected",
  );
  expect(body().querySelector('[aria-label^="Model GPT-5.5"]')!.getAttribute("aria-label")).not.toContain(
    "Selected",
  );
  expect(body().querySelector('[aria-label="Remove GPT-5.5 from favorites"]')).not.toBeNull();
  expect(body().querySelector('[aria-label="All models"]')).not.toBeNull();
});

test("choosing a favorite picks the model; the star only toggles the favorite", () => {
  const onChoose = mock((_id: string) => {});
  const onToggle = mock((_id: string) => {});
  renderSheet({ onChooseModel: onChoose, onToggleFavorite: onToggle });
  click(body().querySelector('[aria-label^="Model GPT-5.5"]'));
  expect(onChoose.mock.calls).toEqual([["omg/openai/gpt-5.5"]]);
  click(body().querySelector('[aria-label="Remove GLM 5.3 Flash from favorites"]'));
  expect(onToggle.mock.calls).toEqual([["omg/z-ai/glm-5.3-flash"]]);
  expect(onChoose.mock.calls).toHaveLength(1);
});

test("the header dropdown lists every agent, routes locked ones to connect, and offers Claude profiles", () => {
  const onSelect = mock((_id: string) => {});
  const onLocked = mock((_id: string) => {});
  const onProfile = mock((_id: string) => {});
  renderSheet({ onSelectAgent: onSelect, onLockedAgent: onLocked, onSelectProfile: onProfile, profiles: [
    { id: "", label: "Auto", selected: true },
    { id: "acct-2", label: "2", selected: false },
  ] });
  const trigger = body().querySelector('[aria-label="Agent: Claude. Change agent"]') as HTMLButtonElement;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(body().querySelector('[aria-label="All agents"]')).not.toBeNull();
  click(body().querySelector('[aria-label="Codex agent"]'));
  click(trigger);
  click(body().querySelector('[aria-label="Connect Gemini"]'));
  expect(onSelect.mock.calls).toEqual([["codex"]]);
  expect(onLocked.mock.calls).toEqual([["gemini"]]);

  click(body().querySelector('[aria-label="Claude profiles"]'));
  expect(body().textContent).toContain("Claude-profielen");
  click(body().querySelector('[aria-label="Claude 2"]'));
  expect(onProfile.mock.calls).toEqual([["acct-2"]]);
  expect(body().querySelector('[aria-label="Remove GPT-5.5 from favorites"]')).not.toBeNull();
});

test("All models opens the searchable list and done returns to the favorites", () => {
  renderSheet();
  click(body().querySelector('[aria-label="All models"]'));
  expect(body().textContent).toContain("Alle modellen");
  click([...body().querySelectorAll("button")].find((b) => b.textContent === "pick glm"));
  expect(body().querySelector('[aria-label^="Model GLM 5.3 Flash"]')).not.toBeNull();
});

test("thinking segments are explicit labeled radios from the actual options", () => {
  const onPick = mock((_id: string) => {});
  renderSheet({ thinking: { options: thinking.options, onPick } });
  const group = body().querySelector('[role="radiogroup"][aria-label="Thinking level"]')!;
  const radios = [...group.querySelectorAll('[role="radio"]')];
  expect(radios.map((r) => r.textContent)).toEqual(["Laag", "Hoog", "Max"]);
  expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
  click(radios[2]);
  expect(onPick.mock.calls).toEqual([["xhigh"]]);
  // The options are static props (selected stays High), so arrows step from
  // High: right to Max, left to Low.
  keydown(group, "ArrowRight");
  keydown(group, "ArrowLeft");
  expect(onPick.mock.calls).toEqual([["xhigh"], ["xhigh"], ["low"]]);
});

test("Fast and Tibo stay reachable as switches", () => {
  const onFast = mock(() => {});
  const onTibo = mock(() => {});
  renderSheet({
    fast: { enabled: false, onToggle: onFast },
    tibo: { enabled: true, onToggle: onTibo },
  });
  const fast = body().querySelector('[role="switch"][aria-label="Fast mode"]') as HTMLButtonElement;
  const tibo = body().querySelector('[role="switch"][aria-label="Tibo mode: Fast service tier and High thinking"]')!;
  expect(fast.getAttribute("aria-checked")).toBe("false");
  expect(tibo.getAttribute("aria-checked")).toBe("true");
  click(fast);
  click(tibo);
  expect(onFast.mock.calls).toHaveLength(1);
  expect(onTibo.mock.calls).toHaveLength(1);
});

test("the usage row opens the breakdown page and back returns to root", () => {
  renderSheet();
  click(body().querySelector('[aria-label="Usage and next resets"]'));
  expect(body().textContent).toContain("Gebruik");
  expect(body().textContent).toContain("usage breakdown");
  click(body().querySelector('[aria-label="Back to picker"]'));
  expect(body().querySelector('[aria-label^="Model GLM 5.3 Flash"]')).not.toBeNull();
});

test("Escape and the close button close the sheet", () => {
  const onOpenChange = mock((_open: boolean) => {});
  renderSheet({ onOpenChange });
  keydown(body().querySelector('[data-testid="compact-model-picker"]'), "Escape");
  click(body().querySelector('[aria-label="Close model picker"]'));
  expect(onOpenChange.mock.calls).toEqual([[false], [false]]);
});

test("an empty favorites list explains how to pin a model", () => {
  renderSheet({ favorites: [] });
  expect(body().textContent).toContain("Voeg via Alle modellen een favoriet toe.");
});
