// Item 19 regression: NO credential VALUE may ride the systemd-run argv.
// A distinctive sentinel env var is injected; the contained command's argv
// must carry the NAME (name-only --setenv import) but never the VALUE, while
// the child env (assembled by spawnManagedHarness) still carries both. This
// is the exact leak pattern the primary verified live on the box (19a).
//
// Item 31 additions: the NEW LFG_MAC_* keys (bridge lease token etc.) exist
// only in the merged child env — they must still be forwarded (name-only)
// through systemd-run, on BOTH the contained-harness path and the legacy
// tmux caller, without regressing the browser/tmp derived env forwarding.
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { containedAgentArgv, spawnManagedAisdkSession } from "./tmux.ts";

describe("containedAgentCommand argv hygiene (item 19)", () => {
  const SENTINEL_NAME = "MAC_CHAT_SETENV_SENTINEL";
  const SENTINEL_VALUE = "SENTINEL-SECRET-VALUE-9f1c-not-in-argv";

  test("secret-capable env values never appear in the systemd-run argv", () => {
    process.env[SENTINEL_NAME] = SENTINEL_VALUE;
    process.env.EXECUTOR_MCP_TOKEN = "executor-tok-sentinel-do-not-print";
    process.env.OMG_MUSE_PROXY = "muse-proxy-sentinel-do-not-print";
    try {
      const argv = containedAgentArgv(
        ["bun", "src/agents/backends/aisdk-session.ts", "--session", crypto.randomUUID()],
        { name: "lfg-sentinel", cwd: "/tmp", omgSessionId: crypto.randomUUID(), omgUser: "u@example.com" },
        { pty: false },
      );
      const joined = argv.join(" ");
      // Values MUST NOT be in the argv...
      expect(joined).not.toContain(SENTINEL_VALUE);
      expect(joined).not.toContain("executor-tok-sentinel");
      expect(joined).not.toContain("muse-proxy-sentinel");
      // ...but the NAMES are forwarded so systemd-run imports them from the
      // caller env (which the spawn assembles with the real values).
      expect(joined).toContain(`--setenv=${SENTINEL_NAME}`);
      expect(joined).toContain("--setenv=EXECUTOR_MCP_TOKEN");
      expect(joined).toContain("--setenv=OMG_MUSE_PROXY");
      // No value-bearing setenv for the browser/tmp derived vars either.
      const setenvTokens = argv.filter((a) => a.startsWith("--setenv="));
      for (const token of setenvTokens) {
        const body = token.slice("--setenv=".length);
        if (!body.includes("=")) continue; // name-only import: fine
        // Inline forms are only allowed for the fixed non-secret launcher
        // facts (DBUS path, PATH, session id, capability version, user tag).
        expect(body.startsWith("DBUS_SESSION_BUS_ADDRESS=")
          || body.startsWith("PATH=")
          || body.startsWith("LFG_SESSION_ID=")
          || body.startsWith("OMG_CAPABILITY_VERSION=")
          || body.startsWith("LFG_USER=")).toBe(true);
      }
    } finally {
      delete process.env[SENTINEL_NAME];
      delete process.env.EXECUTOR_MCP_TOKEN;
      delete process.env.OMG_MUSE_PROXY;
    }
  });

  test("item 31: LFG_MAC_* child-env keys forward NAME-ONLY (absent from parent env, present in child env)", () => {
    const MAC_TOKEN = "mac-bridge-lease-sentinel-8c2f-not-in-argv";
    const argv = containedAgentArgv(
      ["bun", "src/agents/backends/aisdk-session.ts", "--session", crypto.randomUUID()],
      {
        name: "lfg-mac-sentinel",
        cwd: "/tmp",
        omgSessionId: crypto.randomUUID(),
        extraEnv: {
          LFG_MAC_BRIDGE_URL: "https://bridge.example.internal/",
          LFG_MAC_BRIDGE_TOKEN: MAC_TOKEN,
          LFG_MAC_SSH_TARGET: "mac-main",
          LFG_MAC_NAMESPACES: "omg,workspace,computer",
          LFG_MAC_REQUEST_ID: crypto.randomUUID(),
        },
      },
      { pty: false },
    );
    const joined = argv.join(" ");
    // The lease token NEVER rides the world-readable systemd-run argv...
    expect(joined).not.toContain(MAC_TOKEN);
    // ...but every LFG_MAC_* key is forwarded name-only so systemd-run
    // imports the values from the spawn env (which spawnManagedHarness
    // assembles — the keys do not exist in process.env at all).
    expect(joined).toContain("--setenv=LFG_MAC_BRIDGE_URL");
    expect(joined).toContain("--setenv=LFG_MAC_BRIDGE_TOKEN");
    expect(joined).toContain("--setenv=LFG_MAC_SSH_TARGET");
    expect(joined).toContain("--setenv=LFG_MAC_NAMESPACES");
    expect(joined).toContain("--setenv=LFG_MAC_REQUEST_ID");
    expect(joined).not.toContain(`--setenv=LFG_MAC_BRIDGE_TOKEN=${MAC_TOKEN}`);
    expect(process.env.LFG_MAC_BRIDGE_TOKEN).toBeUndefined();
    // Legacy caller WITHOUT extraEnv: no LFG_MAC_* setenv appears (nothing
    // to import), and the browser/tmp derived forwarding stays name-only.
    const legacy = containedAgentArgv(["claude", "--version"], { name: "lfg-legacy", cwd: "/tmp" }, { pty: false });
    expect(legacy.some((a) => a.startsWith("--setenv=LFG_MAC_"))).toBe(false);
    expect(legacy).toContain("--setenv=AGENT_BROWSER_SESSION");
    expect(legacy).toContain("--setenv=AGENT_BROWSER_IDLE_TIMEOUT_MS");
  });

  test("item 31 harness path: spawnManagedAisdkSession carries the token in the CHILD env only", () => {
    const MAC_TOKEN = "mac-bridge-lease-sentinel-harness-55d1";
    const BUILD_TMP = process.env.MAC_CHAT_BUILD_TMP ?? "/Users/samht/.cache/mac-headchat-build-20261003/tmp-tests";
    const capturePath = join(BUILD_TMP, `harness-capture-${crypto.randomUUID()}.json`);
    const prev = process.env.LFG_TEST_HARNESS_CAPTURE;
    process.env.LFG_TEST_HARNESS_CAPTURE = capturePath;
    try {
      const spawned = spawnManagedAisdkSession({
        name: "lfg-mac-e2e",
        cwd: "/tmp",
        prompt: "hi",
        model: "opus",
        sessionId: crypto.randomUUID(),
        omgSessionId: crypto.randomUUID(),
        containInAgentSlice: true,
        extraEnv: { LFG_MAC_BRIDGE_TOKEN: MAC_TOKEN, LFG_MAC_NAMESPACES: "omg,workspace" },
      });
      expect(spawned.ok).toBe(true);
      const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
        cmd: string[];
        env: Record<string, string | undefined>;
      };
      // Child env HAS the token...
      expect(captured.env.LFG_MAC_BRIDGE_TOKEN).toBe(MAC_TOKEN);
      expect(captured.env.LFG_MAC_NAMESPACES).toBe("omg,workspace");
      // ...and on Linux the systemd-run argv forwards it NAME-ONLY; on other
      // dev platforms the command runs uncontained, so only the env contract
      // is asserted here (the argv rule is covered by containedAgentArgv).
      if (process.platform === "linux") {
        expect(captured.cmd).toContain("--setenv=LFG_MAC_BRIDGE_TOKEN");
        expect(captured.cmd.join(" ")).not.toContain(MAC_TOKEN);
      }
    } finally {
      if (prev === undefined) delete process.env.LFG_TEST_HARNESS_CAPTURE;
      else process.env.LFG_TEST_HARNESS_CAPTURE = prev;
      rmSync(capturePath, { force: true });
    }
  });
});
