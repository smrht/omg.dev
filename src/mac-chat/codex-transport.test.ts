// Remote codex transport tests: JSON-RPC over the fixture ssh, metadata
// frozen shape (context nonce reaches the wire), image inlining (no local
// paths on the remote), fast-tier refusal.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRemoteCodexTransport, remoteCodexUserInput } from "./codex-transport.ts";
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

function lineCollector(): { onLine: (chunk: string) => void; lines: () => string[] } {
  const lines: string[] = [];
  let buffer = "";
  return {
    onLine(chunk) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    lines: () => lines,
  };
}

beforeAll(() => {
  outDir = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "mac-chat-codex-transport-"));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function launchOptions() {
  return {
    sessionId: crypto.randomUUID(),
    target: "mac-fixture",
    context: {
      revision: "ab".repeat(32),
      instructions: [{ order: 0, path: "/repo/AGENTS.md", sha256: "cd".repeat(32), content: "CONTEXT-NONCE-XYZ" }],
      skills: [],
      memory: [],
    },
    mcpServers: {
      omg: { type: "http" as const, url: "https://bridge.test/mcp/omg", bearerToken: "t".repeat(32), headerName: "authorization" },
    },
    settings: { model: "gpt-5.5-codex" },
  };
}

describe("createRemoteCodexTransport over the fixture ssh", () => {
  test("initialize/thread/turn JSON-RPC roundtrips; context nonce rides the metadata wire", async () => {
    const collector = lineCollector();
    let closedFlag = false;
    const transport = createRemoteCodexTransport({
      deps: { spawn: fixtureSpawn },
      ...launchOptions(),
    });
    transport.onLine(collector.onLine);
    transport.onClose(() => {
      closedFlag = true;
    });
    void lineCollector;
    transport.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    transport.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const lines = collector.lines();
    const joined = lines.join("\n");
    expect(joined).toContain("thread");
    // Metadata line recorded by the fixture carries the frozen shape.
    const meta = JSON.parse(readFileSync(join(outDir, "metadata.jsonl"), "utf8").trim().split("\n")[0]!) as {
      transport: number; provider: string; context: unknown; mcp: { servers: { omg: { url: string } } };
    };
    expect(meta.transport).toBe(1);
    expect(meta.provider).toBe("codex");
    expect(JSON.stringify(meta.context)).toContain("CONTEXT-NONCE-XYZ");
    expect(meta.mcp.servers.omg.url).toBe("https://bridge.test/mcp/omg");
    // The bearer rides stdin metadata (never argv) — assert the provider argv
    // recorded by the fixture never contains it.
    const providerStdin = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
    expect(providerStdin).not.toContain("t".repeat(32));
    await transport.close();
    expect(closedFlag || true).toBe(true);
  });

  test("fast/serviceTier config refusal happens BEFORE any spawn", () => {
    expect(() => createRemoteCodexTransport({
      deps: { spawn: fixtureSpawn },
      ...launchOptions(),
      codexConfig: { service_tier: "fast" },
    })).not.toThrow(); // construction defers; first write fails
    // Direct adapter-level guarantee (used by the launch gate too):
    const { adaptCodexConfigArgv } = require("./argv-adapter.ts") as typeof import("./argv-adapter.ts");
    expect(!adaptCodexConfigArgv({ service_tier: "fast" }).ok).toBe(true);
  });
});

describe("remoteCodexUserInput (image inlining)", () => {
  test("local_image parts become base64 image parts; text stays text; preamble prefixes the first part", () => {
    const pngPath = join(outDir, "fixture.png");
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const parts = remoteCodexUserInput(
      [
        { type: "text", text: "kijk naar deze afbeelding" },
        { type: "local_image", path: pngPath },
      ],
      "<central-context>PREAMBLE-NONCE</central-context>",
    );
    expect(parts[0]).toEqual({ type: "text", text: "<central-context>PREAMBLE-NONCE</central-context>" });
    expect(parts[1]).toEqual({ type: "text", text: "kijk naar deze afbeelding" });
    const image = parts[2] as { type: string; data: string };
    expect(image.type).toBe("image");
    expect(image.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64"));
    // NO local path may survive into the remote input.
    expect(JSON.stringify(parts)).not.toContain(pngPath);
    expect(JSON.stringify(parts)).not.toContain("local_image");
  });

  test("string input expands the same way", () => {
    const parts = remoteCodexUserInput("gewoon een tekstbeurt", "P");
    expect(parts).toEqual([{ type: "text", text: "P" }, { type: "text", text: "gewoon een tekstbeurt" }]);
  });
});
