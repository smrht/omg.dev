// ACTUAL tools-availability regression for the Claude Mac route's MCP
// provisioning (not an argv assertion).
//
// Background (live-diagnosed 2026-10-04): claude 2.1.285 reserves the MCP
// server name "workspace" for its built-in tool surface
// (Bash -> mcp__workspace__bash, WebFetch -> mcp__workspace__web_fetch). A
// provisioned --mcp-config server with that name is dropped at config load
// with only a debug stderr WARN — the stream-json session stays otherwise
// healthy, so the model simply has no workspace tools and the bridge sees
// zero requests. claude-transport.ts therefore aliases reserved names on the
// wire (claudeLeaseMcpServers).
//
// This test drives the REAL installed claude binary in stream-json mode with
// the same control-protocol sequence the SDK uses (initialize, then
// mcp_call) against a LOOPBACK MCP server this test starts. NO user message
// is ever sent, so no model/API turn runs; the only network is 127.0.0.1.
// It proves at the tool level:
//   - the literal reserved name does NOT yield a usable server (the bug), and
//   - the alias produced by claudeLeaseMcpServers loads, handshakes
//     (initialize/initialized/tools/list visible on the loopback server) and
//     the tool call RETURNS the tool result.
//
// Skips (with the reason printed) when no local claude binary resolves or
// its major.minor is outside the 2.1 line whose reserved-name behavior this
// pins.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLeaseMcpServers } from "./claude-transport.ts";

type JsonRpc = { jsonrpc: "2.0"; id: number | string; method?: string; params?: unknown };

const TOOL_NAME = "write_file";
const QUALIFIED = (server: string): string => `mcp__${server}__${TOOL_NAME}`;

function resolveLocalClaude(): string | null {
  // Same resolution order the local aisdk harness documents; probe without
  // spawning a session.
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] })
      ? "claude"
      : null;
  } catch {
    return null;
  }
}

function claudeMajorMinor(): { major: number; minor: number } | null {
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
    const match = /(\d+)\.(\d+)\./.exec(out);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
  } catch {
    return null;
  }
}

/** Minimal loopback streamable-HTTP MCP server: JSON responses only. */
function startLoopbackMcpServer(): { server: Server; port: number; events: string[]; stop: () => Promise<void> } {
  const events: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let msg: JsonRpc | null = null;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpc;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (msg.method) events.push(msg.method);
      if (!("id" in msg)) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      switch (msg.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "reserved-name-regression", version: "1.0.0" },
          };
          break;
        case "tools/list":
          result = {
            tools: [{
              name: TOOL_NAME,
              description: "loopback stand-in for the bridge workspace write_file",
              inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
            }],
          };
          break;
        case "tools/call":
          result = { content: [{ type: "text", text: "regression write ok" }], isError: false };
          break;
        case "ping":
          result = {};
          break;
        default:
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown method" } }));
          return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        port,
        events,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  }) as never;
}

type ProbeOutcome = {
  initialized: boolean;
  callSubtype: string | null;
  callPayload: unknown;
  callError: string | null;
  serverSawHandshake: boolean;
};

/**
 * One claude run: exact transport-style argv (stream-json, empty setting
 * sources, slash-commands off, strict mcp config with the given server name)
 * driven through initialize + mcp_call. No user message, so no model turn.
 */
async function probeServerName(serverName: string, port: number, events: string[]): Promise<ProbeOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "claude-reserved-regression-"));
  mkdirSync(join(dir, ".tmp"), { recursive: true });
  const configPath = join(dir, "mcp-claude.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: { [serverName]: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { authorization: "Bearer regression-local" } } },
  }));
  try {
    const child = Bun.spawn([
      "claude",
      "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
      "--model", "opus", "--disallowedTools", "AskUserQuestion",
      "--setting-sources=", "--permission-mode", "bypassPermissions",
      "--include-partial-messages", "--disable-slash-commands",
      "--mcp-config", configPath, "--strict-mcp-config",
    ], {
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...process.env,
        HOME: process.env.HOME!,
        TMPDIR: join(dir, ".tmp"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
    });
    const send = (obj: unknown): void => {
      child.stdin.write(JSON.stringify(obj) + "\n");
    };
    // Snapshot BEFORE initialize: the CLI starts http servers fully async at
    // startup, so the handshake can land anywhere in the process lifetime.
    const eventsBefore = events.length;
    send({ request_id: "i", type: "control_request", request: { subtype: "initialize" } });
    await Bun.sleep(5_000);
    send({
      request_id: "c", type: "control_request",
      request: { subtype: "mcp_call", server_name: serverName, tool: QUALIFIED(serverName), arguments: { path: "nonce.txt", content: "x" } },
    });
    const out: ProbeOutcome = {
      initialized: false,
      callSubtype: null,
      callPayload: null,
      callError: null,
      serverSawHandshake: false,
    };
    const decoder = new TextDecoder();
    let buffer = "";
    const handleLine = (raw: string): void => {
      if (!raw.trim()) return;
      let obj: { type?: string; response?: { subtype?: string; request_id?: string; response?: unknown; error?: unknown } };
      try {
        obj = JSON.parse(raw);
      } catch {
        return;
      }
      const resp = obj.response;
      if (obj.type !== "control_response" || !resp) return;
      if (resp.request_id === "i") out.initialized = resp.subtype === "success";
      if (resp.request_id === "c") {
        out.callSubtype = resp.subtype ?? null;
        out.callPayload = resp.response ?? null;
        out.callError = resp.error ? String((resp.error as { message?: string }).message ?? resp.error) : null;
      }
    };
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && out.callSubtype === null) {
      const read = await Promise.race([
        reader.read(),
        Bun.sleep(1_000).then(() => null),
      ]);
      if (read?.value) buffer += decoder.decode(read.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      if (read?.done) break;
    }
    const grew = events.slice(eventsBefore);
    out.serverSawHandshake = grew.includes("initialize") && grew.includes("tools/list");
    try {
      send({ request_id: "e", type: "control_request", request: { subtype: "end_session" } });
    } catch {}
    child.kill();
    await child.exited;
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("claude Mac-route MCP provisioning: actual tools availability (live, loopback only)", () => {
  test.skipIf(!process.env.HOME || !resolveLocalClaude() || (() => {
    const v = claudeMajorMinor();
    return !v || v.major !== 2 || v.minor !== 1;
  })())("reserved name drops the server; the claudeLeaseMcpServers alias loads and the tool call succeeds", async () => {
    const loopback = await startLoopbackMcpServer();
    try {
      const alias = claudeLeaseMcpServers({
        workspace: { type: "http", url: `http://127.0.0.1:${loopback.port}/mcp`, bearerToken: "r".repeat(32), headerName: "authorization" },
      });
      expect(alias.renames).toEqual([{ from: "workspace", to: "omgworkspace" }]);

      // The bug, pinned: the literal reserved name never becomes a usable server.
      const reserved = await probeServerName("workspace", loopback.port, loopback.events);
      expect(reserved.initialized).toBe(true);
      expect(reserved.callSubtype).toBe("error");
      expect(String(reserved.callError).toLowerCase()).toContain("not connected");
      expect(reserved.serverSawHandshake).toBe(false);

      // The fix, at the tool level: same URL under the alias handshakes and
      // the mcp_call returns the tool result.
      const fixed = await probeServerName(alias.renames[0]!.to, loopback.port, loopback.events);
      expect(fixed.initialized).toBe(true);
      expect(fixed.callSubtype).toBe("success");
      expect(fixed.serverSawHandshake).toBe(true);
      const payload = fixed.callPayload as { content?: Array<{ text?: string }> } | null;
      expect(payload?.content?.[0]?.text).toBe("regression write ok");
    } finally {
      await loopback.stop();
    }
  }, 120_000);
});
