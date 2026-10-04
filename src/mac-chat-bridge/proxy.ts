// Proxied MCP namespaces for the Mac main-chat bridge.
//
// The bridge keeps the central Agentbox authoritative for every existing OMG
// namespace (omg, connectors, computer, executor, chrome-work, ...): requests
// are forwarded verbatim to the exact loopback URL registered in the lease,
// with the exact identity headers from server configuration. The remote side
// cannot influence the upstream URL, the identity headers, or its role. What
// the remote sends in authorization/host/session headers is dropped and
// replaced, redirects are refused, and responses (including SSE streams and
// text/media payloads) pass through untouched up to hard byte caps.
import type { BridgeNamespaceTarget } from "./lease.ts";

export interface ProxyLimits {
  upstreamTimeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_PROXY_LIMITS: ProxyLimits = {
  upstreamTimeoutMs: 60_000,
  maxOutputBytes: 4 * 1024 * 1024,
};

/** Request headers safe to forward from the remote caller. Identity is NOT among them. */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"];

/** Response headers never copied back (hop-by-hop or transport-owned). */
const STRIPPED_RESPONSE_HEADERS = ["connection", "keep-alive", "transfer-encoding", "content-length", "access-control-allow-origin"];

function errBody(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: code, message }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isAllowedUpstream(url: string, trustedHttpsHosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "http:") {
      return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    }
    if (parsed.protocol === "https:") {
      const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      return trustedHttpsHosts.includes(parsed.hostname) || trustedHttpsHosts.includes(hostPort);
    }
    return false;
  } catch {
    return false;
  }
}

async function readBodyCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out };
}

/**
 * SSE passthrough with real backpressure and a FULL-BODY deadline:
 *
 * - pull-based pumping (read one chunk, enqueue it, let the stream pull the
 *   next when the consumer is ready) instead of an unbounded start() loop;
 * - the per-request timeout covers the ENTIRE body, not just the headers
 *   (a slow/hung SSE upstream aborts at the deadline, it cannot hang a
 *   worker forever on an output-cap technicality);
 * - the byte cap still hard-fails the stream;
 * - cancel() releases the reader lock before cancelling (Bun throws on
 *   cancelling a locked stream) so a client disconnect propagates upstream.
 */
function capStream(
  body: ReadableStream<Uint8Array>,
  cap: number,
  deadlineMs: number,
): ReadableStream<Uint8Array> {
  let passed = 0;
  let reader: { read(): Promise<{ done?: boolean; value?: Uint8Array }> } | null = null;
  const getReader = () => {
    if (!reader) reader = body.getReader() as unknown as { read(): Promise<{ done?: boolean; value?: Uint8Array }> };
    return reader;
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const upstream = getReader();
        try {
          const deadline = Date.now() + deadlineMs;
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              controller.error(new Error("upstream stream exceeded the response deadline"));
              return;
            }
            const raced = await Promise.race([
              upstream.read() as Promise<{ done?: boolean; value?: Uint8Array }>,
              new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
            ]);
            if (raced === "timeout") {
              controller.error(new Error("upstream stream exceeded the response deadline"));
              return;
            }
            if (raced.done) {
              controller.close();
              return;
            }
            if (raced.value?.byteLength) {
              passed += raced.value.byteLength;
              if (passed > cap) {
                controller.error(new Error("upstream stream exceeded output cap"));
                return;
              }
              controller.enqueue(raced.value);
              return; // wait for the next pull = downstream backpressure
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        Promise.resolve()
          .then(() => body.cancel(reason))
          .catch(() => {});
      },
    },
    { highWaterMark: 1 },
  );
}

export type ProxyFetch = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  redirect: "error";
  signal: AbortSignal;
}) => Promise<Response>;

export interface ProxyDeps {
  fetchImpl?: ProxyFetch;
  limits?: Partial<ProxyLimits>;
  /** Structured, secret-free logging. Never receives headers or bodies. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Forward one request to the exact upstream registered for `namespace`.
 * The target comes from the lease (server configuration), never from the wire.
 */
export async function proxyNamespaceRequest(
  req: Request,
  namespace: string,
  target: BridgeNamespaceTarget,
  body: Uint8Array | undefined,
  deps: ProxyDeps & { trustedHttpsHosts?: readonly string[] } = {},
): Promise<Response> {
  const limits = { ...DEFAULT_PROXY_LIMITS, ...deps.limits };
  if (!isAllowedUpstream(target.url, deps.trustedHttpsHosts ?? [])) {
    // Defense in depth: registration already rejects upstreams outside the
    // loopback-http / allowlisted-https policy.
    return errBody(502, "upstream_not_allowed", "configured upstream is not an allowed loopback/https target; refusing to fetch");
  }
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return errBody(405, "method_not_allowed", "namespace proxy accepts GET/POST/DELETE only");
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  // Server-owned identity wins over anything the remote tried to send; the
  // strip is explicit so a future edit to the allowlist cannot leak it.
  for (const banned of ["authorization", "host", "cookie", "x-omg-session-id", "x-lfg-session-id", "x-omg-session-token"]) {
    delete headers[banned];
  }
  for (const [name, value] of Object.entries(target.headers)) {
    headers[name] = value;
  }

  const controller = new AbortController();
  // The timeout covers the ENTIRE exchange (headers + body): a hung SSE
  // upstream aborts at the deadline instead of streaming forever under an
  // already-cleared header timer.
  let timer = setTimeout(() => controller.abort(), limits.upstreamTimeoutMs);
  (timer as { unref?: () => void }).unref?.();
  const startedAt = Date.now();
  let upstream: Response;
  try {
    const doFetch: ProxyFetch = deps.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as unknown as Promise<Response>);
    upstream = await doFetch(target.url, {
      method: req.method,
      headers,
      body,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    const aborted = controller.signal.aborted;
    clearTimeout(timer);
    deps.log?.("bridge.proxy.fail", { namespace, method: req.method, aborted, name: err?.name });
    if (aborted) return errBody(504, "upstream_timeout", "upstream call exceeded the configured timeout");
    if (err?.name === "AbortError") return errBody(504, "upstream_timeout", "upstream call aborted");
    return errBody(502, "upstream_unreachable", "upstream call failed (network or redirect refused)");
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.includes(name.toLowerCase())) responseHeaders.set(name, value);
  }
  responseHeaders.set("cache-control", "no-store");

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    // Streamed reply: pull-based passthrough with the byte cap AND a body
    // deadline; lifecycle headers (mcp-session-id, event ids) preserved.
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), limits.upstreamTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const stream = capStream(upstream.body as ReadableStream<Uint8Array>, limits.maxOutputBytes, limits.upstreamTimeoutMs);
    deps.log?.("bridge.proxy.ok", { namespace, method: req.method, status: upstream.status, sse: true, ms: Date.now() - startedAt });
    return new Response(stream, { status: upstream.status, headers: responseHeaders });
  }

  const buffered = await readBodyCapped(upstream.body as ReadableStream<Uint8Array> | null, limits.maxOutputBytes);
  clearTimeout(timer);
  if (!buffered.ok) {
    try {
      controller.abort();
    } catch {}
    deps.log?.("bridge.proxy.fail", { namespace, status: upstream.status, reason: "output-cap" });
    return errBody(502, "upstream_too_large", "upstream response exceeded the output cap");
  }
  const out = new Headers(responseHeaders);
  out.set("content-length", String(buffered.bytes.byteLength));
  deps.log?.("bridge.proxy.ok", {
    namespace,
    method: req.method,
    status: upstream.status,
    bytes: buffered.bytes.byteLength,
    ms: Date.now() - startedAt,
  });
  return new Response(buffered.bytes, { status: upstream.status, headers: out });
}
