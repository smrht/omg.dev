// REAL SDK spawn-seam test: the actual @anthropic-ai/claude-agent-sdk query()
// drives the fixture provider through macClaudeSpawnFactory (fake ssh child
// via injectable spawn). Proves: the SDK accepts the remote process, the
// context nonce reaches the provider over the wire (metadata + turn), argv
// --settings never forwards, the seam reports a real exit code, and reserved
// MCP server names (claude 2.1.285 drops them at config load) are aliased on
// the wire while every bridge URL/token survives verbatim.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { macClaudeSpawnFactory, claudeLeaseMcpServers, claudeMcpServerAlias, CLAUDE_RESERVED_MCP_SERVER_NAMES } from "./claude-transport.ts";
import type { SpawnedSshChild } from "./stream.ts";

const FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/fake-ssh.ts");
let outDir: string;

function fixtureSpawn(argv: readonly string[]): SpawnedSshChild {
  const child = Bun.spawn([process.execPath, FIXTURE, ...argv.slice(1)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, FIXTURE_OUT: outDir },
  });
  return {
    pid: child.pid ?? 0,
    stdin: {
      write(data) {
        child.stdin!.write(data as never);
      },
      end() {
        child.stdin!.end();
      },
    },
    stdout: child.stdout as ReadableStream<Uint8Array>,
    exited: child.exited as Promise<number>,
    kill(signal) {
      child.kill(signal);
    },
  };
}

beforeAll(() => {
  outDir = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "mac-chat-claude-seam-"));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

test("real SDK query() drives the remote fixture provider through the spawn seam", async () => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const sessionId = crypto.randomUUID();
  const handshakes: unknown[] = [];
  const captured: { notes: string[]; settings: Record<string, unknown> | null } = { notes: [], settings: null };

  const q = query({
    prompt: "TURN-ONE hello provider",
    options: {
      model: "opus",
      permissionMode: "bypassPermissions",
      disallowedTools: ["AskUserQuestion"],
      // NOTE: settings:{fastMode:true} deliberately exercises the argv
      // extraction path — the SDK emits `--settings {"fastMode":true}` and
      // the adapter must strip it (the Mac schema refuses it on argv).
      settings: { fastMode: true },
      spawnClaudeCodeProcess: macClaudeSpawnFactory(
        { spawn: fixtureSpawn },
        {
          sessionId,
          target: "mac-fixture",
          context: {
            revision: "ab".repeat(32),
            instructions: [{ order: 0, path: "/repo/AGENTS.md", sha256: "cd".repeat(32), content: "CONTEXT-NONCE-CLAUDE" }],
            skills: [],
            memory: [],
          },
          mcpServers: {
            omg: { type: "http", url: "https://bridge.test/mcp/omg", bearerToken: "t".repeat(32), headerName: "authorization" },
            // The bridge's own workspace namespace: claude 2.1.285 refuses a
            // server literally named "workspace" — the seam MUST alias it.
            workspace: { type: "http", url: "https://bridge.test/mcp/workspace?session=mac-x", bearerToken: "w".repeat(32), headerName: "authorization" },
          },
          settings: { model: "opus", fastMode: true },
          onArgvExtraction: (notes, settings) => {
            captured.notes.push(...notes);
            // Note-only callbacks (thinkingLevel drop, MCP reserved-name
            // rename) pass null — mirror aisdk-session: never overwrite the
            // last extracted settings with null.
            if (settings) captured.settings = settings;
          },
          onHandshake: (handshake) => {
            handshakes.push(handshake);
          },
        },
      ),
    },
  });

  const messages: unknown[] = [];
  for await (const message of q) {
    messages.push(message);
  }

  // The fixture answered: system init + assistant echo + result.
  const types = messages.map((m) => (m as { type?: string }).type);
  expect(types).toContain("system");
  expect(types).toContain("assistant");
  expect(types).toContain("result");

  // Handshake observed ready.
  const ready = handshakes.find((h) => (h as { status?: string }).status === "ready");
  expect(ready).toBeTruthy();

  // The --settings extraction happened (never forwarded on argv).
  expect(captured.settings).toEqual({ fastMode: true });
  expect(captured.notes.join(" ")).toContain("--settings extracted");

  // The frozen metadata reached the fixture: nonce + mcp entry + no
  // --settings/--append-system-prompt on the native argv.
  const meta = JSON.parse(readFileSync(join(outDir, "metadata.jsonl"), "utf8").trim().split("\n")[0]!) as {
    transport: number;
    provider: string;
    args: string[];
    context: { instructions: Array<{ content: string }> };
    mcp: { servers: Record<string, { type?: string; url: string; bearerToken?: string; headerName?: string }> };
    settings: Record<string, unknown>;
  };
  expect(meta.transport).toBe(1);
  expect(meta.provider).toBe("claude");
  expect(meta.args).not.toContain("--settings");
  expect(meta.args.join(" ")).not.toContain("fastMode");
  expect(meta.context.instructions[0].content).toBe("CONTEXT-NONCE-CLAUDE");
  expect(meta.mcp.servers.omg.url).toBe("https://bridge.test/mcp/omg");
  // Reserved-name aliasing: "workspace" NEVER rides the wire under its own
  // name (the CLI would drop it at config load), the alias carries the SAME
  // bridge URL and token, and no entry is lost.
  expect(Object.keys(meta.mcp.servers).sort()).toEqual(["omg", "omgworkspace"]);
  expect(meta.mcp.servers.omgworkspace).toEqual({
    type: "http",
    url: "https://bridge.test/mcp/workspace?session=mac-x",
    bearerToken: "w".repeat(32),
    headerName: "authorization",
  });
  expect(captured.notes.join(" ")).toContain('mcp server "workspace" renamed to "omgworkspace"');
  expect(meta.settings.fastMode).toBe(true);

  // The provider saw the actual TURN text through the raw pipe.
  const providerStdin = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
  expect(providerStdin).toContain("TURN-ONE");
  // ...and the bearer never leaked into the provider's stdin stream (it
  // lives only in the metadata document, which the SUPERVISOR consumes).
  expect(providerStdin).not.toContain("t".repeat(32));
}, 30_000);

describe("claudeLeaseMcpServers reserved-name aliasing (pure)", () => {
  const server = (url: string): { type: "http"; url: string; bearerToken: string; headerName: "authorization" } => ({
    type: "http",
    url,
    bearerToken: "b".repeat(32),
    headerName: "authorization",
  });

  test("non-reserved names pass through verbatim; nothing is dropped", () => {
    const { servers, renames } = claudeLeaseMcpServers({
      omg: server("https://b/mcp/omg"),
      connectors: server("https://b/mcp/connectors"),
      computer: server("https://b/mcp/computer"),
    });
    expect(renames).toEqual([]);
    expect(Object.keys(servers).sort()).toEqual(["computer", "connectors", "omg"]);
    expect(servers.omg.url).toBe("https://b/mcp/omg");
  });

  test("reserved names (case-insensitive) alias deterministically with URL and token intact", () => {
    const { servers, renames } = claudeLeaseMcpServers({
      workspace: server("https://b/mcp/workspace?session=mac-x"),
      WORKSPACE: server("https://b/mcp/other"),
    });
    expect(renames.map((r) => [r.from, r.to])).toEqual([["workspace", "omgworkspace"], ["WORKSPACE", "omgWORKSPACE"]]);
    expect(servers.omgworkspace.url).toBe("https://b/mcp/workspace?session=mac-x");
    expect(servers.omgWORKSPACE.url).toBe("https://b/mcp/other");
    expect(Object.keys(servers).sort()).toEqual(["omgWORKSPACE", "omgworkspace"]);
  });

  test("a real namespace already using the alias shape never collides", () => {
    const { servers, renames } = claudeLeaseMcpServers({
      workspace: server("https://b/mcp/workspace"),
      omgworkspace: server("https://b/mcp/omgworkspace"),
    });
    expect(renames).toEqual([{ from: "workspace", to: "omgworkspace2" }]);
    expect(Object.keys(servers).sort()).toEqual(["omgworkspace", "omgworkspace2"]);
  });

  test("__proto__ is aliased too when it arrives as an own key (JSON-parsed maps)", () => {
    // An object literal cannot even create this own key (it sets the
    // prototype), so build it the way an upstream JSON layer would.
    const map = JSON.parse('{"__proto__":' + JSON.stringify(server("https://b/mcp/p")) + "}");
    const { servers, renames } = claudeLeaseMcpServers(map);
    expect(renames).toEqual([{ from: "__proto__", to: "omg__proto__" }]);
    expect(servers.omg__proto__!.url).toBe("https://b/mcp/p");
  });

  test("the exported alias rule matches the map builder (driver imports rely on it)", () => {
    expect(CLAUDE_RESERVED_MCP_SERVER_NAMES.has("workspace")).toBe(true);
    expect(claudeMcpServerAlias("workspace")).toBe("omgworkspace");
    expect(claudeMcpServerAlias("workspace", new Set(["omgworkspace"]))).toBe("omgworkspace2");
  });
});
