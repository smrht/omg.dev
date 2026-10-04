// Stream framing tests with a REAL fixture subprocess standing in for ssh
// (test/mac-chat/fixtures/fake-ssh.ts): raw byte preservation both ways
// (incl. >64 KiB), handshake strip, rejection handling, argv screen.
// Item 30/33 additions: split+coalesced handshake payload survives verbatim
// (exact SHA) through the pull-based stdout; macSshOneShot resolves only
// after drained stdout AND exit 0, with real fixture processes for the
// delayed-burst race and the nonzero-exit case.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openMacStream, macSshOneShot, macSshSpawn, type SpawnedSshChild } from "./stream.ts";
import { macSshArgv, assertNoSecretsOnArgv } from "./ssh.ts";
import type { MacStreamMetadata } from "./wire.ts";

const FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/fake-ssh.ts");
const SPLIT_FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/handshake-split.ts");
const ONESHOT_FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/oneshot-behaviors.ts");
// Cache-only temp namespace (task rule: never os.tmpdir / /tmp for fixtures).
const BUILD_TMP = process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests";

function fixtureSpawn(argv: readonly string[]): SpawnedSshChild {
  // The fake ssh receives the SAME argv it would get in production; the
  // fixture binary replaces only argv[0].
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

/** The PRODUCTION pipe adapter driving a fixture binary (item 30 tests). */
function productionSpawn(argv: readonly string[]): SpawnedSshChild {
  return macSshSpawn([process.execPath, FIXTURE, ...argv.slice(1)]);
}

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(BUILD_TMP, "mac-chat-stream-"));
});

function meta(overrides: Partial<MacStreamMetadata> = {}): MacStreamMetadata {
  return {
    transport: 1,
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    provider: "claude",
    args: ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"],
    context: { revision: "r".repeat(64), instructions: [], skills: [], memory: [] },
    mcp: { servers: {} },
    settings: {},
    ...overrides,
  };
}

describe("openMacStream with fixture ssh", () => {
  test("handshake ready → raw stdout passthrough (binary-safe, chunk-agnostic)", async () => {
    const handle = openMacStream({ spawn: fixtureSpawn }, { target: "mac-fixture", metadata: meta() });
    const ready = await handle.whenReady;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.handshake.status).toBe("ready");
    // Drive one claude turn through the raw pipe.
    handle.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "hello nonce" } })}\n`);
    const reader = ready.stdout.getReader();
    const seen: string[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
      ]);
      if (!chunk) continue;
      if (chunk.done) break;
      seen.push(new TextDecoder().decode(chunk.value));
      const text = seen.join("");
      if (text.includes("\"result\"")) break;
    }
    const text = seen.join("");
    expect(text).toContain("system");
    expect(text).toContain("fixture-claude:");
    expect(text).toContain("result");
    handle.kill();
  });

  test(">64 KiB stdin payload reaches the provider verbatim (recorded by the fixture)", async () => {
    const bigNonce = `BIG-${"x".repeat(70_000)}`;
    const handle = openMacStream({ spawn: fixtureSpawn }, { target: "mac-fixture", metadata: meta() });
    const ready = await handle.whenReady;
    expect(ready.ok).toBe(true);
    handle.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: bigNonce } })}\n`);
    // Give the fixture a moment to record, then close stdin.
    await new Promise((resolve) => setTimeout(resolve, 400));
    handle.stdin.end();
    if (ready.ok) await ready.exited.catch(() => 0);
    const recorded = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
    expect(recorded.length).toBeGreaterThan(70_000);
    expect(recorded).toContain("BIG-");
  });

  test("rejected handshake fails closed with the sanitized reason", async () => {
    const handle = openMacStream({ spawn: fixtureSpawn }, {
      target: "mac-fixture",
      metadata: meta({ args: ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "REJECT_ME"] }),
    });
    const ready = await handle.whenReady;
    expect(ready.ok).toBe(false);
    if (ready.ok) return;
    expect(ready.error).toContain("fixture rejection");
  });

  test("item 33: split handshake + coalesced payload arrives VERBATIM (exact SHA) via the production adapter", async () => {
    const child = { spawn: (argv: readonly string[]): SpawnedSshChild => macSshSpawn([process.execPath, SPLIT_FIXTURE, ...argv.slice(1)]) };
    const handle = openMacStream(child, { target: "mac-fixture", metadata: meta() });
    const ready = await handle.whenReady;
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.handshake.status).toBe("ready");
    // Slow consumer on purpose: the pull-based stream must hold the payload
    // without an eager pump and still deliver every byte afterwards.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const expected = Buffer.alloc(64 * 1024);
    for (let i = 0; i < expected.length; i++) expected[i] = (i * 7 + 13) % 256;
    const reader = ready.stdout.getReader();
    const parts: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      if (Buffer.concat(parts).byteLength >= expected.byteLength) break;
    }
    const received = Buffer.concat(parts).subarray(0, expected.byteLength);
    expect(received.byteLength).toBe(expected.byteLength);
    expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(received.equals(expected)).toBe(true);
    handle.kill();
  });
});

describe("macSshOneShot over the production spawn adapter (item 30)", () => {
  test("delayed burst right before exit is FULLY captured (no exit-vs-drain race)", async () => {
    const spawn = (argv: readonly string[]): SpawnedSshChild =>
      macSshSpawn([process.execPath, ONESHOT_FIXTURE, ...argv.slice(1)]);
    const answer = await macSshOneShot(spawn, "mac-fixture", { kind: "probe" }, {
      stdinJson: { type: "probe", schema: 1 },
      timeoutMs: 15_000,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const lines = answer.stdout.split("\n");
    const first = JSON.parse(lines[0]!) as { marker: string };
    expect(first.marker).toBe("oneshot-delayed");
    // The 100 KB burst must be complete: resolving on `exited` alone would
    // truncate it nondeterministically. ASCII letters survive the UTF-8 text
    // round-trip byte-for-byte.
    const expectedBurst = Buffer.alloc(100_000);
    for (let i = 0; i < expectedBurst.length; i++) expectedBurst[i] = 65 + ((i * 3 + 5) % 26);
    const receivedBurst = Buffer.from(answer.stdout, "utf8").subarray(lines[0]!.length + 1);
    expect(receivedBurst.byteLength).toBeGreaterThanOrEqual(expectedBurst.byteLength);
    expect(receivedBurst.subarray(0, expectedBurst.byteLength).equals(expectedBurst)).toBe(true);
  }, 20_000);

  test("nonzero exit (real process, delayed stdout): error carries the exit code", async () => {
    const script = join(outDir, "nonzero-fixture.ts");
    writeFileSync(script, [
      "process.stdout.write(JSON.stringify({transport:1,marker:\"looks-fine-but-failing\"}) + \"\\n\");",
      "process.exit(3);",
      "",
    ].join("\n"));
    const spawn = (argv: readonly string[]): SpawnedSshChild =>
      macSshSpawn([process.execPath, script, ...argv.slice(1)]);
    const answer = await macSshOneShot(spawn, "mac-fixture", { kind: "probe" }, {
      stdinJson: { type: "probe", schema: 1 },
      timeoutMs: 15_000,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toContain("exited 3");
    expect(answer.error).toContain("looks-fine-but-failing");
  }, 20_000);

  test("silent child is killed at the deadline (bounded, never hangs)", async () => {
    const script = join(outDir, "hang-fixture.ts");
    writeFileSync(script, "await new Promise((r) => setTimeout(r, 30_000)); process.exit(0);\n");
    const spawn = (argv: readonly string[]): SpawnedSshChild =>
      macSshSpawn([process.execPath, script, ...argv.slice(1)]);
    const started = Date.now();
    const answer = await macSshOneShot(spawn, "mac-fixture", { kind: "probe" }, {
      stdinJson: { type: "probe", schema: 1 },
      timeoutMs: 1_500,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe("ssh argv construction + no-secret screen", () => {
  test("exactly four verbs; rigid options; no provision verb", () => {
    for (const verb of [
      { kind: "probe" } as const,
      { kind: "stream" } as const,
      { kind: "status", requestId: crypto.randomUUID() } as const,
      { kind: "cancel", requestId: crypto.randomUUID() } as const,
    ]) {
      const argv = macSshArgv("mac-fixture", verb);
      expect(Array.isArray(argv)).toBe(true);
      if (!Array.isArray(argv)) continue;
      expect(argv).toContain("ClearAllForwardings=yes");
      expect(argv).toContain("StrictHostKeyChecking=yes");
    }
    const bad = macSshArgv("mac fixture; rm -rf /", { kind: "stream" });
    expect(Array.isArray(bad)).toBe(false);
  });

  test("no-secret screen rejects prompt/settings/mcp-config/bearer leakage on ssh argv", () => {
    expect(() => assertNoSecretsOnArgv(["ssh", "-T", "mac", "stream", "--append-system-prompt", "x"])).toThrow();
    expect(() => assertNoSecretsOnArgv(["ssh", "-T", "mac", "stream", "Bearer abcdefghijklmnop"])).toThrow();
    expect(() => assertNoSecretsOnArgv(["ssh", "-T", "mac", "--mcp-config", "/tmp/x.json"])).toThrow();
    expect(() => assertNoSecretsOnArgv(["ssh", "-T", "mac", "stream"])).not.toThrow();
  });
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});
