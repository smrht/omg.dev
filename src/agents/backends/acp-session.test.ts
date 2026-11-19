import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import {
  acpResumeStrategy,
  advertisedAcpSessionMethods,
  applyAcpSessionUpdate,
  bindAcpConversation,
  type AcpUpdateState,
} from "./acp-session.ts";
import type { ManagedSdkEventSink } from "./managed-sdk-session.ts";

function sinkRecorder() {
  const drafts: string[] = [];
  const committed: string[] = [];
  const tools: string[] = [];
  const sink: ManagedSdkEventSink = {
    draft(text) {
      drafts.push(text);
    },
    thinking() {},
    commitText(text) {
      committed.push(text);
    },
    toolStart(id, name) {
      tools.push(`start:${id}:${name}`);
    },
    toolEnd(id, name) {
      tools.push(`end:${id}:${name}`);
    },
    async ask() {
      return null;
    },
  };
  return { sink, drafts, committed, tools };
}

describe("ACP initialize capabilities", () => {
  test("defaults load/resume/close to unsupported", () => {
    expect(advertisedAcpSessionMethods({})).toEqual({
      loadSession: false,
      resume: false,
      close: false,
    });
    expect(advertisedAcpSessionMethods({
      agentCapabilities: { loadSession: false, sessionCapabilities: {} },
    })).toEqual({
      loadSession: false,
      resume: false,
      close: false,
    });
  });

  test("treats advertised resume/close objects as supported", () => {
    expect(advertisedAcpSessionMethods({
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, close: {} },
      },
    })).toEqual({
      loadSession: true,
      resume: true,
      close: true,
    });
  });

  test("never selects session/load when the agent does not advertise it", () => {
    expect(acpResumeStrategy({ loadSession: false, resume: false, close: false }, "sess-1")).toBe("new");
    expect(acpResumeStrategy({ loadSession: true, resume: false, close: false }, "sess-1")).toBe("load");
    expect(acpResumeStrategy({ loadSession: true, resume: true, close: false }, "sess-1")).toBe("resume");
    expect(acpResumeStrategy({ loadSession: true, resume: true, close: false })).toBe("new");
  });
});

describe("ACP load replay suppression", () => {
  test("ignores load-history notifications so tools and drafts are not duplicated", () => {
    const { sink, drafts, tools } = sinkRecorder();
    const state: AcpUpdateState = { draft: "", thought: "", replaying: true };
    applyAcpSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "old answer" },
    }, sink, state);
    applyAcpSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Read",
      status: "completed",
    }, sink, state);
    expect(drafts).toEqual([]);
    expect(tools).toEqual([]);
    expect(state.draft).toBe("");

    state.replaying = false;
    applyAcpSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fresh" },
    }, sink, state);
    expect(drafts).toEqual(["fresh"]);
    expect(state.draft).toBe("fresh");
  });
});

describe("ACP mid-turn draft flush", () => {
  test("commits narrated text before each tool so segments do not glue together", () => {
    const { sink, drafts, committed, tools } = sinkRecorder();
    const state: AcpUpdateState = { draft: "", thought: "", replaying: false };

    applyAcpSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I'll start by understanding the current state." },
    }, sink, state);
    applyAcpSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Shell",
      status: "pending",
    }, sink, state);

    expect(committed).toEqual(["I'll start by understanding the current state."]);
    expect(state.draft).toBe("");
    expect(drafts.at(-1)).toBe("");
    expect(tools).toEqual(["start:call-1:Shell"]);

    applyAcpSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "This is the vibes repo." },
    }, sink, state);
    applyAcpSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-2",
      title: "Read",
      status: "completed",
    }, sink, state);

    expect(committed).toEqual([
      "I'll start by understanding the current state.",
      "This is the vibes repo.",
    ]);
    expect(state.draft).toBe("");
    expect(tools).toEqual([
      "start:call-1:Shell",
      "start:call-2:Read",
      "end:call-2:Read",
    ]);

    applyAcpSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Final answer." },
    }, sink, state);
    expect(state.draft).toBe("Final answer.");
    expect(committed).toHaveLength(2);
  });

  test("does not commit an empty draft when a tool arrives with no prior text", () => {
    const { sink, committed, tools } = sinkRecorder();
    const state: AcpUpdateState = { draft: "", thought: "", replaying: false };
    applyAcpSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Shell",
      status: "pending",
    }, sink, state);
    expect(committed).toEqual([]);
    expect(tools).toEqual(["start:call-1:Shell"]);
  });
});

describe("bindAcpConversation", () => {
  test("opens a new session when loadSession is unsupported", async () => {
    const methods: string[] = [];
    const { sink } = sinkRecorder();
    const state: AcpUpdateState = { draft: "", thought: "", replaying: false };
    const opened = await bindAcpConversation({
      cwd: "/tmp",
      mcpServers: [],
      resume: "old-session",
      state,
      sink,
      context: {
        async request(method, params) {
          methods.push(method);
          if (method === "initialize") {
            return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
          }
          if (method === "session/new") {
            expect(params).toEqual(expect.objectContaining({ cwd: "/tmp" }));
            return { sessionId: "fresh-session" };
          }
          throw new Error(`unexpected ${method}`);
        },
      },
    });
    expect(opened.sessionId).toBe("fresh-session");
    expect(methods).toEqual(["initialize", "session/new"]);
  });

  test("prefers session/resume over session/load", async () => {
    const methods: string[] = [];
    const { sink } = sinkRecorder();
    const opened = await bindAcpConversation({
      cwd: "/tmp",
      mcpServers: [],
      resume: "old-session",
      state: { draft: "", thought: "", replaying: false },
      sink,
      context: {
        async request(method) {
          methods.push(method);
          if (method === "initialize") {
            return {
              protocolVersion: acp.PROTOCOL_VERSION,
              agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
            };
          }
          if (method === "session/resume") return {};
          throw new Error(`unexpected ${method}`);
        },
      },
    });
    expect(opened.sessionId).toBe("old-session");
    expect(methods).toEqual(["initialize", "session/resume"]);
  });

  test("session/load replay notifications do not reach the sink", async () => {
    const { sink, drafts, tools } = sinkRecorder();
    const state: AcpUpdateState = { draft: "stale", thought: "old", replaying: false };
    let loadStarted = false;
    const agent = acp.agent({ name: "load-replay-agent" })
      .onRequest(acp.methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.load, async ({ client }) => {
        loadStarted = state.replaying;
        await client.notify(acp.methods.client.session.update, {
          sessionId: "old-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed" } },
        });
        await client.notify(acp.methods.client.session.update, {
          sessionId: "old-session",
          update: { sessionUpdate: "tool_call", toolCallId: "call-replay", title: "Read", status: "completed" },
        });
        return {};
      })
      .onRequest(acp.methods.agent.session.new, () => {
        throw new Error("session/new must not run when loadSession is advertised");
      });
    const client = acp.client({ name: "load-replay-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        applyAcpSessionUpdate(params.update, sink, state);
      });

    await client.connectWith(agent, async (context) => {
      const opened = await bindAcpConversation({
        context,
        cwd: "/tmp",
        mcpServers: [],
        resume: "old-session",
        state,
        sink,
      });
      expect(opened.sessionId).toBe("old-session");
      expect(opened.methods.loadSession).toBe(true);
    });

    expect(loadStarted).toBe(true);
    expect(state.replaying).toBe(false);
    expect(state.draft).toBe("");
    expect(drafts.at(-1)).toBe("");
    expect(tools).toEqual([]);
  });
});

describe("ACP tool output and step reasoning (Antigravity shape)", () => {
  test("a tool end without rawOutput takes its text from the content blocks", () => {
    const ends: unknown[] = [];
    const { sink } = sinkRecorder();
    sink.toolEnd = (_id, name, output) => ends.push([name, output]);
    const state: AcpUpdateState = { draft: "", thought: "", replaying: false };
    applyAcpSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      title: "ls | head -3",
      name: "run_command",
      content: [{ type: "content", content: { type: "text", text: "Created At: 2026-11-19T19:53:23+01:00\nCompleted At: 2026-11-19T19:53:23+01:00\nCommand exited with code 0.\n\nCommand output:\na0.txt\n" } }],
    } as acp.SessionUpdate, sink, state);
    expect(ends).toEqual([["run_command", "Command exited with code 0.\n\nCommand output:\na0.txt"]]);
  });

  test("rawOutput still wins when an agent sends it", () => {
    const ends: unknown[] = [];
    const { sink } = sinkRecorder();
    sink.toolEnd = (_id, _name, output) => ends.push(output);
    const state: AcpUpdateState = { draft: "", thought: "", replaying: false };
    applyAcpSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c2",
      status: "completed",
      rawOutput: { ok: true },
      content: [{ type: "content", content: { type: "text", text: "ignored" } }],
    } as acp.SessionUpdate, sink, state);
    expect(ends).toEqual([{ ok: true }]);
  });

  test("reasoning before a tool is committed as its own step", () => {
    const order: string[] = [];
    const { sink } = sinkRecorder();
    sink.commitThinking = (text) => order.push(`think:${text}`);
    sink.commitText = (text) => order.push(`text:${text}`);
    sink.toolStart = (id) => order.push(`tool:${id}`);
    const state: AcpUpdateState = { draft: "", thought: "", replaying: false };
    applyAcpSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan A" } }, sink, state);
    applyAcpSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I will list it." } }, sink, state);
    applyAcpSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", status: "in_progress" } as acp.SessionUpdate, sink, state);
    applyAcpSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan B" } }, sink, state);
    expect(order).toEqual(["think:plan A", "text:I will list it.", "tool:t1"]);
    expect(state.thought).toBe("plan B");
  });

  test("a sink without commitThinking keeps the whole turn's reasoning for the turn end", () => {
    const { sink } = sinkRecorder();
    const state: AcpUpdateState = { draft: "", thought: "", replaying: false };
    applyAcpSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan A" } }, sink, state);
    applyAcpSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", status: "in_progress" } as acp.SessionUpdate, sink, state);
    expect(state.thought).toBe("plan A");
  });
});
