import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { getConversation } from "./conversations.ts";
import {
  answerMention,
  appendThreadMessage,
  queueThreadAnswer,
  readThreadMessages,
  startThread,
  summarizeThread,
  threadAuthor,
  threadUpdate,
  type ThreadDeps,
  type ThreadTurnPair,
} from "./threads.ts";
import type { ThreadSelection } from "../packages/protocol/src/threads.ts";

const originalData = PATHS.data;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omg-threads-sel-"));
  PATHS.data = join(root, "data");
});

afterEach(() => {
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

const TURN: ThreadTurnPair = {
  completion: { agent: "aisdk", model: "sonnet", thinkingLevel: "high" },
  task: { agent: "aisdk", model: "sonnet", thinkingLevel: "high" },
};

const DAYBREAK_TURN: ThreadTurnPair = {
  completion: { agent: "codex-aisdk", model: "gpt-6-sol", cyberAccessProgram: "daybreakBlue" },
  task: { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: null },
};

const STANDARD_TURN: ThreadTurnPair = {
  completion: { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "low", cyberAccessProgram: "standard" },
  task: { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "low" },
};

function deps(
  overrides: {
    complete?: ThreadDeps["complete"];
    resolveTurn?: ThreadDeps["resolveTurn"];
    startTask?: ThreadDeps["startTask"];
  } = {},
) {
  const started: Array<Record<string, unknown>> = [];
  const told: Array<{ sessionId: string; text: string }> = [];
  const completions: Array<ThreadTurnPair["completion"] | null> = [];
  const d: ThreadDeps = {
    resolveTurn: async () => TURN,
    complete: async (_system, _user, pair) => {
      completions.push(pair);
      return '{"action":"reply","text":"ok"}';
    },
    startTask: async (input) => {
      started.push(input);
      return "a1b2c3d4-0000-4000-8000-00000000000f";
    },
    tellTask: async ({ sessionId, text }) => {
      told.push({ sessionId, text });
    },
    ...overrides,
  };
  return { d, started, told, completions };
}

describe("the selection persists on the thread", () => {
  test("a thread starts with none, stores one, reports it in its summary, and clears it", () => {
    const thread = startThread({ identity: "benny@example.com" });
    expect(summarizeThread(thread).selection).toBeNull();

    const pick: ThreadSelection = { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "low" };
    threadUpdate(thread.id, { selection: pick });
    expect(getConversation(thread.id)?.threadSelection).toEqual(pick);
    expect(summarizeThread(getConversation(thread.id)!).selection).toEqual(pick);

    threadUpdate(thread.id, { selection: null });
    expect(getConversation(thread.id)?.threadSelection).toBeNull();
  });

  test("a new thread can be born with a choice", () => {
    const thread = startThread({ identity: "benny@example.com", selection: { agent: "opencode", model: "opencode/mimo-v2.5-free" } });
    expect(summarizeThread(thread).selection).toEqual({ agent: "opencode", model: "opencode/mimo-v2.5-free" });
  });
});

describe("one thread's answers run in order", () => {
  test("a second answer waits for the first, and a failure does not stall the queue", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = queueThreadAnswer("t-1", async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });
    const second = queueThreadAnswer("t-1", async () => {
      order.push("second");
    });
    await Bun.sleep(5);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);

    const failing = queueThreadAnswer("t-2", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const after = queueThreadAnswer("t-2", async () => {
      order.push("after-failure");
    });
    await after;
    expect(order).toContain("after-failure");
  });
});

describe("the resolved pair reaches the reply and the task", () => {
  test("complete gets the pair, and a task starts with the same agent, model and level", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d, started, completions } = deps({
      complete: async (_system, _user, pair) => {
        completions.push(pair);
        return '{"action":"task","title":"Fix it","prompt":"Fix the build."}';
      },
    });
    await answerMention(thread.id, "@omg fix the build", "benny@example.com", d, "root-1");
    expect(completions).toEqual([TURN.completion]);
    expect(started[0]).toMatchObject({ agent: "aisdk", model: "sonnet", thinkingLevel: "high" });
  });

  test("the stored selection is handed to resolveTurn untouched", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const stored: ThreadSelection = { agent: "opencode", model: "opencode/mimo-v2.5-free", thinkingLevel: "low" };
    threadUpdate(thread.id, { selection: stored });
    const seen: Array<{ stored: ThreadSelection | null; mentioned: { key: string; handle?: string } | null }> = [];
    const { d } = deps({
      resolveTurn: async (sel, mentioned) => {
        seen.push({ stored: sel, mentioned });
        return TURN;
      },
    });
    await answerMention(thread.id, "@omg hi", "benny@example.com", d, "root-1", false, null, stored);
    expect(seen).toEqual([{ stored, mentioned: null }]);
  });
});

describe("a failed reply is an honest failure", () => {
  test("a completion that returns nothing says so in the thread, and starts no task", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d, started } = deps({ complete: async () => null });
    const posted = await answerMention(thread.id, "@omg price?", "benny@example.com", d, "root-1");
    expect(posted).toMatchObject({
      author: { kind: "omg" },
      text: "I could not get an answer from aisdk (sonnet): no answer came back.",
      replyTo: "root-1",
    });
    expect(started).toEqual([]);
    expect(getConversation(thread.id)!.runtimeSessions).toEqual([]);
  });

  test("a completion that throws carries its reason through, visibly", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d } = deps({
      complete: async () => {
        throw new Error("claude is not logged in");
      },
    });
    const posted = await answerMention(thread.id, "@omg price?", "benny@example.com", d, "root-1");
    expect(posted!.text).toBe("I could not get an answer from aisdk (sonnet): claude is not logged in.");
  });

  test("an unreadable answer is a failure too, never a task on a guess", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d, started } = deps({ complete: async () => "sure thing, boss" });
    const posted = await answerMention(thread.id, "@omg update the pricing page", "benny@example.com", d, "root-1");
    expect(posted!.text).toContain("the answer was unreadable");
    expect(started).toEqual([]);
  });

  test("a selection that is no longer available says which one, instead of switching", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d } = deps({
      resolveTurn: async () => {
        throw new Error("grok is not connected for thread replies anymore; pick another agent for this thread");
      },
    });
    const posted = await answerMention(thread.id, "@omg hi", "benny@example.com", d, "root-1");
    expect(posted!.text).toBe(
      "I could not use this thread's agent choice: grok is not connected for thread replies anymore; pick another agent for this thread",
    );
    expect(readThreadMessages(thread.id).filter((row) => row.task)).toEqual([]);
  });

  test("a valid task decision still starts the task", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d, started } = deps({
      complete: async () => '{"action":"task","title":"Names","prompt":"Brainstorm names."}',
    });
    const posted = await answerMention(thread.id, "@omg names please", "benny@example.com", d, "root-2");
    expect(posted).toMatchObject({ task: { event: "started", title: "Names" }, replyTo: "root-2" });
    expect(started).toHaveLength(1);
  });

  test("an explicit Daybreak program answers chat; a task decision under it is refused visibly, never rerouted", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const daybreakCaptures: Array<ThreadTurnPair["completion"] | null> = [];
    const daybreakDeps = (completeReturn: string) =>
      deps({
        resolveTurn: async () => DAYBREAK_TURN,
        complete: async (_system, _user, pair) => {
          daybreakCaptures.push(pair);
          return completeReturn;
        },
      });

    // A chat reply works and the program reaches the completion pair.
    const chat = daybreakDeps('{"action":"reply","text":"Klaar."}');
    const posted = await answerMention(thread.id, "@omg wat kost dit?", "benny@example.com", chat.d, "root-5");
    expect(posted).toMatchObject({ author: { kind: "omg" }, text: "Klaar.", replyTo: "root-5" });
    expect(daybreakCaptures).toEqual([DAYBREAK_TURN.completion]);

    // A task decision is NOT silently started as a standard task: the person
    // picked an access program a task cannot carry.
    const task = daybreakDeps('{"action":"task","title":"Fix","prompt":"Fix it."}');
    const refused = await answerMention(thread.id, "@omg fix the build", "benny@example.com", task.d, "root-6");
    expect(refused).toMatchObject({ author: { kind: "omg" }, replyTo: "root-6" });
    expect(refused!.text).toContain("chat-only access choice");
    expect(refused!.task).toBeUndefined();
    expect(task.started).toEqual([]);
    expect(getConversation(thread.id)!.runtimeSessions).toEqual([]);
  });

  test("the STANDARD program refuses nothing: a task decision still starts the task", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d, started } = deps({
      resolveTurn: async () => STANDARD_TURN,
      complete: async () => '{"action":"task","title":"Fix","prompt":"Fix it."}',
    });
    const posted = await answerMention(thread.id, "@omg fix the build", "benny@example.com", d, "root-7");
    expect(posted).toMatchObject({ task: { event: "started", title: "Fix" }, replyTo: "root-7" });
    expect(started).toMatchObject([{ agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: "low" }]);
  });

  test("unasked, omg still stays quiet when the completion fails", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const benny = threadAuthor(thread.id, "benny@example.com", "Benny");
    const ask = appendThreadMessage(thread.id, { author: benny, text: "@omg make the pricing page" });
    appendThreadMessage(thread.id, {
      author: { kind: "omg" },
      text: "Started a task.",
      replyTo: ask.id,
      task: { sessionId: "a1b2c3d4-0000-4000-8000-0000000000aa", event: "started", title: "Pricing", project: null },
    });
    const before = readThreadMessages(thread.id).length;
    const { d } = deps({ complete: async () => null });
    expect(await answerMention(thread.id, "thanks", "benny@example.com", d, ask.id, true)).toBeNull();
    expect(readThreadMessages(thread.id)).toHaveLength(before);
  });
});

describe("an agent asked by name", () => {
  test("an unreadable brief fails visibly; the work is not started on a guess", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const { d, started } = deps({ complete: async () => "hmm" });
    const posted = await answerMention(thread.id, "@codex fix it", "benny@example.com", d, "root-3", false, {
      key: "codex-aisdk",
      handle: "codex",
    });
    expect(posted!.text).toContain("the answer was unreadable");
    expect(started).toEqual([]);
  });

  test("the mention rides into resolveTurn, and the task runs the resolved pair", async () => {
    const thread = startThread({ identity: "benny@example.com" });
    const codexTurn: ThreadTurnPair = {
      completion: { agent: "codex-aisdk", model: "gpt-6-sol" },
      task: { agent: "codex-aisdk", model: "gpt-6-sol", thinkingLevel: null },
    };
    const seen: Array<{ stored: ThreadSelection | null; mentioned: { key: string; handle?: string } | null }> = [];
    const { d, started } = deps({
      resolveTurn: async (stored, mentioned) => {
        seen.push({ stored, mentioned });
        return codexTurn;
      },
      complete: async () => "not json",
    });
    await answerMention(thread.id, "@codex fix it", "benny@example.com", d, "root-4", false, { key: "codex-aisdk", handle: "codex" }, null);
    expect(seen).toEqual([{ stored: null, mentioned: { key: "codex-aisdk", handle: "codex" } }]);
    expect(started).toEqual([]);
  });
});
