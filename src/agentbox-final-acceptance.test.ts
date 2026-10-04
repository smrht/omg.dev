import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnManagedAisdkSession, containedAgentCommand } from "./tmux.ts";
import { workerCommand, boundedText } from "./omg-isolation-runtime.ts";

describe("independent isolation layer", () => {
  test("managed parent and explicit old opt-out both remain bounded on Linux", () => {
    const root = mkdtempSync(join(tmpdir(), "omg-isolation-test-"));
    const capture = join(root, "capture.json");
    process.env.LFG_TEST_HARNESS_CAPTURE = capture;
    process.env.ISOLATION_TEST_SECRET = "dummy-do-not-copy-to-argv";
    try {
      for (const flag of [undefined, false, true]) {
        const result = spawnManagedAisdkSession({ name: "isolation-test", cwd: root, model: "opus",
          sessionId: "isolation-test", containInAgentSlice: flag });
        expect(result.ok).toBe(true);
        const { cmd } = JSON.parse(readFileSync(capture, "utf8"));
        expect(cmd[0]).toContain("systemd-run");
        expect(cmd).toContain("--slice=lfg-agents.slice");
        expect(cmd).toContain("--property=MemoryMax=8G");
        expect(cmd).toContain("--property=KillMode=control-group");
        expect(cmd).toContain("--setenv=ISOLATION_TEST_SECRET");
        expect(cmd.join(" ")).not.toContain("dummy-do-not-copy-to-argv");
      }
    } finally {
      delete process.env.LFG_TEST_HARNESS_CAPTURE;
      delete process.env.ISOLATION_TEST_SECRET;
      rmSync(root, { recursive: true });
    }
  });
  test("background command is piped, bounded and scoped", () => {
    const cmd = workerCommand(["/bin/true"], "omg-auto-test", "/tmp");
    expect(cmd).toContain("--pipe");
    expect(cmd).toContain("--property=KillMode=control-group");
    expect(cmd).toContain("--property=MemoryMax=4G");
    expect(cmd.some(s => s.includes("omg-worker-no-session-bus"))).toBe(true);
    const temp = cmd.find(s => s.startsWith("--setenv=TMPDIR="))?.split("=").slice(2).join("=");
    expect(temp).toBeTruthy();
    expect(statfsSync(temp!).type).not.toBe(0x01021994); // actual filesystem, not a hostname-specific path
    expect(() => workerCommand(["/bin/true"], "bad/name", "/tmp")).toThrow();
  });
  test("worker output cannot grow unbounded in the UI", async () => {
    const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
    expect(await boundedText(stream("hello"), 5)).toBe("hello");
    await expect(boundedText(stream("too long"), 5)).rejects.toThrow("safety limit");
  });
});
