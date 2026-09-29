import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { mount, type Mounted } from "../test-support/render";
import type { ThreadSelection, ThreadSelectionOption } from "../../../packages/protocol/src/threads";

const { ThreadSelectionBar, ThreadChatView } = await import("./threads");
const { setThreadSelectionCatalogForTests } = await import("../lib/threads");
const { CodingAgentsContext } = await import("../lib/session-ui");

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

const OPTIONS: ThreadSelectionOption[] = [
  {
    key: "aisdk",
    label: "claude",
    models: ["opus", "sonnet"],
    defaultModel: "opus",
    thinkingLevels: ["low", "high"],
  },
  {
    key: "codex-aisdk",
    label: "codex",
    models: ["gpt-6-sol", "gpt-5.5"],
    defaultModel: "gpt-6-sol",
    thinkingLevels: ["low", "medium", "high"],
    thinkingLevelsByModel: { "gpt-6-sol": ["low", "high", "ultra"], "gpt-5.5": ["low", "medium"] },
    cyberAccessProgramsByModel: { "gpt-6-sol": ["standard", "daybreakBlue", "daybreakRed"] },
  },
  {
    key: "opencode",
    label: "opencode",
    models: ["opencode/mimo-v2.5-free"],
    defaultModel: "opencode/mimo-v2.5-free",
    thinkingLevels: ["low", "medium"],
    thinkingLevelsByModel: { "opencode/mimo-v2.5-free": ["low", "medium"] },
  },
];

function select(testId: string): HTMLSelectElement {
  const el = ui.query(`[data-testid="${testId}"]`);
  expect(el).not.toBeNull();
  return el as HTMLSelectElement;
}

function choose(testId: string, value: string): void {
  const el = select(testId);
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the thread model bar", () => {
  test("while the catalog loads it says so, and with nothing to pick it stays away", () => {
    ui.render(<ThreadSelectionBar selection={null} options={[]} loading error={null} onSelect={() => {}} />);
    expect(ui.text()).toContain("Modellen laden…");

    ui.render(<ThreadSelectionBar selection={null} options={[]} loading={false} error={null} onSelect={() => {}} />);
    expect(ui.host.innerHTML).toBe("");
  });

  test("three labelled selects with Automatisch, and the own-account hint", () => {
    ui.render(<ThreadSelectionBar selection={null} options={OPTIONS} loading={false} error={null} onSelect={() => {}} />);
    for (const label of ["Agent", "Model", "Denkniveau"]) {
      const field = ui.queryAll("label").find((el) => el.textContent === label);
      expect(field, `label ${label}`).toBeTruthy();
      expect((field as HTMLLabelElement).htmlFor).toBeTruthy();
      expect(ui.host.querySelector(`#${(field as HTMLLabelElement).htmlFor}`)).toBeTruthy();
    }
    expect([...select("thread-selection-agent").options].map((o) => o.textContent)).toEqual([
      "Automatisch",
      "claude",
      "codex",
      "opencode",
    ]);
    expect(ui.text()).toContain("Draait op je eigen verbonden account.");
    // No agent chosen: model and level wait.
    expect(select("thread-selection-model").disabled).toBe(true);
    expect(select("thread-selection-level").disabled).toBe(true);
  });

  test("picking an agent stores its default model; picking Automatisch clears the choice", () => {
    const picked: Array<unknown> = [];
    ui.render(
      <ThreadSelectionBar selection={{ agent: "aisdk", model: "sonnet" }} options={OPTIONS} loading={false} error={null} onSelect={(next) => picked.push(next)} />,
    );
    choose("thread-selection-agent", "opencode");
    expect(picked.at(-1)).toEqual({ agent: "opencode", model: "opencode/mimo-v2.5-free" });
    choose("thread-selection-agent", "");
    expect(picked.at(-1)).toBeNull();
  });

  test("model and thinking level changes persist the whole choice", () => {
    const picked: Array<unknown> = [];
    function Harness() {
      const [selection, setSelection] = useState<ThreadSelection | null>({ agent: "aisdk", model: "sonnet", thinkingLevel: "high" });
      return (
        <ThreadSelectionBar
          selection={selection}
          options={OPTIONS}
          loading={false}
          error={null}
          onSelect={(next) => {
            picked.push(next);
            setSelection(next);
          }}
        />
      );
    }
    ui.render(<Harness />);
    expect([...select("thread-selection-model").options].map((o) => o.value)).toEqual(["opus", "sonnet"]);
    ui.flush(() => choose("thread-selection-model", "opus"));
    expect(picked.at(-1)).toEqual({ agent: "aisdk", model: "opus", thinkingLevel: "high" });

    expect([...select("thread-selection-level").options].map((o) => o.value)).toEqual(["", "low", "high"]);
    ui.flush(() => choose("thread-selection-level", "low"));
    expect(picked.at(-1)).toEqual({ agent: "aisdk", model: "opus", thinkingLevel: "low" });
    ui.flush(() => choose("thread-selection-level", ""));
    expect(picked.at(-1)).toEqual({ agent: "aisdk", model: "opus", thinkingLevel: null });
  });

  test("switching models keeps level and program only where the new model supports them", () => {
    const picked: Array<unknown> = [];
    function Harness() {
      const [selection, setSelection] = useState<ThreadSelection | null>({
        agent: "codex-aisdk",
        model: "gpt-6-sol",
        thinkingLevel: "ultra",
        cyberAccessProgram: "daybreakBlue",
      });
      return (
        <ThreadSelectionBar
          selection={selection}
          options={OPTIONS}
          loading={false}
          error={null}
          onSelect={(next) => {
            picked.push(next);
            setSelection(next);
          }}
        />
      );
    }
    ui.render(<Harness />);
    // gpt-5.5 has no programs in metadata and no "ultra": BOTH are dropped,
    // never carried into a model that cannot honour them.
    ui.flush(() => choose("thread-selection-model", "gpt-5.5"));
    expect(picked.at(-1)).toEqual({ agent: "codex-aisdk", model: "gpt-5.5", thinkingLevel: null, cyberAccessProgram: null });
    // The access control disappeared with the model switch.
    expect(ui.query('[data-testid="thread-selection-program"]')).toBeNull();
  });

  test("the access choice: named programs, truthful tooltip, hidden when only standard", () => {
    const picked: Array<unknown> = [];
    ui.render(
      <ThreadSelectionBar
        selection={{ agent: "codex-aisdk", model: "gpt-6-sol" }}
        options={OPTIONS}
        loading={false}
        error={null}
        onSelect={(next) => picked.push(next)}
      />,
    );
    const program = select("thread-selection-program");
    expect([...program.options].map((o) => o.textContent)).toEqual(["Automatisch", "Standard", "Daybreak Blue", "Daybreak Red"]);
    expect(program.title).toContain("geweigerd");
    choose("thread-selection-program", "daybreakBlue");
    expect(picked.at(-1)).toEqual({ agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" });
    // A stored "standard" displays as Automatisch, not as a broken value.
    ui.render(
      <ThreadSelectionBar
        selection={{ agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "standard" }}
        options={OPTIONS}
        loading={false}
        error={null}
        onSelect={() => {}}
      />,
    );
    expect(select("thread-selection-program").value).toBe("");
    // A model without offered programs shows no access control at all.
    ui.render(
      <ThreadSelectionBar selection={{ agent: "aisdk", model: "opus" }} options={OPTIONS} loading={false} error={null} onSelect={() => {}} />,
    );
    expect(ui.query('[data-testid="thread-selection-program"]')).toBeNull();
  });

  test("a stored model that disappeared WITHIN a live agent stays visible, flagged", () => {
    ui.render(
      <ThreadSelectionBar selection={{ agent: "aisdk", model: "fable" }} options={OPTIONS} loading={false} error={null} onSelect={() => {}} />,
    );
    // Live models stay listed; the stale one is appended, visibly flagged.
    expect([...select("thread-selection-model").options].map((o) => o.textContent)).toEqual([
      "opus",
      "sonnet",
      "fable (niet beschikbaar)",
    ]);
    expect(select("thread-selection-model").value).toBe("fable");
    expect(ui.query('[role="status"]')?.textContent).toContain("niet meer beschikbaar");
  });

  test("a stored choice the box can no longer run stays visible instead of vanishing", () => {
    ui.render(
      <ThreadSelectionBar selection={{ agent: "grok", model: "grok-4.7" }} options={OPTIONS} loading={false} error={null} onSelect={() => {}} />,
    );
    expect([...select("thread-selection-agent").options].at(-1)?.textContent).toBe("grok (niet beschikbaar)");
    expect(ui.query('[role="status"]')?.textContent).toContain("niet meer beschikbaar");
    // Still loading with no options yet: the stale choice shows too.
    ui.render(
      <ThreadSelectionBar selection={{ agent: "grok", model: "grok-4.7" }} options={[]} loading error={null} onSelect={() => {}} />,
    );
    expect(ui.query('[data-testid="thread-selection-agent"]')).not.toBeNull();
  });

  test("a refused save is shown, not swallowed", () => {
    ui.render(
      <ThreadSelectionBar selection={null} options={OPTIONS} loading={false} error={'unknown model "fable" for aisdk'} onSelect={() => {}} />,
    );
    expect(ui.query('[role="alert"]')?.textContent).toContain('unknown model "fable"');
  });
});

describe("saving the selection from the thread view", () => {
  const CATALOG_AGENTS = [
    { key: "aisdk", label: "claude", visible: true, status: { configured: true } },
    { key: "opencode", label: "opencode", visible: true, status: { configured: true } },
  ];
  const CATALOG_ITEMS = [
    { key: "aisdk", label: "claude", defaultModel: "opus", models: ["opus"], thinkingLevels: [] },
    { key: "opencode", label: "opencode", defaultModel: "opencode/mimo-v2.5-free", models: ["opencode/mimo-v2.5-free"], thinkingLevels: [] },
  ];

  function detail(): import("../../../packages/protocol/src/threads").ThreadDetail {
    return {
      me: "human:me",
      thread: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "T",
        createdAt: 1,
        updatedAt: 2,
        project: null,
        selection: null,
        lastMessage: null,
      },
      participants: [],
      messages: [],
      tasks: [],
      typing: [],
      people: [],
    };
  }

  function view(
    save: (next: import("../../../packages/protocol/src/threads").ThreadSelection | null) => Promise<void>,
    threadId = "22222222-2222-4222-8222-222222222222",
    send = async () => null,
  ) {
    return (
      <CodingAgentsContext.Provider value={CATALOG_AGENTS as never}>
        <ThreadChatView
          threadId={threadId}
          detail={detail()}
          repos={[]}
          selection={null}
          onSelectSelection={save}
          openAskSessionIds={[]}
          questionPanel={null}
          send={send}
          renderComposer={({ onSend }) => <button data-testid="qa-send" onClick={() => void onSend("test message", []).catch(() => {})}>Send</button>}
          setProject={async () => {}}
          onOpenTask={() => {}}
        />
      </CodingAgentsContext.Provider>
    );
  }

  test("an earlier save completing cannot clear a newer draft, and a thread change resets the chain", async () => {
    setThreadSelectionCatalogForTests(CATALOG_ITEMS);
    try {
      const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      let calls = 0;
      ui.render(view(() => gates[calls++]!.promise));
      await ui.flushAsync();

      const agentSelect = () => ui.query('[data-testid="thread-selection-agent"]') as HTMLSelectElement;
      expect(agentSelect()).not.toBeNull();
      // First choice (aisdk), then a second (opencode) while the first is still saving.
      ui.flush(() => {
        agentSelect().value = "aisdk";
        agentSelect().dispatchEvent(new Event("change", { bubbles: true }));
      });
      await ui.flushAsync();
      expect(calls).toBe(1);
      ui.flush(() => {
        agentSelect().value = "opencode";
        agentSelect().dispatchEvent(new Event("change", { bubbles: true }));
      });
      await ui.flushAsync();
      // The second save is chained behind the first: not on the wire yet.
      expect(calls).toBe(1);
      expect(agentSelect().value).toBe("opencode");

      // The FIRST save settles and its wire turn releases the second: the
      // newer draft still on screen is not clobbered by the older completion.
      gates[0]!.resolve();
      await ui.flushAsync();
      expect(calls).toBe(2);
      expect(agentSelect().value).toBe("opencode");

      // The SECOND save settles: only now does the draft hand over to the stored value.
      gates[1]!.resolve();
      await ui.flushAsync();
      expect(agentSelect().value).toBe("");

    // A thread change resets any pending draft and chain.
    ui.flush(() => {
      agentSelect().value = "aisdk";
      agentSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await ui.flushAsync();
    expect(agentSelect().value).toBe("aisdk");
    ui.render(view(() => gates[calls++]!.promise, "33333333-3333-4333-8333-333333333333"));
    await ui.flushAsync();
    expect(ui.query('[data-testid="thread-selection-agent"]')).toBeTruthy();
    expect((ui.query('[data-testid="thread-selection-agent"]') as HTMLSelectElement).value).toBe("");
    } finally {
      setThreadSelectionCatalogForTests(null);
    }
  });
  test("Send waits for the model save, and a failed save leaves the message unsent", async () => {
    setThreadSelectionCatalogForTests(CATALOG_ITEMS);
    try {
      for (const fail of [false, true]) {
        const gate = Promise.withResolvers<void>();
        let sent = 0;
        ui.render(view(() => gate.promise, crypto.randomUUID(), async () => { sent++; return null; }));
        await ui.flushAsync();
        ui.flush(() => choose("thread-selection-agent", "aisdk"));
        await ui.flushAsync();
        ui.flush(() => (ui.query('[data-testid="qa-send"]') as HTMLButtonElement).click());
        await ui.flushAsync();
        expect(sent).toBe(0);
        if (fail) gate.reject(new Error("keuze bewaren mislukt")); else gate.resolve();
        await ui.flushAsync();
        expect(sent).toBe(fail ? 0 : 1);
        if (fail) expect(ui.text()).toContain("keuze bewaren mislukt");
      }
    } finally { setThreadSelectionCatalogForTests(null); }
  });

});
