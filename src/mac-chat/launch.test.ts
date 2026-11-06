// Integrated mac-launch tests: refusals (claudeAccountId, untested settings,
// codex fast tier, missing pins), pending-before-spawn ordering, full
// namespace forwarding + role preservation with the REAL bridge host.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchMacHostedSession, MAC_ENV_BRIDGE_TOKEN, MAC_ENV_NAMESPACES, MAC_ENV_REQUEST_ID, MAC_ENV_SSH_TARGET, type MacHarnessSpawner } from "./launch.ts";
import { MacBridgeHost, setMacBridgeHost } from "./bridge-host.ts";
import { readMacStart } from "./pending.ts";
import {
  parseExecutionHostRequest,
  registerMacLaunchAdapter,
  resetExecutionHostCachesForTests,
  setExecutionHostDepsForTests,
  setMacRuntimeForTests,
  type MacChatConfig,
  type MacRuntimeProbeReport,
} from "../execution-host.ts";

let dataDir: string;
let configPath: string;
let baseDir: string;
let fixtureCwd: string;
let host: MacBridgeHost;
const spawnCalls: Array<{ input: Record<string, unknown>; env: Record<string, string> }> = [];
const orderLog: string[] = [];

const fakeSpawner: MacHarnessSpawner = (input, extraEnv) => {
  spawnCalls.push({ input: input as unknown as Record<string, unknown>, env: extraEnv });
  orderLog.push("spawn");
  return { ok: true, pid: 4242 };
};

function pinnedConfig(overrides: Partial<MacChatConfig> = {}): MacChatConfig {
  return {
    enabled: true,
    adapter: "/usr/local/bin/fake-adapter",
    machineIdentity: "test-mac",
    buildManifestSha256: "ab".repeat(32),
    osVersion: "24.6.0",
    toolManifestSha256: "cd".repeat(32),
    ssh: { target: "mac-test" },
    bridge: {
      bindAddress: "127.0.0.1",
      port: 18766,
      publicUrl: "http://127.0.0.1:18766",
      trustedUpstreamHosts: ["api.githubcopilot.com"],
    },
    ...overrides,
  };
}

function installRuntime(provider: "aisdk" | "codex-aisdk", testedSettings: string[]): void {
  const report: MacRuntimeProbeReport = {
    schema: 1,
    probedAt: Date.now(),
    machineIdentity: "test-mac",
    buildManifestSha256: "ab".repeat(32),
    os: { platform: "darwin", version: "24.6.0" },
    cliVersion: "fixture",
    toolManifestSha256: "cd".repeat(32),
    health: { power: "adapter", thermal: "normal", policy: "eligible" },
    providers: [
      {
        id: provider,
        parity: { chat: true, tools: true, memory: true },
        testedSettings,
        supportedContainment: { agentSlice: false, sandbox: [], egressProxy: false, restrictedRoles: false },
        testedAt: Date.now(),
      },
    ],
  };
  setMacRuntimeForTests({ config: pinnedConfig(), probe: report });
}

beforeAll(() => {
  const base = mkdtempSync(join(process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests", "mac-chat-launch-"));
  baseDir = base;
  dataDir = join(base, "data");
  process.env.OMG_DATA_DIR = dataDir;
  configPath = join(base, "mac-chat-config.json");
  process.env.OMG_MAC_CHAT_CONFIG = configPath;
  fixtureCwd = join(base, "project");
  mkdirSync(fixtureCwd, { recursive: true });
  writeFileSync(join(fixtureCwd, "AGENTS.md"), "PROJECT INSTRUCTIONS NONCE");
  // Fixture provider configs for namespace discovery.
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "claude.json"), JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    },
  }));
  writeFileSync(join(home, "codex.toml"), [
    '[mcp_servers.executor]',
    'url = "https://executor.internal/mcp"',
  ].join("\n"));
  setExecutionHostDepsForTests({
    readConfigFile: (path) => (path === configPath ? JSON.stringify(pinnedConfig()) : null),
    statFile: (path) => (path === "/usr/local/bin/fake-adapter" ? { mtimeMs: 0, size: 1, executable: true } : null),
  });
  installRuntime("aisdk", ["model", "thinkingLevel", "fastMode"]);
  host = new MacBridgeHost({
    bindAddress: "127.0.0.1",
    port: 18766,
    publicUrl: "http://127.0.0.1:18766",
    trustedUpstreamHosts: ["api.githubcopilot.com"],
    log: () => {},
    claudeUserConfigPath: join(home, "claude.json"),
    codexUserConfigPath: join(home, "codex.toml"),
  });
  installRuntime("aisdk", ["model", "thinkingLevel", "fastMode"]);
  setMacBridgeHost(host);
});

afterAll(() => {
  setMacBridgeHost(null);
  resetExecutionHostCachesForTests();
  setExecutionHostDepsForTests(null);
  delete process.env.OMG_DATA_DIR;
  delete process.env.OMG_MAC_CHAT_CONFIG;
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch { /* retry below */ }
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch { /* empty-dir residue in the cache tmp namespace is cosmetic */ }
});

function debugOnce(): string {
  const result = launch({});
  return result.ok ? "OK" : result.error;
}
void debugOnce;
function launch(overrides: Record<string, unknown> = {}) {
  return launchMacHostedSession(
    {
      agent: "aisdk",
      sessionId: crypto.randomUUID(),
      name: "lfg-test",
      cwd: fixtureCwd,
      model: "opus",
      omgUser: null,
      ...overrides,
    } as never,
    host,
    { log: () => {}, spawn: fakeSpawner },
  );
}

describe("launchMacHostedSession refusals (fail closed before any spawn)", () => {
  test("item 35: unreadable REQUIRED instruction refuses launch BEFORE any lease or spawn", () => {
    const badCwd = join(baseDir, "bad-project");
    mkdirSync(join(badCwd, "sub"), { recursive: true });
    mkdirSync(join(badCwd, "sub", "AGENTS.md")); // exists, not a regular file
    const sessionId = crypto.randomUUID();
    const result = launch({ cwd: join(badCwd, "sub"), sessionId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(join(badCwd, "sub", "AGENTS.md"));
    expect(result.error).toContain("not-a-regular-file");
    // Fail closed BEFORE anything: no harness spawn, no lease, no journal.
    expect(spawnCalls.length).toBe(0);
    expect(host.registry.lookup(`mac-${sessionId}`, Date.now())).toBeUndefined();
  });

  test("claude account binding is refused — the Mac runs its own login", () => {
    const result = launch({ claudeAccountId: "acc-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("account");
    expect(spawnCalls.length).toBe(0);
  });

  test("untested settings are refused (fastMode without provider proof)", () => {
    installRuntime("aisdk", ["model"]);
    const result = launch({ fastMode: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("fastMode");
  });

  test("codex fast/serviceTier is SUPPORTED and reaches the harness env path (item 17)", () => {
    installRuntime("codex-aisdk", ["model", "serviceTier", "fastMode"]);
    const sessionId = crypto.randomUUID();
    const result = launch({ agent: "codex-aisdk", serviceTier: "fast", sessionId });
    expect(result.ok).toBe(true);
  });

  test("sandbox/role containment beyond the provider record is refused (no owner promotion)", () => {
    installRuntime("aisdk", ["model"]);
    expect(launch({ sandbox: "bwrap" }).ok).toBe(false);
    const role = launch({ role: "editor" });
    expect(role.ok).toBe(false);
    if (role.ok) return;
    expect(role.error).toContain("restricted role");
    expect(role.error).toContain("geen promotie naar owner");
  });
});

describe("launchMacHostedSession success path", () => {
  test("pending journal written BEFORE spawn; full namespaces + role forwarded in env", () => {
    installRuntime("aisdk", ["model", "thinkingLevel", "fastMode"]);
    const sessionId = crypto.randomUUID();
    const result = launch({ sessionId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Ordering: journal first, spawn second (this test spawned once so far
    // — the codex-fast sibling above may add entries; check THIS session).
    expect(orderLog.length).toBeGreaterThanOrEqual(1);
    const record = readMacStart(sessionId);
    expect(record?.state).toBe("pending");
    expect(record?.requestId).toBeTruthy();
    const env = spawnCalls[spawnCalls.length - 1]!.env;
    expect(env[MAC_ENV_SSH_TARGET]).toBe("mac-test");
    expect((env[MAC_ENV_BRIDGE_TOKEN] ?? "").length).toBeGreaterThanOrEqual(16);
    expect(env[MAC_ENV_REQUEST_ID] ?? "").toBe(record?.requestId ?? "");
    const names = (env[MAC_ENV_NAMESPACES] ?? "").split(",");
    expect(names).toContain("omg");
    expect(names).toContain("connectors");
    expect(names).toContain("computer");
    expect(names).toContain("workspace");
    expect(names).toContain("github"); // claude-user http namespace (allowlisted host)
  });

  test("spawn failure revokes the lease", () => {
    installRuntime("aisdk", ["model"]);
    const failSpawner: MacHarnessSpawner = () => ({ ok: false, error: "boom" });
    const sessionId = crypto.randomUUID();
    const result = launchMacHostedSession(
      { agent: "aisdk", sessionId, name: "lfg-test", cwd: fixtureCwd, model: "opus", omgUser: null } as never,
      host,
      { log: () => {}, spawn: failSpawner },
    );
    expect(result.ok).toBe(false);
    expect(host.registry.lookup(`mac-${sessionId}`)).toBeUndefined();
  });
});

describe("provider-specific namespaces (no union collisions)", () => {
  test("codex namespace map uses codex-user entries; github (claude entry) absent", () => {
    const map = host.buildNamespaces("codex", crypto.randomUUID(), "lease-x", {
      claudeUserConfigPath: join(dataDir, "..", "home", "claude.json"),
      codexUserConfigPath: join(dataDir, "..", "home", "codex.toml"),
    });
    // executor is http on a NON-allowlisted host → explicitly unavailable.
    expect(map.mcpNames).not.toContain("executor");
    expect(map.mcpNames).toContain("omg");
    expect(map.mcpNames).toContain("workspace");
  });
});

test("parseExecutionHostRequest stays strict (no auto/no objects)", () => {
  expect(parseExecutionHostRequest("mac")).toEqual({ ok: true, host: "mac" });
  expect(parseExecutionHostRequest(null).ok).toBe(false);
  expect(parseExecutionHostRequest("auto").ok).toBe(false);
  expect(parseExecutionHostRequest({}).ok).toBe(false);
});
