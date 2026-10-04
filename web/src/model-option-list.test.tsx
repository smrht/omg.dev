import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mount, type Mounted } from "./test-support/render";
import { OMG_MODELS } from "../../src/omg-models";

const { ModelOptionList } = await import("./App");

// The hosted omg picker used to list raw router ids
// ("omg/deepseek/deepseek-v4-flash-0731"), which truncated on a phone-width
// popover. Each row now shows the lab's mark and the short model name, while
// the router id stays the value that is chosen and the text the filter matches.
describe("ModelOptionList", () => {
  let ui: Mounted;
  beforeEach(() => {
    ui = mount();
  });
  afterEach(() => ui.cleanup());

  test("omg rows show the short name and the provider mark, and choose the id", () => {
    let chosen: string | null = null;
    ui.render(
      <ModelOptionList value={OMG_MODELS[0]!} models={OMG_MODELS} onChoose={(m) => { chosen = m; }} />,
    );
    const text = ui.text();
    expect(text).toContain("DeepSeek V4 Flash");
    expect(text).toContain("GLM 5.3 Flash");
    expect(text).toContain("GPT-5.6 Sol");
    expect(text).not.toContain("omg/deepseek/deepseek-v4-flash-0731");
    const rows = ui.queryAll("button");
    expect(rows.length).toBe(OMG_MODELS.length);
    // One mark per row: every hosted id maps to a lab with artwork.
    expect(ui.queryAll("button svg[role='img']").length).toBe(OMG_MODELS.length);
    const glm = rows.find((row) => row.textContent?.includes("GLM 5.2")) as HTMLButtonElement;
    expect(glm.title).toBe("Z.ai · omg/z-ai/glm-5.2");
    ui.flush(() => glm.click());
    expect(chosen).toBe("omg/z-ai/glm-5.2");
  });

  test("the filter matches the short name and the router id", () => {
    ui.render(<ModelOptionList value={OMG_MODELS[0]!} models={OMG_MODELS} onChoose={() => {}} />);
    const input = ui.query("input") as HTMLInputElement;
    expect(input).not.toBeNull();
    const type = (value: string) =>
      ui.flush(() => {
        // React tracks the last value it set; the prototype setter bypasses
        // that so the "input" event reads as a real change.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("deepseek v4");
    expect(ui.queryAll("button").length).toBe(2);
    type("z-ai");
    expect(ui.queryAll("button").length).toBe(2);
    expect(ui.text()).toContain("GLM 5.2");
    type("nothing-here");
    expect(ui.text()).toContain("No matching models");
  });

  test("Codex ids show their display name, without a mark", () => {
    ui.render(<ModelOptionList value="gpt-5.6" models={["gpt-5.6", "gpt-5.6-mini"]} onChoose={() => {}} />);
    expect(ui.text()).toContain("GPT-5.6 Mini");
    expect(ui.text()).not.toContain("gpt-5.6-mini");
    expect(ui.queryAll("button svg[role='img']").length).toBe(0);
    expect(ui.query("input")).toBeNull();
  });
});

// Stars are opt-in: callers that pass favorites get a toggle per row, callers
// that do not keep the exact list they had before.
describe("ModelOptionList favorites", () => {
  let ui: Mounted;
  beforeEach(() => {
    ui = mount();
  });
  afterEach(() => ui.cleanup());

  test("without favorite props there is no star to tap", () => {
    ui.render(<ModelOptionList value="gpt-5.6" models={["gpt-5.6", "gpt-5.6-mini"]} onChoose={() => {}} />);
    expect(ui.query("button[aria-pressed]")).toBeNull();
    expect(ui.queryAll("button").length).toBe(2);
  });

  test("a star toggles the favorite for its own row and never chooses the model", () => {
    let chosen = "";
    const toggled: string[] = [];
    ui.render(
      <ModelOptionList
        value={OMG_MODELS[0]!}
        models={OMG_MODELS}
        onChoose={(m) => { chosen = m; }}
        favorites={["omg/z-ai/glm-5.2"]}
        onToggleFavorite={(m) => { toggled.push(m); }}
      />,
    );
    const rows = ui.queryAll("button");
    // Every row still chooses; the stars are extra buttons.
    expect(rows.length).toBe(OMG_MODELS.length + OMG_MODELS.length);
    const starred = ui.query("button[aria-label='Remove GLM 5.2 from favorites']") as HTMLButtonElement;
    const plain = ui.query("button[aria-label='Favorite GLM 5.3 Flash']") as HTMLButtonElement;
    expect(starred.getAttribute("aria-pressed")).toBe("true");
    expect(plain.getAttribute("aria-pressed")).toBe("false");
    ui.flush(() => starred.click());
    ui.flush(() => plain.click());
    expect(toggled).toEqual(["omg/z-ai/glm-5.2", "omg/z-ai/glm-5.3-flash"]);
    expect(chosen).toBe("");
  });

  test("the filter still narrows starred rows the same way", () => {
    ui.render(
      <ModelOptionList
        value={OMG_MODELS[0]!}
        models={OMG_MODELS}
        onChoose={() => {}}
        favorites={["omg/z-ai/glm-5.2"]}
        onToggleFavorite={() => {}}
      />,
    );
    const input = ui.query("input") as HTMLInputElement;
    const type = (value: string) =>
      ui.flush(() => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("glm 5.2");
    const chooseRows = ui.queryAll("button").filter((b) => !b.hasAttribute("aria-pressed"));
    const starRows = ui.queryAll("button[aria-pressed]");
    expect(chooseRows.length).toBe(starRows.length);
    expect(chooseRows.length).toBeGreaterThan(0);
    expect(ui.text()).toContain("GLM 5.2");
  });
});

// The composer pill: a hosted omg model wears the lab's mark with a small omg
// mark in the corner; any other agent keeps its own mark alone.
describe("AgentModelPicker pill", () => {
  let ui: Mounted;
  beforeEach(() => {
    ui = mount();
  });
  afterEach(() => ui.cleanup());

  const options = [
    { key: "omg" as const, label: "omg agent" },
    { key: "aisdk" as const, label: "Claude" },
  ];

  test("an omg model shows the provider mark plus the omg badge", async () => {
    const { AgentModelPicker } = await import("./App");
    ui.render(
      <AgentModelPicker
        options={options}
        agent="omg"
        agentLabel="omg agent"
        onSelectAgent={() => {}}
        model="omg/z-ai/glm-5.2"
        models={OMG_MODELS}
        onModelChange={() => {}}
      />,
    );
    const pill = ui.query("button[aria-label^='Agent omg agent']") as HTMLButtonElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain("GLM 5.2");
    expect(pill.querySelectorAll("svg[role='img']").length).toBe(1);
    expect(pill.querySelector("img[data-testid='omg-model-badge']")).not.toBeNull();
  });

  test("another agent keeps its own mark and no badge", async () => {
    const { AgentModelPicker } = await import("./App");
    ui.render(
      <AgentModelPicker
        options={options}
        agent="aisdk"
        agentLabel="Claude"
        onSelectAgent={() => {}}
        model="opus"
        models={["opus", "sonnet"]}
        onModelChange={() => {}}
      />,
    );
    const pill = ui.query("button[aria-label^='Agent Claude']") as HTMLButtonElement;
    expect(pill.querySelectorAll("svg[role='img']").length).toBe(0);
    expect(pill.querySelector("img[data-testid='omg-model-badge']")).toBeNull();
    expect(pill.querySelectorAll("img").length).toBe(1);
  });
});
