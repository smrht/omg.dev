// Serve-side mount of the mac-chat bridge (integration revision 2).
//
// OWNED LIFECYCLE: one MacBridgeHost per serve process, created ONLY when the
// admin config pins bridge {bindAddress, port, publicUrl} (default: absent →
// bridge stays unmounted and mac MCP needs fail closed). Responsibilities:
//
// - provider-specific namespace maps with REAL central auth: runtime
//   namespaces carry derived session-token headers; user-config http(s)
//   entries keep their original headers (resolved env bearers included) —
//   in-memory only, never logged, never serialized to the durable store,
//   never sent to the remote (the remote sees the bridge URL + lease bearer);
// - per-lease stdio adaptation specs (immutable, lease-scoped: no
//   cross-session identity mutation), spawned/closed by the bridge itself;
// - durable lease records WITHOUT secrets: token hashes + re-derivable
//   source references, so a serve restart keeps authorizing already-running
//   remote sessions and reloads resolve fresh auth from the live configs.
//
// The frozen wire has exactly FOUR ssh verbs (probe/stream/status/cancel) and
// NO out-of-band provisioning: the supervisor materializes MCP config and
// secrets itself from the authenticated stream stdin.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PATHS, localServeBaseUrl, COMPUTER_MCP_SERVER_NAME, CONNECTORS_MCP_SERVER_NAME } from "../config.ts";
import { SESSION_TOKEN_HEADER, sessionToken } from "../policy/session-token.ts";
import {
  createMacChatBridge,
  LeaseRegistry,
  newLeaseToken,
  type BridgeNamespaceTarget,
  type BridgeRoot,
  type MacChatBridge,
  type StdioServerSpec,
} from "../mac-chat-bridge/index.ts";
import { discoverCentralNamespaces, type FullNamespaceEntry } from "./namespaces.ts";
import type { MacStreamProvider } from "./wire.ts";

export type MacBridgeHostOptions = {
  bindAddress: string;
  port: number;
  publicUrl: string;
  trustedUpstreamHosts: string[];
  log?: (line: string) => void;
  /** Central user-config paths (tests inject fixtures; defaults are real). */
  claudeUserConfigPath?: string;
  codexUserConfigPath?: string;
};

type DurableLease = {
  id: string;
  tokenHash: string;
  expiresAt: number;
  sessionId: string;
  provider: MacStreamProvider;
  sessionRole: string | null;
  cwd: string;
  roots: BridgeRoot[];
  instructions: string[];
  skillRoots: string[];
  memoryRoots: string[];
  /** Namespace names this lease serves (entries re-resolved from live configs). */
  namespaceNames: string[];
  trustedHttpsHosts: string[];
  createdAt: number;
};

function leaseDir(): string {
  return join(PATHS.data, "mac-chat-leases");
}

function leasePath(id: string): string {
  return join(leaseDir(), `${id.replace(/[^a-zA-Z0-9-]/g, "")}.json`);
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type MintedLease = {
  leaseId: string;
  token: string;
  expiresAt: number;
};

export type SessionNamespaceMap = {
  /** Bridge proxy targets (http/https upstreams with central auth). */
  targets: Record<string, BridgeNamespaceTarget>;
  /** Lease-scoped immutable stdio specs (adapted on this box). */
  stdioSpecs: Record<string, StdioServerSpec>;
  /** Ordered namespace names for the wire metadata + lease bundle. */
  mcpNames: string[];
  /** The provider this map was built for (never a union). */
  provider: MacStreamProvider;
};

export class MacBridgeHost {
  readonly registry = new LeaseRegistry();
  readonly bridge: MacChatBridge;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly log: (line: string) => void;
  /** Lease-scoped stdio specs: key `${leaseId}|${namespace}`, immutable values. */
  private stdioSpecs: Record<string, StdioServerSpec> = {};
  /** Renewal sweep: extends live-session leases below half their TTL. */
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  /** Test seam for deterministic clocks (item 14 fake-clock tests). */
  private now: () => number = Date.now;

  useClockForTests(now: () => number): void {
    this.now = now;
  }

  constructor(private readonly options: MacBridgeHostOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.bridge = createMacChatBridge({
      registry: this.registry,
      journalDir: join(PATHS.data, "mac-chat-journal"),
      log: (event, fields) => this.log(`[mac-bridge] ${event} ${JSON.stringify(fields)}`),
      stdioSpecs: this.stdioSpecs,
    });
  }

  /** Mount on the pinned private address. Idempotent. */
  start(): { ok: true } | { ok: false; error: string } {
    if (this.server) return { ok: true };
    try {
      this.server = Bun.serve({
        hostname: this.options.bindAddress,
        port: this.options.port,
        fetch: (req) => this.bridge.handle(req),
      });
      this.log(`[mac-bridge] mounted on ${this.options.bindAddress}:${this.options.port} (public ${this.options.publicUrl})`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Close ONLY this lease's adapted stdio children (item 14): close must
   * revoke and stop its own children, never another session's.
   */
  closeOwnStdio(sessionId: string): void {
    const prefix = `mac-${sessionId}|`;
    const keys = Object.keys(this.stdioSpecs).filter((k) => k.startsWith(prefix));
    void this.bridge.closeStdio(keys);
  }

  stop(): void {
    try {
      this.server?.stop(true);
    } catch {}
    this.server = null;
    void this.bridge.closeStdio();
  }

  /**
   * Build the session's PROVIDER-SPECIFIC namespace map from trusted central
   * discovery. Runtime namespaces (omg/connectors/computer) carry derived
   * session-token headers; user-config http(s) entries keep their exact
   * central auth; stdio entries become lease-scoped adaptation specs with
   * the session identity env. Unallowlisted https upstreams are left out
   * EXPLICITLY (the bridge 404s them by name; the omission is logged).
   */
  buildNamespaces(
    provider: MacStreamProvider,
    sessionId: string,
    leaseId = `mac-${sessionId}`,
    overrides: { claudeUserConfigPath?: string; codexUserConfigPath?: string } = {},
  ): SessionNamespaceMap {
    overrides = {
      ...(this.options.claudeUserConfigPath ? { claudeUserConfigPath: this.options.claudeUserConfigPath } : {}),
      ...(this.options.codexUserConfigPath ? { codexUserConfigPath: this.options.codexUserConfigPath } : {}),
      ...overrides,
    };
    const base = localServeBaseUrl();
    const identityHeaders = {
      "x-omg-session-id": sessionId,
      [SESSION_TOKEN_HEADER]: sessionToken(sessionId),
    };
    const runtime: Record<string, string> = {
      omg: `${base}/mcp?session=${encodeURIComponent(sessionId)}`,
      [CONNECTORS_MCP_SERVER_NAME]: `${base}/mcp/connectors?session=${encodeURIComponent(sessionId)}`,
      [COMPUTER_MCP_SERVER_NAME]: `${base}/mcp/computer?session=${encodeURIComponent(sessionId)}`,
    };
    const inventory = discoverCentralNamespaces({ provider, runtime, ...overrides });
    const targets: Record<string, BridgeNamespaceTarget> = {};
    const stdioSpecs: Record<string, StdioServerSpec> = {};
    const mcpNames: string[] = [];
    for (const [name, entry] of Object.entries(inventory)) {
      if (entry.source === "omg-runtime") {
        targets[name] = { url: entry.url!, headers: { ...identityHeaders } };
        mcpNames.push(name);
        continue;
      }
      if (entry.kind === "stdio") {
        // Adapted centrally with the session identity env; lease-scoped key
        // so two sessions never share one child or identity.
        const key = `${leaseId}|${name}`;
        stdioSpecs[key] = {
          name,
          key,
          command: entry.command!,
          args: entry.args,
          env: {
            ...entry.env,
            OMG_SESSION_ID: sessionId,
            LFG_SESSION_ID: sessionId,
          },
        };
        mcpNames.push(name);
        continue;
      }
      if (entry.kind === "http") {
        targets[name] = { url: entry.url!, headers: { ...entry.headers } };
        mcpNames.push(name);
        continue;
      }
      // https: only exact host(:port) pins pass.
      const parsed = new URL(entry.url!);
      const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      if (
        this.options.trustedUpstreamHosts.includes(parsed.hostname) ||
        this.options.trustedUpstreamHosts.includes(hostPort)
      ) {
        targets[name] = { url: entry.url!, headers: { ...entry.headers } };
        mcpNames.push(name);
      } else {
        this.log(`[mac-bridge] namespace ${name} upstream ${hostPort} niet in de trusted-allowlist; expliciet niet beschikbaar`);
      }
    }
    // The bridge's own workspace surface rides along for every session.
    mcpNames.unshift("workspace");
    return { targets, stdioSpecs, mcpNames: [...new Set(mcpNames)], provider };
  }

  /**
   * Mint one session lease. The token plaintext is returned EXACTLY ONCE for
   * the harness env; only its hash is kept. The durable record stores NO
   * secrets (headers re-resolve from the live configs on reload).
   */
  mintLease(input: {
    sessionId: string;
    provider: MacStreamProvider;
    sessionRole?: string | null;
    cwd: string;
    roots: BridgeRoot[];
    instructions: string[];
    skillRoots: string[];
    memoryRoots: string[];
    namespaceMap: SessionNamespaceMap;
    ttlMs?: number;
  }): MintedLease {
    const id = `mac-${input.sessionId}`;
    const token = newLeaseToken();
    const expiresAt = this.now() + (input.ttlMs ?? DEFAULT_MAC_LEASE_TTL_MS);
    this.registerLease(id, token, expiresAt, input);
    this.persistDurableOrFail({
      id,
      tokenHash: sha256Hex(token),
      expiresAt,
      sessionId: input.sessionId,
      provider: input.provider,
      sessionRole: input.sessionRole ?? null,
      cwd: input.cwd,
      roots: input.roots,
      instructions: input.instructions,
      skillRoots: input.skillRoots,
      memoryRoots: input.memoryRoots,
      namespaceNames: input.namespaceMap.mcpNames,
      trustedHttpsHosts: this.options.trustedUpstreamHosts,
      createdAt: Date.now(),
    });
    // Install the lease-scoped stdio specs now (immutable objects).
    for (const [key, spec] of Object.entries(input.namespaceMap.stdioSpecs)) {
      this.stdioSpecs[key] = spec;
    }
    return { leaseId: id, token, expiresAt };
  }

  /** Rotate a live lease (resume): new token, same id; old token dies. */
  rotateLease(input: Parameters<MacBridgeHost["mintLease"]>[0]): MintedLease {
    const id = `mac-${input.sessionId}`;
    const token = newLeaseToken();
    const expiresAt = this.now() + (input.ttlMs ?? DEFAULT_MAC_LEASE_TTL_MS);
    this.registerLease(id, token, expiresAt, input);
    this.persistDurableOrFail({
      id,
      tokenHash: sha256Hex(token),
      expiresAt,
      sessionId: input.sessionId,
      provider: input.provider,
      sessionRole: input.sessionRole ?? null,
      cwd: input.cwd,
      roots: input.roots,
      instructions: input.instructions,
      skillRoots: input.skillRoots,
      memoryRoots: input.memoryRoots,
      namespaceNames: input.namespaceMap.mcpNames,
      trustedHttpsHosts: this.options.trustedUpstreamHosts,
      createdAt: Date.now(),
    });
    return { leaseId: id, token, expiresAt };
  }

  private registerLease(id: string, token: string, expiresAt: number, input: Parameters<MacBridgeHost["mintLease"]>[0]): void {
    this.registry.register({
      id,
      token,
      expiresAt,
      cwd: input.cwd,
      roots: input.roots,
      instructions: input.instructions,
      skillRoots: input.skillRoots,
      memoryRoots: input.memoryRoots,
      role: "mac-chat",
      namespaces: input.namespaceMap.targets,
      trustedHttpsHosts: this.options.trustedUpstreamHosts,
    });
  }

  /**
   * Durability is part of the launch contract (item 14): a lease whose
   * durable record could not be written is NOT a successful lease — a serve
   * restart could not re-authorize the session, so the launch FAILS here
   * instead of returning a non-restorable success.
   */
  private persistDurableOrFail(record: DurableLease): void {
    try {
      mkdirSync(leaseDir(), { recursive: true });
      writeFileSync(leasePath(record.id), JSON.stringify(record, null, 2));
    } catch (error) {
      throw new Error(`lease-durabiliteit faalde voor ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistDurable(record: DurableLease): void {
    try {
      mkdirSync(leaseDir(), { recursive: true });
      writeFileSync(leasePath(record.id), JSON.stringify(record, null, 2));
    } catch (error) {
      this.log(`[mac-bridge] lease persist failed for ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Renew a live lease through the trusted central lifecycle (item 14): the
   * SAME token keeps working, expiry extends, the durable record updates —
   * session/role/namespaces untouched. An expired or revoked lease CANNOT be
   * renewed by this (or any remote) path: renewal requires the lease to be
   * currently active in the registry.
   */
  renewLease(sessionId: string, opts: { ttlMs?: number } = {}): { ok: true; expiresAt: number } | { ok: false; error: string } {
    const id = `mac-${sessionId}`;
    const current = this.registry.lookup(id, this.now());
    if (!current) {
      return { ok: false, error: "lease is verlopen of ingetrokken; verlengen is niet mogelijk (opnieuw aanmaken via de launcher)" };
    }
    const expiresAt = this.now() + (opts.ttlMs ?? DEFAULT_MAC_LEASE_TTL_MS);
    // Re-register under the SAME token: seedFromHash with the known hash.
    this.registry.seedFromHash({
      id: current.id,
      tokenHash: current.tokenHash,
      expiresAt,
      cwd: current.cwd,
      roots: current.roots,
      instructions: current.instructions,
      skillRoots: current.skillRoots,
      memoryRoots: current.memoryRoots,
      role: current.role,
      namespaces: current.namespaces,
      trustedHttpsHosts: current.trustedHttpsHosts ?? [],
    });
    try {
      const record: DurableLease = JSON.parse(readFileSync(leasePath(id), "utf8")) as DurableLease;
      record.expiresAt = expiresAt;
      this.persistDurable(record);
    } catch {
      // The in-memory registry is authoritative for auth; a failed durable
      // update is logged but must not invalidate a working session.
      this.log(`[mac-bridge] renew: duurzame update faalde voor ${id} (in-memory verlengd)`);
    }
    return { ok: true, expiresAt };
  }

  /**
   * Renewal sweep for ordinary long-lived chats: extends every ACTIVE lease
   * whose remaining TTL dropped below half, so a session that simply stays
   * open keeps working the next day. Served by serve on a timer; also called
   * directly after bridge mounts.
   */
  renewDueLeases(): number {
    let renewed = 0;
    const now = this.now();
    for (const lease of this.registry.active(this.now())) {
      const remaining = lease.expiresAt - now;
      const total = DEFAULT_MAC_LEASE_TTL_MS;
      if (remaining > total / 2) continue;
      const result = this.renewLease(lease.id.replace(/^mac-/, ""), {});
      if (result.ok) renewed++;
    }
    void now;
    return renewed;
  }

  startRenewalSweep(intervalMs = 30 * 60_000): void {
    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => {
      try {
        const renewed = this.renewDueLeases();
        if (renewed) this.log(`[mac-bridge] ${renewed} lease(s) verlengd`);
      } catch (error) {
        this.log(`[mac-bridge] renew-sweep fout: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, intervalMs);
    (this.renewTimer as { unref?: () => void }).unref?.();
  }

  stopRenewalSweep(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  revoke(sessionId: string): void {
    const id = `mac-${sessionId}`;
    this.registry.revoke(id);
    const prefix = `${id}|`;
    const keys = Object.keys(this.stdioSpecs).filter((k) => k.startsWith(prefix));
    for (const key of keys) delete this.stdioSpecs[key];
    void this.bridge.closeStdio(keys);
    try {
      rmSync(leasePath(id), { force: true });
    } catch {}
  }

  /**
   * Re-register unexpired durable leases after a serve restart: the token
   * HASH is restored verbatim (the plaintext lives only in the running
   * harness), and every namespace entry is RE-RESOLVED from the live central
   * configs — fresh auth, no stale serialized secrets. Expired records are
   * removed; the lease-scoped stdio specs are rebuilt.
   */
  reloadDurableLeases(): number {
    let restored = 0;
    let files: string[] = [];
    try {
      files = readdirSync(leaseDir());
    } catch {
      return 0;
    }
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(leaseDir(), name), "utf8")) as DurableLease;
        if (!record?.id || typeof record.tokenHash !== "string" || record.tokenHash.length !== 64) continue;
        if (record.expiresAt <= this.now()) {
          rmSync(join(leaseDir(), name), { force: true });
          continue;
        }
        const namespaceMap = this.buildNamespaces(record.provider, record.sessionId, record.id);
        this.registry.seedFromHash({
          id: record.id,
          tokenHash: record.tokenHash,
          expiresAt: record.expiresAt,
          cwd: record.cwd,
          roots: record.roots,
          instructions: record.instructions,
          skillRoots: record.skillRoots,
          memoryRoots: record.memoryRoots,
          role: "mac-chat",
          namespaces: namespaceMap.targets,
          trustedHttpsHosts: record.trustedHttpsHosts,
        });
        for (const [key, spec] of Object.entries(namespaceMap.stdioSpecs)) {
          this.stdioSpecs[key] = spec;
        }
        restored++;
      } catch {
        // unreadable record: skip; auth fails closed for that session.
      }
    }
    return restored;
  }

  publicUrl(): string {
    return this.options.publicUrl;
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton (serve mounts it; launchers read it)
// ---------------------------------------------------------------------------

let mountedHost: MacBridgeHost | null = null;

/** Mount (or replace) the process-wide bridge host. Called by serve boot. */
/** Default lease TTL (a long-lived chat must survive the night without the
 * user recreating anything — renewal extends it; see renewLease). */
export const DEFAULT_MAC_LEASE_TTL_MS = 8 * 60 * 60_000;

export function setMacBridgeHost(host: MacBridgeHost | null): void {
  mountedHost = host;
}

/** The mounted bridge host, or null when the admin config pins no bridge. */
export function macBridgeHost(): MacBridgeHost | null {
  return mountedHost;
}
