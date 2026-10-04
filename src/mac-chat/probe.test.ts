// Item 30: the serve registration must use the production pipe adapter
// (macSshSpawn) — never a bare Bun.spawn cast with `as never` (Bun's default
// stdin "ignore" would silently drop the probe JSON). The spawn adapter is
// DEPENDENCY-INJECTED: serve passes macSshSpawn explicitly; this suite drives
// the same production adapter with a fixture executable pinned as argv[0]
// (deterministic — no PATH mutation, no ssh, no DNS). Failing answers
// (garbage) fail closed.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { macSshSpawn, type SpawnedSshChild } from "./stream.ts";
import { serveSshProbeOverride, type MacSshPreflightDetail } from "./probe.ts";
import { isProbeReport, type MacChatConfig } from "../execution-host.ts";

const ONESHOT_FIXTURE = join(import.meta.dir, "../../test/mac-chat/fixtures/oneshot-behaviors.ts");

/** The production pipe adapter carrying a fixture binary + mode as argv[0..1]. */
function fixtureAdapter(script: string, mode: string): (argv: readonly string[]) => SpawnedSshChild {
  return (argv) => macSshSpawn([process.execPath, script, mode, ...argv.slice(1)]);
}

const config: MacChatConfig = {
  enabled: true,
  adapter: "/nonexistent",
  machineIdentity: "fixture-probe-identity",
  buildManifestSha256: "ab".repeat(32),
  osVersion: "99",
  toolManifestSha256: "cd".repeat(32),
  ssh: { target: "fixture-target" },
};

describe("serveSshProbeOverride (production adapter, item 30)", () => {
  test("answers the frozen report through real pipes and surfaces preflight reachability", async () => {
    const preflight: MacSshPreflightDetail[] = [];
    const probe = serveSshProbeOverride(fixtureAdapter(ONESHOT_FIXTURE, "probereport"), (d) => preflight.push(d));
    const outcome = await probe(config);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isProbeReport(outcome.report)).toBe(true);
    expect(preflight).toHaveLength(1);
    expect(preflight[0]!.reachable).toBe(true);
  }, 20_000);

  test("garbage answer fails closed (never invented parity)", async () => {
    const garbageFixture = join(import.meta.dir, "../../test/mac-chat/fixtures/garbage-answer.ts");
    const preflight: MacSshPreflightDetail[] = [];
    const probe = serveSshProbeOverride(fixtureAdapter(garbageFixture, "garbage"), (d) => preflight.push(d));
    const outcome = await probe(config);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(preflight[0]?.reachable).toBe(false);
  }, 20_000);

  test("config without an ssh pin refuses explicitly (not applicable, not unreachable)", async () => {
    const probe = serveSshProbeOverride(fixtureAdapter(ONESHOT_FIXTURE, "probereport"));
    const noTarget = { ...config, ssh: {} } as MacChatConfig;
    const outcome = await probe(noTarget);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("ssh-target");
  }, 20_000);
});
