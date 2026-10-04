// Focused tests for the manual execution-host contract (src/execution-host.ts)
// tranche 2: strict-null parsing, dynamic per-provider attestation (static
// hashes prove nothing), full settings/containment forwarding or explicit
// refusal, the request/acknowledgement launch interface (spawn is never
// success), the local remote-control budget, and unchanged local launches.
import { resetSettingsDbConnectionForTests } from "./settings.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { currentBootId, writeEntry } from "./aisdk-registry.ts";
import {
  addManaged,
  listManaged,
  removeManaged,
  resetManagedRegistryForTests,
  type ManagedSession,
} from "./managed.ts";
import { getSessionContainment, resetSessionContainmentForTests } from "./session-containment-record.ts";
import { launchCodingAgentSession } from "./coding-agent-provider.ts";
import { coldResumeExecutionHost, relaunchDeadCommandFileHarness } from "./session-recovery.ts";
import { managedLaunchRow } from "./sessions.ts";
import {
  admitMacRemoteControl,
  createSupervisedMacLaunchAdapter,
  evaluateMacRuntime,
  executionHostsResponse,
  guardExecutionHostLaunch,
  launchViaMacAdapter,
  MAC_PROBE_FRESHNESS_MS,
  MAC_REMOTE_CONTROL_BUDGET_DEFAULT,
  MAC_SETTING_KEYS,
  MAC_UNVERIFIED_REASON,
  macRemoteControlBudget,
  parseExecutionHostRequest,
  parseMacChatConfig,
  registerMacLaunchAdapter,
  resetExecutionHostCachesForTests,
  sanitizeAdapterText,
  setExecutionHostDepsForTests,
  setMacRuntimeForTests,
  type MacChatConfig,
  type MacLaunchAdapter,
  type MacLaunchRequest,
  type MacProbeProviderRecord,
  type MacRuntimeProbeReport,
} from "./execution-host.ts";

const KEY = "5d5404ad-79df-4e10-b8a5-0d2772fa9acc";
const NAME = "lfg-hosttest";
const DEAD_PID = 2147483646;

const ADAPTER = "/opt/agentbox-mac-chat";
const MACHINE = "macbook-m1-pro-16gb";
const BUILD_SHA = "d".repeat(64);
const TOOL_SHA = "c".repeat(64);
const OS_VERSION = "25.1.0";

function configJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    enabled: true,
    adapter: ADAPTER,
    machineIdentity: MACHINE,
    buildManifestSha256: BUILD_SHA,
    osVersion: OS_VERSION,
    toolManifestSha256: TOOL_SHA,
    ...overrides,
  });
}

function providerRecord(
  id: "aisdk" | "codex-aisdk",
  overrides: Partial<MacProbeProviderRecord> = {},
): MacProbeProviderRecord {
  return {
    id,
    parity: { chat: true, tools: true, memory: true },
    testedSettings: [...MAC_SETTING_KEYS],
    supportedContainment: { agentSlice: true, sandbox: ["bwrap"], egressProxy: true, restrictedRoles: true },
    testedAt: 1_000_000,
    ...overrides,
  };
}

function probeReport(overrides: Partial<MacRuntimeProbeReport> = {}, now = 1_000_000): MacRuntimeProbeReport {
  return {
    schema: 1,
    probedAt: now,
    machineIdentity: MACHINE,
    buildManifestSha256: BUILD_SHA,
    os: { platform: "darwin", version: OS_VERSION },
    cliVersion: "omg-remote-1.2.3",
    toolManifestSha256: TOOL_SHA,
    health: { power: "adapter", thermal: "normal", policy: "eligible" },
    providers: [providerRecord("aisdk"), providerRecord("codex-aisdk")],
    ...overrides,
  };
}

type DepsOverride = {
  configJson?: string | null;
  executable?: boolean;
  now?: number;
  probe?: MacRuntimeProbeReport | null;
  probeError?: string;
};

function installDeps(override: DepsOverride = {}) {
  const now = override.now ?? 1_000_000;
  setExecutionHostDepsForTests({
    now: () => now,
    env: { HOME: "/home/test", OMG_MAC_CHAT_CONFIG: "/opt/mac-chat-config.json" },
    readConfigFile: () =>
      override.configJson === undefined ? configJson() : override.configJson,
    statFile: (path) =>
      path === ADAPTER
        ? { mtimeMs: 1, size: 42, executable: override.executable ?? true }
        : null,
    probeRuntime: async () =>
      override.probe === null || override.probeError
        ? { ok: false, error: override.probeError ?? "adapter niet aanwezig" }
        : { ok: true, report: (override.probe ?? probeReport({}, now)) as MacRuntimeProbeReport },
  });
}

/** Install a runtime cache synchronously (test injection path). */
function installRuntime(probe: MacRuntimeProbeReport, adapter?: MacLaunchAdapter, config: MacChatConfig | null = null) {
  const parsed = parseMacChatConfig();
  if (!config && !parsed.ok) throw new Error("config must parse to install a runtime");
  setMacRuntimeForTests({
    config: config ?? (parsed as { ok: true; config: MacChatConfig }).config,
    probe,
    ...(adapter ? { adapter } : {}),
  });
}

function acknowledgedStub(
  requests: MacLaunchRequest[],
  answer: { jobId?: string; nativeSessionId?: string; pid?: number } = {},
): MacLaunchAdapter {
  return {
    id: "mac",
    binaryPath: ADAPTER,
    launch: (request) => {
      requests.push(request);
      return {
        status: "acknowledged",
        requestId: request.requestId,
        jobId: answer.jobId ?? "job-1",
        ...(answer.nativeSessionId ? { nativeSessionId: answer.nativeSessionId } : {}),
        ...(answer.pid !== undefined ? { pid: answer.pid } : {}),
      };
    },
  };
}

// The supervised spawn contract: argv stays [binary], the request travels on
// stdin as one JSON document. Recorded by the fake below.
type RecordedSpawn = { binaryPath: string; requestJson: string };

function recordingSpawn(log: RecordedSpawn[], response: () => Promise<string>) {
  return (binaryPath: string, requestJson: string) => {
    log.push({ binaryPath, requestJson });
    return {
      pid: 31337,
      writeStdin: () => {},
      endStdin: () => {},
      exited: response(),
      kill: () => {},
    };
  };
}

describe("execution-host", () => {
  const originalData = PATHS.data;
  let root: string;
  let capture: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-execution-host-"));
    capture = join(root, "launch.json");
    PATHS.data = join(root, "data");
    process.env.LFG_TEST_HARNESS_CAPTURE = capture;
    resetSettingsDbConnectionForTests();
    resetManagedRegistryForTests();
    resetSessionContainmentForTests();
    resetExecutionHostCachesForTests();
    installDeps();
  });

  afterEach(() => {
    delete process.env.LFG_TEST_HARNESS_CAPTURE;
    setExecutionHostDepsForTests(null);
    resetExecutionHostCachesForTests();
    resetSettingsDbConnectionForTests();
    resetManagedRegistryForTests();
    resetSessionContainmentForTests();
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  const localSpawnRan = () => existsSync(capture);

  function row(extra: Partial<ManagedSession>) {
    // createdAt 1 keeps the relaunch "owner row is newer" claim window out of
    // the way, exactly like the existing recovery suites do it.
    addManaged({
      tmuxName: NAME,
      cwd: root,
      createdAt: 1,
      agent: "aisdk",
      runtime: "command-file",
      sessionId: KEY,
      nativeSessionId: KEY,
      model: "claude-opus-5-5",
      launchState: "running",
      ...extra,
    });
  }

  // A fresh row inside the boot window, for list-row (API) assertions.
  function bootingRow(extra: Partial<ManagedSession> = {}) {
    addManaged({
      tmuxName: NAME,
      cwd: root,
      createdAt: Date.now(),
      agent: "aisdk",
      runtime: "command-file",
      sessionId: KEY,
      nativeSessionId: KEY,
      launchState: "launching",
      ...extra,
    });
  }

  function deadEntry() {
    writeEntry({
      sessionId: KEY,
      agent: "claude",
      harnessPid: DEAD_PID,
      tmuxName: NAME,
      supervisor: "process",
      bootId: currentBootId(),
      cwd: root,
      model: "claude-opus-5-5",
      busy: true,
      createdAt: 2,
    });
  }

  // ---- strict request parsing -------------------------------------------

  describe("parseExecutionHostRequest", () => {
    test("absent stays the legacy case; explicit null is a hard error", () => {
      expect(parseExecutionHostRequest(undefined)).toEqual({ ok: true, host: undefined });
      // JSON null is an EXPLICIT value on the wire, not the legacy absence.
      const parsed = parseExecutionHostRequest(null);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/invalid executionhost/i);
    });

    test("accepts exactly agentbox and mac", () => {
      expect(parseExecutionHostRequest("agentbox")).toEqual({ ok: true, host: "agentbox" });
      expect(parseExecutionHostRequest("mac")).toEqual({ ok: true, host: "mac" });
    });

    test("invalid values are a hard error, never a fallback or coercion", () => {
      for (const bad of ["auto", "Mac", "AGENTBOX", "", "agentbox ", "cloud", 42, {}, [], true, null]) {
        const parsed = parseExecutionHostRequest(bad);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toMatch(/executionhost/i);
      }
    });
  });

  // ---- read-only status contract ----------------------------------------

  describe("executionHostsResponse", () => {
    test("exactly two hosts, agentbox default, no auto host, consistent MacBook M1 label", () => {
      const response = executionHostsResponse({});
      expect(response.defaultHost).toBe("agentbox");
      expect(response.hosts.map((h) => h.id)).toEqual(["agentbox", "mac"]);
      expect(response.hosts.find((h) => h.id === "agentbox")?.available).toBe(true);
      expect(response.hosts.find((h) => h.id === "mac")?.label).toBe("MacBook M1");
      expect(response.hosts.some((h) => (h.id as string) === "auto")).toBe(false);
    });

    test("mac is disabled with the concrete parity reason (spelled correctly) while unverified", () => {
      installDeps({ configJson: null }); // no config at all
      const mac = executionHostsResponse({}).hosts.find((h) => h.id === "mac")!;
      expect(mac.available).toBe(false);
      expect(mac.reason).toContain("Mac-hoofdchat nog niet volledig geverifieerd");
      expect(mac.reason).not.toContain("volledijk");
    });

    test("no false readiness from a one-shot queue status or env booleans", () => {
      setExecutionHostDepsForTests({
        now: () => 1_000_000,
        env: {
          HOME: "/home/test",
          OMG_MAC_CHAT_CONFIG: join(root, "missing-config.json"),
          OMG_MAC_CHAT: "1",
          OMG_MAC_CHAT_QUEUE_STATUS: "eligible",
          AGENTBOX_MAC_STATUS: "eligible",
        },
        readConfigFile: () => null,
        statFile: () => null,
        probeRuntime: async () => ({ ok: false, error: "no adapter" }),
      });
      const mac = executionHostsResponse({}).hosts.find((h) => h.id === "mac")!;
      expect(mac.available).toBe(false);
      expect(mac.reason).toContain(MAC_UNVERIFIED_REASON);
    });

    test("non-mac-capable agents make mac explicitly unavailable", () => {
      installDeps({});
      const response = executionHostsResponse({ agent: "grok" });
      const mac = response.hosts.find((h) => h.id === "mac")!;
      expect(mac.available).toBe(false);
      expect(mac.reason).toContain("grok");
      expect(response.hosts.find((h) => h.id === "agentbox")?.available).toBe(true);
    });

    test("a fully pinned static config WITHOUT a live probe still leaves mac unavailable", () => {
      // Static hashes inside one config are self-reported, never live proof.
      installDeps({ probe: null });
      const mac = executionHostsResponse({ agent: "aisdk" }).hosts.find((h) => h.id === "mac")!;
      expect(mac.available).toBe(false);
      expect(mac.reason).toContain(MAC_UNVERIFIED_REASON);
      expect(mac.reason).toContain("geen actuele runtime-probe");
    });

    test("a fresh matching probe makes the proven providers available", () => {
      installRuntime(probeReport());
      const response = executionHostsResponse({ agent: "aisdk" });
      expect(response.hosts.find((h) => h.id === "mac")?.available).toBe(true);
    });
  });

  // ---- config pins (static parse only, never readiness) ------------------

  describe("parseMacChatConfig", () => {
    test("missing config fails closed", () => {
      installDeps({ configJson: null });
      const result = parseMacChatConfig();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(MAC_UNVERIFIED_REASON);
    });

    test("invalid JSON fails closed", () => {
      installDeps({ configJson: "{not json" });
      expect(parseMacChatConfig().ok).toBe(false);
    });

    test("disabled config fails closed", () => {
      installDeps({ configJson: configJson({ enabled: false }) });
      const result = parseMacChatConfig();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(MAC_UNVERIFIED_REASON);
    });

    test("relative adapter path, missing or non-executable binary fail closed", () => {
      installDeps({ configJson: configJson({ adapter: "bin/agentbox-mac-chat" }) });
      expect(parseMacChatConfig().ok).toBe(false);
      installDeps({ executable: false });
      expect(parseMacChatConfig().ok).toBe(false);
    });

    test("every pin is mandatory: machine identity, build manifest, os, tool manifest", () => {
      for (const pin of ["machineIdentity", "buildManifestSha256", "osVersion", "toolManifestSha256"]) {
        const json = JSON.parse(configJson()) as Record<string, unknown>;
        delete json[pin];
        installDeps({ configJson: JSON.stringify(json) });
        const result = parseMacChatConfig();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(pin === "machineIdentity" ? "machine-identiteit" : pin === "osVersion" ? "OS-versie" : pin === "buildManifestSha256" ? "build-manifest" : "tool-manifest");
      }
    });

    test("remoteControlBudget must be an integer within 1..10 when present", () => {
      installDeps({ configJson: configJson({ remoteControlBudget: 0 }) });
      expect(parseMacChatConfig().ok).toBe(false);
      installDeps({ configJson: configJson({ remoteControlBudget: 11 }) });
      expect(parseMacChatConfig().ok).toBe(false);
      installDeps({ configJson: configJson({ remoteControlBudget: 4 }) });
      const result = parseMacChatConfig();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.remoteControlBudget).toBe(4);
    });
  });

  // ---- dynamic runtime probe evaluation -----------------------------------

  describe("evaluateMacRuntime (probe binding)", () => {
    const now = 1_000_000;
    const pins = (): MacChatConfig => {
      const parsed = parseMacChatConfig();
      if (!parsed.ok) throw new Error("pins must parse");
      return parsed.config;
    };

    test("no probe is not verified, with the probe error sanitized", () => {
      installDeps({});
      const result = evaluateMacRuntime(pins(), null, "spawn faalde\nmet newlines", now);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(MAC_UNVERIFIED_REASON);
        expect(result.reason).toContain("runtime-probe faalde");
        expect(result.reason).not.toContain("\n");
      }
    });

    test("a probe timestamp far from now is rejected", () => {
      installDeps({});
      const result = evaluateMacRuntime(pins(), probeReport({}, now - MAC_PROBE_FRESHNESS_MS - 1), null, now);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("te ver van nu");
    });

    test("machine identity, build manifest, os version and tool manifest must match the pins", () => {
      installDeps({});
      const base = pins();
      for (const mismatch of [
        { probe: probeReport({ machineIdentity: "other-machine" }), needle: "machine-identiteit" },
        { probe: probeReport({ buildManifestSha256: "e".repeat(64) }), needle: "build-manifest" },
        { probe: probeReport({ os: { platform: "darwin", version: "24.0.0" } }), needle: "OS-versie" },
        { probe: probeReport({ toolManifestSha256: "f".repeat(64) }), needle: "tool-manifest" },
      ]) {
        const result = evaluateMacRuntime(base, mismatch.probe, null, now);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(mismatch.needle);
      }
    });

    test("the machine must be on power, thermally normal and policy-eligible", () => {
      installDeps({});
      const base = pins();
      for (const health of [
        { power: "battery" as const, thermal: "normal" as const, policy: "eligible" as const, needle: "netstroom" },
        { power: "adapter" as const, thermal: "hot" as const, policy: "eligible" as const, needle: "thermische" },
        { power: "adapter" as const, thermal: "normal" as const, policy: "ineligible" as const, needle: "eligible" },
      ]) {
        const result = evaluateMacRuntime(base, probeReport({ health }, now), null, now);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain(health.needle);
      }
    });

    test("records with incomplete parity are excluded per provider, not averaged", () => {
      installDeps({});
      const base = pins();
      const result = evaluateMacRuntime(
        base,
        probeReport({
          providers: [
            providerRecord("codex-aisdk"),
            providerRecord("aisdk", { parity: { chat: true, tools: true, memory: false } }),
          ],
        }, now),
        null,
        now,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.providers.has("codex-aisdk")).toBe(true);
        expect(result.providers.has("aisdk")).toBe(false);
      }
    });
  });

  // ---- registration requires config pins AND a passing probe -------------

  describe("registerMacLaunchAdapter", () => {
    test("an unprobed or unverified setup is refused: registration stays null", async () => {
      installDeps({ probe: null });
      expect(await registerMacLaunchAdapter()).toBeNull();
      installDeps({ configJson: null });
      expect(await registerMacLaunchAdapter()).toBeNull();
    });

    test("a probe that contradicts the pins is refused", async () => {
      installDeps({ probe: probeReport({ machineIdentity: "not-my-mac" }) });
      expect(await registerMacLaunchAdapter()).toBeNull();
    });

    test("a probe with no fully proven provider is refused", async () => {
      installDeps({
        probe: probeReport({
          providers: [providerRecord("aisdk", { parity: { chat: true, tools: false, memory: true } })],
        }),
      });
      expect(await registerMacLaunchAdapter()).toBeNull();
    });

    test("a matching fresh probe registers the supervised adapter", async () => {
      installDeps({});
      const adapter = await registerMacLaunchAdapter();
      expect(adapter).not.toBeNull();
      expect(adapter?.binaryPath).toBe(ADAPTER);
      // The registered runtime makes the proven providers available.
      expect(executionHostsResponse({ agent: "aisdk" }).hosts.find((h) => h.id === "mac")?.available).toBe(true);
    });

    test("registration is per-provider: only Codex proven leaves Claude unavailable", async () => {
      // The weekly Claude 429 state stays blocked: one proven provider never
      // vouches for the other.
      installDeps({
        probe: probeReport({
          providers: [providerRecord("codex-aisdk")],
        }),
      });
      const adapter = await registerMacLaunchAdapter();
      expect(adapter).not.toBeNull();
      const aisdk = guardExecutionHostLaunch({ agent: "aisdk", executionHost: "mac" });
      expect(aisdk.ok).toBe(false);
      if (!aisdk.ok) expect(aisdk.error).toContain("per-provider");
      const codex = guardExecutionHostLaunch({ agent: "codex-aisdk", executionHost: "mac" });
      expect(codex.ok).toBe(true);
    });

    test("a stale runtime (probe older than the freshness window) fails closed again", () => {
      installDeps({});
      const parsed = parseMacChatConfig();
      if (!parsed.ok) throw new Error("config must parse");
      setMacRuntimeForTests({ config: parsed.config, probe: probeReport(), probedAt: 1_000_000 - MAC_PROBE_FRESHNESS_MS - 1 });
      const mac = executionHostsResponse({ agent: "aisdk" }).hosts.find((h) => h.id === "mac")!;
      expect(mac.available).toBe(false);
      expect(mac.reason).toContain("verlopen");
      const decision = guardExecutionHostLaunch({ agent: "aisdk", executionHost: "mac" });
      expect(decision.ok).toBe(false);
    });
  });

  // ---- supervised adapter: spawn is never success -------------------------

  describe("supervised adapter spawn contract", () => {
    test("request rides stdin as JSON; argv stays the bare binary; sync result is unacknowledged", async () => {
      installDeps({});
      const parsed = parseMacChatConfig();
      if (!parsed.ok) throw new Error("config must parse");
      const recorded: RecordedSpawn[] = [];
      const followup: string[] = [];
      const adapter = createSupervisedMacLaunchAdapter(parsed.config, {
        spawn: recordingSpawn(recorded, async () =>
          JSON.stringify({ status: "acknowledged", jobId: "job-9", nativeSessionId: "native-1" })),
        followup: {
          onAcknowledged: (ack) => followup.push(`acked:${ack.jobId}`),
          onRejected: (id, error) => followup.push(`rejected:${id}:${error}`),
          onUnacknowledged: (id, reason) => followup.push(`unacked:${id}:${reason}`),
        },
      });
      const disposition = adapter.launch({
        type: "launch",
        requestId: "req-1",
        sessionId: KEY,
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "geheime prompt met newlines\nen quotes",
        settings: { model: "opus" },
        containment: { agentSlice: true, sandbox: "none", egressProxy: false },
      });
      // Spawn-only is NOT a successful start: the synchronous disposition is
      // fail-closed, whatever the adapter answers later.
      expect(disposition.status).toBe("unacknowledged");
      expect(recorded.length).toBe(1);
      expect(recorded[0]!.binaryPath).toBe(ADAPTER);
      const parsedRequest = JSON.parse(recorded[0]!.requestJson) as MacLaunchRequest;
      expect(parsedRequest.prompt).toBe("geheime prompt met newlines\nen quotes");
      expect(parsedRequest.sessionId).toBe(KEY);
      expect(parsedRequest.type).toBe("launch");
      expect(parsedRequest.requestId).toBe("req-1");
      // The later acknowledgement is a reconciliation signal, never success.
      await Bun.sleep(20);
      expect(followup).toEqual(["acked:job-9"]);
    });

    test("a late rejection surfaces through the followup only; sync stays failed", async () => {
      installDeps({});
      const parsed = parseMacChatConfig();
      if (!parsed.ok) throw new Error("config must parse");
      const events: string[] = [];
      const adapter = createSupervisedMacLaunchAdapter(parsed.config, {
        spawn: recordingSpawn([], async () => JSON.stringify({ status: "rejected", error: "remote weigerde" })),
        followup: {
          onRejected: (_id, error) => events.push(error),
          onAcknowledged: () => events.push("acked"),
          onUnacknowledged: (_id, reason) => events.push(reason),
        },
      });
      const disposition = adapter.launch({
        type: "launch",
        requestId: "req-2",
        sessionId: KEY,
        agent: "aisdk",
        name: NAME,
        cwd: root,
        settings: {},
        containment: { agentSlice: false, sandbox: "none", egressProxy: false },
      });
      expect(disposition.status).toBe("unacknowledged");
      await Bun.sleep(20);
      expect(events).toEqual(["remote weigerde"]);
    });

    test("an answer without a job binding never becomes an acknowledgement", async () => {
      installDeps({});
      const parsed = parseMacChatConfig();
      if (!parsed.ok) throw new Error("config must parse");
      const events: string[] = [];
      const adapter = createSupervisedMacLaunchAdapter(parsed.config, {
        spawn: recordingSpawn([], async () => JSON.stringify({ status: "acknowledged" })),
        followup: {
          onAcknowledged: () => events.push("acked"),
          onUnacknowledged: () => events.push("unacked"),
          onRejected: () => events.push("rejected"),
        },
      });
      const disposition = adapter.launch({
        type: "launch",
        requestId: "req-3",
        sessionId: KEY,
        agent: "aisdk",
        name: NAME,
        cwd: root,
        settings: {},
        containment: { agentSlice: false, sandbox: "none", egressProxy: false },
      });
      expect(disposition.status).toBe("unacknowledged");
      await Bun.sleep(20);
      expect(events).toEqual(["unacked"]);
    });
  });

  // ---- central guard ------------------------------------------------------

  describe("guardExecutionHostLaunch", () => {
    test("missing and agentbox hosts stay local", () => {
      expect(guardExecutionHostLaunch({ agent: "aisdk" })).toEqual({ ok: true, host: "agentbox", transport: "local" });
      expect(guardExecutionHostLaunch({ agent: "aisdk", executionHost: "agentbox" })).toEqual({
        ok: true,
        host: "agentbox",
        transport: "local",
      });
      expect(guardExecutionHostLaunch({ agent: "aisdk", executionHost: undefined })).toEqual({
        ok: true,
        host: "agentbox",
        transport: "local",
      });
    });

    test("mac without a registered runtime fails closed with the concrete reason", () => {
      installDeps({ configJson: null });
      const decision = guardExecutionHostLaunch({ agent: "aisdk", executionHost: "mac" });
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.error).toContain(MAC_UNVERIFIED_REASON);
    });

    test("mac refuses non-capable agents even with a registered runtime", () => {
      installRuntime(probeReport());
      const decision = guardExecutionHostLaunch({ agent: "grok", executionHost: "mac" });
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.error).toContain("grok");
    });

    test("mac with a proven runtime routes to the adapter", () => {
      installRuntime(probeReport());
      const decision = guardExecutionHostLaunch({ agent: "codex-aisdk", executionHost: "mac" });
      expect(decision.ok).toBe(true);
      if (decision.ok && decision.transport === "adapter") {
        expect(decision.adapter.id).toBe("mac");
      } else {
        throw new Error("expected adapter transport");
      }
    });
  });

  // ---- launchCodingAgentSession integration -------------------------------

  describe("launchCodingAgentSession", () => {
    test("unavailable mac never calls the local provider", () => {
      installDeps({ configJson: null });
      const result = launchCodingAgentSession({
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "nope",
        sessionId: KEY,
        executionHost: "mac",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(MAC_UNVERIFIED_REASON);
      expect(localSpawnRan()).toBe(false);
    });

    test("a failing mac route never falls back to a local provider", () => {
      installRuntime(probeReport(), {
        id: "mac",
        binaryPath: ADAPTER,
        launch: () => {
          throw new Error("adapter exploded");
        },
      });
      const result = launchCodingAgentSession({
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "nope",
        sessionId: KEY,
        executionHost: "mac",
      });
      // Integrated route (revision 2): no bridge host is mounted in this
      // process, so the launch fails CLOSED with the concrete reason — a
      // broken route never silently runs the provider locally.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("ssh-route");
      expect(localSpawnRan()).toBe(false);
    });

    test("the supervised adapter alone fails closed: spawn is not a durable acknowledgement", async () => {
      // A real supervised adapter (real spawn contract, no synchronous answer
      // channel): the launch can only come back unacknowledged.
      installDeps({});
      const parsed = parseMacChatConfig();
      if (!parsed.ok) throw new Error("config must parse");
      const adapter = createSupervisedMacLaunchAdapter(parsed.config, {
        spawn: () => ({
          pid: 4711,
          writeStdin: () => {},
          endStdin: () => {},
          exited: new Promise<string>(() => {}), // never answers
          kill: () => {},
        }),
      });
      setMacRuntimeForTests({ config: parsed.config, probe: probeReport(), adapter });
      const result = launchCodingAgentSession({
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "werk op de mac",
        sessionId: KEY,
        executionHost: "mac",
      });
      // Integrated route: the supervised external adapter no longer fronts
      // the launch; without bridge pins the route fails closed (spawn is
      // never booked as success — remoteInit pending is the only "started").
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("ssh-route");
      expect(localSpawnRan()).toBe(false);
    });

    test("full settings incl. codex Fast pass validation (item 17); mac route fails only on missing pins, never on Fast", () => {
      const requests: MacLaunchRequest[] = [];
      void requests;
      installRuntime(probeReport(), acknowledgedStub(requests, { nativeSessionId: "remote-native-1" }));
      const result = launchCodingAgentSession({
        agent: "codex-aisdk",
        name: NAME,
        cwd: root,
        prompt: "werk op de mac",
        model: "gpt-5.5",
        thinkingLevel: "high",
        fastMode: true,
        serviceTier: "fast",
        cyberAccessProgram: "daybreakBlue",
        sessionId: KEY,
        executionHost: "mac",
        containInAgentSlice: true,
        sandbox: "bwrap",
        egressProxyUrl: "http://127.0.0.1:9/proxy?token=SECRET-TOKEN",
        role: "contractor",
      });
      // Integrated route (item 17): Fast is supported — the FULL settings
      // request passes validation and now fails only on the missing
      // ssh/bridge pins (fail-closed, never local, never a Fast refusal).
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("service_tier");
        expect(result.error).toContain("ssh-route");
      }
      expect(localSpawnRan()).toBe(false);
    });

    test("a CUSTOM Claude account is explicitly refused; the default own-login passes validation (item 22)", () => {
      const requests: MacLaunchRequest[] = [];
      installRuntime(probeReport(), acknowledgedStub(requests));
      const custom = launchCodingAgentSession({
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "x",
        sessionId: KEY,
        executionHost: "mac",
        claudeAccountId: "acct-1",
      });
      expect(custom.ok).toBe(false);
      if (!custom.ok) expect(custom.error).toContain("claude-account \"acct-1\"");
      // The DEFAULT account is the normal live payload (inventory: every
      // ordinary harness launches with it) — it must NOT be rejected at the
      // account guard; the launch proceeds and fails only on missing pins.
      const standard = launchCodingAgentSession({
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "x",
        sessionId: KEY,
        executionHost: "mac",
        claudeAccountId: "default",
      });
      expect(standard.ok).toBe(false);
      if (!standard.ok) {
        expect(standard.error).not.toContain("claude-account");
        expect(standard.error).toContain("ssh-route");
      }
      expect(requests.length).toBe(0);
      expect(localSpawnRan()).toBe(false);
    });

    test("a setting the provider record did not test is explicitly refused", () => {
      installRuntime(
        probeReport({
          providers: [providerRecord("codex-aisdk", { testedSettings: ["model"] })],
        }),
        acknowledgedStub([]),
      );
      const result = launchCodingAgentSession({
        agent: "codex-aisdk",
        name: NAME,
        cwd: root,
        prompt: "x",
        sessionId: KEY,
        executionHost: "mac",
        serviceTier: "fast",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("serviceTier");
      expect(localSpawnRan()).toBe(false);
    });

    test("unsupported remote containment is refused, never promoted to owner/open", () => {
      const base = { agent: "aisdk" as const, name: NAME, cwd: root, prompt: "x", sessionId: KEY, executionHost: "mac" as const };
      // Sandbox mode unsupported remotely.
      installRuntime(
        probeReport({
          providers: [providerRecord("aisdk", { supportedContainment: { agentSlice: true, sandbox: [], egressProxy: true, restrictedRoles: true } })],
        }),
        acknowledgedStub([]),
      );
      const sandboxed = launchCodingAgentSession({ ...base, sandbox: "bwrap" });
      expect(sandboxed.ok).toBe(false);
      if (!sandboxed.ok) expect(sandboxed.error).toContain("sandbox");
      // Restricted role unsupported remotely.
      installRuntime(
        probeReport({
          providers: [providerRecord("aisdk", { supportedContainment: { agentSlice: true, sandbox: ["bwrap"], egressProxy: true, restrictedRoles: false } })],
        }),
        acknowledgedStub([]),
      );
      const roled = launchCodingAgentSession({ ...base, role: "contractor" });
      expect(roled.ok).toBe(false);
      if (!roled.ok) expect(roled.error).toContain("restricted role");
      expect(localSpawnRan()).toBe(false);
    });

    test("explicit agentbox and legacy launches are unchanged local spawns", () => {
      const legacy = launchCodingAgentSession({
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "lokale taken",
        sessionId: KEY,
      });
      expect(legacy.ok).toBe(true);
      expect(localSpawnRan()).toBe(true);
      rmSync(capture, { force: true });

      const explicit = launchCodingAgentSession({
        agent: "aisdk",
        name: NAME,
        cwd: root,
        prompt: "lokale taken",
        sessionId: KEY,
        executionHost: "agentbox",
      });
      expect(explicit.ok).toBe(true);
      expect(localSpawnRan()).toBe(true);
      const captured = JSON.parse(readFileSync(capture, "utf8")) as { cmd: string[] };
      expect(captured.cmd.length).toBeGreaterThan(0);
    });
  });

  // ---- persistence + recovery roundtrip -----------------------------------

  describe("host roundtrip through registry and recovery", () => {
    test("the managed registry preserves the host on rows and API rows", () => {
      bootingRow({ executionHost: "mac" });
      const stored = listManaged().find((m) => m.tmuxName === NAME)!;
      expect(stored.executionHost).toBe("mac");
      const listed = managedLaunchRow(stored, {}, {});
      expect(listed?.executionHost).toBe("mac");
    });

    test("legacy rows report the effective agentbox host", () => {
      bootingRow({});
      const listed = managedLaunchRow(listManaged()[0]!, {}, {});
      expect(listed?.executionHost).toBe("agentbox");
    });

    test("recovery of a mac-hosted row without a runtime fails closed instead of going local", () => {
      row({ executionHost: "mac" });
      deadEntry();
      const result = relaunchDeadCommandFileHarness(KEY, { log: () => {} });
      expect(result.state).toBe("failed");
      if (result.state === "failed") expect(result.error).toContain(MAC_UNVERIFIED_REASON);
      expect(localSpawnRan()).toBe(false);
      const stored = listManaged().find((m) => m.tmuxName === NAME)!;
      expect(stored.launchState).toBe("failed");
      expect(stored.launchError).toContain(MAC_UNVERIFIED_REASON);
    });

    test("recovery of a mac-hosted row keeps the integrated route (fast tier refused, never local)", () => {
      const requests: MacLaunchRequest[] = [];
      void requests;
      installRuntime(probeReport(), acknowledgedStub(requests, { pid: 5555 }));
      row({
        executionHost: "mac",
        model: "gpt-5.5",
        thinkingLevel: "high",
        fastMode: true,
        serviceTier: "fast",
        cyberAccessProgram: "daybreakBlue",
        role: "contractor",
        containment: { agentSlice: true, sandbox: "bwrap", egressProxy: true },
        agent: "codex-aisdk",
      });
      deadEntry();
      writeEntry({ sessionId: KEY, agent: "codex", harnessPid: DEAD_PID, tmuxName: NAME, supervisor: "process", bootId: currentBootId(), cwd: root, model: "gpt-5.5", busy: true, createdAt: 2, threadId: "thread-1" });
      const result = relaunchDeadCommandFileHarness(KEY, { log: () => {} });
      // Integrated route (item 17): recorded Fast is SUPPORTED — recovery
      // proceeds past validation and fails only on the missing pins, never
      // silently runs the provider locally.
      expect(result.state).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("service_tier");
      expect(localSpawnRan()).toBe(false);
    });

    test("recovery of a legacy row still relaunches locally, unchanged", () => {
      row({});
      deadEntry();
      const result = relaunchDeadCommandFileHarness(KEY, { log: () => {} });
      expect(result.state).toBe("relaunched");
      expect(localSpawnRan()).toBe(true);
    });

    test("the containment record keeps the host after the row is removed", () => {
      row({ executionHost: "mac" });
      const recorded = getSessionContainment([KEY]);
      expect(recorded?.executionHost).toBe("mac");
      removeManaged(NAME);
      expect(getSessionContainment([KEY])?.executionHost).toBe("mac");
      expect(coldResumeExecutionHost([KEY])).toBe("mac");
    });

    test("closed legacy sessions resume as agentbox", () => {
      row({});
      removeManaged(NAME);
      expect(getSessionContainment([KEY])?.executionHost).toBeNull();
      expect(coldResumeExecutionHost([KEY])).toBe("agentbox");
    });
  });

  // ---- launchViaMacAdapter refusal contract --------------------------------

  describe("launchViaMacAdapter", () => {
    test("refuses non-capable agents before touching the adapter", () => {
      const seen: MacLaunchRequest[] = [];
      const stub = acknowledgedStub(seen);
      const result = launchViaMacAdapter(stub, {
        agent: "opencode",
        sessionId: KEY,
        name: NAME,
        cwd: root,
      });
      expect(result.status).toBe("rejected");
      expect(seen.length).toBe(0);
    });

    test("an acknowledged disposition without a jobId is downgraded to unacknowledged", () => {
      installRuntime(probeReport(), {
        id: "mac",
        binaryPath: ADAPTER,
        launch: (request) => ({ status: "acknowledged", requestId: request.requestId, jobId: "" }),
      });
      const result = launchViaMacAdapter(registeredAdapterOrThrow(), {
        agent: "aisdk",
        sessionId: KEY,
        name: NAME,
        cwd: root,
      });
      expect(result.status).toBe("unacknowledged");
      if (result.status === "unacknowledged") expect(result.error).toContain("jobId");
    });

    test("rejects when no runtime is installed, even with a stub adapter in hand", () => {
      // A caller-supplied adapter can never bypass the runtime attestation.
      const stub = acknowledgedStub([]);
      const result = launchViaMacAdapter(stub, {
        agent: "aisdk",
        sessionId: KEY,
        name: NAME,
        cwd: root,
      });
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.error).toContain(MAC_UNVERIFIED_REASON);
    });
  });

  // ---- adapter text hygiene -------------------------------------------------

  describe("sanitizeAdapterText", () => {
    test("collapses control characters and whitespace and caps the length", () => {
      expect(sanitizeAdapterText("a\nb\tc\u0000d  e")).toBe("a b c d e");
      const long = "x".repeat(500);
      expect(sanitizeAdapterText(long).length).toBeLessThanOrEqual(240);
      expect(sanitizeAdapterText(null)).toBe("");
    });
  });

  // ---- local remote-control budget ------------------------------------------

  describe("mac remote-control budget", () => {
    test("default budget and config override with clamping", () => {
      expect(macRemoteControlBudget(null)).toBe(MAC_REMOTE_CONTROL_BUDGET_DEFAULT);
      installDeps({ configJson: configJson({ remoteControlBudget: 3 }) });
      const parsed = parseMacChatConfig();
      if (!parsed.ok) throw new Error("config must parse");
      expect(macRemoteControlBudget(parsed.config)).toBe(3);
    });

    test("admits below the budget, refuses at it, with a concrete message", () => {
      expect(admitMacRemoteControl(0, 2).ok).toBe(true);
      expect(admitMacRemoteControl(1, 2).ok).toBe(true);
      const at = admitMacRemoteControl(2, 2);
      expect(at.ok).toBe(false);
      if (!at.ok) expect(at.error).toContain("2 actief van 2");
    });
  });
});

function registeredAdapterOrThrow(): MacLaunchAdapter {
  const adapter = guardExecutionHostLaunch({ agent: "aisdk", executionHost: "mac" });
  if (adapter.ok && adapter.transport === "adapter") return adapter.adapter;
  throw new Error("expected a registered mac runtime");
}
