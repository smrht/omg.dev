// Manual execution-host choice for coding-agent sessions (mac-headchat).
//
// Contract owner for the host dimension of a session launch. Exactly two
// hosts exist — agentbox (this box, local providers) and mac (the MacBook M1
// worker reached through an admin-installed launch adapter). There is no
// "auto" host and no fallback between hosts: the caller picks one, the
// choice is persisted on the managed row, and recovery/respawn/fork/resume
// reuse the recorded host. A launch that names mac while mac is not fully
// verified fails closed; it never silently runs on a local provider.
//
// Mac readiness is deliberately conservative and DYNAMIC (tranche 2). An
// admin-installed config file OUTSIDE the omg source tree (default
// ~/.config/agentbox-mac-chat/config.json, path override via
// OMG_MAC_CHAT_CONFIG) carries PINS ONLY — expected machine identity, the
// sha256 of the adapter installation's full build manifest (the executable
// plus every dependency, so editing an imported file invalidates the pin),
// the expected remote OS version, and the expected remote tool-manifest
// hash. Pins prove nothing on their own: two identical hashes inside one
// config file are self-reported, not live evidence. Readiness requires a
// RUNTIME PROBE: the adapter binary is actually executed with a probe
// request, and its answer must match every pin, report the machine healthy
// (on power, eligible per the Mac worker policy, thermally normal) and
// carry PER-PROVIDER attestation records (parity chat/tools/memory, tested
// settings, supported containment) — a global "parity proven" flag for all
// providers at once does not exist. When only Codex is proven, Claude
// stays unavailable, and vice versa. No environment boolean can enable mac
// by itself, and the one-shot mac queue status is NEVER consulted here.
//
// The probe result lives in process memory only, is refreshed on a timer,
// and expires after MAC_PROBE_FRESHNESS_MS. A stale, missing or invalid
// probe means unavailable — mac therefore stays unavailable until the real
// runtime adapter (which answers the probe protocol) is installed and a
// real per-provider attestation producer keeps the record fresh.
//
// Launch acknowledgement (tranche 2): an adapter process that merely
// spawned is NOT a successful start. The launch protocol is
// request/acknowledgement based: the adapter must answer with an explicit
// durable acknowledgement (a remote registry job binding) before any
// caller may treat the launch as started. The supervised adapter in this
// file cannot obtain that answer synchronously, so its launch() returns
// "unacknowledged" — which every caller treats as a FAILED launch (fail
// closed), with the requestId available for reconciliation. The followup
// hooks report the eventual outcome for reconciliation only; they never
// flip a failed launch into success. Until the runtime tranche integrates
// confirmed local harness registration + remote durable binding, mac
// stays not ready end to end.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEFAULT_CLAUDE_ACCOUNT_ID } from "./claude-accounts.ts";

/** The only two host ids the API ever reports. No "auto", no fallback. */
export type ExecutionHostId = "agentbox" | "mac";

export const EXECUTION_HOST_IDS: readonly ExecutionHostId[] = ["agentbox", "mac"];

/** Legacy rows and requests without a host run on this box. Never changed. */
export const DEFAULT_EXECUTION_HOST: ExecutionHostId = "agentbox";

export const EXECUTION_HOST_LABELS: Record<ExecutionHostId, string> = {
  agentbox: "Agentbox",
  mac: "MacBook M1",
};

/** Concrete reason while per-provider parity is not proven by a fresh probe. */
export const MAC_UNVERIFIED_REASON = "Mac-hoofdchat nog niet volledig geverifieerd";

/**
 * Provider kinds that may run on the mac host. Initial scope of the mac
 * head-chat: the two SDK drivers omg itself supervises end to end. Every
 * other kind is explicitly unavailable on mac — not silently remapped to a
 * different provider, account or model.
 */
export const MAC_CAPABLE_AGENTS: readonly ("aisdk" | "codex-aisdk")[] = ["aisdk", "codex-aisdk"];

// ---------------------------------------------------------------------------
// Strict request parsing (POST /api/sessions/new, /resume refusal checks)
// ---------------------------------------------------------------------------

export type ExecutionHostParse =
  | { ok: true; host: ExecutionHostId | undefined }
  | { ok: false; error: string };

/**
 * Strict parser for a caller-supplied executionHost value. Absent (undefined)
 * is the legacy case. Every other value — explicit null, wrong type, "auto",
 * unknown string, casing — is a hard 400, never a silent fallback. A client
 * that serializes null explicitly said "no host"; that is not the legacy
 * wire shape and must not be coerced into one.
 */
export function parseExecutionHostRequest(value: unknown): ExecutionHostParse {
  if (value === undefined) return { ok: true, host: undefined };
  if (typeof value !== "string") {
    return { ok: false, error: 'invalid executionHost: expected "agentbox" or "mac"' };
  }
  if (value === "agentbox" || value === "mac") return { ok: true, host: value };
  return { ok: false, error: `unknown executionHost "${value}": expected "agentbox" or "mac"` };
}

// ---------------------------------------------------------------------------
// Adapter text hygiene: adapter answers are external input; user-facing
// errors stay short, single-line and never carry request/env material.
// ---------------------------------------------------------------------------

export function sanitizeAdapterText(raw: string | undefined | null, maxLen = 240): string {
  if (!raw) return "";
  const collapsed = String(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 1)}…` : collapsed;
}

// ---------------------------------------------------------------------------
// Admin-installed config: PINS ONLY. Static hashes here are bindings the
// probe must match — they are never accepted as live proof by themselves.
// ---------------------------------------------------------------------------

export type MacChatConfig = {
  enabled: boolean;
  /** Absolute path to the adapter executable. Never a prompt or secret. */
  adapter: string;
  /** Expected machine identity of the MacBook M1 (probe must report equal). */
  machineIdentity: string;
  /**
   * sha256 over the adapter installation's full build manifest: executable
   * plus every dependency file. Hashing only the entry script would miss
   * changes in imported modules; the manifest pin covers the whole install.
   */
  buildManifestSha256: string;
  /** Expected remote OS version string (probe must report equal). */
  osVersion: string;
  /**
   * sha256 of the remote tool-manifest source. A remote that dropped the
   * regular MCP connectors or the computer surface produces a different
   * manifest hash, so the probe evaluation fails and mac goes unavailable.
   */
  toolManifestSha256: string;
  /**
   * Local budget for concurrently SUPERVISED mac control harnesses (this
   * box only runs lightweight control processes; the provider runs on the
   * MacBook). Optional, clamped to 1..MAC_REMOTE_CONTROL_BUDGET_MAX.
   */
  remoteControlBudget?: number;
  /**
   * SSH transport pins (integration revision 2). When present, probes and
   * provider streams run through the trusted ssh client config alias and
   * the Mac forced-command supervisor (`probe|stream|status|cancel`); the
   * legacy local adapter executable is then used only as the pinned
   * installation reference. The alias is a single token — host, user,
   * identity and known_hosts live in the trusted local ssh client config.
   */
  ssh?: { target: string };
  /**
   * Central MCP bridge pins. When present, serve mounts the mac-chat bridge
   * on the explicit private bind address/port and remote sessions reach it
   * at publicUrl. Absent (default): bridge stays unmounted and mac sessions
   * with MCP needs fail closed with a concrete reason.
   */
  bridge?: {
    bindAddress: string;
    port: number;
    /** Exact public base URL the Mac uses (https on the tailnet, or loopback for tests). */
    publicUrl: string;
    /** Exact host(:port) allowlist for https upstream namespace targets. */
    trustedUpstreamHosts?: string[];
  };
};

export type MacChatConfigResult =
  | { ok: true; config: MacChatConfig }
  | { ok: false; reason: string };

export const MAC_REMOTE_CONTROL_BUDGET_DEFAULT = 6;
export const MAC_REMOTE_CONTROL_BUDGET_MAX = 10;

/**
 * Every mac-unavailable reason carries the parity fact, with the specific
 * gap appended. Readiness for a head chat is exactly the proven E2E/tool/
 * memory parity, so any validation failure states that plainly first; the
 * detail between parentheses says what the operator can fix.
 */
function unverified(detail: string): string {
  return `${MAC_UNVERIFIED_REASON} (${detail})`;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function parseMacChatConfig(): MacChatConfigResult {
  const path = macChatConfigPath();
  const raw = deps.readConfigFile(path);
  if (raw === null) {
    return { ok: false, reason: unverified("geen geldig config-bestand") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: unverified("config is geen geldig JSON") };
  }
  const cfg = parsed as Partial<MacChatConfig> | null;
  if (!cfg || typeof cfg !== "object" || cfg.enabled !== true) {
    return { ok: false, reason: unverified("Mac-chat staat niet aan in de configuratie") };
  }
  if (typeof cfg.adapter !== "string" || !cfg.adapter.trim() || !isAbsolute(cfg.adapter)) {
    return { ok: false, reason: unverified("adapter-pad ontbreekt of is niet absoluut") };
  }
  const adapterPath = cfg.adapter.trim();
  const st = deps.statFile(adapterPath);
  if (!st) {
    return { ok: false, reason: unverified("adapter-binary bestaat niet") };
  }
  if (!st.executable) {
    return { ok: false, reason: unverified("adapter-binary is niet uitvoerbaar") };
  }
  if (typeof cfg.machineIdentity !== "string" || !cfg.machineIdentity.trim()) {
    return { ok: false, reason: unverified("machine-identiteit-pin ontbreekt") };
  }
  if (typeof cfg.buildManifestSha256 !== "string" || !SHA256.test(cfg.buildManifestSha256)) {
    return { ok: false, reason: unverified("build-manifest-pin ontbreekt of is geen sha256") };
  }
  if (typeof cfg.osVersion !== "string" || !cfg.osVersion.trim()) {
    return { ok: false, reason: unverified("OS-versie-pin ontbreekt") };
  }
  if (typeof cfg.toolManifestSha256 !== "string" || !SHA256.test(cfg.toolManifestSha256)) {
    return { ok: false, reason: unverified("tool-manifest-pin ontbreekt of is geen sha256") };
  }
  if (
    cfg.remoteControlBudget !== undefined &&
    (typeof cfg.remoteControlBudget !== "number" ||
      !Number.isInteger(cfg.remoteControlBudget) ||
      cfg.remoteControlBudget < 1 ||
      cfg.remoteControlBudget > MAC_REMOTE_CONTROL_BUDGET_MAX)
  ) {
    return { ok: false, reason: unverified(`remoteControlBudget moet een geheel getal 1..${MAC_REMOTE_CONTROL_BUDGET_MAX} zijn`) };
  }
  // SSH transport pins (optional; integration revision 2). Single-token alias
  // only — everything else belongs in the trusted ssh client config.
  let ssh: MacChatConfig["ssh"];
  if (cfg.ssh !== undefined) {
    if (!cfg.ssh || typeof cfg.ssh !== "object" || typeof (cfg.ssh as { target?: unknown }).target !== "string") {
      return { ok: false, reason: unverified("ssh-pin moet een object met target-alias zijn") };
    }
    const target = ((cfg.ssh as { target: unknown }).target as string).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target)) {
      return { ok: false, reason: unverified("ssh.target moet een enkelvoudige veilige alias-token zijn") };
    }
    ssh = { target };
  }
  // Bridge pins (optional; default disabled → bridge stays unmounted).
  let bridge: MacChatConfig["bridge"];
  if (cfg.bridge !== undefined) {
    if (!cfg.bridge || typeof cfg.bridge !== "object") {
      return { ok: false, reason: unverified("bridge-pin moet een object zijn") };
    }
    const raw = cfg.bridge as Partial<NonNullable<MacChatConfig["bridge"]>>;
    if (typeof raw.bindAddress !== "string" || !raw.bindAddress.trim()) {
      return { ok: false, reason: unverified("bridge.bindAddress ontbreekt") };
    }
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
      return { ok: false, reason: unverified("bridge.port moet een geldige poort zijn") };
    }
    if (typeof raw.publicUrl !== "string" || !/^https?:\/\//.test(raw.publicUrl.trim())) {
      return { ok: false, reason: unverified("bridge.publicUrl moet een http(s)-URL zijn") };
    }
    let hosts: string[] | undefined;
    if (raw.trustedUpstreamHosts !== undefined) {
      if (!Array.isArray(raw.trustedUpstreamHosts) || raw.trustedUpstreamHosts.some((h) => typeof h !== "string" || !h.trim())) {
        return { ok: false, reason: unverified("bridge.trustedUpstreamHosts moet een lijst host(:poort)-strings zijn") };
      }
      hosts = (raw.trustedUpstreamHosts as string[]).map((h) => h.trim()).filter(Boolean);
    }
    bridge = {
      bindAddress: raw.bindAddress.trim(),
      port: raw.port,
      publicUrl: raw.publicUrl.trim().replace(/\/+$/, ""),
      ...(hosts ? { trustedUpstreamHosts: hosts } : {}),
    };
  }
  return {
    ok: true,
    config: {
      enabled: true,
      adapter: adapterPath,
      machineIdentity: cfg.machineIdentity.trim(),
      buildManifestSha256: cfg.buildManifestSha256,
      osVersion: cfg.osVersion.trim(),
      toolManifestSha256: cfg.toolManifestSha256,
      ...(cfg.remoteControlBudget !== undefined ? { remoteControlBudget: cfg.remoteControlBudget } : {}),
      ...(ssh ? { ssh } : {}),
      ...(bridge ? { bridge } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime probe: the ONLY source of live readiness. Per provider.
// ---------------------------------------------------------------------------

export const MAC_PROBE_SCHEMA = 1;
/** A probe older than this proves nothing; mac reports unavailable. */
export const MAC_PROBE_FRESHNESS_MS = 15 * 60_000;
/** Bound on the probe subprocess itself. */
export const MAC_PROBE_TIMEOUT_MS = 10_000;
/** Background re-probe cadence while a runtime is registered. */
export const MAC_PROBE_REFRESH_MS = 5 * 60_000;

/** Setting keys a provider record can declare as tested on the remote. */
export const MAC_SETTING_KEYS = ["model", "thinkingLevel", "fastMode", "serviceTier", "cyberAccessProgram"] as const;
export type MacSettingKey = (typeof MAC_SETTING_KEYS)[number];

export type MacProbeContainment = {
  agentSlice: boolean;
  sandbox: string[];
  egressProxy: boolean;
  restrictedRoles: boolean;
};

/**
 * Per-provider attestation record inside the probe answer. Parity, tested
 * settings and supported containment are proven PER PROVIDER: a Codex record
 * never makes Claude available (and a weekly Claude 429 state never blocks
 * Codex). A record with incomplete parity is simply not ready — it is kept
 * out of the ready map, not averaged into a global flag.
 */
export type MacProbeProviderRecord = {
  id: (typeof MAC_CAPABLE_AGENTS)[number];
  parity: { chat: boolean; tools: boolean; memory: boolean };
  testedSettings: string[];
  supportedContainment: MacProbeContainment;
  testedAt: number;
};

export type MacRuntimeProbeReport = {
  schema: number;
  /** Remote clock at probe time; must be close to ours. */
  probedAt: number;
  machineIdentity: string;
  buildManifestSha256: string;
  os: { platform: string; version: string };
  cliVersion: string;
  toolManifestSha256: string;
  health: { power: "adapter" | "battery"; thermal: "normal" | "hot"; policy: "eligible" | "ineligible" };
  providers: MacProbeProviderRecord[];
};

export type MacRuntimeProbeOutcome =
  | { ok: true; report: MacRuntimeProbeReport }
  | { ok: false; error: string };

function isProbeContainment(value: unknown): value is MacProbeContainment {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<MacProbeContainment>;
  return (
    typeof v.agentSlice === "boolean" &&
    Array.isArray(v.sandbox) && v.sandbox.every((s) => typeof s === "string") &&
    typeof v.egressProxy === "boolean" &&
    typeof v.restrictedRoles === "boolean"
  );
}

function isProviderRecord(value: unknown): value is MacProbeProviderRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<MacProbeProviderRecord>;
  return (
    (v.id === "aisdk" || v.id === "codex-aisdk") &&
    !!v.parity && typeof v.parity === "object" &&
    typeof (v.parity as { chat?: unknown }).chat === "boolean" &&
    typeof (v.parity as { tools?: unknown }).tools === "boolean" &&
    typeof (v.parity as { memory?: unknown }).memory === "boolean" &&
    Array.isArray(v.testedSettings) && v.testedSettings.every((s) => typeof s === "string") &&
    isProbeContainment(v.supportedContainment) &&
    typeof v.testedAt === "number" && Number.isFinite(v.testedAt)
  );
}

export function isProbeReport(value: unknown): value is MacRuntimeProbeReport {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<MacRuntimeProbeReport>;
  return (
    v.schema === MAC_PROBE_SCHEMA &&
    typeof v.probedAt === "number" && Number.isFinite(v.probedAt) &&
    typeof v.machineIdentity === "string" && !!v.machineIdentity.trim() &&
    typeof v.buildManifestSha256 === "string" && SHA256.test(v.buildManifestSha256) &&
    !!v.os && typeof v.os === "object" &&
    typeof (v.os as { platform?: unknown }).platform === "string" &&
    typeof (v.os as { version?: unknown }).version === "string" &&
    typeof v.cliVersion === "string" && !!v.cliVersion.trim() &&
    typeof v.toolManifestSha256 === "string" && SHA256.test(v.toolManifestSha256) &&
    !!v.health && typeof v.health === "object" &&
    ((v.health as { power?: unknown }).power === "adapter" || (v.health as { power?: unknown }).power === "battery") &&
    ((v.health as { thermal?: unknown }).thermal === "normal" || (v.health as { thermal?: unknown }).thermal === "hot") &&
    ((v.health as { policy?: unknown }).policy === "eligible" || (v.health as { policy?: unknown }).policy === "ineligible") &&
    Array.isArray(v.providers) && v.providers.every(isProviderRecord)
  );
}

export type MacRuntimeEvaluation =
  | { ok: false; reason: string }
  | { ok: true; providers: Map<string, MacProbeProviderRecord> };

/**
 * Bind a probe answer to the admin pins and the machine's actual health.
 * Fail closed on every step; a partial or stale probe is "not verified",
 * never half-ready. Records with incomplete parity are excluded from the
 * ready map (per-provider readiness), they do not fail the whole probe.
 */
export function evaluateMacRuntime(
  config: MacChatConfig,
  probe: MacRuntimeProbeReport | null,
  probeError: string | null,
  now: number,
): MacRuntimeEvaluation {
  if (!probe) {
    return {
      ok: false,
      reason: unverified(probeError ? `runtime-probe faalde: ${sanitizeAdapterText(probeError)}` : "geen runtime-probe beschikbaar"),
    };
  }
  if (Math.abs(now - probe.probedAt) > MAC_PROBE_FRESHNESS_MS) {
    return { ok: false, reason: unverified("probe-tijdstip ligt te ver van nu") };
  }
  if (probe.machineIdentity.trim() !== config.machineIdentity) {
    return { ok: false, reason: unverified("machine-identiteit wijkt af van de pin") };
  }
  if (probe.buildManifestSha256 !== config.buildManifestSha256) {
    return { ok: false, reason: unverified("build-manifest van de adapterinstallatie wijkt af van de pin (executable plus dependencies)") };
  }
  if (probe.os.platform !== "darwin" || probe.os.version !== config.osVersion) {
    return { ok: false, reason: unverified("OS-versie/platform wijkt af van de pin") };
  }
  if (!probe.cliVersion.trim()) {
    return { ok: false, reason: unverified("geen CLI-versie gerapporteerd") };
  }
  if (probe.toolManifestSha256 !== config.toolManifestSha256) {
    return { ok: false, reason: unverified("tool-manifest wijkt af van de pin; connectors/computer moeten ongewijzigd blijven") };
  }
  if (probe.health.power !== "adapter") {
    return { ok: false, reason: unverified("Mac draait niet op netstroom") };
  }
  if (probe.health.thermal !== "normal") {
    return { ok: false, reason: unverified("Mac rapporteert een afwijkende thermische toestand") };
  }
  if (probe.health.policy !== "eligible") {
    return { ok: false, reason: unverified("Mac-werkbeleid is niet eligible (thuis/netstroom/idle)") };
  }
  const providers = new Map<string, MacProbeProviderRecord>();
  for (const record of probe.providers) {
    if (!record.parity.chat || !record.parity.tools || !record.parity.memory) continue;
    providers.set(record.id, record);
  }
  return { ok: true, providers };
}

// ---------------------------------------------------------------------------
// Supervised subprocess plumbing (probe and launch share it)
// ---------------------------------------------------------------------------

export type ExecutionHostDeps = {
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Synchronous config read; default readFileSync. */
  readConfigFile?: (path: string) => string | null;
  /** stat for existence/executability. */
  statFile?: (path: string) => { mtimeMs: number; size: number; executable: boolean } | null;
  /** Execute the runtime probe against the adapter binary. */
  probeRuntime?: (adapterPath: string) => Promise<MacRuntimeProbeOutcome>;
  /** Request id source for launches. */
  randomUUID?: () => string;
};

const SANITIZED_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const;

function sanitizedAdapterEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SANITIZED_ENV_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

type SpawnedProcess = {
  pid: number;
  writeStdin(data: string): void;
  endStdin(): void;
  /** Resolves the adapter's stdout when it exits; rejects on transport errors. */
  exited: Promise<string>;
  kill(): void;
};

export type MacAdapterSpawn = (
  binaryPath: string,
  requestJson: string,
) => SpawnedProcess | null;

function defaultAdapterSpawn(binaryPath: string, requestJson: string): SpawnedProcess | null {
  // The adapter binary is spawned with argv [binary] only: every request
  // (probe or launch, prompt included) travels as JSON on stdin, never on
  // the command line.
  const child = Bun.spawn({
    cmd: [binaryPath],
    env: sanitizedAdapterEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    child.stdin!.write(requestJson);
    child.stdin!.end();
  } catch {
    try {
      child.kill();
    } catch {}
    return null;
  }
  const exited = new Promise<string>((resolve, reject) => {
    void child.exited
      .then(async () => {
        try {
          resolve(await new Response(child.stdout).text());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .catch(reject);
  });
  return { pid: child.pid ?? 0, writeStdin: () => {}, endStdin: () => {}, exited, kill: () => child.kill() };
}

/** Run one request/answer exchange with the adapter binary, bounded in time. */
async function runAdapterExchange(
  binaryPath: string,
  requestJson: string,
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  let child: SpawnedProcess;
  try {
    const spawned = defaultAdapterSpawn(binaryPath, requestJson);
    if (!spawned) return { ok: false, error: "adapter kon niet gestart worden" };
    child = spawned;
  } catch (error) {
    return { ok: false, error: `adapter spawn faalde: ${error instanceof Error ? error.message : String(error)}` };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, error: "adapter gaf geen antwoord binnen de tijd" });
    }, timeoutMs);
    timer.unref?.();
    void child.exited
      .then((stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, stdout });
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: `adapter proces faalde: ${error instanceof Error ? error.message : String(error)}` });
      });
  });
}

async function defaultProbeRuntime(adapterPath: string): Promise<MacRuntimeProbeOutcome> {
  const exchange = await runAdapterExchange(
    adapterPath,
    JSON.stringify({ type: "probe", schema: MAC_PROBE_SCHEMA }),
    MAC_PROBE_TIMEOUT_MS,
  );
  if (!exchange.ok) return { ok: false, error: exchange.error };
  const trimmed = exchange.stdout.trim();
  if (!trimmed) return { ok: false, error: "adapter antwoordde geen probe-JSON" };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isProbeReport(parsed)) return { ok: false, error: "adapter antwoordde geen geldig probe-report" };
    return { ok: true, report: parsed };
  } catch {
    return { ok: false, error: "adapter antwoordde geen geldig probe-report" };
  }
}

const DEFAULT_DEPS: Required<ExecutionHostDeps> = {
  now: () => Date.now(),
  env: process.env,
  readConfigFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  statFile: (path) => {
    try {
      const st = statSync(path);
      const executable = (st.mode & 0o111) !== 0;
      return { mtimeMs: st.mtimeMs, size: st.size, executable };
    } catch {
      return null;
    }
  },
  probeRuntime: defaultProbeRuntime,
  randomUUID: () => randomUUID(),
};

// Tests replace the whole deps bundle; production keeps the defaults.
let deps: Required<ExecutionHostDeps> = DEFAULT_DEPS;

export function setExecutionHostDepsForTests(override: ExecutionHostDeps | null): void {
  deps = override ? { ...DEFAULT_DEPS, ...override } : DEFAULT_DEPS;
}

export function macChatConfigPath(env: Record<string, string | undefined> = deps.env): string {
  const override = env.OMG_MAC_CHAT_CONFIG?.trim();
  if (override) return override;
  const home = env.HOME ?? "";
  return home ? `${home}/.config/agentbox-mac-chat/config.json` : "~/.config/agentbox-mac-chat/config.json";
}

// ---------------------------------------------------------------------------
// Registered runtime (config + fresh probe + supervised adapter), in memory
// only: nothing on disk can fabricate a probe result.
// ---------------------------------------------------------------------------

type MacRuntime = {
  config: MacChatConfig;
  probe: MacRuntimeProbeReport;
  /** When THIS process last executed the probe. */
  probedAt: number;
  adapter: MacLaunchAdapter;
};

let macRuntime: MacRuntime | null = null;
let macProbeRefreshTimer: ReturnType<typeof setInterval> | null = null;

function stopMacRuntime(): void {
  if (macProbeRefreshTimer !== null) {
    clearInterval(macProbeRefreshTimer);
    macProbeRefreshTimer = null;
  }
  macRuntime = null;
}

export function resetExecutionHostCachesForTests(): void {
  stopMacRuntime();
}

/**
 * Mac host availability right now, per agent kind. Read-only: config pins +
 * the in-memory probe cache only; no subprocess runs here.
 */
export type MacHostStatus =
  | { available: false; reason: string }
  | { available: true; provider?: MacProbeProviderRecord };

export function macRuntimeStatus(agent: string | null): MacHostStatus {
  if (agent && !MAC_CAPABLE_AGENTS.includes(agent as "aisdk" | "codex-aisdk")) {
    return { available: false, reason: `De Mac-host ondersteunt "${agent}" niet (alleen aisdk en codex-aisdk)` };
  }
  const now = deps.now();
  if (!macRuntime) {
    const parsed = parseMacChatConfig();
    return { available: false, reason: parsed.ok ? unverified("geen actuele runtime-probe") : parsed.reason };
  }
  if (now - macRuntime.probedAt > MAC_PROBE_FRESHNESS_MS) {
    return { available: false, reason: unverified("runtime-probe is verlopen") };
  }
  const evaluation = evaluateMacRuntime(macRuntime.config, macRuntime.probe, null, now);
  if (!evaluation.ok) return { available: false, reason: evaluation.reason };
  if (evaluation.providers.size === 0) {
    return { available: false, reason: unverified("geen enkele provider volledig bewezen") };
  }
  if (agent) {
    const record = evaluation.providers.get(agent);
    if (!record) {
      return { available: false, reason: unverified(`geen geldige per-provider attestation voor "${agent}" (pariteit wordt per provider bewezen, niet globaal)`) };
    }
    return { available: true, provider: record };
  }
  return { available: true };
}

// ---------------------------------------------------------------------------
// Status API (read-only, no subprocess, no queue consultation)
// ---------------------------------------------------------------------------

export type ExecutionHostStatus = {
  id: ExecutionHostId;
  label: string;
  available: boolean;
  reason?: string;
};

export type ExecutionHostsResponse = {
  ok: true;
  hosts: ExecutionHostStatus[];
  defaultHost: ExecutionHostId;
};

/**
 * The GET /api/execution-hosts body. Read-only: config pins + the cached
 * runtime probe. No subprocess runs, no remote poll, no consultation of the
 * one-shot mac queue status — a finished queue job is not head-chat
 * readiness, and neither are static hashes inside the config file.
 */
export function executionHostsResponse(input: { agent?: string | null } = {}): ExecutionHostsResponse {
  const mac = macRuntimeStatus(input.agent ?? null);
  const hosts: ExecutionHostStatus[] = [
    { id: "agentbox", label: EXECUTION_HOST_LABELS.agentbox, available: true },
    {
      id: "mac",
      label: EXECUTION_HOST_LABELS.mac,
      available: mac.available,
      ...(mac.available ? {} : { reason: mac.reason }),
    },
  ];
  return { ok: true, hosts, defaultHost: DEFAULT_EXECUTION_HOST };
}

// ---------------------------------------------------------------------------
// Launch protocol: request/acknowledgement. Spawn is not success.
// ---------------------------------------------------------------------------

export type MacLaunchSettings = {
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  serviceTier?: string;
  cyberAccessProgram?: string;
};

export type MacLaunchContainment = {
  agentSlice: boolean;
  sandbox: string;
  egressProxy: boolean;
  role?: string;
};

/**
 * Launch request handed to the adapter binary as ONE JSON document on stdin.
 * Nothing here ever lands on argv: argv is world-readable in process lists,
 * and the prompt must not be. The adapter owns the remote CLI invocation and
 * the remote registry lifecycle; the remote head may itself delegate.
 *
 * No account or credential material is forwarded: the mac runs its own
 * signed-in provider sessions (own profiles, own subscriptions), so the
 * request carries the task and its full settings, never a token, key,
 * account copy — and never the local egress-proxy URL (it embeds a local
 * session token); only the containment FACT travels.
 */
export type MacLaunchRequest = {
  type: "launch";
  requestId: string;
  sessionId: string;
  agent: (typeof MAC_CAPABLE_AGENTS)[number];
  name: string;
  cwd: string;
  prompt?: string;
  resume?: string;
  omgUser?: string | null;
  settings: MacLaunchSettings;
  containment: MacLaunchContainment;
};

/**
 * The launch disposition. Only "acknowledged" (the adapter answered with a
 * durable remote job binding) counts as started. "unacknowledged" means the
 * request left for an adapter process without that confirmation: callers
 * MUST treat it as a failed launch and reconcile by requestId; it is never
 * retried automatically and never falls back to a local provider.
 */
export type MacLaunchDisposition =
  | { status: "acknowledged"; requestId: string; jobId: string; nativeSessionId?: string; pid?: number }
  | { status: "rejected"; error: string }
  | { status: "unacknowledged"; requestId: string; error: string };

export type MacLaunchAnswer =
  | { status: "acknowledged"; jobId: string; nativeSessionId?: string; pid?: number }
  | { status: "rejected"; error?: string };

export type MacLaunchAdapter = {
  readonly id: "mac";
  /** Absolute adapter binary this supervisor spawns. */
  readonly binaryPath: string;
  launch(request: MacLaunchRequest): MacLaunchDisposition;
};

/**
 * Reconciliation channel for an in-flight launch. These hooks NEVER decide
 * success: the synchronous disposition does. They exist so the eventual
 * adapter answer (which may arrive after launch() already returned
 * unacknowledged) can be reconciled durably by the runtime owner.
 */
export type MacAdapterFollowup = {
  /** Adapter answered with a durable remote job binding. */
  onAcknowledged?: (ack: { requestId: string; jobId: string; nativeSessionId?: string; pid?: number }) => void;
  /** Adapter explicitly refused the launch. */
  onRejected?: (requestId: string, error: string) => void;
  /** No valid answer within bounds: outcome unknown, reconcile by requestId. */
  onUnacknowledged?: (requestId: string, reason: string) => void;
};

/** Bound on how long the supervisor waits for the adapter's launch answer. */
export const MAC_ADAPTER_RESPONSE_TIMEOUT_MS = 30_000;

export type MacAdapterFollowupEvent =
  | { kind: "acknowledged"; requestId: string; jobId: string; nativeSessionId?: string; pid?: number }
  | { kind: "rejected"; requestId: string; error: string }
  | { kind: "unacknowledged"; requestId: string; reason: string };

function parseAdapterAnswer(stdout: string): MacLaunchAnswer | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const v = parsed as Partial<MacLaunchAnswer>;
    if (v.status === "acknowledged") {
      if (typeof v.jobId !== "string" || !v.jobId.trim()) return null;
      return {
        status: "acknowledged",
        jobId: v.jobId,
        ...(typeof v.nativeSessionId === "string" && v.nativeSessionId ? { nativeSessionId: v.nativeSessionId } : {}),
        ...(typeof v.pid === "number" && Number.isFinite(v.pid) ? { pid: v.pid } : {}),
      };
    }
    if (v.status === "rejected") {
      return { status: "rejected", ...(typeof v.error === "string" ? { error: v.error } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the supervised mac launch adapter for a probe-verified config. The
 * spawn is a plain local process (Bun.spawn, unref'd, killed on timeout);
 * the request travels on stdin only, argv stays [binary]. Because the
 * adapter's acknowledgement cannot arrive synchronously through a
 * subprocess pipe, launch() returns "unacknowledged": an honest fail-closed
 * disposition. The runtime tranche must supply the confirmed local harness
 * registration + remote durable binding (or an awaiting launch path)
 * before a mac launch can ever come back "acknowledged" from this process.
 */
export function createSupervisedMacLaunchAdapter(
  config: MacChatConfig,
  opts: { followup?: MacAdapterFollowup; spawn?: MacAdapterSpawn } = {},
): MacLaunchAdapter {
  const spawn = opts.spawn ?? defaultAdapterSpawn;
  return {
    id: "mac",
    binaryPath: config.adapter,
    launch(request: MacLaunchRequest): MacLaunchDisposition {
      const requestJson = JSON.stringify(request);
      let child: SpawnedProcess | null = null;
      try {
        child = spawn(config.adapter, requestJson);
      } catch (error) {
        return {
          status: "rejected",
          error: sanitizeAdapterText(`mac adapter spawn faalde: ${error instanceof Error ? error.message : String(error)}`),
        };
      }
      if (!child) {
        return { status: "rejected", error: "mac adapter kon niet gestart worden" };
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child!.kill();
        } catch {}
        opts.followup?.onUnacknowledged?.(request.requestId, "mac adapter gaf geen antwoord binnen de tijd");
      }, MAC_ADAPTER_RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      void child.exited
        .then((stdout) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const answer = parseAdapterAnswer(stdout);
          if (answer?.status === "acknowledged") {
            opts.followup?.onAcknowledged?.({
              requestId: request.requestId,
              jobId: answer.jobId,
              ...(answer.nativeSessionId ? { nativeSessionId: answer.nativeSessionId } : {}),
              ...(answer.pid !== undefined ? { pid: answer.pid } : { pid: child!.pid }),
            });
          } else if (answer?.status === "rejected") {
            opts.followup?.onRejected?.(request.requestId, sanitizeAdapterText(answer.error) || "mac adapter weigerde de launch");
          } else {
            opts.followup?.onUnacknowledged?.(request.requestId, "mac adapter antwoordde geen geldig protocol-antwoord");
          }
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.followup?.onUnacknowledged?.(
            request.requestId,
            sanitizeAdapterText(`mac adapter proces faalde: ${error instanceof Error ? error.message : String(error)}`),
          );
        });
      // Spawn-only is NEVER success. Without a synchronous durable
      // acknowledgement this launch is unacknowledged: callers fail closed
      // and reconcile by requestId; there is no local fallback anywhere.
      return {
        status: "unacknowledged",
        requestId: request.requestId,
        error: "geen synchrone duurzame bevestiging van de Mac-adapter; uitkomst wordt gereconcilieerd, niet als succes geboekt",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime registration: requires config pins AND a passing live probe.
// ---------------------------------------------------------------------------

/**
 * Register the mac runtime for this process: parse the admin config, then
 * EXECUTE the runtime probe against the adapter binary. Registration is
 * refused unless the probe answer matches every pin, reports a healthy
 * eligible machine and carries at least one fully proven provider record.
 * A background timer re-probes; a failing re-probe unregisters immediately.
 * Returns the registered adapter, or null when refused.
 *
 * `probeRuntime` overrides the default local-adapter probe (used by the SSH
 * transport route: `ssh <target> probe`, INTEGRATION-WIRE §2). The override
 * receives the parsed config so it can bind to the ssh pins.
 */
export async function registerMacLaunchAdapter(
  opts: {
    followup?: MacAdapterFollowup;
    log?: (line: string) => void;
    probeRuntime?: (config: MacChatConfig) => Promise<MacRuntimeProbeOutcome>;
  } = {},
): Promise<MacLaunchAdapter | null> {
  const log = opts.log ?? ((line) => console.log(line));
  stopMacRuntime();
  const parsed = parseMacChatConfig();
  if (!parsed.ok) return null;
  const probe = opts.probeRuntime ? await opts.probeRuntime(parsed.config) : await deps.probeRuntime(parsed.config.adapter);
  if (!probe.ok) {
    log(`[execution-host] mac registratie geweigerd: ${unverified(`runtime-probe faalde: ${sanitizeAdapterText(probe.error)}`)}`);
    return null;
  }
  const evaluation = evaluateMacRuntime(parsed.config, probe.report, null, deps.now());
  if (!evaluation.ok || evaluation.providers.size === 0) {
    log(`[execution-host] mac registratie geweigerd: ${evaluation.ok ? unverified("geen enkele provider volledig bewezen") : evaluation.reason}`);
    return null;
  }
  macRuntime = {
    config: parsed.config,
    probe: probe.report,
    probedAt: deps.now(),
    adapter: createSupervisedMacLaunchAdapter(parsed.config, { followup: opts.followup }),
  };
  macProbeRefreshTimer = setInterval(() => {
    void (async () => {
      const current = macRuntime;
      if (!current) return;
      const reparsed = parseMacChatConfig();
      if (!reparsed.ok) {
        log(`[execution-host] mac runtime verwijderd: ${reparsed.reason}`);
        stopMacRuntime();
        return;
      }
      const reprobed = opts.probeRuntime
        ? await opts.probeRuntime(reparsed.config)
        : await deps.probeRuntime(reparsed.config.adapter);
      if (!reprobed.ok) {
        log(`[execution-host] mac runtime verwijderd: ${unverified(`runtime-probe faalde: ${sanitizeAdapterText(reprobed.error)}`)}`);
        stopMacRuntime();
        return;
      }
      const rechecked = evaluateMacRuntime(reparsed.config, reprobed.report, null, deps.now());
      if (!rechecked.ok || rechecked.providers.size === 0) {
        log(`[execution-host] mac runtime verwijderd: ${rechecked.ok ? unverified("geen enkele provider volledig bewezen") : rechecked.reason}`);
        stopMacRuntime();
        return;
      }
      macRuntime = {
        config: reparsed.config,
        probe: reprobed.report,
        probedAt: deps.now(),
        adapter: current.adapter,
      };
    })().catch(() => {
      // A crashing refresh must never leave a stale runtime pretending to
      // be fresh: unregister and let the next boot/register re-probe.
      stopMacRuntime();
    });
  }, MAC_PROBE_REFRESH_MS);
  macProbeRefreshTimer.unref?.();
  return macRuntime.adapter;
}

export function registeredMacLaunchAdapter(): MacLaunchAdapter | null {
  return macRuntime?.adapter ?? null;
}

/**
 * Test injection point for the runtime itself ("constructor injection"):
 * installs a runtime cache with a probe report (and optionally an adapter),
 * bypassing the real probe subprocess. Production readiness NEVER runs
 * through this path.
 */
export function setMacRuntimeForTests(
  runtime: { config: MacChatConfig; probe: MacRuntimeProbeReport; adapter?: MacLaunchAdapter; probedAt?: number } | null,
): void {
  stopMacRuntime();
  if (!runtime) return;
  macRuntime = {
    config: runtime.config,
    probe: runtime.probe,
    probedAt: runtime.probedAt ?? deps.now(),
    adapter: runtime.adapter ?? createSupervisedMacLaunchAdapter(runtime.config),
  };
}

// ---------------------------------------------------------------------------
// Local supervision budget for mac control harnesses
// ---------------------------------------------------------------------------

/**
 * The local budget for concurrently supervised mac sessions. The provider
 * runs on the MacBook; this box only holds lightweight control state, so a
 * mac launch never reserves the heavy local provider memory budget. The
 * remote worker's own queue owns the real remote limits; this is the local
 * control-plane guard only.
 */
export function macRemoteControlBudget(config: MacChatConfig | null): number {
  const raw = config?.remoteControlBudget ?? MAC_REMOTE_CONTROL_BUDGET_DEFAULT;
  return Math.min(MAC_REMOTE_CONTROL_BUDGET_MAX, Math.max(1, Math.round(raw)));
}

export type MacRemoteControlAdmission =
  | { ok: true }
  | { ok: false; error: string };

export function admitMacRemoteControl(activeMacSessions: number, budget: number): MacRemoteControlAdmission {
  if (activeMacSessions < budget) return { ok: true };
  return {
    ok: false,
    error: `Mac-remotecontrol is op zijn limiet (${activeMacSessions} actief van ${budget}); wacht tot een Mac-sessie sluit`,
  };
}

// ---------------------------------------------------------------------------
// Central launch guard (every launch path passes through here)
// ---------------------------------------------------------------------------

export type HostLaunchDecision =
  | { ok: true; host: "agentbox"; transport: "local" }
  | { ok: true; host: "mac"; transport: "adapter"; adapter: MacLaunchAdapter }
  | { ok: false; error: string };

/**
 * The one guard every coding-agent launch passes. Legacy rows and requests
 * without a host run locally (agentbox), exactly as before. An explicit mac
 * launch fails closed unless a fresh, pin-matching, per-provider-proven
 * runtime is registered — it never degrades to a local provider spawn, and
 * it never swaps provider, account or model.
 */
export function guardExecutionHostLaunch(request: {
  agent?: string | null;
  executionHost?: string | null | undefined;
  sessionId?: string | null;
}): HostLaunchDecision {
  if (request.executionHost !== "mac") {
    // Missing (legacy), "agentbox", or an unrecognised persisted value on a
    // legacy row: local launch, the pre-contract behaviour.
    return { ok: true, host: "agentbox", transport: "local" };
  }
  const status = macRuntimeStatus(request.agent ?? null);
  if (!status.available) return { ok: false, error: status.reason };
  const adapter = macRuntime?.adapter;
  if (!adapter) return { ok: false, error: unverified("geen geregistreerde adapter") };
  return { ok: true, host: "mac", transport: "adapter", adapter };
}

/**
 * Validate a mac launch's full settings/containment against the per-provider
 * record WITHOUT handing it to an adapter. Shared by the external-adapter
 * path (launchViaMacAdapter) and the integrated harness-spawn path
 * (src/mac-chat/session.ts): every setting is either covered by the record
 * or explicitly refused — never silently dropped, never relaxed.
 */
export function validateMacLaunchVia(
  via: {
    agent: string;
    model?: string;
    thinkingLevel?: string;
    fastMode?: boolean;
    serviceTier?: string;
    cyberAccessProgram?: string;
    claudeAccountId?: string;
    containInAgentSlice?: boolean;
    sandbox?: string;
    egressProxyUrl?: string;
    role?: string;
  },
): { ok: true; record: MacProbeProviderRecord; containment: MacLaunchContainment } | { ok: false; error: string } {
  if (!MAC_CAPABLE_AGENTS.includes(via.agent as "aisdk" | "codex-aisdk")) {
    return { ok: false, error: `De Mac-host ondersteunt "${via.agent}" niet (alleen aisdk en codex-aisdk)` };
  }
  const status = macRuntimeStatus(via.agent);
  if (!status.available || !status.provider) {
    return {
      ok: false,
      error: status.available ? unverified(`geen per-provider attestation voor "${via.agent}"`) : status.reason,
    };
  }
  const record = status.provider;
  if (via.claudeAccountId !== undefined && via.claudeAccountId !== DEFAULT_CLAUDE_ACCOUNT_ID) {
    // Custom (VPS) account bindings are LOCAL: the Mac runs its own signed-in
    // sessions and an account copy would leak credentials. The DEFAULT
    // account is the box's own primary login marker — the Mac's own login is
    // the verified equivalent route, so "default" is allowed through as the
    // explicit own-login choice (item 22: never reject the normal payload,
    // never silently switch a custom account).
    return {
      ok: false,
      error: `claude-account "${via.claudeAccountId}" is lokaal gebonden; de Mac-route ondersteunt alleen de eigen Mac-login (default) — expliciet onbeschikbaar, geen accountkopie, geen stille accountwissel`,
    };
  }
  const unsupported = (setting: string): string =>
    `instelling "${setting}" is voor "${via.agent}" op de Mac-host niet getest/ondersteund; zet hem uit of laat de provider eerst bewijzen`;
  if (via.model !== undefined && !record.testedSettings.includes("model")) return { ok: false, error: unsupported("model") };
  if (via.thinkingLevel !== undefined && !record.testedSettings.includes("thinkingLevel")) return { ok: false, error: unsupported("thinkingLevel") };
  if (via.fastMode === true && !record.testedSettings.includes("fastMode")) return { ok: false, error: unsupported("fastMode") };
  if (via.serviceTier !== undefined && !record.testedSettings.includes("serviceTier")) return { ok: false, error: unsupported("serviceTier") };
  if (via.cyberAccessProgram !== undefined && !record.testedSettings.includes("cyberAccessProgram")) return { ok: false, error: unsupported("cyberAccessProgram") };
  const containment: MacLaunchContainment = {
    agentSlice: !!via.containInAgentSlice,
    sandbox: via.sandbox ?? "none",
    egressProxy: !!via.egressProxyUrl,
    ...(via.role ? { role: via.role } : {}),
  };
  const supported = record.supportedContainment;
  if (containment.agentSlice && !supported.agentSlice) {
    return { ok: false, error: "agent-slice-containment wordt op de Mac-host niet ondersteund voor deze sessie" };
  }
  if (containment.sandbox !== "none" && !supported.sandbox.includes(containment.sandbox)) {
    return { ok: false, error: `sandbox-modus "${containment.sandbox}" wordt op de Mac-host niet ondersteund` };
  }
  if (containment.egressProxy && !supported.egressProxy) {
    return { ok: false, error: "egress-beperking wordt op de Mac-host niet ondersteund; niet stil opengezet" };
  }
  if (containment.role && !supported.restrictedRoles) {
    return { ok: false, error: `restricted role "${containment.role}" wordt op de Mac-host niet ondersteund (geen promotie naar owner)` };
  }
  return { ok: true, record, containment };
}

/**
 * Hand a guarded mac launch to the adapter. The full request travels on
 * stdin inside the adapter; never argv. Every setting the caller set is
 * either FORWARDED or EXPLICITLY REFUSED — dropping fastMode, serviceTier,
 * cyberAccessProgram, claudeAccountId or containment silently is a contract
 * violation this function cannot commit:
 *
 * - claudeAccountId is always refused: account binding is local-only, the
 *   Mac runs its own signed-in sessions (no account copy, no promotion).
 * - model/thinkingLevel/fastMode/serviceTier/cyberAccessProgram must be
 *   covered by the provider record's testedSettings for this agent.
 * - containment (agent slice, sandbox mode, egress restriction, restricted
 *   role) must be within the record's supportedContainment; an unsupported
 *   dimension is refused, never relaxed to owner/open.
 */
export function launchViaMacAdapter(
  adapter: MacLaunchAdapter,
  via: {
    agent: string;
    sessionId: string;
    name: string;
    cwd: string;
    prompt?: string;
    model?: string;
    thinkingLevel?: string;
    fastMode?: boolean;
    serviceTier?: string;
    cyberAccessProgram?: string;
    claudeAccountId?: string;
    resume?: string;
    omgUser?: string | null;
    containInAgentSlice?: boolean;
    sandbox?: string;
    egressProxyUrl?: string;
    role?: string;
  },
): MacLaunchDisposition {
  const validated = validateMacLaunchVia(via);
  if (!validated.ok) return { status: "rejected", error: validated.error };
  const { containment } = validated;
  const request: MacLaunchRequest = {
    type: "launch",
    requestId: deps.randomUUID(),
    sessionId: via.sessionId,
    agent: via.agent as "aisdk" | "codex-aisdk",
    name: via.name,
    cwd: via.cwd,
    ...(via.prompt !== undefined ? { prompt: via.prompt } : {}),
    ...(via.resume !== undefined ? { resume: via.resume } : {}),
    ...(via.omgUser !== null && via.omgUser !== undefined ? { omgUser: via.omgUser } : {}),
    settings: {
      ...(via.model !== undefined ? { model: via.model } : {}),
      ...(via.thinkingLevel !== undefined ? { thinkingLevel: via.thinkingLevel } : {}),
      ...(via.fastMode !== undefined ? { fastMode: via.fastMode } : {}),
      ...(via.serviceTier !== undefined ? { serviceTier: via.serviceTier } : {}),
      ...(via.cyberAccessProgram !== undefined ? { cyberAccessProgram: via.cyberAccessProgram } : {}),
    },
    containment,
  };
  let disposition: MacLaunchDisposition;
  try {
    disposition = adapter.launch(request);
  } catch (error) {
    return {
      status: "rejected",
      error: sanitizeAdapterText(`mac adapter launch faalde: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
  if (disposition.status === "rejected") {
    return { status: "rejected", error: sanitizeAdapterText(disposition.error) || "mac adapter weigerde de launch" };
  }
  if (disposition.status === "unacknowledged") {
    return { status: "unacknowledged", requestId: disposition.requestId, error: sanitizeAdapterText(disposition.error) || "mac launch zonder duurzame bevestiging" };
  }
  // Enforce the acknowledgement contract even against a custom adapter: an
  // "acknowledged" without a job binding is not durable.
  if (!disposition.jobId || !disposition.jobId.trim()) {
    return {
      status: "unacknowledged",
      requestId: disposition.requestId,
      error: "adapter bevestigde zonder jobId; geen duurzame koppeling, dus niet als succes geboekt",
    };
  }
  return disposition;
}
