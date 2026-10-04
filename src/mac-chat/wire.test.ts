// Wire codec tests: frozen metadata shape, bounds, handshake decoding.
import { describe, expect, test } from "bun:test";
import {
  createHandshakeDecoder,
  encodeMacStreamMetadata,
  MAC_HANDSHAKE_MAX_BYTES,
  MAC_METADATA_MAX_BYTES,
  type MacStreamMetadata,
} from "./wire.ts";

function meta(overrides: Partial<MacStreamMetadata> = {}): MacStreamMetadata {
  return {
    transport: 1,
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    provider: "claude",
    args: ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--model", "opus"],
    context: {
      revision: "r".repeat(64),
      instructions: [{ order: 0, path: "/home/x/AGENTS.md", sha256: "a".repeat(64), content: "FULL CONTENT" }],
      skills: [{ root: "/skills", name: "s", skillFile: "/skills/s/SKILL.md", sha256: "b".repeat(64) }],
      memory: [{ root: "/mem", path: "/mem/MEMORY.md", sha256: "c".repeat(64) }],
    },
    mcp: {
      servers: {
        omg: { type: "http", url: "https://bridge.example/mcp/omg", bearerToken: "t".repeat(32), headerName: "authorization" },
      },
    },
    settings: { model: "opus", fastMode: true },
    ...overrides,
  };
}

describe("encodeMacStreamMetadata (frozen shape)", () => {
  test("encodes a valid document as one newline-terminated line", () => {
    const result = encodeMacStreamMetadata(meta());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = new TextDecoder().decode(result.line);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as { transport: number; args: string[]; mcp: unknown; settings: unknown; context: { instructions: Array<{ content: string }> } };
    expect(parsed.transport).toBe(1);
    expect(parsed.args[0]).toBe("--output-format");
    expect(parsed.mcp).toHaveProperty("servers.omg.bearerToken");
    expect(parsed.settings).toEqual({ model: "opus", fastMode: true });
    expect(parsed.context.instructions[0].content).toBe("FULL CONTENT");
  });

  test("refuses non-uuid ids, bad provider, empty args, non-http mcp entries", () => {
    expect(!encodeMacStreamMetadata(meta({ requestId: "nope" })).ok).toBe(true);
    expect(!encodeMacStreamMetadata(meta({ provider: "grok" as never })).ok).toBe(true);
    expect(!encodeMacStreamMetadata(meta({ args: [] })).ok).toBe(true);
    expect(!encodeMacStreamMetadata(meta({
      mcp: { servers: { x: { type: "http", url: "file:///etc", bearerToken: "t".repeat(32) } } },
    })).ok).toBe(true);
    expect(!encodeMacStreamMetadata(meta({
      mcp: { servers: { x: { type: "http", url: "https://b/mcp", bearerToken: "short" } } },
    })).ok).toBe(true);
  });

  test("refuses metadata beyond the frozen 512 KiB bound", () => {
    const big = meta({
      context: {
        revision: "r".repeat(64),
        instructions: [{ order: 0, path: "/AGENTS.md", sha256: "a".repeat(64), content: "x".repeat(600_000) }],
        skills: [],
        memory: [],
      },
    });
    const result = encodeMacStreamMetadata(big);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(String(MAC_METADATA_MAX_BYTES));
  });

  test("optional model and cwd ride along when present", () => {
    const result = encodeMacStreamMetadata(meta({ model: "opus", cwd: "/private/tmp/scratch" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(new TextDecoder().decode(result.line)) as { model?: string; cwd?: string };
    expect(parsed.model).toBe("opus");
    expect(parsed.cwd).toBe("/private/tmp/scratch");
  });
});

describe("createHandshakeDecoder", () => {
  test("ready handshake split across chunks; consumed is the offset IN the completing chunk", () => {
    const requestId = crypto.randomUUID();
    const decoder = createHandshakeDecoder(requestId);
    const line = `{"transport":1,"requestId":"${requestId}","status":"ready","pid":123}\n`;
    const bytes = new TextEncoder().encode(line);
    const step = decoder.push(bytes.subarray(0, 10));
    expect("pending" in step).toBe(true);
    const done = decoder.push(bytes.subarray(10));
    expect("pending" in done).toBe(false);
    if ("pending" in done || !done.ok) return;
    expect(done.handshake.status).toBe("ready");
    if (done.handshake.status === "ready") expect(done.handshake.pid).toBe(123);
    // consumed counts from the START OF THE COMPLETING CHUNK (newlineAt+1),
    // never the cumulative prefix: slicing the current chunk by the
    // cumulative count drops payload bytes (item 33).
    expect(done.consumed).toBe(bytes.byteLength - 10);
    // No bytes followed the newline inside the completing chunk.
    expect(done.remainder.byteLength).toBe(0);
  });

  test("item 33 primary probe: split handshake NEVER drops the coalesced payload", () => {
    const requestId = crypto.randomUUID();
    const decoder = createHandshakeDecoder(requestId);
    const header = new TextEncoder().encode(
      `{"transport":1,"requestId":"${requestId}","status":"ready"}`,
    );
    const providerPayload = new Uint8Array(4096).fill(0x5a);
    const first = header.subarray(0, 20); // the primary's exact fragment size
    const second = new Uint8Array(header.byteLength - 20 + 1 + providerPayload.byteLength);
    second.set(header.subarray(20), 0);
    second[header.byteLength - 20] = 0x0a; // newline completing the handshake
    second.set(providerPayload, header.byteLength - 20 + 1);
    const step = decoder.push(first);
    expect("pending" in step).toBe(true);
    const done = decoder.push(second);
    expect("pending" in done).toBe(false);
    if ("pending" in done || !done.ok) return;
    expect(done.handshake.status).toBe("ready");
    // The explicit remainder carries the ENTIRE native payload verbatim.
    expect(done.remainder.byteLength).toBe(providerPayload.byteLength);
    expect(done.remainder[0]).toBe(0x5a);
    expect(done.remainder[done.remainder.byteLength - 1]).toBe(0x5a);
  });

  test("bytes after the handshake newline are preserved via the explicit remainder", () => {
    const requestId = crypto.randomUUID();
    const decoder = createHandshakeDecoder(requestId);
    const payload = `{"transport":1,"requestId":"${requestId}","status":"ready"}\nRAW-NATIVE-BYTES`;
    const step = decoder.push(new TextEncoder().encode(payload));
    expect("pending" in step).toBe(false);
    if ("pending" in step || !step.ok) return;
    expect(new TextDecoder().decode(step.remainder)).toBe("RAW-NATIVE-BYTES");
    expect(step.consumed).toBe(payload.indexOf("\n") + 1);
  });

  for (const status of ["rejected", "refused", "exists", "conflict", "failed", "reused"] as const) {
    test(`non-ready status "${status}" parses with reason (peer spellings degrade safely)`, () => {
      const requestId = crypto.randomUUID();
      const decoder = createHandshakeDecoder(requestId);
      const step = decoder.push(new TextEncoder().encode(
        `{"transport":1,"requestId":"${requestId}","status":"${status}","reason":"policy-ineligible"}\n`,
      ));
      expect("pending" in step).toBe(false);
      if ("pending" in step || !step.ok) return;
      expect(step.handshake.status).toBe(status);
    });
  }

  test("coalesced handshake + large native output in ONE chunk is NOT rejected (item 26)", () => {
    const requestId = crypto.randomUUID();
    const decoder = createHandshakeDecoder(requestId);
    const handshakeLine = `{"transport":1,"requestId":"${requestId}","status":"ready","pid":9}\n`;
    const native = new Uint8Array(32 * 1024).fill(0x41); // 32 KiB of provider output
    const coalesced = new Uint8Array(handshakeLine.length + native.byteLength);
    coalesced.set(new TextEncoder().encode(handshakeLine), 0);
    coalesced.set(native, handshakeLine.length);
    const step = decoder.push(coalesced);
    expect("pending" in step).toBe(false);
    if ("pending" in step || !step.ok) return;
    expect(step.handshake.status).toBe("ready");
    if (step.handshake.status === "ready") expect(step.handshake.pid).toBe(9);
    expect(step.consumed).toBe(handshakeLine.length);
    expect(step.remainder.byteLength).toBe(native.byteLength);
    expect(step.remainder[0]).toBe(0x41);
  });

  test("prefix bound still fires on an oversized handshake LINE (no newline in sight)", () => {
    const requestId = crypto.randomUUID();
    const decoder = createHandshakeDecoder(requestId);
    const bigNoNewline = new Uint8Array(MAC_HANDSHAKE_MAX_BYTES + 1).fill(0x61);
    const step = decoder.push(bigNoNewline);
    expect(!("pending" in step) && !step.ok).toBe(true);
  });

  test("requestId mismatch and garbage are fatal", () => {
    const decoder = createHandshakeDecoder(crypto.randomUUID());
    const bad = decoder.push(new TextEncoder().encode(
      `{"transport":1,"requestId":"00000000-0000-0000-0000-000000000000","status":"ready"}\n`,
    ));
    expect(!("pending" in bad) && !bad.ok).toBe(true);
    const decoder2 = createHandshakeDecoder(crypto.randomUUID());
    const garbage = decoder2.push(new TextEncoder().encode("not json at all\n"));
    expect(!("pending" in garbage) && !garbage.ok).toBe(true);
  });
});
