import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CodexDaybreakError,
  codexAppServerArgv,
  enumerateCodexMcpServers,
  DAYBREAK_DISABLED_FEATURES,
  initializeAppServer,
  listCodexAppServerModels,
  redactCodexErrorText,
  resolveCyberAccessProgram,
  runCodexDaybreakTurn,
  tomlQuotedKey,
  TOOLLESS_THREAD_CONFIG,
  CodexAppServerClient,
  type CodexAppServerTransport,
  type CodexModelCapabilities,
} from "./codex-daybreak.ts";
import { PATHS } from "./config.ts";

const SOL_CAPS: CodexModelCapabilities = {
  reasoningEfforts: ["low", "medium", "high"],
  cyberAccessPrograms: ["standard", "daybreakBlue"],
};
const CAPS: Record<string, CodexModelCapabilities> = { "gpt-6-sol": SOL_CAPS };
const ASTRA_ONLY: Record<string, CodexModelCapabilities> = {
  "gpt-6-astra": { reasoningEfforts: ["low"], cyberAccessPrograms: ["standard"] },
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/**
 * In-memory transport. Records every written line; scripted handlers answer
 * requests deterministically. No process, no network, no inference.
 */
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

  /** Deliver one framed message (object -> JSON line, or raw string). */
  emit(value: unknown): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const listener of [...this.lineListeners]) listener(`${text}\n`);
  }

  requests(): Array<Record<string, unknown>> {
    return this.written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => typeof message.method === "string" && message.id != null);
  }

  notifications(): Array<Record<string, unknown>> {
    return this.written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => typeof message.method === "string" && message.id == null);
  }

  requestByMethod(method: string): Record<string, unknown> | undefined {
    return this.requests().find((message) => message.method === method);
  }
}

/** Auto-answer requests by method name with a scripted result or RPC error. */
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

function happyPathTransport(): FakeTransport {
  const transport = new FakeTransport();
  script(transport, {
    initialize: () => ({ serverInfo: { name: "codex", version: "0.157.1" } }),
    "thread/start": () => ({ thread: { id: "t-1" }, model: "gpt-6-sol", reasoningEffort: "medium" }),
    "turn/start": () => ({ turn: { id: "turn-9" } }),
  });
  return transport;
}

// ---------------------------------------------------------------------------
// Program validation: pure, before any spawn
// ---------------------------------------------------------------------------

describe("resolveCyberAccessProgram", () => {
  test("an absent request stays automatic: no field on the wire", () => {
    expect(resolveCyberAccessProgram({ model: "gpt-6-sol", capabilities: CAPS })).toEqual({});
    expect(resolveCyberAccessProgram({ model: "gpt-6-sol" })).toEqual({});
  });

  test("normalizes the snake_case catalog spelling to the protocol enum", () => {
    expect(
      resolveCyberAccessProgram({ model: "gpt-6-sol", requested: "daybreak_blue", capabilities: CAPS }),
    ).toEqual({ cyberAccessProgram: "daybreakBlue" });
  });

  test("rejects an unknown program value", () => {
    try {
      resolveCyberAccessProgram({ model: "gpt-6-sol", requested: "daybreak_purple", capabilities: CAPS });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CodexDaybreakError);
      expect((e as CodexDaybreakError).code).toBe("unknown-program");
    }
  });

  test("rejects an explicit program for a model without metadata", () => {
    try {
      resolveCyberAccessProgram({
        model: "gpt-6.1-sol",
        requested: "daybreakBlue",
        capabilities: CAPS,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("no-metadata");
    }
  });

  test("rejects a program the account does not offer for that model", () => {
    // Astra's live metadata advertises cyber: ["standard"] only.
    const astraOnly = ASTRA_ONLY;
    try {
      resolveCyberAccessProgram({ model: "gpt-6-astra", requested: "daybreakBlue", capabilities: astraOnly });
      throw new Error("should have thrown");
    } catch (e) {
      const error = e as CodexDaybreakError;
      expect(error.code).toBe("program-not-offered");
      expect(error.message).toContain("gpt-6-astra");
      expect(error.message).toContain("standard");
    }
  });

  test("rejects when the metadata carries no access programs at all", () => {
    const noPrograms = { "gpt-6-sol": { reasoningEfforts: ["low"] } };
    try {
      resolveCyberAccessProgram({ model: "gpt-6-sol", requested: "standard", capabilities: noPrograms });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("program-not-offered");
    }
  });
});

// ---------------------------------------------------------------------------
// Spawn shape
// ---------------------------------------------------------------------------

describe("app-server argv", () => {
  test("app-server --stdio, one --disable per feature, ONE whole-map MCP override", () => {
    expect(
      codexAppServerArgv("/usr/bin/codex", {
        disabledFeatures: ["shell_tool", "apps"],
        mcpServerNames: ["omg", "foo"],
      }),
    ).toEqual([
      "/usr/bin/codex",
      "app-server",
      "--stdio",
      "--disable", "shell_tool",
      "--disable", "apps",
      "-c", 'mcp_servers={ "omg" = { enabled = false }, "foo" = { enabled = false } }',
    ]);
  });

  test("no configured MCP servers means no -c override at all", () => {
    expect(
      codexAppServerArgv("/bin/codex", { disabledFeatures: [], mcpServerNames: [] }),
    ).toEqual(["/bin/codex", "app-server", "--stdio"]);
  });

  test("the default feature set covers shell, apps, browser, image, code, tools", () => {
    expect(DAYBREAK_DISABLED_FEATURES).toContain("shell_tool");
    expect(DAYBREAK_DISABLED_FEATURES).toContain("apps");
    expect(DAYBREAK_DISABLED_FEATURES).toContain("browser_use");
    expect(DAYBREAK_DISABLED_FEATURES).toContain("image_generation");
    expect(DAYBREAK_DISABLED_FEATURES).toContain("view_image");
    expect(DAYBREAK_DISABLED_FEATURES).toContain("code_mode");
    expect(DAYBREAK_DISABLED_FEATURES).toContain("tool_suggest");
  });
});

describe("MCP config enumeration", () => {
  test("reads table headers: bare, double-quoted, single-quoted, dotted, sub-tables", () => {
    expect(
      enumerateCodexMcpServers(`
[model]
reasoning_effort = "high"

[mcp_servers.omg]
command = "bun"

[mcp_servers."weird name"]

[mcp_servers.'single quoted']

[mcp_servers."dotted.name" ]

[mcp_servers.omg.inner]
level = 1

[mcp_servers."esc\\"aped"]
`),
    ).toEqual({
      servers: ["omg", "weird name", "single quoted", "dotted.name", 'esc"aped'],
      unsafe: false,
    });
  });

  test("reads top-level dotted assignments that define servers", () => {
    expect(
      enumerateCodexMcpServers(`
mcp_servers.dotted = { command = "bun" }
mcp_servers."other one".args = ["--x"]
unrelated = true
`),
    ).toEqual({ servers: ["dotted", "other one"], unsafe: false });
  });

  test("a malicious dotted server name stays one quoted key and disables nothing else", () => {
    // Both a plain server and a server literally named "omg.enabled" exist.
    // In the whole-map VALUE (real TOML), quoting keeps each name exactly one
    // key — the dotted name can never flatten into server omg's `enabled`.
    const enumeration = enumerateCodexMcpServers(`
[mcp_servers.omg]
[mcp_servers."omg.enabled"]
`);
    expect(enumeration).toEqual({ servers: ["omg", "omg.enabled"], unsafe: false });
    const overrides = codexAppServerArgv("/bin/codex", {
      disabledFeatures: [],
      mcpServerNames: enumeration.servers,
    }).filter((part) => part.startsWith("mcp_servers="))[0]!;
    expect(overrides).toBe('mcp_servers={ "omg" = { enabled = false }, "omg.enabled" = { enabled = false } }');
  });

  test("tomlQuotedKey escapes backslash, quote, and control characters", () => {
    expect(tomlQuotedKey("omg")).toBe('"omg"');
    expect(tomlQuotedKey('we"ird')).toBe('"we\\"ird"');
    expect(tomlQuotedKey("back\\slash")).toBe('"back\\\\slash"');
    expect(tomlQuotedKey("line\nbreak")).toBe('"line\\u000abreak"');
  });

  test("inline mcp_servers tables make the scan unsafe instead of half-right", () => {
    const inline = enumerateCodexMcpServers('mcp_servers = { omg = { command = "bun" } }');
    expect(inline.unsafe).toBe(true);
    expect(inline.servers).toEqual([]);
    expect(inline.reason).toContain("inline or scalar");
    // An explicitly empty map defines no servers and stays safe.
    expect(enumerateCodexMcpServers("mcp_servers = {}")).toEqual({ servers: [], unsafe: false });
  });

  test("malformed mcp_servers keys make the scan unsafe", () => {
    expect(enumerateCodexMcpServers("mcp_servers.$$ = 1").unsafe).toBe(true);
    expect(enumerateCodexMcpServers("[mcp_servers.").unsafe).toBe(true);
    expect(enumerateCodexMcpServers("[[mcp_servers]]\nc = 1").unsafe).toBe(true);
    expect(enumerateCodexMcpServers("mcp_servers = 3").unsafe).toBe(true);
  });

  test("an unsafe config fails before spawn with a clear error", () => {
    try {
      codexAppServerArgv("/bin/codex", {
        disabledFeatures: [],
        configToml: 'mcp_servers = { omg = { command = "bun" } }',
      });
      throw new Error("should have thrown");
    } catch (e) {
      const error = e as CodexDaybreakError;
      expect(error.code).toBe("config-unsafe");
      expect(error.message).toContain("inline or scalar");
    }
    // The same enumeration feeds spawnCodexAppServerTransport's argv, so the
    // throw happens before Bun.spawn — nothing starts with MCP unenumerated.
  });
});

// ---------------------------------------------------------------------------
// Serialization and the one turn
// ---------------------------------------------------------------------------

describe("runCodexDaybreakTurn serialization", () => {
  test("initialize declares the experimental capability, then the initialized notice", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({
      prompt: "Hi",
      model: "gpt-6-sol",
      cyberAccessProgram: "daybreakBlue",
      capabilities: CAPS,
      transport,
    });
    await flush();
    transport.emit({
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "Hello" } },
    });
    transport.emit({ method: "turn/completed", params: { turn: { id: "turn-9", status: "completed" } } });
    await pending;

    const initialize = transport.requestByMethod("initialize");
    expect(initialize?.params).toMatchObject({
      clientInfo: { name: "omg_dev_daybreak", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    expect(transport.notifications().some((n) => n.method === "initialized" && n.params != null)).toBe(true);
  });

  test("thread/start is ephemeral, tool-less, and created for the requested model", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({
      prompt: "Hi",
      model: "gpt-6-sol",
      effort: "high",
      cyberAccessProgram: "daybreakBlue",
      capabilities: CAPS,
      cwd: "/tmp/daybreak",
      transport,
    });
    await flush();
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-1", turnId: "turn-9", item: { type: "agentMessage", text: "Hello" } },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-9", status: "completed" } } });
    const result = await pending;

    expect(transport.requestByMethod("thread/start")?.params).toEqual({
      ephemeral: true,
      config: TOOLLESS_THREAD_CONFIG,
      model: "gpt-6-sol",
      cwd: "/tmp/daybreak",
    });
    expect(TOOLLESS_THREAD_CONFIG).toEqual({
      web_search: "disabled",
      apps: { _default: { enabled: false } },
      sandbox_mode: "read-only",
      approval_policy: "never",
    });
    expect(transport.requestByMethod("turn/start")?.params).toEqual({
      threadId: "t-1",
      input: [{ type: "text", text: "Hi" }],
      model: "gpt-6-sol",
      effort: "high",
      cyberAccessProgram: "daybreakBlue",
    });
    expect(result).toEqual({
      text: "Hello",
      threadId: "t-1",
      turnId: "turn-9",
      status: "completed",
      requestedModel: "gpt-6-sol",
      requestedEffort: "high",
      servedModel: "gpt-6-sol",
      requestedCyberAccessProgram: "daybreakBlue",
    });
    expect(transport.closeCalls).toBeGreaterThan(0);
  });

  test("no cwd means no cwd field on the thread", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    transport.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "ok" } } });
    transport.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-9", status: "completed" } } });
    await pending;
    expect(transport.requestByMethod("thread/start")?.params).toEqual({
      ephemeral: true,
      config: TOOLLESS_THREAD_CONFIG,
      model: "gpt-6-sol",
    });
  });

  test("a thread model that differs from the request is never mislabeled served", async () => {
    // The thread reports its own default despite the turn override; a reroute
    // notice then moves it again. Neither may appear as servedModel.
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "t-1" }, model: "gpt-6-astra" }),
      "turn/start": () => ({ turn: { id: "turn-9" } }),
    });
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    transport.emit({
      method: "model/rerouted",
      params: { threadId: "t-1", turnId: "turn-9", fromModel: "gpt-6-astra", toModel: "gpt-6-luna", reason: "capacity" },
    });
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-1", turnId: "turn-9", item: { type: "agentMessage", text: "Hi there" } },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-9", status: "completed" } } });
    const result = await pending;
    expect(result.servedModel).toBeUndefined();
    expect(result.threadModel).toBe("gpt-6-luna");
    expect(result.reroutedFromModel).toBe("gpt-6-astra");
    expect(result.requestedModel).toBe("gpt-6-sol");
  });

  test("a reroute to exactly the requested model confirms served", async () => {
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "t-1" }, model: "gpt-6-astra" }),
      "turn/start": () => ({ turn: { id: "turn-9" } }),
    });
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    transport.emit({
      method: "model/rerouted",
      params: { threadId: "t-1", turnId: "turn-9", fromModel: "gpt-6-astra", toModel: "gpt-6-sol" },
    });
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-1", turnId: "turn-9", item: { type: "agentMessage", text: "ok" } },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-9", status: "completed" } } });
    const result = await pending;
    expect(result.servedModel).toBe("gpt-6-sol");
    expect(result.threadModel).toBeUndefined();
  });

  test("absent program and effort mean absent fields, never explicit standard", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    transport.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "ok" } } });
    transport.emit({ method: "turn/completed", params: { turn: { id: "turn-9", status: "completed" } } });
    await pending;

    const params = transport.requestByMethod("turn/start")?.params as Record<string, unknown>;
    expect("cyberAccessProgram" in params).toBe(false);
    expect("effort" in params).toBe(false);
  });

  test("rejects an incompatible program BEFORE creating any transport", async () => {
    let spawns = 0;
    const astraOnly = ASTRA_ONLY;
    try {
      await runCodexDaybreakTurn({
        prompt: "Hi",
        model: "gpt-6-astra",
        cyberAccessProgram: "daybreakBlue",
        capabilities: astraOnly,
        transport: () => {
          spawns++;
          return new FakeTransport();
        },
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("program-not-offered");
      expect(spawns).toBe(0);
    }
  });
});

describe("runCodexDaybreakTurn robustness", () => {
  test("denies every server request with a JSON-RPC error and still finishes", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    // A tool approval mid-turn: the adapter must deny it without blocking.
    transport.emit({ id: 41, method: "item/commandExecution/requestApproval", params: { callId: "c1" } });
    transport.emit({ id: 42, method: "item/tool/call", params: { tool: "shell" } });
    await flush();
    transport.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "done" } } });
    transport.emit({ method: "turn/completed", params: { turn: { id: "turn-9", status: "completed" } } });
    await pending;

    const replies = transport.written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((message) => message.id === 41 || message.id === 42);
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply.error).toMatchObject({ code: -32000 });
      expect(reply.result).toBeUndefined();
    }
  });

  test("tolerates stray non-protocol lines within bounds", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    transport.emit("not json at all");
    transport.emit("");
    transport.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "ok" } } });
    transport.emit({ method: "turn/completed", params: { turn: { id: "turn-9", status: "completed" } } });
    const result = await pending;
    expect(result.status).toBe("completed");
  });

  test("a line beyond the framing cap fails bounded instead of buffering", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({
      prompt: "Hi",
      model: "gpt-6-sol",
      capabilities: CAPS,
      transport,
      timeoutMs: 250,
    });
    await flush();
    transport.emit(`{"junk":"${"x".repeat(1_200_000)}"}`);
    try {
      await pending;
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("closed");
    }
    expect(transport.closeCalls).toBeGreaterThan(0);
  });

  test("timeout interrupts the own turn, fails bounded, shuts the transport down", async () => {
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({}),
      "thread/start": () => ({ thread: { id: "t-1" }, model: "gpt-6-sol" }),
      "turn/start": () => ({ turn: { id: "turn-9" } }),
      // No turn/completed, no turn/interrupt answer: the deadline must fire.
    });
    try {
      await runCodexDaybreakTurn({
        prompt: "Hi",
        model: "gpt-6-sol",
        capabilities: CAPS,
        transport,
        timeoutMs: 60,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("timeout");
    }
    expect(transport.requestByMethod("turn/interrupt")?.params).toEqual({ threadId: "t-1", turnId: "turn-9" });
    expect(transport.closeCalls).toBeGreaterThan(0);
  });

  test("a failed turn surfaces a redacted, bounded message", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    transport.emit({
      method: "turn/completed",
      params: { turn: { id: "turn-9", status: "failed", error: { message: `rate limited sk-abcdefghijklmnop123456 ${"y".repeat(500)}` } } },
    });
    try {
      await pending;
      throw new Error("should have thrown");
    } catch (e) {
      const error = e as CodexDaybreakError;
      expect(error.code).toBe("turn-failed");
      expect(error.message).not.toContain("sk-abcdefghijklmnop123456");
      expect(error.message).toContain("«redacted»");
      expect(error.message.length).toBeLessThanOrEqual(300 + "Daybreak turn failed: ".length);
    }
  });

  test("a JSON-RPC error reply is redacted and bounded", async () => {
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({}),
      "thread/start": () => ({ __rpcError: { code: -32001, message: "auth exploded Bearer abcdef1234567890abcdef" } }),
    });
    try {
      await runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
      throw new Error("should have thrown");
    } catch (e) {
      const error = e as CodexDaybreakError;
      expect(error.code).toBe("codex-error");
      expect(error.message).not.toContain("abcdef1234567890abcdef");
      expect(error.message).toContain("«redacted»");
    }
  });

  test("only a turn/completed status of exactly completed settles success", async () => {
    for (const status of ["interrupted", "inProgress", "banana", undefined]) {
      const transport = happyPathTransport();
      const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
      await flush();
      transport.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "partial" } } });
      transport.emit({
        method: "turn/completed",
        params: { threadId: "t-1", turn: { id: "turn-9", ...(status == null ? {} : { status }) } },
      });
      try {
        await pending;
        throw new Error(`status ${String(status)} should have rejected`);
      } catch (e) {
        const error = e as CodexDaybreakError;
        expect(error.code).toBe("turn-failed");
        expect(error.message).toContain(status == null ? "missing" : status);
      }
    }
  });

  test("notifications for another thread or turn are ignored, not merged", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    // Foreign thread: both its reply text and its completion must be dropped.
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-OTHER", turnId: "turn-x", item: { type: "agentMessage", text: "not ours" } },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "t-OTHER", turn: { id: "turn-x", status: "completed" } } });
    // Foreign turn on our thread: same.
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-1", turnId: "turn-x", item: { type: "agentMessage", text: "not ours either" } },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-x", status: "completed" } } });
    await flush();
    // The real one completes with only its own text.
    transport.emit({
      method: "item/completed",
      params: { threadId: "t-1", turnId: "turn-9", item: { type: "agentMessage", text: "ours" } },
    });
    transport.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-9", status: "completed" } } });
    const result = await pending;
    expect(result.text).toBe("ours");
  });

  test("a completed turn with an empty reply is a visible error", async () => {
    const transport = happyPathTransport();
    const pending = runCodexDaybreakTurn({ prompt: "Hi", model: "gpt-6-sol", capabilities: CAPS, transport });
    await flush();
    transport.emit({ method: "turn/completed", params: { threadId: "t-1", turn: { id: "turn-9", status: "completed" } } });
    try {
      await pending;
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("empty-reply");
      expect((e as CodexDaybreakError).message).toContain("empty reply");
    }
    expect(transport.closeCalls).toBeGreaterThan(0);
  });

  test("the overall deadline bounds the start phase too, before any turn exists", async () => {
    const transport = new FakeTransport();
    script(transport, {
      // initialize never answers; thread/start and turn/start never happen.
    });
    try {
      await runCodexDaybreakTurn({
        prompt: "Hi",
        model: "gpt-6-sol",
        capabilities: CAPS,
        transport,
        timeoutMs: 60,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("timeout");
    }
    expect(transport.requestByMethod("turn/interrupt")).toBeUndefined();
    expect(transport.closeCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// model/list stays read-only
// ---------------------------------------------------------------------------

describe("listCodexAppServerModels", () => {
  test("normalizes live app-server metadata and never starts a thread or turn", async () => {
    const transport = new FakeTransport();
    script(transport, {
      initialize: () => ({}),
      "model/list": () => ({
        data: [
          { id: "gpt-6-sol", displayName: "GPT-6-Sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "low", availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] } },
          { id: "gpt-daybreak-blue-latest", displayName: "Daybreak Blue", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], availableAccessPrograms: { cyber: ["daybreakBlue"] } },
          { id: "gpt-reserve", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], availableAccessPrograms: { cyber: ["daybreakRed"] } },
        ],
        nextCursor: null,
      }),
    });
    const list = await listCodexAppServerModels({ transport });
    expect(list.models).toEqual(["gpt-6-sol", "gpt-daybreak-blue-latest"]);
    expect(list.labels["gpt-daybreak-blue-latest"]).toBe("Daybreak Blue");
    expect(list.capabilities["gpt-6-sol"]).toEqual({
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      cyberAccessPrograms: ["standard", "daybreakBlue"],
    });
    expect(list.capabilities["gpt-daybreak-blue-latest"]?.cyberAccessPrograms).toEqual(["daybreakBlue"]);
    expect(list.capabilities["gpt-reserve"]).toBeUndefined();
    const methods = transport.requests().map((message) => message.method);
    expect(methods).toContain("initialize");
    expect(methods).not.toContain("thread/start");
    expect(methods).not.toContain("turn/start");
    expect(transport.closeCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Bounded helpers
// ---------------------------------------------------------------------------

describe("redactCodexErrorText", () => {
  test("strips credential shapes and caps length", () => {
    const out = redactCodexErrorText(`boom \x1b[31mred sk-abcdefghijklmnop123456 and Bearer zzzz1111zzzz2222 tail ${"a".repeat(400)}`);
    expect(out).not.toContain("sk-abcdefghijklmnop123456");
    expect(out).not.toContain("zzzz1111zzzz2222");
    expect(out).not.toContain("\x1b");
    expect(out.length).toBeLessThanOrEqual(300);
  });

  test("redacts BEFORE truncating: a secret at the cap boundary leaves no prefix", () => {
    // 290 filler characters put the key right at the 300-char cut. Redaction
    // must run first, so the truncated text cannot leak "sk-abcdefgh…".
    const out = redactCodexErrorText(`${"a".repeat(290)} sk-abcdefghijklmnop123456 tail`);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{4,}/);
    expect(out).toContain("«redacted»");
  });
});

// ---------------------------------------------------------------------------
// Client framing details
// ---------------------------------------------------------------------------

describe("CodexAppServerClient", () => {
  test("a stray response after its request timed out is ignored, not fatal", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport, { defaultTimeoutMs: 30 });
    const pending = client.request("model/list", {});
    try {
      await pending;
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CodexDaybreakError).code).toBe("timeout");
    }
    transport.emit({ id: 1, result: { data: [] } }); // late: must not throw
    await client.close();
    expect(transport.closeCalls).toBeGreaterThan(0);
  });

  test("initializeAppServer sends the experimental capability and the notice", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const pending = initializeAppServer(client);
    await flush();
    expect(transport.requests()[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    // The notice only goes out after the server answered.
    expect(transport.notifications()).toHaveLength(0);
    transport.emit({ id: 1, result: {} });
    await pending;
    expect(transport.notifications()[0]).toMatchObject({ method: "initialized" });
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Catalog carries discovered metadata (agent-catalog integration surface)
// ---------------------------------------------------------------------------

describe("catalog carries discovered capability metadata", () => {
  const originalData = PATHS.data;
  function withCache(providers: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
    const root = join("/var/folders/rh/knlyzddx7n3bmksk2w0snhs00000gn/T/opencode", `daybreak-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    return (async () => {
      await Bun.write(
        join(root, "model-catalog.json"),
        JSON.stringify({ version: 1, refreshedAt: Date.now(), schedule: "0 8 * * *", timeZone: "UTC", providers }),
      );
      (PATHS as { data: string }).data = root;
      try {
        await run();
      } finally {
        (PATHS as { data: string }).data = originalData;
        rmSync(root, { recursive: true, force: true });
      }
    })();
  }

  test("codex and the mirrored codex-aisdk entry expose per-model capabilities", async () => {
    const capabilities: Record<string, CodexModelCapabilities> = {
      "gpt-6-sol": { reasoningEfforts: ["low"], cyberAccessPrograms: ["standard", "daybreakBlue"] },
    };
    await withCache(
      {
        codex: { key: "codex", ok: true, models: ["gpt-6-sol"], refreshedAt: Date.now(), durationMs: 1, modelCapabilities: capabilities },
        "codex-aisdk": { key: "codex-aisdk", ok: true, models: ["gpt-6-sol"], refreshedAt: Date.now(), durationMs: 1, modelCapabilities: capabilities },
      },
      async () => {
        const { listModelCatalog } = await import("./agent-catalog.ts");
        const codex = listModelCatalog().find((item) => item.key === "codex");
        const aisdk = listModelCatalog().find((item) => item.key === "codex-aisdk");
        expect(codex?.modelCapabilities).toEqual(capabilities);
        expect(aisdk?.modelCapabilities).toEqual(capabilities);
      },
    );
  });

  test("no metadata in the cache means no advertised program, statically never", async () => {
    await withCache(
      { codex: { key: "codex", ok: true, models: ["gpt-6-sol"], refreshedAt: Date.now(), durationMs: 1 } },
      async () => {
        const { listModelCatalog } = await import("./agent-catalog.ts");
        const codex = listModelCatalog().find((item) => item.key === "codex");
        expect(codex?.modelCapabilities).toBeUndefined();
      },
    );
  });
});
