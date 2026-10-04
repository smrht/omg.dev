// Handler factory for the Mac main-chat bridge (BRIDGE-TASK, 2026-10-03).
//
// This module produces ONE Web-standard handler ((req) => Promise<Response>)
// that a private Bun server may mount later. It is deliberately NOT wired
// into src/commands/serve.ts — exposing it is a deployment decision, not a
// library default. Central authority stays untouched: cwd, roots, role,
// instructions and the exact upstream namespace map all come from a lease
// that only trusted local control-plane code can register. Unknown sessions,
// bad tokens, expired or revoked leases and unsupported roles fail closed
// with 401/403 — there is no anonymous path and never an owner fallback.
import { hashToken, hashesMatch, type BridgeLease, type LeaseRegistry } from "./lease.ts";
import { proxyNamespaceRequest, type ProxyFetch } from "./proxy.ts";
import { serveWorkspaceMcp, type WorkspaceLimits } from "./workspace.ts";
import { IdempotencyJournal } from "./journal.ts";
import { StdioNamespaceAdapter, type StdioServerSpec } from "./stdio-adapter.ts";

export interface BridgeLimits {
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_BRIDGE_LIMITS: BridgeLimits = {
  maxBodyBytes: 2 * 1024 * 1024,
  upstreamTimeoutMs: 60_000,
  maxOutputBytes: 4 * 1024 * 1024,
};

/** The role a lease must carry. One role, on purpose: fail closed on the rest. */
export const SUPPORTED_BRIDGE_ROLES = ["mac-chat"] as const;

export interface MacChatBridgeOptions {
  registry: LeaseRegistry;
  /** Directory for the write idempotency journal (bridge-owned, not the lease cwd). */
  journalDir: string;
  supportedRoles?: readonly string[];
  limits?: Partial<BridgeLimits>;
  workspaceLimits?: Partial<WorkspaceLimits>;
  /** Injectable upstream transport; tests pass fixtures, production uses fetch. */
  fetchImpl?: ProxyFetch;
  now?: () => number;
  /** Secret-free structured logging. Default: silent. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * stdio namespace adaptation (integration revision 2): trusted specs for
   * namespaces the control-plane wants adapted on this box. Keys are
   * namespace names; the bridge serves them behind the lease like any other
   * namespace. Absent names still answer 404 explicitly.
   */
  stdioSpecs?: Record<string, StdioServerSpec>;
  stdioLimits?: Partial<{ maxRequestBytes: number; idleCloseMs: number; requestTimeoutMs: number }>;
}

export interface MacChatBridge {
  /** Web-standard handler for a private Bun server. */
  handle: (req: Request) => Promise<Response>;
  /** Registry handed in, for the control-plane to rotate/revoke leases. */
  registry: LeaseRegistry;
  /** Close the given adapted stdio children (or all when omitted). */
  closeStdio(keys?: string[]): Promise<void>;
}

/** Per-lease single-concurrency shell admission (workspace shell tool). */
class LeaseShellGate {
  private busy = new Set<string>();
  admit(leaseId: string): { ok: true; release: () => void } | { ok: false; error: string } {
    if (this.busy.has(leaseId)) {
      return { ok: false, error: "another shell command for this session is still running" };
    }
    this.busy.add(leaseId);
    return {
      ok: true,
      release: () => {
        this.busy.delete(leaseId);
      },
    };
  }
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function sessionOf(req: Request, url: URL): string | undefined {
  const fromQuery = url.searchParams.get("session")?.trim();
  if (fromQuery) return fromQuery;
  // The remote names its session; the lease plus token decide if that name
  // is honoured. Cross-session attempts are detected, not silently mapped.
  return req.headers.get("x-omg-session-id")?.trim() || undefined;
}

function deny(status: 401 | 403 | 404 | 405 | 413 | 502, error: string, message: string): Response {
  return Response.json({ ok: false, error, message }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function createMacChatBridge(options: MacChatBridgeOptions): MacChatBridge {
  const registry = options.registry;
  const journal = new IdempotencyJournal(options.journalDir);
  const limits = { ...DEFAULT_BRIDGE_LIMITS, ...options.limits };
  const supportedRoles = options.supportedRoles ?? SUPPORTED_BRIDGE_ROLES;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const stdio = new StdioNamespaceAdapter(options.stdioLimits ?? {}, log);
  const shellGate = new LeaseShellGate();

  const readBodyCapped = async (req: Request): Promise<Uint8Array | undefined> => {
    if (req.method !== "POST") return undefined;
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > limits.maxBodyBytes) return Promise.reject(new Error("body-too-large"));
    const reader = req.body?.getReader();
    if (!reader) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBodyBytes) {
        await reader.cancel().catch(() => {});
        return Promise.reject(new Error("body-too-large"));
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };

  const handle = async (req: Request): Promise<Response> => {
    const startedAt = now();
    const url = new URL(req.url);
    const respond = (res: Response): Response => {
      log("bridge.request", { path: url.pathname, method: req.method, status: res.status, ms: now() - startedAt });
      return res;
    };

    if (!url.pathname.startsWith("/mcp/") || url.pathname.slice("/mcp/".length).length === 0) {
      return respond(deny(404, "not_found", "the bridge serves /mcp/<namespace> and /mcp/workspace only"));
    }
    const namespace = decodeURIComponent(url.pathname.slice("/mcp/".length).replace(/\/+$/, ""));

    let body: Uint8Array | undefined;
    try {
      body = await readBodyCapped(req);
    } catch {
      return respond(deny(413, "body_too_large", `request body exceeds ${limits.maxBodyBytes} bytes`));
    }

    // ---- auth: session + bearer token + active lease. No fallback path. ----
    const session = sessionOf(req, url);
    const token = bearerToken(req);
    if (!session) return respond(deny(401, "session_required", "name the lease session (query ?session= or x-omg-session-id)"));
    if (!token) return respond(deny(401, "token_required", "missing bearer token"));
    const lease = registry.lookup(session, now());
    if (!lease) {
      log("bridge.auth.fail", { reason: "unknown-or-expired-session" });
      return respond(deny(401, "invalid_session", "unknown, expired or revoked session"));
    }
    const tokenHash = hashToken(token);
    if (!hashesMatch(tokenHash, lease.tokenHash)) {
      // A token that matches a DIFFERENT lease is a cross-session attempt:
      // report it as such instead of a generic bad token.
      const owner = registry.leaseIdForTokenHash(tokenHash);
      log("bridge.auth.fail", { reason: owner ? "cross-session-token" : "bad-token" });
      return respond(deny(owner ? 403 : 401, owner ? "cross_session_token" : "invalid_token",
        owner ? "token belongs to a different session" : "invalid token for this session"));
    }
    if (!supportedRoles.includes(lease.role)) {
      log("bridge.auth.fail", { reason: "unsupported-role", role: lease.role });
      return respond(deny(403, "unsupported_role", `role '${lease.role}' is not supported by this bridge; failing closed`));
    }

    if (namespace === "workspace") {
      const res = await serveWorkspaceMcp(
        body === undefined ? req : new Request(url.toString(), { method: "POST", headers: req.headers, body }),
        lease,
        {
          journal,
          limits: options.workspaceLimits,
          stillActive: () => registry.lookup(lease.id, now()) !== undefined,
          shellGate: () => shellGate.admit(lease.id),
        },
      );
      return respond(res);
    }

    const stdioSpec = options.stdioSpecs?.[`${lease.id}|${namespace}`] ?? options.stdioSpecs?.[namespace];
    if (stdioSpec) {
      // Adapted stdio namespace: served by THIS bridge from its own child,
      // behind the same lease auth as every other namespace.
      const res = await stdio.handle(stdioSpec, req, body);
      return respond(res);
    }

    const target = lease.namespaces[namespace];
    if (!target) {
      // Explicit unavailability, never silent omission (CONTEXT-CONTRACT v1).
      return respond(deny(404, "namespace_unavailable", `namespace '${namespace}' is not part of this session lease`));
    }
    const res = await proxyNamespaceRequest(
      body === undefined ? req : new Request(url.toString(), { method: req.method, headers: req.headers, body }),
      namespace,
      target,
      body,
      {
        fetchImpl: options.fetchImpl,
        limits: { upstreamTimeoutMs: limits.upstreamTimeoutMs, maxOutputBytes: limits.maxOutputBytes },
        log,
        trustedHttpsHosts: lease.trustedHttpsHosts ?? [],
      },
    );
    return respond(res);
  };

  return { handle, registry, closeStdio: (keys?: string[]) => stdio.close(keys) };
}

/** Lease type re-export for integrators. */
export type { BridgeLease };
