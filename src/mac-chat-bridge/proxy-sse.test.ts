// Proxy SSE backpressure/deadline tests (WIRE-RECONCILIATION defect 6):
// a hung SSE upstream must fail at the body deadline (not stream forever
// after headers), the output cap still hard-fails, and a client disconnect
// propagates instead of throwing on a locked stream.
import { describe, expect, test } from "bun:test";
import { proxyNamespaceRequest } from "./proxy.ts";
import type { BridgeNamespaceTarget } from "./lease.ts";

const target: BridgeNamespaceTarget = { url: "http://127.0.0.1:19999/mcp", headers: {} };

function sseResponse(chunks: string[], opts: { hangAfter?: number; msBetween?: number } = {}): Response {
  const hangAfter = opts.hangAfter ?? Number.POSITIVE_INFINITY;
  const msBetween = opts.msBetween ?? 5;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= hangAfter) {
        // Hung upstream: never enqueue, never close.
        await new Promise(() => {});
        return;
      }
      if (sent >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[sent]!));
      sent++;
      await new Promise((resolve) => setTimeout(resolve, msBetween));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseRequest(): Request {
  return new Request("http://bridge.local/mcp/omg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })),
  });
}

describe("proxyNamespaceRequest SSE", () => {
  test("a hung SSE upstream fails at the body deadline (headers alone are not success)", async () => {
    const started = Date.now();
    const response = await proxyNamespaceRequest(
      sseRequest(),
      "omg",
      target,
      undefined,
      {
        limits: { upstreamTimeoutMs: 250, maxOutputBytes: 1024 * 1024 },
        fetchImpl: async () => sseResponse(["data: one\n\n"], { hangAfter: 1 }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Consuming the stream must ERROR at the deadline, not hang.
    let errored = false;
    try {
      await response.text();
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("healthy SSE streams through until close", async () => {
    const response = await proxyNamespaceRequest(
      sseRequest(),
      "omg",
      target,
      undefined,
      {
        limits: { upstreamTimeoutMs: 2_000, maxOutputBytes: 1024 * 1024 },
        fetchImpl: async () => sseResponse(["data: a\n\n", "data: b\n\n"]),
      },
    );
    const text = await response.text();
    expect(text).toContain("data: a");
    expect(text).toContain("data: b");
  });

  test("the output cap still hard-fails an oversized SSE stream", async () => {
    const big = `data: ${"x".repeat(2048)}\n\n`;
    const response = await proxyNamespaceRequest(
      sseRequest(),
      "omg",
      target,
      undefined,
      {
        limits: { upstreamTimeoutMs: 2_000, maxOutputBytes: 1024 },
        fetchImpl: async () => sseResponse([big, big, big]),
      },
    );
    let errored = false;
    try {
      await response.text();
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });

  test("client disconnect cancels without throwing on the locked upstream stream", async () => {
    const response = await proxyNamespaceRequest(
      sseRequest(),
      "omg",
      target,
      undefined,
      {
        limits: { upstreamTimeoutMs: 10_000, maxOutputBytes: 1024 * 1024 },
        fetchImpl: async () => sseResponse(["data: a\n\n", "data: b\n\n", "data: c\n\n"], { msBetween: 30 }),
      },
    );
    const body = response.body!;
    const reader = body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Client goes away: cancel MUST NOT throw (locked-stream handling).
    await expect(reader.cancel("client gone")).resolves.toBeUndefined();
  });
});
