import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mount, type Mounted } from "../test-support/render";
import type { ThreadDetail } from "../../../packages/protocol/src/threads";

const { ThreadChatView } = await import("./threads");

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

function detail(id = "11111111-1111-4111-8111-111111111111"): ThreadDetail {
  return {
    me: "human:me",
    thread: {
      id,
      title: "Logo ideas",
      createdAt: 1,
      updatedAt: 2,
      project: null,
      selection: null,
      lastMessage: null,
    },
    participants: [],
    messages: [
      { id: "m1", threadId: id, ts: 1, author: { kind: "human", participantId: "human:me", name: "Benny" }, text: "hello" },
    ],
    tasks: [],
    typing: [],
    people: [],
  };
}

function view(extra: Partial<Parameters<typeof ThreadChatView>[0]> = {}) {
  return (
    <ThreadChatView
      threadId="11111111-1111-4111-8111-111111111111"
      detail={detail()}
      repos={[]}
      selection={null}
      onSelectSelection={async () => {}}
      openAskSessionIds={[]}
      questionPanel={null}
      send={async () => null}
      setProject={async () => {}}
      onOpenTask={() => {}}
      {...extra}
    />
  );
}

describe("the thread view's own-media action", () => {
  test("a compact Media button sits in the header of an existing thread", () => {
    ui.render(view());
    const button = ui.query('[data-testid="thread-media-button"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBe("Eigen media maken");
    // Closed by default: no panel, no layout change.
    expect(document.querySelector('[data-testid="thread-media-dialog"]')).toBeNull();
  });

  test("clicking it reveals the own-media panel in a dialog, closed again afterwards", async () => {
    ui.render(view());
    await ui.flush(() => {
      (ui.query('[data-testid="thread-media-button"]') as HTMLButtonElement).click();
    });
    await ui.flushAsync();
    const dialog = document.querySelector('[data-testid="thread-media-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Eigen media in dit gesprek");
    // The REAL panel is mounted: with no machine behind this test its provider
    // list cannot load, and the panel's own error surface (role=alert inside
    // its "Eigen media" section) says so.
    const panelError = dialog!.querySelector('[aria-label="Eigen media"] [role="alert"]');
    expect(panelError).not.toBeNull();
    expect(panelError!.textContent!.length).toBeGreaterThan(0);
  });

  test("a new thread carries no Media action (nothing to attach to yet)", () => {
    ui.render(
      view({
        threadId: "new",
        detail: null,
        selection: null,
        onSelectSelection: async () => {},
      }),
    );
    expect(ui.query('[data-testid="thread-media-button"]')).toBeNull();
  });
});
