// stdio→HTTP namespace adaptation for the Mac main-chat bridge.
//
// Some central MCP namespaces are stdio servers in the provider user configs
// (chrome-work, omg on codex, …). The Mac cannot spawn them (no auth, no
// binaries); the bridge adapts them ON THE AGENTBOX instead: each adapted
// namespace spawns its stdio server via the official MCP SDK
// (StdioClientTransport) with the session identity env, and the resulting
// client is served under /mcp/<name> behind the lease.
//
// Lifecycle: one child per (namespace, session lease) pair; the child is
// closed on lease revoke, on bridge shutdown, and after idle (no request for
// idleCloseMs). Only trusted control-plane registrations reach this module —
// the command/args come from the central user config, never from the wire.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type StdioServerSpec = {
  name: string;
  /** Lease-scoped key (`<leaseId>|<name>`); defaults to `name`. Children are
   * never shared across leases — one session identity per child. */
  key?: string;
  command: string;
  args: string[];
  /** Session identity env (OMG_SESSION_ID / LFG_SESSION_ID) merged in. */
  env?: Record<string, string>;
  /** Working directory for the stdio server. */
  cwd?: string;
};

export type StdioAdapterLimits = {
  /** Requests are proxied as single JSON-RPC messages; cap each body. */
  maxRequestBytes: number;
  /** Close the child when no request arrived for this long. */
  idleCloseMs: number;
  /** Per-request bound. */
  requestTimeoutMs: number;
};

export const DEFAULT_STDIO_ADAPTER_LIMITS: StdioAdapterLimits = {
  maxRequestBytes: 4 * 1024 * 1024,
  idleCloseMs: 10 * 60_000,
  requestTimeoutMs: 120_000,
};

type AdaptedServer = {
  client: Client;
  closing: Promise<void> | null;
};

/**
 * Registry of adapted stdio namespaces. Owns its children exclusively: each
 * child was spawned by THIS process, is closed by THIS process, and never
 * shared across leases with different session identity.
 */
export class StdioNamespaceAdapter {
  private servers = new Map<string, AdaptedServer>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly limits: StdioAdapterLimits;

  constructor(
    limits: Partial<StdioAdapterLimits> = {},
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => {},
  ) {
    this.limits = { ...DEFAULT_STDIO_ADAPTER_LIMITS, ...limits };
  }

  private idleWatch(name: string): void {
    const existing = this.idleTimers.get(name);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.close(name);
    }, this.limits.idleCloseMs);
    (timer as { unref?: () => void }).unref?.();
    this.idleTimers.set(name, timer);
  }

  private async getOrCreate(spec: StdioServerSpec): Promise<Client> {
    const key = spec.key ?? spec.name;
    const existing = this.servers.get(key);
    if (existing) {
      this.idleWatch(key);
      return existing.client;
    }
    const client = new Client(
      { name: `omg-mac-chat-bridge-${key}`, version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: {
        ...(spec.env ?? {}),
      },
    });
    await client.connect(transport);
    this.servers.set(key, { client, closing: null });
    this.log("bridge.stdio.spawn", { namespace: key });
    this.idleWatch(key);
    return client;
  }

  /**
   * Handle one /mcp/<name> request for a stdio namespace: initialize /
   * tools/list / tools/call are answered from the adapted client; MCP
   * lifecycle methods keep their native semantics (session state lives in
   * the child). Unknown methods fail closed with -32601.
   */
  async handle(spec: StdioServerSpec, req: Request, body: Uint8Array | undefined): Promise<Response> {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "stdio namespace accepts POST only" }), {
        status: 405,
        headers: { allow: "POST", "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (body && body.byteLength > this.limits.maxRequestBytes) {
      return Response.json({ ok: false, error: "body_too_large" }, { status: 413, headers: { "cache-control": "no-store" } });
    }
    let message: { id?: number | string | null; method?: string; params?: Record<string, unknown>; jsonrpc?: string };
    try {
      message = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as typeof message;
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { headers: { "cache-control": "no-store" } });
    }
    const isNotification = message.id === undefined;
    const respond = (payload: unknown): Response =>
      isNotification
        ? new Response(null, { status: 202, headers: { "cache-control": "no-store" } })
        : Response.json(payload, { headers: { "cache-control": "no-store" } });

    try {
      const client = await this.getOrCreate(spec);
      const method = message.method ?? "";
      if (method === "initialize") {
        // The adapted child is already connected (getOrCreate); answer the
        // MCP handshake from the bridge with the child's declared identity.
        const serverInfo = (client as unknown as { getServerVersion?: () => { name?: string; version?: string } | undefined })
          .getServerVersion?.() ?? { name: spec.name, version: "adapted" };
        return respond({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `omg-bridge-${serverInfo.name ?? spec.name}`, version: serverInfo.version ?? "1.0.0" },
          },
        });
      }
      if (method === "ping") {
        await client.ping();
        return respond({ jsonrpc: "2.0", id: message.id ?? null, result: {} });
      }
      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
      }
      if (method === "tools/list") {
        const result = await client.listTools();
        return respond({ jsonrpc: "2.0", id: message.id ?? null, result });
      }
      if (method === "tools/call") {
        const name = message.params?.name;
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        if (typeof name !== "string") {
          return respond({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32602, message: "tool name required" } });
        }
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.limits.requestTimeoutMs });
        return respond({ jsonrpc: "2.0", id: message.id ?? null, result });
      }
      if (method === "resources/list") {
        const result = await client.listResources();
        return respond({ jsonrpc: "2.0", id: message.id ?? null, result });
      }
      if (method === "prompts/list") {
        const result = await client.listPrompts();
        return respond({ jsonrpc: "2.0", id: message.id ?? null, result });
      }
      return respond({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (error) {
      this.log("bridge.stdio.fail", { namespace: spec.name, name: error instanceof Error ? error.name : "unknown" });
      // A dead child must not poison the next request: drop it so the next
      // call spawns a fresh one.
      await this.close(spec.name);
      return respond({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32000, message: "stdio namespace upstream failed" },
      });
    }
  }

  /** Close ONE adapted child, a set of keys, or all when omitted. */
  async close(name?: string | string[]): Promise<void> {
    const wanted = name === undefined ? undefined : Array.isArray(name) ? name : [name];
    const targets = wanted === undefined
      ? [...this.servers.keys()]
      : wanted.filter((k) => this.servers.has(k));
    await Promise.all(targets.map((key) => (async () => {
      const entry = this.servers.get(key);
      const timer = this.idleTimers.get(key);
      if (timer) clearTimeout(timer);
      this.idleTimers.delete(key);
      if (!entry) return;
      this.servers.delete(key);
      if (!entry.closing) {
        entry.closing = (async () => {
          try {
            await entry.client.close();
          } catch {}
        })();
      }
      await entry.closing;
      this.log("bridge.stdio.close", { namespace: key });
    })()));
  }
}
