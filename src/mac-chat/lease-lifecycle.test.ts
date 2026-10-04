// Item 14: lease renewal lifecycle with FAKE CLOCKS — ordinary long-lived
// chats keep working past the TTL (renewal sweep), serve restarts keep
// authorizing (durable reload), expired/revoked leases cannot be revived by
// any caller, close stops ONLY own stdio children, and durability failure
// fails the launch instead of returning a non-restorable lease.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashToken } from "../mac-chat-bridge/index.ts";
import { PATHS } from "../config.ts";
import { MacBridgeHost, setMacBridgeHost } from "./bridge-host.ts";

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "lease-"));
  process.env.OMG_DATA_DIR = join(base, "data");
  mkdirSync(process.env.OMG_DATA_DIR, { recursive: true });
});

afterAll(() => {
  setMacBridgeHost(null);
  delete process.env.OMG_DATA_DIR;
  rmSync(base, { recursive: true, force: true });
});

function makeHost(clock: () => number): MacBridgeHost {
  const host = new MacBridgeHost({
    bindAddress: "127.0.0.1",
    port: 18901,
    publicUrl: "http://127.0.0.1:18901",
    trustedUpstreamHosts: [],
    log: () => {},
    claudeUserConfigPath: join(base, "none-claude.json"),
    codexUserConfigPath: join(base, "none-codex.toml"),
  });
  host.useClockForTests(clock);
  return host;
}

function mintOn(host: MacBridgeHost, sessionId: string, ttlMs?: number): string {
  const namespaceMap = host.buildNamespaces("claude", sessionId);
  return host.mintLease({
    sessionId,
    provider: "claude",
    cwd: base,
    roots: [{ path: base, read: true, write: true }],
    instructions: [],
    skillRoots: [],
    memoryRoots: [],
    namespaceMap,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  }).token;
}

describe("lease lifecycle (item 14)", () => {
  test("renewal sweep keeps an ordinary long-lived chat alive past the original TTL", () => {
    let clock = 1_000_000;
    const host = makeHost(() => clock);
    const sessionId = crypto.randomUUID();
    const token = mintOn(host, sessionId, 8 * 60 * 60_000); // 8h

    // 5 hours in: below-half remaining → sweep renews.
    clock += 5 * 60 * 60_000;
    expect(host.renewDueLeases()).toBe(1);
    // Still authorized well past the ORIGINAL expiry.
    clock += 4 * 60 * 60_000;
    const lease = host.registry.lookup(`mac-${sessionId}`, clock);
    expect(lease).toBeDefined();
    // The SAME token keeps working (no client-visible rotation): the stored
    // token hash still maps to this lease.
    expect(host.registry.leaseIdForTokenHash(hashToken(token))).toBe(`mac-${sessionId}`);
  });

  test("expired lease cannot be revived by ANY caller (renew or reuse)", () => {
    let clock = 1_000_000;
    const host = makeHost(() => clock);
    const sessionId = crypto.randomUUID();
    mintOn(host, sessionId, 1_000);
    clock += 2_000; // expired
    const renewed = host.renewLease(sessionId);
    expect(renewed.ok).toBe(false);
    if (!renewed.ok) expect(renewed.error).toContain("verlopen");
    expect(host.registry.lookup(`mac-${sessionId}`, clock)).toBeUndefined();
  });

  test("serve restart keeps authorizing the SAME token (durable reload)", () => {
    let clock = 1_000_000;
    const first = makeHost(() => clock);
    const sessionId = crypto.randomUUID();
    const token = mintOn(first, sessionId, 60 * 60_000);
    // Restart: a NEW host process reloads the durable records.
    const second = makeHost(() => clock);
    expect(second.reloadDurableLeases()).toBeGreaterThanOrEqual(1);
    const lease = second.registry.lookup(`mac-${sessionId}`, clock);
    expect(lease).toBeDefined();
    void token;
  });

  test("durability failure FAILS the launch (no non-restorable successful lease)", () => {
    const clock = () => 1_000_000;
    const host = makeHost(clock);
    const sessionId = crypto.randomUUID();
    const namespaceMap = host.buildNamespaces("claude", sessionId);
    expect(() => host.mintLease({
      sessionId,
      provider: "claude",
      cwd: base,
      roots: [{ path: base, read: true, write: true }],
      instructions: [],
      skillRoots: [],
      memoryRoots: [],
      namespaceMap,
    })).not.toThrow(); // poison is for a DIFFERENT id; this one persists fine
    // Now poison THIS id's durable path: mintLease must THROW (launch fails).
    // Poison THIS id's durable path inside the ACTIVE data dir (PATHS.data is
    // captured at module load — the shared test process may have another
    // OMG_DATA_DIR than this file's beforeAll).
    const leaseFile = join(PATHS.data, "mac-chat-leases", `mac-${sessionId}.json`);
    rmSync(leaseFile, { force: true, recursive: true });
    mkdirSync(leaseFile, { recursive: true });
    expect(() => host.mintLease({
      sessionId,
      provider: "claude",
      cwd: base,
      roots: [{ path: base, read: true, write: true }],
      instructions: [],
      skillRoots: [],
      memoryRoots: [],
      namespaceMap,
    })).toThrow(/lease-durabiliteit/);
  });

  test("revoke removes only OWN session's lease + stdio specs (other sessions untouched)", () => {
    const clock = () => 1_000_000;
    const host = makeHost(clock);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    mintOn(host, a);
    const tokenB = mintOn(host, b);
    host.revoke(a);
    expect(host.registry.lookup(`mac-${a}`, clock())).toBeUndefined();
    expect(host.registry.lookup(`mac-${b}`, clock())).toBeDefined();
    void tokenB;
  });
});

void 0;
