// Regression: the mac harnesses' bridge MCP URLs must NAME the session lease.
//
// The bridge authorizes by lease, not by bearer alone: sessionOf(req) →
// registry.lookup(lease.id) → token-hash match (mac-chat-bridge/bridge.ts).
// MacBridgeHost.mintLease ids are `mac-<central sessionId>`, and both
// harnesses build their entries through the one shared builder
// (macBridgeMcpServers in mac-chat/mcp.ts). Before that, both emitted a
// bearer-only /mcp/<name> URL and every bridge call died 401
// session_required.
//
// This file proves the FIX against running code, not source text:
//   - REAL harness subprocesses (claude + codex, fixture ssh) emit their
//     stream metadata; the mcp URL is read from the emitted metadata bytes
//     (post encodeMacStreamMetadata — the fixture line only exists because
//     the frozen TS wire encoder accepted the URL);
//   - the REAL bridge (createMacChatBridge over the registry a REAL
//     MacBridgeHost.mintLease filled) authorizes the emitted URL + bearer
//     and proxies to the exact lease upstream with identity headers;
//   - the same URL without a session query reproduces the original 401
//     session_required; an unknown session is 401 invalid_session; naming a
//     live other lease, or presenting another lease's bearer, is 403
//     cross_session_token;
//   - the REAL production Python schema (transport._valid_mcp, pinned Mac
//     code) accepts the query-carrying URL under its pinned origin and
//     refuses a non-pinned origin (control proving the check ran).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { macBridgeMcpServers, macChatLeaseId } from "./mcp.ts";
import { createMacChatBridge } from "../mac-chat-bridge/bridge.ts";
import type { ProxyFetch } from "../mac-chat-bridge/proxy.ts";
import type { MacBridgeHost } from "./bridge-host.ts";

const BUILD_TMP = process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests";
const PEER_DIR = process.env.MAC_CHAT_TRANSPORT_DIR ?? "/Users/samht/sites-beheer/scripts/agentbox/mac-chat-transport";
const REPO_ROOT = join(import.meta.dir, "../..");
const FIXTURE_SSH = join(REPO_ROOT, "test/mac-chat/fixtures/fake-ssh.ts");
const HARNESS_CLAUDE = join(REPO_ROOT, "src/agents/backends/aisdk-session.ts");
const HARNESS_CODEX = join(REPO_ROOT, "src/agents/backends/codex-aisdk-session.ts");
const PUBLIC_BRIDGE_URL = "http://127.0.0.1:18971";

let base: string;
let host: MacBridgeHost;
let bridgeHandle: ReturnType<typeof createMacChatBridge>["handle"];
let upstreamCalls: Array<{ url: string; headers: Record<string, string> }>;

const sessionClaude = crypto.randomUUID();
const sessionCodex = crypto.randomUUID();
const sessionOther = crypto.randomUUID();
let tokenClaude = "";
let tokenCodex = "";
let tokenOther = "";

const jsonRpcReply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "omg_ping" }] } });

function mintFor(provider: "claude" | "codex", sessionId: string): string {
  const namespaceMap = host.buildNamespaces(provider, sessionId);
  return host.mintLease({
    sessionId,
    provider,
    cwd: base,
    roots: [{ path: base, read: true, write: true }],
    instructions: [],
    skillRoots: [],
    memoryRoots: [],
    namespaceMap,
  }).token;
}

beforeAll(async () => {
  base = mkdtempSync(join(BUILD_TMP, "mcp-session-route-"));
  // MUST precede the bridge-host import: config.ts freezes PATHS.data from
  // this env at module evaluation, and mintLease persists durable lease
  // records there. Static imports above touch none of that graph.
  process.env.OMG_DATA_DIR = join(base, "data");
  mkdirSync(process.env.OMG_DATA_DIR, { recursive: true });
  const { MacBridgeHost } = await import("./bridge-host.ts");
  host = new MacBridgeHost({
    bindAddress: "127.0.0.1",
    port: 18971,
    publicUrl: PUBLIC_BRIDGE_URL,
    trustedUpstreamHosts: [],
    log: () => {},
    claudeUserConfigPath: join(base, "none-claude.json"),
    codexUserConfigPath: join(base, "none-codex.toml"),
  });
  // The same handler factory MacBridgeHost itself mounts (bridge-host.ts),
  // built here with an injected upstream fetch so the proxied happy path is
  // observable without a socket. Auth is 100% the real bridge path.
  upstreamCalls = [];
  const fetchImpl: ProxyFetch = async (url, init) => {
    upstreamCalls.push({ url, headers: { ...init.headers } });
    return new Response(jsonRpcReply, { status: 200, headers: { "content-type": "application/json" } });
  };
  const bridge = createMacChatBridge({ registry: host.registry, journalDir: join(base, "journal"), fetchImpl });
  bridgeHandle = bridge.handle;

  tokenClaude = mintFor("claude", sessionClaude);
  tokenCodex = mintFor("codex", sessionCodex);
  tokenOther = mintFor("claude", sessionOther);
});

afterAll(() => {
  delete process.env.OMG_DATA_DIR;
  rmSync(base, { recursive: true, force: true });
});

function request(url: string, token: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

async function authError(url: string, token: string): Promise<{ status: number; error: string }> {
  const res = await bridgeHandle(request(url, token));
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
}

/** Run one REAL harness over the fixture ssh and return its emitted mcp servers. */
async function emittedMcpServers(
  kind: "claude" | "codex",
  sessionId: string,
  token: string,
): Promise<Record<string, { url: string; bearerToken: string }>> {
  const outDir = join(base, `out-${kind}`);
  const shimDir = join(base, `bin-${kind}`);
  const project = join(base, `proj-${kind}`);
  const dataDir = join(base, `data-${kind}`);
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "SESSION ROUTE FIXTURE\n");
  writeFileSync(join(shimDir, "ssh"), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_SSH}" "$@"\n`);
  chmodSync(join(shimDir, "ssh"), 0o755);

  const argv = [
    process.execPath,
    kind === "codex" ? HARNESS_CODEX : HARNESS_CLAUDE,
    ...(kind === "codex" ? ["--key", sessionId] : ["--session", sessionId]),
    "--cwd", project,
    "--managed-name", `lfg-route-${kind}`,
    "--execution-host", "mac",
    // The codex harness opens its remote stream on the FIRST turn; the
    // claude harness opens it at query start. Give both a first prompt.
    "--", "SESSION ROUTE TEST",
  ];
  const child = Bun.spawn(argv, {
    cwd: project,
    env: {
      ...process.env,
      OMG_DATA_DIR: dataDir,
      LFG_MAC_SSH_TARGET: "mac-fixture",
      LFG_MAC_BRIDGE_URL: PUBLIC_BRIDGE_URL,
      LFG_MAC_BRIDGE_TOKEN: token,
      LFG_MAC_NAMESPACES: "omg,workspace",
      LFG_MAC_REQUEST_ID: crypto.randomUUID(),
      FIXTURE_OUT: outDir,
      PATH: `${shimDir}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? "",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const metadataPath = join(outDir, "metadata.jsonl");
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (existsSync(metadataPath)) {
        const lines = readFileSync(metadataPath, "utf8").split("\n").filter((l) => l.trim());
        const mine = lines
          .map((l) => JSON.parse(l) as { sessionId?: string; mcp?: { servers?: Record<string, { url: string; bearerToken: string }> } })
          .filter((m) => m.sessionId === sessionId && m.mcp?.servers && Object.keys(m.mcp.servers).length > 0);
        if (mine.length) return mine[0]!.mcp!.servers!;
      }
      if (Date.now() > deadline) {
        throw new Error(`${kind} harness emitted no stream metadata for ${sessionId} within 30s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    child.kill();
    await child.exited.catch(() => 0);
  }
}

describe("mac bridge MCP session route (real bridge + real harness emissions)", () => {
  let emittedClaude: Record<string, { url: string; bearerToken: string }>;
  let emittedCodex: Record<string, { url: string; bearerToken: string }>;

  test("both harnesses emit URLs that name their minted lease and succeed on the real bridge", async () => {
    [emittedClaude, emittedCodex] = await Promise.all([
      emittedMcpServers("claude", sessionClaude, tokenClaude),
      emittedMcpServers("codex", sessionCodex, tokenCodex),
    ]);

    for (const [servers, sessionId, token] of [
      [emittedClaude, sessionClaude, tokenClaude],
      [emittedCodex, sessionCodex, tokenCodex],
    ] as const) {
      const omg = servers.omg;
      expect(omg).toBeDefined();
      // The emitted URL names the lease id MacBridgeHost.mintLease registered.
      const url = new URL(omg!.url);
      expect(url.pathname).toBe("/mcp/omg");
      expect(url.searchParams.get("session")).toBe(macChatLeaseId(sessionId));
      expect(omg!.bearerToken).toBe(token);

      // The REAL bridge authorizes the emitted URL + bearer and proxies to
      // the exact upstream registered in the lease, with the lease's
      // identity headers (server-owned, not caller-supplied).
      const before = upstreamCalls.length;
      const res = await bridgeHandle(request(omg!.url, token));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(jsonRpcReply);
      const call = upstreamCalls[before]!;
      const lease = host.registry.lookup(macChatLeaseId(sessionId))!;
      expect(call.url).toBe(lease.namespaces.omg!.url);
      expect(call.headers["x-omg-session-id"]).toBe(sessionId);
    }
  }, 120_000);

  test("bearer-only URL (the old emission, session query stripped) is 401 session_required", async () => {
    for (const [servers, token] of [
      [emittedClaude, tokenClaude],
      [emittedCodex, tokenCodex],
    ] as const) {
      const url = new URL(servers.omg!.url);
      const stripped = `${url.origin}${url.pathname}`;
      expect(await authError(stripped, token)).toEqual({ status: 401, error: "session_required" });
    }
  });

  test("unknown session name is 401 invalid_session", async () => {
    const url = new URL(emittedClaude.omg!.url);
    url.searchParams.set("session", macChatLeaseId(crypto.randomUUID()));
    expect(await authError(url.toString(), tokenClaude)).toEqual({ status: 401, error: "invalid_session" });
  });

  test("naming a live other lease with an own token is 403 cross_session_token", async () => {
    const url = new URL(emittedClaude.omg!.url);
    url.searchParams.set("session", macChatLeaseId(sessionOther));
    expect(await authError(url.toString(), tokenClaude)).toEqual({ status: 403, error: "cross_session_token" });
  });

  test("another lease's bearer on the emitted URL is 403 cross_session_token", async () => {
    expect(await authError(emittedClaude.omg!.url, tokenOther)).toEqual({ status: 403, error: "cross_session_token" });
    expect(upstreamCalls.length).toBe(2); // only the two happy-path calls ever proxied
  });

  test("real Python schema permits the query in the pinned-origin URL; non-pinned origin refused", async () => {
    // The production Mac validator (transport._valid_mcp) on the EMITTED
    // claude URL: URL_RE plus the admin-pinned origin prefix check.
    const script = [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(PEER_DIR)})`,
      "import transport",
      `url = ${JSON.stringify(emittedClaude.omg!.url)}`,
      `token = ${JSON.stringify(emittedClaude.omg!.bearerToken)}`,
      "def check(origin, label):",
      "    mcp = {'servers': {'omg': {'type': 'http', 'url': url, 'bearerToken': token, 'headerName': 'authorization'}}}",
      "    try:",
      "        out = transport._valid_mcp({'mcp_allowed_origins': [origin]}, mcp)",
      "        print(label + ':OK:' + out['omg']['url'])",
      "    except Exception as e:",
      "        print(label + ':REFUSED:' + getattr(e, 'reason', type(e).__name__))",
      `check(${JSON.stringify(`${PUBLIC_BRIDGE_URL}/`)}, 'pinned')`,
      "check('https://other-origin.test/', 'control')",
    ].join("\n");
    const proc = Bun.spawn(["python3", "-c", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    // Pinned origin accepts the query-carrying URL verbatim.
    expect(lines).toContain(`pinned:OK:${emittedClaude.omg!.url}`);
    // Control: a different pin refuses it — the origin check actually ran.
    expect(lines).toContain("control:REFUSED:mcp-origin-not-allowed");
  }, 60_000);

  test("shared builder output is byte-identical to the harness emission", () => {
    // The builder both harnesses call, invoked directly for both central id
    // kinds (Claude --session uuid / Codex --key uuid): same URL, same shape.
    // Claude-side note: the harness emission passes through the claude wire's
    // reserved-name aliasing (claude 2.1.285 drops a server literally named
    // "workspace" at config load), so the entry arrives as "omgworkspace"
    // carrying the byte-identical URL/token the builder produced.
    for (const [servers, sessionId, token, workspaceKey] of [
      [emittedClaude, sessionClaude, tokenClaude, "omgworkspace"],
      [emittedCodex, sessionCodex, tokenCodex, "workspace"],
    ] as const) {
      const built = macBridgeMcpServers({
        bridgeUrl: PUBLIC_BRIDGE_URL,
        bridgeToken: token,
        sessionId,
        namespaces: ["omg", "workspace"],
      });
      expect(built.omg.url).toBe(servers.omg!.url);
      expect(built.workspace.url).toBe(servers[workspaceKey]!.url);
      expect(built.workspace.bearerToken).toBe(servers[workspaceKey]!.bearerToken);
      expect(built.omg.bearerToken).toBe(servers.omg!.bearerToken);
      expect(built.omg.headerName).toBe("authorization");
    }
    // The reserved literal never rides the claude wire under its own name.
    expect(emittedClaude.workspace).toBeUndefined();
    expect(emittedClaude.omgworkspace).toBeDefined();
  });
});
