// Issue 521 — every newly launched managed PARENT harness runs contained.
//
// Containment used to be subagent-only: parents spawned as loose children of
// omg.service, whose KillMode=process deliberately lets them survive a serve
// restart — so helper daemons (agent-browser/Chromium) survived it too, for
// ever, piling up outside any reaping owner. The fix is the same transient
// lfg-agent-<name>.service the subagent path already uses: KillMode=
// control-group reaps the whole group when the harness exits, and browser
// profile/login state survives because agent-browser stores it on disk under
// the session-named profile, not in the process.
//
// Tested end-to-end at the public launch boundary: spawnManagedAisdkSession
// plus upstream's LFG_TEST_HARNESS_CAPTURE seam, which records the exact
// command serve would spawn.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnManagedAisdkSession } from "./tmux.ts";

const isLinux = process.platform === "linux";

describe("managed parent harness containment (issue 521)", () => {
  let root: string;
  let capture: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-parent-contain-"));
    capture = join(root, "launch.json");
    process.env.LFG_TEST_HARNESS_CAPTURE = capture;
  });

  afterEach(() => {
    delete process.env.LFG_TEST_HARNESS_CAPTURE;
    rmSync(root, { recursive: true, force: true });
  });

  test("a parent harness spawns inside its own lfg-agent service by default", () => {
    const result = spawnManagedAisdkSession({
      name: "lfg-parentx",
      cwd: root,
      model: "opus",
      sessionId: "sess-contain",
      omgSessionId: "sess-contain",
      // NOTE: no containInAgentSlice — the default must contain.
    });
    expect(result.ok).toBe(true);
    const launch = JSON.parse(readFileSync(capture, "utf8")) as {
      cmd: string[];
      env: Record<string, string | undefined>;
    };
    if (!isLinux) return; // containment is a Linux-only property
    expect(launch.cmd[0]).toContain("systemd-run");
    expect(launch.cmd).toContain("--unit=lfg-agent-lfg-parentx");
    expect(launch.cmd).toContain("--slice=lfg-agents.slice");
    expect(launch.cmd).toContain("--property=KillMode=control-group");
    expect(launch.cmd).toContain("--setenv=LFG_SESSION_ID=sess-contain");
    // Browser profile/login state: named, disk-backed session profile with an
    // idle timeout — identical to the subagent contract.
    expect(launch.cmd).toContain("--setenv=AGENT_BROWSER_SESSION=lfg-parentx");
    expect(launch.env.AGENT_BROWSER_SESSION).toBe("lfg-parentx");
    expect(launch.cmd.indexOf("--")).toBeGreaterThan(0);
  });

  test("containInAgentSlice: false remains an explicit opt-out", () => {
    const result = spawnManagedAisdkSession({
      name: "lfg-parenty",
      cwd: root,
      model: "opus",
      sessionId: "sess-plain",
      containInAgentSlice: false,
    });
    expect(result.ok).toBe(true);
    const launch = JSON.parse(readFileSync(capture, "utf8")) as { cmd: string[] };
    expect(launch.cmd[0]).not.toContain("systemd-run");
    // The browser session env is universal — parents keep it either way.
    expect(launch.cmd).toContain("--session");
  });
});
