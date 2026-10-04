// Session leases for the Mac main-chat bridge (BRIDGE-TASK, 2026-10-03).
//
// A lease is the ONLY way a remote Mac main chat gets access to this Agentbox.
// It is registered programmatically by trusted local control-plane code (the
// serve process or a launcher acting for Sam), never over the bridge itself.
// The registry keeps the SHA-256 of the bearer token, never the plaintext, and
// the same hashing is used for request auth so a leaked log line cannot reuse
// a session. Nothing here touches ~/.config, credentials or the data dir; the
// registry is in-memory by design and dies with the process that owns it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, sep } from "node:path";
import { forbiddenPathSegment } from "./guards.ts";

/** One approved directory tree, with explicit read/write booleans. */
export interface BridgeRoot {
  /** Absolute path, as approved by the control-plane. */
  path: string;
  read: boolean;
  write: boolean;
}

/** Exact upstream target for one proxied MCP namespace. Server-owned. */
export interface BridgeNamespaceTarget {
  /** Loopback URL of the central endpoint, e.g. http://127.0.0.1:8766/mcp?session=<id>. */
  url: string;
  /** Identity headers injected on every proxied call. From server configuration only. */
  headers: Record<string, string>;
}

/** What the control-plane hands the registry. Token plaintext exists only here. */
export interface BridgeLeaseInput {
  id: string;
  /** Bearer token plaintext, >= 16 chars. Hashed immediately, never stored or logged. */
  token: string;
  /** Expiry in epoch ms. Checked on every request. */
  expiresAt: number;
  cwd: string;
  roots: BridgeRoot[];
  /** Ordered instruction files (AGENTS.md and friends), absolute. */
  instructions: string[];
  skillRoots: string[];
  memoryRoots: string[];
  /** Role for this session. Must be in the handler's supported set. */
  role: string;
  namespaces: Record<string, BridgeNamespaceTarget>;
  /**
   * Exact host(:port) allowlist for https namespace upstreams. Registered by
   * trusted control-plane code from the admin config pins only; a lease
   * cannot widen it beyond what the registrar itself allows.
   */
  trustedHttpsHosts?: string[];
}

export interface BridgeLease {
  id: string;
  tokenHash: string;
  expiresAt: number;
  cwd: string;
  roots: BridgeRoot[];
  instructions: string[];
  skillRoots: string[];
  memoryRoots: string[];
  role: string;
  namespaces: Record<string, BridgeNamespaceTarget>;
  /** Present when the registrar allowed https upstreams (exact host(:port) pins). */
  trustedHttpsHosts?: string[];
  createdAt: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests. */
export function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Mint a fresh bearer token for the control-plane (plaintext, hand to one session). */
export function newLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

export class LeaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseValidationError";
  }
}

/**
 * Upstream policy for namespace targets (integration revision 2):
 * - loopback http stays always allowed (the original bridge contract);
 * - https targets are allowed ONLY when the exact host(:port) is in the
 *   control-plane allowlist (admin-pinned tailnet/private endpoints);
 * - everything else (external http, non-http schemes) is refused.
 */
export function assertUpstreamUrl(
  url: string,
  label: string,
  trustedHttpsHosts: readonly string[] = [],
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LeaseValidationError(`${label}: unparseable url`);
  }
  if (parsed.username || parsed.password) {
    throw new LeaseValidationError(`${label}: url carries embedded credentials`);
  }
  const host = parsed.hostname;
  if (parsed.protocol === "http:") {
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new LeaseValidationError(`${label}: http upstream must be loopback, got ${host}`);
    }
    return parsed;
  }
  if (parsed.protocol === "https:") {
    const hostPort = parsed.port ? `${host}:${parsed.port}` : host;
    if (!trustedHttpsHosts.includes(host) && !trustedHttpsHosts.includes(hostPort)) {
      throw new LeaseValidationError(`${label}: https upstream host ${hostPort} is not in the trusted allowlist`);
    }
    return parsed;
  }
  throw new LeaseValidationError(`${label}: only http (loopback) and allowlisted https upstreams are allowed`);
}

function assertLoopbackUrl(url: string, label: string): URL {
  return assertUpstreamUrl(url, label, []);
}

function assertCleanAbsolute(p: string, label: string): void {
  if (typeof p !== "string" || !isAbsolute(p) || p.includes("\0")) {
    throw new LeaseValidationError(`${label}: must be an absolute path`);
  }
  const segments = p.split(sep).filter(Boolean);
  if (segments.some((s) => forbiddenPathSegment(s))) {
    throw new LeaseValidationError(`${label}: path touches a forbidden segment (${p})`);
  }
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Validate and register a lease. Throws LeaseValidationError on anything the
 * control-plane got wrong; defense in depth, not distrust — but a bad lease
 * must never reach the request path.
 */
export function validateLease(input: BridgeLeaseInput): BridgeLease {
  if (!input?.id || typeof input.id !== "string") throw new LeaseValidationError("id required");
  if (typeof input.token !== "string" || input.token.length < 16) {
    throw new LeaseValidationError("token must be at least 16 characters");
  }
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) {
    throw new LeaseValidationError("expiresAt required (epoch ms)");
  }
  if (typeof input.role !== "string" || !input.role) throw new LeaseValidationError("role required");
  if (!Array.isArray(input.roots) || input.roots.length === 0) {
    throw new LeaseValidationError("at least one approved root required");
  }
  for (const root of input.roots) {
    if (!root || typeof root.path !== "string") throw new LeaseValidationError("root.path required");
    assertCleanAbsolute(root.path, "root");
  }
  assertCleanAbsolute(input.cwd, "cwd");
  const cwdReadable = input.roots.some((r) => r.read && isWithin(input.cwd, r.path));
  if (!cwdReadable) throw new LeaseValidationError("cwd must sit inside a readable root");
  for (const p of [...(input.instructions ?? []), ...(input.skillRoots ?? []), ...(input.memoryRoots ?? [])]) {
    assertCleanAbsolute(p, "context path");
  }
  for (const [ns, target] of Object.entries(input.namespaces ?? {})) {
    if (!ns || !/^[a-z0-9_-]+$/i.test(ns)) throw new LeaseValidationError(`namespace name invalid: ${ns}`);
    if (!target || typeof target.url !== "string") throw new LeaseValidationError(`namespace ${ns}: url required`);
    assertUpstreamUrl(target.url, `namespace ${ns}`, input.trustedHttpsHosts ?? []);
    if (!target.headers || typeof target.headers !== "object") {
      throw new LeaseValidationError(`namespace ${ns}: headers object required`);
    }
    for (const [k, v] of Object.entries(target.headers)) {
      if (typeof v !== "string") throw new LeaseValidationError(`namespace ${ns}: header ${k} must be a string`);
    }
  }
  return {
    id: input.id,
    tokenHash: hashToken(input.token),
    expiresAt: input.expiresAt,
    cwd: input.cwd,
    roots: input.roots.map((r) => ({ ...r })),
    instructions: [...(input.instructions ?? [])],
    skillRoots: [...(input.skillRoots ?? [])],
    memoryRoots: [...(input.memoryRoots ?? [])],
    role: input.role,
    namespaces: structuredClone(input.namespaces ?? {}),
    createdAt: Date.now(),
    ...(input.trustedHttpsHosts?.length ? { trustedHttpsHosts: [...input.trustedHttpsHosts] } : {}),
  };
}

/**
 * In-memory lease registry. One instance owns every live bridge session; it is
 * the single source of truth for "is this session still allowed".
 */
export class LeaseRegistry {
  private byId = new Map<string, BridgeLease>();
  private byTokenHash = new Map<string, string>();

  register(input: BridgeLeaseInput): BridgeLease {
    const lease = validateLease(input);
    this.byId.set(lease.id, lease);
    this.byTokenHash.set(lease.tokenHash, lease.id);
    return lease;
  }

  /** Replaces an existing lease (token rotation). Fails if the id is unknown. */
  rotate(input: BridgeLeaseInput): BridgeLease {
    const existing = this.byId.get(input.id);
    if (!existing) throw new LeaseValidationError(`unknown lease ${input.id}`);
    this.byTokenHash.delete(existing.tokenHash);
    return this.register(input);
  }

  /**
   * Rebuild a lease from a persisted token HASH (serve-restart recovery).
   * The plaintext token is NOT known here — it lives only in the harness
   * process that received it — but request auth hashes the presented token
   * anyway, so the stored hash authorizes exactly the same bearer.
   */
  seedFromHash(record: {
    id: string;
    tokenHash: string;
    expiresAt: number;
    cwd: string;
    roots: BridgeRoot[];
    instructions: string[];
    skillRoots: string[];
    memoryRoots: string[];
    role: string;
    namespaces: Record<string, BridgeNamespaceTarget>;
    trustedHttpsHosts?: string[];
  }): BridgeLease {
    if (!/^[0-9a-f]{64}$/.test(record.tokenHash)) {
      throw new LeaseValidationError("seedFromHash: tokenHash must be a sha256 hex digest");
    }
    const lease: BridgeLease = {
      id: record.id,
      tokenHash: record.tokenHash,
      expiresAt: record.expiresAt,
      cwd: record.cwd,
      roots: record.roots.map((r) => ({ ...r })),
      instructions: [...record.instructions],
      skillRoots: [...record.skillRoots],
      memoryRoots: [...record.memoryRoots],
      role: record.role,
      namespaces: structuredClone(record.namespaces),
      createdAt: Date.now(),
      ...(record.trustedHttpsHosts?.length ? { trustedHttpsHosts: [...record.trustedHttpsHosts] } : {}),
    };
    this.byId.set(lease.id, lease);
    this.byTokenHash.set(lease.tokenHash, lease.id);
    return lease;
  }

  revoke(id: string): boolean {
    const lease = this.byId.get(id);
    if (!lease) return false;
    this.byId.delete(id);
    this.byTokenHash.delete(lease.tokenHash);
    return true;
  }

  /** Active, unexpired lookup. Expired leases are treated as absent. */
  lookup(id: string, now: number = Date.now()): BridgeLease | undefined {
    const lease = this.byId.get(id);
    if (!lease) return undefined;
    if (now >= lease.expiresAt) return undefined;
    return lease;
  }

  /** All active, unexpired leases (renewal sweep input). */
  active(now: number = Date.now()): BridgeLease[] {
    const out: BridgeLease[] = [];
    for (const lease of this.byId.values()) {
      if (now < lease.expiresAt) out.push(lease);
    }
    return out;
  }

  /** Which lease a token hash belongs to, for cross-session detection. */
  leaseIdForTokenHash(hash: string): string | undefined {
    return this.byTokenHash.get(hash);
  }

  size(): number {
    return this.byId.size;
  }
}
