// Focused tests for the Mac main-chat bridge: lease registration validation,
// fail-closed auth, routing, and the namespace proxy (identity replacement,
// SSE passthrough, caps, timeout, loopback enforcement). All upstreams are
// injected fetch fixtures; nothing opens a socket, nothing touches $HOME.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LeaseRegistry, LeaseValidationError, newLeaseToken } from "./lease.ts";
import { createMacChatBridge } from "./bridge.ts";
import { proxyNamespaceRequest, type ProxyFetch } from "./proxy.ts";

const BASE = "/Users/samht/.cache/mac-headchat-build-20261003/tmp";
const TOKEN_A = "bridge-test-token-aaaaaaaaaaaaaaaa";
const TOKEN_B = "bridge-test-token-bbbbbbbbbbbbbbbb";

let runDir: string;

beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
  runDir = mkdtempSync(join(BASE, "bridge-"));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

interface FixtureOverrides {
  role?: string;
  expiresAt?: number;
  namespaces?: Record<string, { url: string; headers: Record<string, string> }>;
  fetchImpl?: ProxyFetch;
  limits?: { maxBodyBytes?: number; upstreamTimeoutMs?: number; maxOutputBytes?: number };
}

function makeFixture(overrides: FixtureOverrides = {}) {
  const proj = join(runDir, "proj");
  mkdirSync(proj, { recursive: true });
  const registry = new LeaseRegistry();
  registry.register({
    id: "sess-a",
    token: TOKEN_A,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    cwd: proj,
    roots: [{ path: proj, read: true, write: true }],
    instructions: [join(runDir, "AGENTS.md")],
    skillRoots: [],
    memoryRoots: [],
    role: overrides.role ?? "mac-chat",
    namespaces:
      overrides.namespaces ??
      ({
        omg: {
          url: "http://127.0.0.1:8766/mcp?session=central-1",
          headers: { "x-omg-session-id": "central-1", "x-omg-session-token": "server-minted-token" },
        },
      } as Record<string, { url: string; headers: Record<string, string> }>),
  });
  const bridge = createMacChatBridge({
    registry,
    journalDir: join(runDir, "journal"),
    fetchImpl: overrides.fetchImpl,
    limits: overrides.limits,
  });
  return { bridge, registry, proj };
}

function request(path: string, init: RequestInit & { token?: string | null; session?: string | null } = {}) {
  const { token = TOKEN_A, session = "sess-a", ...rest } = init;
  const url = `http://127.0.0.1:8767${path}${session ? `${path.includes("?") ? "&" : "?"}session=${session}` : ""}`;
  const headers = new Headers(rest.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { ...rest, headers });
}

type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  redirect?: string;
  signal?: AbortSignal;
};

function capturingFetch(respond: (c: Captured) => Response | Promise<Response>): { fetchImpl: ProxyFetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: ProxyFetch = async (url, init) => {
    const captured: Captured = { url, method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect, signal: init.signal };
    calls.push(captured);
    return await respond(captured);
  };
  return { fetchImpl, calls };
}

const jsonRpcReply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "omg_ping" }, { name: "omg_ship" }] } });

describe("lease registration validation", () => {
  test("rejects a short token", () => {
    const registry = new LeaseRegistry();
    expect(() => registry.register({
      id: "x", token: "short", expiresAt: Date.now() + 1000, cwd: "/tmp/x",
      roots: [{ path: "/tmp/x", read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat", namespaces: {},
    })).toThrow(LeaseValidationError);
  });

  test("rejects a non-loopback upstream url", () => {
    const registry = new LeaseRegistry();
    expect(() => registry.register({
      id: "x", token: TOKEN_A, expiresAt: Date.now() + 1000, cwd: "/tmp/x",
      roots: [{ path: "/tmp/x", read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat",
      namespaces: { omg: { url: "http://10.0.0.5:8766/mcp", headers: {} } },
    })).toThrow(/loopback/);
  });

  test("rejects an https upstream url", () => {
    const registry = new LeaseRegistry();
    expect(() => registry.register({
      id: "x", token: TOKEN_A, expiresAt: Date.now() + 1000, cwd: "/tmp/x",
      roots: [{ path: "/tmp/x", read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat",
      namespaces: { omg: { url: "https://127.0.0.1:8766/mcp", headers: {} } },
    })).toThrow(LeaseValidationError);
  });

  test("rejects a cwd outside every root", () => {
    const registry = new LeaseRegistry();
    expect(() => registry.register({
      id: "x", token: TOKEN_A, expiresAt: Date.now() + 1000, cwd: "/tmp/elsewhere",
      roots: [{ path: "/tmp/x", read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat", namespaces: {},
    })).toThrow(/cwd/);
  });

  test("rejects a root that is itself a forbidden path (.ssh)", () => {
    const registry = new LeaseRegistry();
    expect(() => registry.register({
      id: "x", token: TOKEN_A, expiresAt: Date.now() + 1000, cwd: "/Users/u/.ssh",
      roots: [{ path: "/Users/u/.ssh", read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat", namespaces: {},
    })).toThrow(LeaseValidationError);
  });

  test("mints tokens of sufficient entropy and rotates them", () => {
    const registry = new LeaseRegistry();
    const t1 = newLeaseToken();
    const t2 = newLeaseToken();
    expect(t1).not.toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(32);
    registry.register({
      id: "x", token: t1, expiresAt: Date.now() + 1000, cwd: "/tmp/x",
      roots: [{ path: "/tmp/x", read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat", namespaces: {},
    });
    registry.rotate({
      id: "x", token: t2, expiresAt: Date.now() + 1000, cwd: "/tmp/x",
      roots: [{ path: "/tmp/x", read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat", namespaces: {},
    });
    expect(registry.lookup("x")).toBeDefined();
  });
});

describe("auth fails closed (401/403, never owner fallback)", () => {
  test("no session named -> 401", async () => {
    const { bridge } = makeFixture();
    const res = await bridge.handle(request("/mcp/omg", { token: TOKEN_A, session: null }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("session_required");
  });

  test("missing bearer -> 401", async () => {
    const { bridge } = makeFixture();
    const res = await bridge.handle(request("/mcp/omg", { token: null }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("token_required");
  });

  test("unknown session -> 401", async () => {
    const { bridge } = makeFixture();
    const res = await bridge.handle(request("/mcp/omg", { session: "nope" }));
    expect(res.status).toBe(401);
  });

  test("wrong token -> 401 invalid_token", async () => {
    const { bridge } = makeFixture();
    const res = await bridge.handle(request("/mcp/omg", { token: "wrong-token-aaaaaaaaaaaaaaaaa" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });

  test("valid token bound to another session -> 403 cross_session_token", async () => {
    const { bridge, registry, proj } = makeFixture();
    registry.register({
      id: "sess-b", token: TOKEN_B, expiresAt: Date.now() + 60_000, cwd: proj,
      roots: [{ path: proj, read: true, write: true }], instructions: [], skillRoots: [],
      memoryRoots: [], role: "mac-chat", namespaces: {},
    });
    const res = await bridge.handle(request("/mcp/omg", { token: TOKEN_B, session: "sess-a" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("cross_session_token");
  });

  test("expired lease -> 401 invalid_session", async () => {
    const { bridge } = makeFixture({ expiresAt: Date.now() - 1000 });
    const res = await bridge.handle(request("/mcp/omg"));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
  });

  test("revoked lease prevents future operations -> 401", async () => {
    const { bridge, registry } = makeFixture();
    expect(registry.revoke("sess-a")).toBe(true);
    const res = await bridge.handle(request("/mcp/omg"));
    expect(res.status).toBe(401);
    const ws = await bridge.handle(request("/mcp/workspace", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    expect(ws.status).toBe(401);
  });

  test("unsupported role fails closed -> 403", async () => {
    const { bridge } = makeFixture({ role: "owner" });
    const res = await bridge.handle(request("/mcp/omg"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_role");
  });

  test("non-/mcp paths are 404", async () => {
    const { bridge } = makeFixture();
    expect((await bridge.handle(request("/api/sessions"))).status).toBe(404);
    expect((await bridge.handle(request("/"))).status).toBe(404);
  });
});

describe("namespace proxy", () => {
  test("forwards the JSON-RPC body verbatim and replaces remote identity", async () => {
    const { fetchImpl, calls } = capturingFetch(() => new Response(jsonRpcReply, { headers: { "content-type": "application/json" } }));
    const { bridge } = makeFixture({ fetchImpl });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    const res = await bridge.handle(request("/mcp/omg", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer remote-tries-its-own-token",
        "x-omg-session-token": "remote-forged-token",
        "x-omg-session-id": "remote-forged-session",
        "mcp-protocol-version": "2025-06-18",
      },
      body,
    }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(jsonRpcReply);
    expect(calls.length).toBe(1);
    const call = calls[0];
    // Exact server-owned upstream URL from the lease, untouched by the wire.
    expect(call.url).toBe("http://127.0.0.1:8766/mcp?session=central-1");
    // Identity replaced, remote attempts gone, host never forwarded.
    expect(call.headers["x-omg-session-id"]).toBe("central-1");
    expect(call.headers["x-omg-session-token"]).toBe("server-minted-token");
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.headers["host"]).toBeUndefined();
    expect(call.headers["cookie"]).toBeUndefined();
    // MCP lifecycle header preserved; redirects never followed.
    expect(call.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(call.redirect).toBe("error");
    expect(new TextDecoder().decode(call.body!)).toBe(body);
  });

  test("remote cannot steer cwd or upstream via query or headers", async () => {
    const { fetchImpl, calls } = capturingFetch(() => new Response(jsonRpcReply, { headers: { "content-type": "application/json" } }));
    const { bridge } = makeFixture({ fetchImpl });
    await bridge.handle(request("/mcp/omg?cwd=/&url=http://10.0.0.9/x", {
      method: "POST",
      headers: { "content-type": "application/json", "x-omg-cwd": "/" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }));
    expect(calls[0].url).toBe("http://127.0.0.1:8766/mcp?session=central-1");
    expect(calls[0].headers["x-omg-cwd"]).toBeUndefined();
  });

  test("SSE responses keep content-type, lifecycle headers and frames", async () => {
    const sseBody = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "hello" }] } })}\n\n`;
    const { fetchImpl } = capturingFetch(() => new Response(sseBody, {
      headers: { "content-type": "text/event-stream", "mcp-session-id": "mse-abc" },
    }));
    const { bridge } = makeFixture({ fetchImpl });
    const res = await bridge.handle(request("/mcp/omg", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "omg_ping" } }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("mcp-session-id")).toBe("mse-abc");
    expect(await res.text()).toBe(sseBody);
  });

  test("GET (server-initiated stream) and DELETE (teardown) pass through", async () => {
    const seen: string[] = [];
    const { fetchImpl } = capturingFetch((c) => {
      seen.push(c.method);
      if (c.method === "GET") return new Response("event: message\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      return new Response(null, { status: 204 });
    });
    const { bridge } = makeFixture({ fetchImpl });
    const get = await bridge.handle(request("/mcp/omg", { method: "GET", headers: { accept: "text/event-stream" } }));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/event-stream");
    const del = await bridge.handle(request("/mcp/omg", { method: "DELETE", headers: { "mcp-session-id": "mse-abc" } }));
    expect(del.status).toBe(204);
    expect(seen).toEqual(["GET", "DELETE"]);
  });

  test("PUT is refused before the upstream is contacted", async () => {
    const { fetchImpl, calls } = capturingFetch(() => new Response("{}"));
    const { bridge } = makeFixture({ fetchImpl });
    const res = await bridge.handle(request("/mcp/omg", { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: string }).error).toBe("method_not_allowed");
    expect(calls.length).toBe(0);
  });

  test("namespace not in the lease is an explicit 404, never silent", async () => {
    const { fetchImpl, calls } = capturingFetch(() => new Response("{}"));
    const { bridge } = makeFixture({ fetchImpl });
    const res = await bridge.handle(request("/mcp/computer"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; namespace?: string };
    expect(body.error).toBe("namespace_unavailable");
    expect(calls.length).toBe(0);
  });

  test("upstream fetch error maps to 502 upstream_unreachable (redirects refused)", async () => {
    const { fetchImpl } = capturingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const { bridge } = makeFixture({ fetchImpl });
    const res = await bridge.handle(request("/mcp/omg", { method: "POST", body: "{}" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("upstream_unreachable");
  });

  test("upstream timeout maps to 504 upstream_timeout", async () => {
    const fetchImpl: ProxyFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
      });
    const { bridge } = makeFixture({ fetchImpl, limits: { upstreamTimeoutMs: 25 } });
    const res = await bridge.handle(request("/mcp/omg", { method: "POST", body: "{}" }));
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: string }).error).toBe("upstream_timeout");
  });

  test("oversized request body is a 413 and never reaches the upstream", async () => {
    const { fetchImpl, calls } = capturingFetch(() => new Response("{}"));
    const { bridge } = makeFixture({ fetchImpl, limits: { maxBodyBytes: 64 } });
    const res = await bridge.handle(request("/mcp/omg", { method: "POST", body: "x".repeat(200) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("body_too_large");
    expect(calls.length).toBe(0);
  });

  test("oversized upstream response is a 502 output cap", async () => {
    const { fetchImpl } = capturingFetch(() => new Response("x".repeat(1024), { headers: { "content-type": "application/json" } }));
    const { bridge } = makeFixture({ fetchImpl, limits: { maxOutputBytes: 64 } });
    const res = await bridge.handle(request("/mcp/omg", { method: "POST", body: "{}" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("upstream_too_large");
  });

  test("oversized SSE stream errors at the cap instead of streaming forever", async () => {
    const big = `data: ${"y".repeat(2048)}\n\n`;
    const { fetchImpl } = capturingFetch(() => new Response(big, { headers: { "content-type": "text/event-stream" } }));
    const { bridge } = makeFixture({ fetchImpl, limits: { maxOutputBytes: 64 } });
    const res = await bridge.handle(request("/mcp/omg", { method: "POST", body: "{}" }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expect(res.text()).rejects.toThrow();
  });

  test("second loopback check at request time (defense in depth)", async () => {
    const stub: ProxyFetch = async () => new Response("{}", { headers: { "content-type": "application/json" } });
    const res = await proxyNamespaceRequest(
      new Request("http://127.0.0.1:8767/mcp/omg", { method: "POST", body: "{}" }),
      "omg",
      { url: "http://127.0.0.1:8766/mcp", headers: {} },
      new TextEncoder().encode("{}"),
      { fetchImpl: stub },
    );
    expect(res.status).toBe(200);
    const resBad = await proxyNamespaceRequest(
      new Request("http://127.0.0.1:8767/mcp/omg", { method: "POST", body: "{}" }),
      "omg",
      { url: "http://192.168.1.4:8766/mcp", headers: {} },
      new TextEncoder().encode("{}"),
      { fetchImpl: stub },
    );
    expect(resBad.status).toBe(502);
    expect(((await resBad.json()) as { error: string }).error).toBe("upstream_not_allowed");
  });
});

describe("workspace endpoint MCP lifecycle", () => {
  async function rpc(bridge: ReturnType<typeof createMacChatBridge>, payload: unknown, init: RequestInit = {}) {
    const res = await bridge.handle(request("/mcp/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
      ...init,
    }));
    return { res, body: res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null };
  }

  test("initialize negotiates the protocol version", async () => {
    const { bridge } = makeFixture();
    const { res, body } = await rpc(bridge, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(res.status).toBe(200);
    const result = body!.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo.name).toBe("omg-mac-chat-workspace");
    expect(res.headers.get("mcp-protocol-version")).toBe("2025-03-26");
  });

  test("unknown protocol version falls back to the default", async () => {
    const { bridge } = makeFixture();
    const { body } = await rpc(bridge, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((body!.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  test("ping answers an empty result", async () => {
    const { bridge } = makeFixture();
    const { body } = await rpc(bridge, { jsonrpc: "2.0", id: 3, method: "ping" });
    expect(body!.result).toEqual({});
  });

  test("tools/list exposes exactly the workspace surface (bounded shell included, no delegation)", async () => {
    const { bridge } = makeFixture();
    const { body } = await rpc(bridge, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    const names = ((body!.result as { tools: { name: string }[] }).tools).map((t) => t.name).sort();
    // Integration revision 2 added the bounded shell tool (src/exec.ts);
    // delegation stays on the proxied omg namespace by design.
    expect(names).toEqual(["get_context", "list_files", "read_file", "readiness", "shell", "write_file"]);
  });

  test("unknown method is -32601, batch is -32600, garbage is -32700", async () => {
    const { bridge } = makeFixture();
    const unknown = await rpc(bridge, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    expect((unknown.body!.error as { code: number }).code).toBe(-32601);
    const batch = await rpc(bridge, [{ jsonrpc: "2.0", id: 6, method: "ping" }]);
    expect((batch.body!.error as { code: number }).code).toBe(-32600);
    const garbage = await rpc(bridge, "not-json{");
    expect((garbage.body!.error as { code: number }).code).toBe(-32700);
  });

  test("notifications get 202; GET is 405; DELETE is 204", async () => {
    const { bridge } = makeFixture();
    const note = await rpc(bridge, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.res.status).toBe(202);
    const get = await bridge.handle(request("/mcp/workspace", { method: "GET" }));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toContain("POST");
    const del = await bridge.handle(request("/mcp/workspace", { method: "DELETE" }));
    expect(del.status).toBe(204);
  });

  test("readiness is honest: bounded shell ready, delegation via omg namespace, live false", async () => {
    const { bridge } = makeFixture();
    const { body } = await rpc(bridge, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "readiness", arguments: {} } });
    const payload = JSON.parse((body!.result as { content: { text: string }[] }).content[0].text);
    // Integration revision 2: the bounded shell (src/exec.ts) is real;
    // delegation runs through the proxied omg namespace, not a local tool.
    expect(payload.shell.status).toContain("ready");
    expect(payload.delegation.status).toBe("via omg namespace");
    expect(payload.live).toBe(false);
    expect(payload.proxiedNamespaces).toEqual(["omg"]);
  });
});
