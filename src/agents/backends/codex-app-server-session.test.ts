// Tests for the persistent app-server bridge adapter and the harness-side
// cyber-access-program helpers. Every fixture mirrors a notification or
// response shape from codex-cli 0.159.0 (`app-server generate-json-schema
// --experimental`); the transport is an in-memory fake, so no process, no
// network, and no inference ever runs here.
import { describe, expect, test } from "bun:test";
import {
  BRIDGE_THREAD_CONFIG,
  CodexAppServerThread,
  mapAppServerItem,
  toAppServerUserInput,
} from "./codex-app-server-session.ts";
import {
  codexAppServerTrustedArgv,
  codexConfigTomlValue,
  flattenCodexConfigOverrides,
  CodexDaybreakError,
  type CodexAppServerTransport,
} from "../../codex-daybreak.ts";
import {
  buildCodexAppServerBridgeArgv,
  parseCyberAccessProgramArg,
  resolveCodexBridgePlan,
} from "./codex-aisdk-session.ts";
import type { CyberAccessProgram } from "../../model-discovery.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

class FakeTransport implements CodexAppServerTransport {
  written: string[] = [];
  closeCalls = 0;
  closed = false;
  private lineListeners: Array<(line: string) => void> = [];
  private closeListeners: Array<() => void> = [];
  private writeHandlers: Array<(message: Record<string, unknown>) => void> = [];

  write(line: string): void {
    this.written.push(line);
    let message: Record<string, unknown> | null = null;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const handler of [...this.writeHandlers]) handler(message!);
  }

  onWrite(handler: (message: Record<string, unknown>) => void): void {
    this.writeHandlers.push(handler);
  }

  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    this.closeCalls++;
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }

  emit(value: unknown): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const listener of [...this.lineListeners]) listener(`${text}\n`);
  }

  requests(): Array<Record<string, unknown>> {
    return this.written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => typeof message.method === "string" && message.id != null);
  }

  requestByMethod(method: string): Record<string, unknown> | undefined {
    return this.requests().find((message) => message.method === method);
  }
}

function script(transport: FakeTransport, steps: Record<string, () => unknown>): void {
  transport.onWrite((message) => {
    if (message.id == null) return;
    const step = steps[message.method as string];
    if (!step) return;
    const result = step() as { __rpcError?: unknown } | undefined;
    queueMicrotask(() => {
      if (result && typeof result === "object" && "__rpcError" in result) {
        transport.emit({ id: message.id, error: result.__rpcError });
      } else {
        transport.emit({ id: message.id, result });
      }
    });
  });
}

function bridgeTransport(): FakeTransport {
  const transport = new FakeTransport();
  script(transport, {
    initialize: () => ({ serverInfo: { name: "codex", version: "0.159.0" } }),
    "thread/start": () => ({ thread: { id: "t-bridge-1" }, model: "gpt-6-sol" }),
    "thread/resume": () => ({ thread: { id: "t-bridge-1" }, model: "gpt-6-sol" }),
    "turn/start": () => ({ turn: { id: "turn-1", status: "inProgress" } }),
  });
  return transport;
}

const CAPS = {
  "gpt-6-sol": { reasoningEfforts: ["low", "high"], cyberAccessPrograms: ["standard", "daybreakBlue"] as CyberAccessProgram[] },
};

async function collect<T>(stream: { [Symbol.asyncIterator](): AsyncIterator<T> }): Promise<T[]> {
  const iterator = stream[Symbol.asyncIterator]();
  const out: T[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return out;
    out.push(next.value);
  }
}

// ---------------------------------------------------------------------------
// Item mapping: actual 0.159 camelCase ThreadItem shapes → SDK snake_case
// ---------------------------------------------------------------------------

describe("mapAppServerItem", () => {
  test("agentMessage, reasoning, commandExecution, fileChange, mcpToolCall, webSearch", () => {
    expect(mapAppServerItem({ id: "a1", type: "agentMessage", text: "Hello" })).toEqual({
      id: "a1",
      type: "agent_message",
      text: "Hello",
    });
    expect(mapAppServerItem({ id: "r1", type: "reasoning", summary: ["step one", "step two"], content: ["raw"] })).toEqual({
      id: "r1",
      type: "reasoning",
      text: "step one\n\nstep two",
    });
    expect(
      mapAppServerItem({
        id: "c1",
        type: "commandExecution",
        command: "bun test",
        cwd: "/w",
        status: "completed",
        aggregatedOutput: "ok\n",
        exitCode: 0,
        commandActions: [],
      }),
    ).toEqual({
      id: "c1",
      type: "command_execution",
      command: "bun test",
      aggregated_output: "ok\n",
      exit_code: 0,
      status: "completed",
    });
    const fileChange = mapAppServerItem({
      id: "f1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "src/a.ts", kind: { type: "add" }, diff: "+new" }, { path: "old.ts", kind: { type: "delete" }, diff: "-gone" }],
    });
    expect(fileChange).toEqual({
      id: "f1",
      type: "file_change",
      changes: [
        { path: "src/a.ts", kind: "add" },
        { path: "old.ts", kind: "delete" },
      ],
      status: "completed",
    });
    expect(
      mapAppServerItem({
        id: "m1",
        type: "mcpToolCall",
        server: "omg",
        tool: "session_read",
        arguments: { q: 1 },
        status: "completed",
        result: { content: [{ type: "text", text: "data" }], structuredContent: { rows: 2 } },
      }),
    ).toEqual({
      id: "m1",
      type: "mcp_tool_call",
      server: "omg",
      tool: "session_read",
      arguments: { q: 1 },
      result: { content: [{ type: "text", text: "data" }], structured_content: { rows: 2 } },
      status: "completed",
    });
    expect(mapAppServerItem({ id: "w1", type: "webSearch", query: "codex app-server", results: [{ title: "docs" }] })).toEqual({
      id: "w1",
      type: "web_search",
      query: "codex app-server",
      results: [{ title: "docs" }],
    } as unknown as ReturnType<typeof mapAppServerItem>);
  });

  test("status enums translate; declined folds to failed; in-progress file changes drop", () => {
    const asStatus = (item: Record<string, unknown>) => mapAppServerItem(item) as { status: string } | null;
    expect(asStatus({ id: "c", type: "commandExecution", command: "x", cwd: "/w", status: "inProgress" })?.status).toBe("in_progress");
    expect(asStatus({ id: "c", type: "commandExecution", command: "x", cwd: "/w", status: "declined" })?.status).toBe("failed");
    expect(mapAppServerItem({ id: "f", type: "fileChange", status: "inProgress", changes: [] })).toBeNull();
    expect(mapAppServerItem({ id: "f", type: "fileChange", status: "declined", changes: [] })).toMatchObject({ status: "failed" });
  });

  test("kinds without an SDK counterpart drop instead of corrupting a shape", () => {
    for (const item of [
      { id: "u1", type: "userMessage", content: [{ type: "text", text: "hi" }] },
      { id: "p1", type: "plan", text: "steps" },
      { id: "d1", type: "dynamicToolCall", tool: "t", arguments: {}, status: "completed" },
      { id: "s1", type: "sleep", durationMs: 100 },
      { id: "x1", type: "futureKind", payload: true },
      null,
      undefined,
    ]) {
      expect(mapAppServerItem(item as Record<string, unknown>)).toBeNull();
    }
  });

  test("an error item keeps its (redacted) message", () => {
    const mapped = mapAppServerItem({ id: "e1", type: "error", message: "boom sk-abcdefghijklmnop123456" });
    expect(mapped).toEqual({ id: "e1", type: "error", message: expect.stringContaining("«redacted»") });
    expect((mapped as { message: string }).message).not.toContain("sk-abcdefghijklmnop123456");
  });
});

describe("toAppServerUserInput", () => {
  test("string, mixed parts, and empty input map onto UserInput parts", () => {
    expect(toAppServerUserInput("hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(
      toAppServerUserInput([
        { type: "text", text: "look" },
        { type: "local_image", path: "/tmp/a.png" },
      ]),
    ).toEqual([
      { type: "text", text: "look" },
      { type: "localImage", path: "/tmp/a.png" },
    ]);
    expect(toAppServerUserInput([])).toEqual([{ type: "text", text: "" }]);
  });
});

// ---------------------------------------------------------------------------
// Serialization: initialize → thread → turn on the real wire shapes
// ---------------------------------------------------------------------------

describe("CodexAppServerThread serialization", () => {
  test("persistent thread (never ephemeral), danger-full-access + never, cwd and model", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", cwd: "/work", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "Hello" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    const { events } = await pending;
    const collected = await collect(events);
    expect(transport.requestByMethod("thread/start")?.params).toEqual({
      cwd: "/work",
      model: "gpt-6-sol",
      config: BRIDGE_THREAD_CONFIG,
    });
    expect(BRIDGE_THREAD_CONFIG).toEqual({ sandbox_mode: "danger-full-access", approval_policy: "never" });
    expect(transport.requestByMethod("turn/start")?.params).toEqual({
      threadId: "t-bridge-1",
      input: [{ type: "text", text: "Hi" }],
      model: "gpt-6-sol",
    });
    expect(transport.requestByMethod("initialize")?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(adapter.id).toBe("t-bridge-1");
    expect(collected.map((event) => event.type)).toEqual(["thread.started", "turn.started", "item.completed", "turn.completed"]);
    expect(collected[0]).toEqual({ type: "thread.started", thread_id: "t-bridge-1" });
    expect((collected[2] as { item: unknown }).item).toEqual({ id: "a1", type: "agent_message", text: "Hello" });
    expect(collected[3]).toEqual({
      type: "turn.completed",
      usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    });
    // The adapter auto-closes its own child once the turn settles.
    await flush();
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
    await adapter.close();
    expect(transport.closeCalls).toBe(1);
  });

  test("explicit program rides turn/start; absent program stays absent (automatic)", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport, cyberAccessProgram: "daybreakBlue", daybreakEnabled: true });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "ok" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    (await pending).events[Symbol.asyncIterator]();
    expect(transport.requestByMethod("turn/start")?.params).toMatchObject({ cyberAccessProgram: "daybreakBlue" });
    // Display-only metadata: sent, but its answer never gates the turn.
    expect(transport.requestByMethod("thread/metadata/update")?.params).toEqual({ threadId: "t-bridge-1", daybreakEnabled: true });

    const transport2 = bridgeTransport();
    const adapter2 = new CodexAppServerThread({ model: "gpt-6-sol", transport: transport2 });
    const pending2 = adapter2.runStreamed("Hi");
    await flush();
    transport2.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    (await pending2).events[Symbol.asyncIterator]();
    const turnStartParams = transport2.requestByMethod("turn/start")?.params as Record<string, unknown> | undefined;
    expect(turnStartParams == null || !("cyberAccessProgram" in turnStartParams)).toBe(true);
    expect(transport2.requestByMethod("thread/metadata/update")).toBeUndefined();
  });

  test("resume: thread/resume carries threadId, cwd, model, config — same id preserved", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", cwd: "/work", transport, resumeThreadId: "t-bridge-1" });
    expect(adapter.id).toBe("t-bridge-1");
    const pending = adapter.runStreamed("Again");
    await flush();
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    (await pending).events[Symbol.asyncIterator]();
    expect(transport.requestByMethod("thread/resume")?.params).toEqual({
      threadId: "t-bridge-1",
      cwd: "/work",
      model: "gpt-6-sol",
      config: BRIDGE_THREAD_CONFIG,
    });
    expect(transport.requestByMethod("thread/start")).toBeUndefined();
    expect(adapter.id).toBe("t-bridge-1");
  });

  test("streaming: agentMessage and reasoning deltas build item.updated drafts; command output folds into the completed item", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ method: "item/agentMessage/delta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "a1", delta: "Hel" } });
    transport.emit({ method: "item/agentMessage/delta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "a1", delta: "lo" } });
    transport.emit({ method: "item/reasoning/summaryTextDelta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "r1", summaryIndex: 0, delta: "thinking " } });
    transport.emit({ method: "item/reasoning/textDelta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "r1", contentIndex: 0, delta: "hard" } });
    transport.emit({ method: "item/commandExecution/outputDelta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "c1", delta: "line1\n" } });
    transport.emit({ method: "item/commandExecution/outputDelta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "c1", delta: "line2" } });
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "c1", type: "commandExecution", command: "ls", cwd: "/w", status: "completed", commandActions: [] } },
    });
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "Hello" } },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const collected = await collect((await pending).events);
    const updates = collected.filter((event) => event.type === "item.updated") as Array<{ item: { id: string; type: string; text?: string } }>;
    expect(updates.filter((event) => event.item.type !== "command_execution").map((event) => `${event.item.id}:${event.item.text}`)).toEqual(["a1:Hello", "r1:thinking hard"]);
    expect(updates.some((event) => event.item.type === "command_execution")).toBe(true);
    const completed = collected.filter((event) => event.type === "item.completed") as Array<{ item: { id: string; aggregated_output?: string } }>;
    expect(completed.find((event) => event.item.id === "c1")?.item.aggregated_output).toBe("line1\nline2");
  });

  test("turn status mapping: failed turns surface a redacted turn.failed; inProgress is not success", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({
      method: "turn/completed",
      params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "failed", error: { message: "rate limited Bearer zzzz1111zzzz2222" } } },
    });
    const collected = await collect((await pending).events);
    const failure = collected.at(-1);
    expect(failure).toMatchObject({ type: "turn.failed" });
    expect((failure as { error: { message: string } }).error.message).not.toContain("zzzz1111zzzz2222");

    const transport2 = bridgeTransport();
    const adapter2 = new CodexAppServerThread({ model: "gpt-6-sol", transport: transport2 });
    const pending2 = adapter2.runStreamed("Hi");
    await flush();
    // inProgress is explicitly NOT terminal: the stream must stay open.
    transport2.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "inProgress" } } });
    transport2.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "late" } } });
    transport2.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const collected2 = await collect((await pending2).events);
    expect(collected2.some((event) => event.type === "turn.completed")).toBe(true);
  });

  test("token usage lands on turn.completed; reroute is tracked, not mislabeled", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t-bridge-1",
        turnId: "turn-1",
        tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 6, reasoningOutputTokens: 3, totalTokens: 25 }, total: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } },
      },
    });
    transport.emit({ method: "model/rerouted", params: { threadId: "t-bridge-1", turnId: "turn-1", fromModel: "gpt-6-sol", toModel: "gpt-6-astra", reason: "capacity" } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const collected = await collect((await pending).events);
    expect(collected.at(-1)).toEqual({
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 2, output_tokens: 6, reasoning_output_tokens: 3 },
    });
    expect(adapter.lastReroute).toEqual({ fromModel: "gpt-6-sol", toModel: "gpt-6-astra" });
    expect(collected.some((event) => event.type === "error")).toBe(false);
  });

  test("retriable errors keep the turn alive; final errors end it; server requests stay denied", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ id: 51, method: "item/commandExecution/requestApproval", params: { callId: "c1" } });
    transport.emit({ method: "error", params: { threadId: "t-bridge-1", turnId: "turn-1", error: { message: "transient 429" }, willRetry: true } });
    await flush();
    transport.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "recovered" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const collected = await collect((await pending).events);
    expect(collected.some((event) => event.type === "error")).toBe(false);
    const denial = transport.written.map((line) => JSON.parse(line) as Record<string, unknown>).find((message) => message.id === 51);
    expect(denial?.error).toMatchObject({ code: -32000 });

    const transport2 = bridgeTransport();
    const adapter2 = new CodexAppServerThread({ model: "gpt-6-sol", transport: transport2 });
    const pending2 = adapter2.runStreamed("Hi");
    await flush();
    transport2.emit({ method: "error", params: { threadId: "t-bridge-1", turnId: "turn-1", error: { message: "fatal sk-abcdefghijklmnop123456" }, willRetry: false } });
    const collected2 = await collect((await pending2).events);
    expect(collected2.at(-1)).toMatchObject({ type: "error" });
    expect((collected2.at(-1) as { message: string }).message).not.toContain("sk-abcdefghijklmnop123456");
  });

  test("foreign thread and turn notifications never merge into our stream", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ method: "item/completed", params: { threadId: "t-OTHER", turnId: "turn-1", item: { id: "x", type: "agentMessage", text: "not ours" } } });
    transport.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-OTHER", item: { id: "x", type: "agentMessage", text: "not ours either" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-OTHER", turn: { id: "turn-1", status: "completed" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-OTHER", status: "completed" } } });
    transport.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "ours" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const collected = await collect((await pending).events);
    const messages = collected.filter((event) => event.type === "item.completed") as Array<{ item: { text?: string } }>;
    expect(messages.map((event) => event.item.text)).toEqual(["ours"]);
  });

  test("notifications that race the turn/start response replay in order", async () => {
    const transport = new FakeTransport();
    let turnStartSent = 0;
    transport.onWrite((message) => {
      if (message.method === "initialize") {
        queueMicrotask(() => transport.emit({ id: message.id, result: {} }));
        return;
      }
      if (message.method === "thread/start") {
        queueMicrotask(() => transport.emit({ id: message.id, result: { thread: { id: "t-race" } } }));
        return;
      }
      if (message.method === "turn/start") {
        turnStartSent++;
        // Answer the response AFTER a real notification for the turn has
        // already arrived — the adapter must buffer and replay, not drop.
        queueMicrotask(() => {
          transport.emit({ method: "item/completed", params: { threadId: "t-race", turnId: "turn-race", item: { id: "a1", type: "agentMessage", text: "raced" } } });
          transport.emit({ id: message.id, result: { turn: { id: "turn-race", status: "inProgress" } } });
          queueMicrotask(() => {
            transport.emit({ method: "turn/completed", params: { threadId: "t-race", turn: { id: "turn-race", status: "completed" } } });
          });
        });
        return;
      }
    });
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    const collected = await collect((await pending).events);
    expect(turnStartSent).toBe(1);
    expect(collected.map((event) => event.type)).toEqual(["thread.started", "turn.started", "item.completed", "turn.completed"]);
    expect(collected[2]).toMatchObject({ type: "item.completed", item: { text: "raced" } });
  });
});

// ---------------------------------------------------------------------------
// Abort semantics
// ---------------------------------------------------------------------------

describe("CodexAppServerThread abort", () => {
  test("abort before start rejects without spawning any transport", async () => {
    let spawns = 0;
    const controller = new AbortController();
    controller.abort();
    const adapter = new CodexAppServerThread({
      model: "gpt-6-sol",
      transport: () => {
        spawns++;
        return new FakeTransport();
      },
    });
    await expect(adapter.runStreamed("Hi", { signal: controller.signal })).rejects.toThrow();
    expect(spawns).toBe(0);
    await adapter.close();
  });

  test("abort during the turn interrupts OUR turn and closes the child with no stray completion", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const controller = new AbortController();
    const pending = adapter.runStreamed("Hi", { signal: controller.signal });
    await flush();
    controller.abort();
    await flush();
    // A late completion for the aborted turn must not resurrect the stream.
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const collected = await collect((await pending).events);
    expect(collected.some((event) => event.type === "turn.completed")).toBe(false);
    expect(collected.some((event) => event.type === "error")).toBe(false);
    expect(transport.requestByMethod("turn/interrupt")?.params).toEqual({ threadId: "t-bridge-1", turnId: "turn-1" });
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
    await adapter.close();
    expect(transport.closeCalls).toBe(1);
  });

  test("abort while turn/start is still in flight closes the child without a bogus interrupt", async () => {
    const transport = new FakeTransport();
    transport.onWrite((message) => {
      if (message.method === "initialize") queueMicrotask(() => transport.emit({ id: message.id, result: {} }));
      if (message.method === "thread/start") queueMicrotask(() => transport.emit({ id: message.id, result: { thread: { id: "t-x" } } }));
      // turn/start never answers.
    });
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const controller = new AbortController();
    const pending = adapter.runStreamed("Hi", { signal: controller.signal });
    const raced = pending.then(({ events }) => collect(events));
    await flush();
    controller.abort();
    const collected = await raced;
    // thread.started was already queued before turn/start hung; abort ends
    // the stream right after it — no turn events, no bogus completion.
    expect(collected).toEqual([{ type: "thread.started", thread_id: "t-x" }]);
    expect(transport.requestByMethod("turn/interrupt")).toBeUndefined();
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
  });

  test("an unexpected interrupted status (no abort of ours) fails visibly", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "interrupted" } } });
    const collected = await collect((await pending).events);
    expect(collected.at(-1)).toMatchObject({ type: "turn.failed", error: { message: "turn interrupted" } });
  });
});

// ---------------------------------------------------------------------------
// Failure, child death, single-use, leaks
// ---------------------------------------------------------------------------

describe("CodexAppServerThread robustness", () => {
  test("child death mid-turn ends the stream with a visible error, not a hang", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    await transport.close(); // read side reports the dead child
    const collected = await collect((await pending).events);
    expect(collected.at(-1)).toEqual({ type: "error", message: "Codex app-server closed during the turn" });
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
  });

  // codex-interrupt-2 regression (live facts 4 Oct): the turn-4 thread/resume
  // response carried the thread's history + the account's tool catalogs in
  // ONE ~1.07 MB line (1,075,909 stdout bytes, 395 stdin). The former 1 MiB
  // frame cap killed the client mid-resume and the generic close text hid it.
  test("a live-sized valid thread/resume response (~1.07 MB) still resumes; the turn completes", async () => {
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({ serverInfo: { name: "codex", version: "0.159.0" } }),
      "thread/resume": () => ({ thread: { id: "t-live-4" }, model: "gpt-6.1-sol", history: "x".repeat(1_075_000) }),
      "turn/start": () => ({ turn: { id: "turn-4", status: "inProgress" } }),
    });
    const adapter = new CodexAppServerThread({ model: "gpt-6.1-sol", transport, resumeThreadId: "t-live-4" });
    const pending = adapter.runStreamed("beurt 4");
    await flush();
    transport.emit({ method: "item/completed", params: { threadId: "t-live-4", turnId: "turn-4", item: { id: "a1", type: "agentMessage", text: "hervat" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-live-4", turn: { id: "turn-4", status: "completed" } } });
    const collected = await collect((await pending).events);
    expect(collected.map((event) => event.type)).toEqual(["thread.started", "turn.started", "item.completed", "turn.completed"]);
    expect(adapter.id).toBe("t-live-4");
  });

  test("a frame beyond the cap fails with the protocol error, never the generic close text", async () => {
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({}),
      "thread/resume": () => ({ thread: { id: "t-huge" }, history: "x".repeat(9 * 1024 * 1024) }),
    });
    const adapter = new CodexAppServerThread({ model: "gpt-6.1-sol", transport, resumeThreadId: "t-huge" });
    const { events } = await adapter.runStreamed("beurt");
    const collected = await collect(events);
    const last = collected.at(-1);
    expect(last).toMatchObject({ type: "error" });
    const message = (last as { message: string }).message;
    expect(message).toContain("line exceeded");
    expect(message).not.toContain("closed during the turn");
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
  });

  test("a failed thread/start surfaces a redacted error event and closes the child", async () => {
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({}),
      "thread/start": () => ({ __rpcError: { code: -32001, message: "auth exploded Bearer abcdef1234567890" } }),
    });
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const { events } = await adapter.runStreamed("Hi");
    const collected = await collect(events);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ type: "error" });
    expect((collected[0] as { message: string }).message).toContain("«redacted»");
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
    expect(adapter.id).toBeNull();
  });

  test("the adapter is single-turn: a second runStreamed rejects", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    await collect((await pending).events);
    await expect(adapter.runStreamed("again")).rejects.toThrow(/one turn/);
  });

  test("multi-turn persistence: turn 2 resumes the id turn 1 started", async () => {
    // Turn 1: fresh thread.
    const transport1 = bridgeTransport();
    const adapter1 = new CodexAppServerThread({ model: "gpt-6-sol", transport: transport1, cyberAccessProgram: "daybreakBlue" });
    const pending1 = adapter1.runStreamed("first");
    await flush();
    transport1.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "one" } } });
    transport1.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    await collect((await pending1).events);
    await adapter1.close();
    expect(adapter1.id).toBe("t-bridge-1");

    // Turn 2 (toggle-off: explicit standard): NEW child, SAME thread id.
    const transport2 = bridgeTransport();
    const adapter2 = new CodexAppServerThread({ model: "gpt-6-sol", transport: transport2, resumeThreadId: adapter1.id, cyberAccessProgram: "standard" });
    const pending2 = adapter2.runStreamed("second");
    await flush();
    transport2.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a2", type: "agentMessage", text: "two" } } });
    transport2.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const collected2 = await collect((await pending2).events);
    await adapter2.close();
    expect(transport2.requestByMethod("thread/start")).toBeUndefined();
    expect(transport2.requestByMethod("thread/resume")?.params).toMatchObject({ threadId: "t-bridge-1" });
    expect(transport2.requestByMethod("turn/start")?.params).toMatchObject({ cyberAccessProgram: "standard" });
    expect((collected2.find((event) => event.type === "item.completed") as { item: { text: string } } | undefined)?.item.text).toBe("two");
    // No leaked child on either turn.
    expect(transport1.closeCalls).toBe(1);
    expect(transport2.closeCalls).toBe(1);
  });

  test("per-turn notification handlers unsubscribe at settle (no handler leak)", async () => {
    const transport = bridgeTransport();
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport });
    const pending = adapter.runStreamed("Hi");
    await flush();
    transport.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    await collect((await pending).events);
    await adapter.close();
    // After settle the client holds no notification handlers: nothing keeps
    // the turn's closures alive on a still-open connection.
    const leaked = transport.written.length; // sanity: connection quiesced
    transport.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "z", type: "agentMessage", text: "late" } } });
    expect(transport.written.length).toBe(leaked);
  });
});

// ---------------------------------------------------------------------------
// Trusted argv encoding (transport extension)
// ---------------------------------------------------------------------------

describe("trusted argv + TOML encoding", () => {
  test("config flattens to --config overrides with SDK-compatible TOML values", () => {
    expect(
      codexAppServerTrustedArgv("/bin/codex", {
        mcp_servers: { omg: { env: { OMG_SESSION_ID: "s-1", LFG_SESSION_ID: "s-1" } } },
        service_tier: "fast",
        features: { fast_mode: true },
      }),
    ).toEqual([
      "/bin/codex",
      "app-server",
      "--stdio",
      "--config", 'mcp_servers.omg.env.OMG_SESSION_ID="s-1"',
      "--config", 'mcp_servers.omg.env.LFG_SESSION_ID="s-1"',
      "--config", 'service_tier="fast"',
      "--config", "features.fast_mode=true",
    ]);
  });

  test("values encode as real TOML: strings, numbers, booleans, arrays, nested tables", () => {
    expect(codexConfigTomlValue("plain", "p")).toBe('"plain"');
    expect(codexConfigTomlValue('with "quote" and \\', "p")).toBe(JSON.stringify('with "quote" and \\'));
    expect(codexConfigTomlValue("nl\n\t", "p")).toBe('"nl\\n\\t"');
    expect(codexConfigTomlValue(1.5, "p")).toBe("1.5");
    expect(codexConfigTomlValue(false, "p")).toBe("false");
    expect(codexConfigTomlValue(["a", "b"], "p")).toBe('["a", "b"]');
    expect(codexConfigTomlValue({ "weird name": { enabled: false }, bare: 1 }, "p")).toBe('{"weird name" = {enabled = false}, bare = 1}');
    expect(codexConfigTomlValue("tab\tnew\n", "p")).toBe('"tab\\tnew\\n"');
  });

  test("fail closed: null, non-finite, and unsafe dotted-path keys throw before spawn", () => {
    expect(() => codexConfigTomlValue(null, "p")).toThrow(CodexDaybreakError);
    expect(() => codexConfigTomlValue(Number.NaN, "p")).toThrow(CodexDaybreakError);
    expect(() => flattenCodexConfigOverrides({ mcp_servers: { "omg.enabled": { enabled: false } } })).toThrow(/dotted --config path/);
    // An empty key is never a valid override anywhere — the SDK rejects it too.
    expect(() => flattenCodexConfigOverrides({ "": 1 })).toThrow(CodexDaybreakError);
    expect(codexAppServerTrustedArgv("/bin/codex")).toEqual(["/bin/codex", "app-server", "--stdio"]);
  });
});

// ---------------------------------------------------------------------------
// Harness-side routing and validation helpers
// ---------------------------------------------------------------------------

describe("harness cyber-access-program helpers", () => {
  test("parseCyberAccessProgramArg validates against live metadata before boot", () => {
    expect(parseCyberAccessProgramArg(undefined, CAPS, "gpt-6-sol")).toEqual({ cyberAccessProgram: null });
    expect(parseCyberAccessProgramArg("", CAPS, "gpt-6-sol")).toEqual({ cyberAccessProgram: null });
    expect(parseCyberAccessProgramArg("daybreak_blue", CAPS, "gpt-6-sol")).toEqual({ cyberAccessProgram: "daybreakBlue" });
    expect(parseCyberAccessProgramArg("standard", CAPS, "gpt-6-sol")).toEqual({ cyberAccessProgram: "standard" });
    expect(() => parseCyberAccessProgramArg("daybreakRed", CAPS, "gpt-6-sol")).toThrow(CodexDaybreakError);
    expect(() => parseCyberAccessProgramArg("daybreakBlue", CAPS, "gpt-unknown")).toThrow(CodexDaybreakError);
    expect(() => parseCyberAccessProgramArg("banana", CAPS, "gpt-6-sol")).toThrow(CodexDaybreakError);
  });

  test("routing: explicit program or prior bridge keeps the app-server path", () => {
    expect(resolveCodexBridgePlan({ program: null, bridgeThreadId: null })).toBe("sdk");
    expect(resolveCodexBridgePlan({ program: "daybreakBlue", bridgeThreadId: null })).toBe("bridge");
    expect(resolveCodexBridgePlan({ program: "standard", bridgeThreadId: null })).toBe("bridge");
    // After the first daybreak, explicit off/standard stays on the bridge.
    expect(resolveCodexBridgePlan({ program: null, bridgeThreadId: "t-1" })).toBe("bridge");
    expect(resolveCodexBridgePlan({ program: "standard", bridgeThreadId: "t-1" })).toBe("bridge");
  });

  test("bridge argv reuses the SDK config layer; muse models are refused, not bridged", () => {
    const argv = buildCodexAppServerBridgeArgv({
      model: "gpt-6-sol",
      serviceTier: "fast",
      codexPath: "/bin/codex",
      codexConfig: null,
    });
    expect(argv[0]).toBe("/bin/codex");
    // The exact mcp_servers entries depend on this machine's config.toml, so
    // assert the shape: every override after the base argv is a --config
    // pair, and none disables tools or MCP.
    expect(argv.slice(1, 3)).toEqual(["app-server", "--stdio"]);
    for (let i = 3; i < argv.length; i += 2) {
      expect(argv[i]).toBe("--config");
      expect(argv[i + 1]).toMatch(/^[A-Za-z0-9_.-]+=/);
      expect(argv[i + 1]).not.toMatch(/^mcp_servers\.[^.]+=(\{\})?$/);
    }
    expect(() =>
      buildCodexAppServerBridgeArgv({ model: "muse-spark-1.3", codexPath: "/bin/codex", codexConfig: null }),
    ).toThrow(/Muse/);
  });
});


describe("reviewed concurrency and resource bounds", () => {
  test("abort during initialize never starts a thread or model turn", async () => {
    const t = new FakeTransport(), ac = new AbortController();
    t.onWrite((m) => { if (m.method === "initialize") ac.abort(); });
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport: t });
    await collect((await adapter.runStreamed("never run", { signal: ac.signal })).events);
    expect(t.requestByMethod("thread/start")).toBeUndefined();
    expect(t.requestByMethod("turn/start")).toBeUndefined();
    expect(t.closeCalls).toBe(1);
  });
  test("abort during thread creation never starts a model turn", async () => {
    const t = new FakeTransport(), ac = new AbortController();
    script(t, { initialize: () => ({}), "thread/start": () => { ac.abort(); return { thread: { id: "t-bridge-1" } }; } });
    const adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport: t });
    await collect((await adapter.runStreamed("never run", { signal: ac.signal })).events);
    expect(t.requestByMethod("turn/start")).toBeUndefined();
    expect(t.closeCalls).toBe(1);
  });
  test("thousands of unread draft deltas coalesce without losing the final answer", async () => {
    const t = bridgeTransport(), adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport: t });
    const stream = await adapter.runStreamed("Hi");
    for (let i = 0; i < 4000; i++) t.emit({ method: "item/agentMessage/delta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "a", delta: "x" } });
    t.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: "a", type: "agentMessage", text: "final answer" } } });
    t.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const rows = await collect(stream.events);
    expect(rows.filter(x => x.type === "item.updated").length).toBe(1);
    expect(rows.some(x => x.type === "item.completed" && x.item.type === "agent_message" && x.item.text === "final answer")).toBe(true);
    expect(rows.at(-1)?.type).toBe("turn.completed");
  });
  test("an unread terminal backlog fails visibly and closes its child", async () => {
    const t = bridgeTransport(), adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport: t });
    const stream = await adapter.runStreamed("Hi");
    for (let i = 0; i < 1500; i++) t.emit({ method: "item/completed", params: { threadId: "t-bridge-1", turnId: "turn-1", item: { id: `a${i}`, type: "agentMessage", text: "answer" } } });
    const rows = await collect(stream.events);
    expect(rows.at(-1)).toMatchObject({ type: "error" });
    expect(rows.some(x => x.type === "turn.completed")).toBe(false);
    expect(t.closeCalls).toBe(1);
  });
  test("command output signals progress while retaining only its bounded tail", async () => {
    const t = bridgeTransport(), adapter = new CodexAppServerThread({ model: "gpt-6-sol", transport: t });
    const stream = await adapter.runStreamed("Hi");
    t.emit({ method: "item/commandExecution/outputDelta", params: { threadId: "t-bridge-1", turnId: "turn-1", itemId: "cmd", delta: "x".repeat(100_000) } });
    t.emit({ method: "turn/completed", params: { threadId: "t-bridge-1", turn: { id: "turn-1", status: "completed" } } });
    const rows = await collect(stream.events), update = rows.find(x => x.type === "item.updated");
    expect(update?.type === "item.updated" && update.item.type === "command_execution" && update.item.aggregated_output.length < 66_000).toBe(true);
  });
});
