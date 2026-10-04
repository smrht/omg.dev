// Integrated launch orchestration for Mac-hosted sessions (revision 2).
//
// A mac launch spawns the ORDINARY LOCAL HARNESS (aisdk-session /
// codex-aisdk-session) with `--execution-host mac`: the harness registers
// itself in the aisdk registry (durable local registration, remoteInit
// pending), opens the provider stream over ssh, and flips remoteInit when
// the handshake answers. This module:
//
//   1. validates the FULL settings/containment against the per-provider
//      probe record (validateMacLaunchVia — same refusals everywhere);
//   2. refuses when the admin config pins no ssh route or no bridge;
//   3. mints the bridge lease (provider-specific namespace map with the
//      session's real role, context/roots from central sources) BEFORE
//      anything spawns;
//   4. persists the pending remote-start journal BEFORE the harness spawns
//      (the FIRST stream id; every later stream id is journaled by the
//      harness itself via recordMacStartRequest);
//   5. spawns the harness with the lease token + namespace names in its
//      environment (never argv) and returns ok only once the harness exists.
//
// No static fake ack exists anywhere on this path: ok:true means "durable
// local harness in starting state with visible remote-init outcome", exactly
// the integrated contract. Fail-closed before any spawn otherwise.
import { parseMacChatConfig, validateMacLaunchVia, registeredMacLaunchAdapter } from "../execution-host.ts";
import { macStreamContractDigest, type MacStreamSettings } from "./wire.ts";
import { persistPendingMacStart } from "./pending.ts";
import { validatedCentralContext } from "./context.ts";
import { bridgeNamespaceUrl } from "./mcp.ts";
import type { MacBridgeHost } from "./bridge-host.ts";
import {
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  type ManagedHarnessSpawnResult,
} from "../tmux.ts";
import type { SandboxMode } from "../sandbox/bwrap.ts";
import type { CodexServiceTier } from "../service-tier.ts";

/** Environment keys the harness reads (token only in env, never argv). */
export const MAC_ENV_BRIDGE_URL = "LFG_MAC_BRIDGE_URL";
export const MAC_ENV_BRIDGE_TOKEN = "LFG_MAC_BRIDGE_TOKEN";
export const MAC_ENV_SSH_TARGET = "LFG_MAC_SSH_TARGET";
export const MAC_ENV_NAMESPACES = "LFG_MAC_NAMESPACES";
/** First stream requestId, persisted in the journal BEFORE the harness spawns. */
export const MAC_ENV_REQUEST_ID = "LFG_MAC_REQUEST_ID";

export type MacLaunchHostInput = {
  agent: string;
  sessionId: string;
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  serviceTier?: CodexServiceTier;
  cyberAccessProgram?: string;
  claudeAccountId?: string;
  resume?: string;
  omgUser?: string | null;
  containInAgentSlice?: boolean;
  sandbox?: SandboxMode;
  egressProxyUrl?: string;
  role?: string;
};

export type MacLaunchOutcome =
  | { ok: true; pid?: number; harness: "local"; remoteInit: "pending" }
  | { ok: false; error: string };

/** Injectable harness spawner — tests capture argv/env without touching HOME. */
export type MacHarnessSpawner = (input: MacLaunchHostInput, extraEnv: Record<string, string>) => ManagedHarnessSpawnResult;

function defaultSpawner(input: MacLaunchHostInput, extraEnv: Record<string, string>): ManagedHarnessSpawnResult {
  if (input.agent === "codex-aisdk") {
    return spawnManagedCodexAisdkSession({
      name: input.name,
      cwd: input.cwd,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      model: input.model ?? "gpt-5.5",
      key: input.sessionId,
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      ...(input.cyberAccessProgram !== undefined ? { cyberAccessProgram: input.cyberAccessProgram as never } : {}),
      ...(input.resume !== undefined ? { resume: input.resume } : {}),
      omgSessionId: input.sessionId,
      ...(input.omgUser !== null && input.omgUser !== undefined ? { omgUser: input.omgUser } : {}),
      containInAgentSlice: input.containInAgentSlice,
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      executionHost: "mac",
      extraEnv,
    });
  }
  return spawnManagedAisdkSession({
    name: input.name,
    cwd: input.cwd,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    model: input.model ?? "opus",
    sessionId: input.sessionId,
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
    omgSessionId: input.sessionId,
    ...(input.omgUser !== null && input.omgUser !== undefined ? { omgUser: input.omgUser } : {}),
    containInAgentSlice: input.containInAgentSlice,
    ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
    executionHost: "mac",
    extraEnv,
  });
}

/**
 * The integrated mac launch. `bridgeHost` is the serve-mounted bridge (owned
 * by serve); a missing host or missing pins fails closed with the concrete
 * reason, before any mutation.
 */
export function launchMacHostedSession(
  input: MacLaunchHostInput,
  bridgeHost: MacBridgeHost | null,
  opts: { log?: (line: string) => void; spawn?: MacHarnessSpawner } = {},
): MacLaunchOutcome {
  const log = opts.log ?? (() => {});
  const provider = input.agent === "codex-aisdk" ? "codex" as const : "claude" as const;
  // Full settings/containment validation FIRST (validateMacLaunchVia): the
  // account/setting/containment refusals are the strongest invariants and
  // must fire identically on every path, pins or no pins. Remote codex Fast
  // is SUPPORTED (item 17): it rides metadata.settings and the supervisor
  // injects the exact service-tier.ts argv natively.
  const validated = validateMacLaunchVia(input);
  if (!validated.ok) return { ok: false, error: validated.error };
  const parsed = parseMacChatConfig();
  if (!parsed.ok) return { ok: false, error: parsed.reason };
  const config = parsed.config;
  if (!config.ssh?.target) {
    return { ok: false, error: "Mac-hoofdchat: geen ssh-route gepind in de configuratie; leverancier-streams zijn niet beschikbaar" };
  }
  if (!config.bridge) {
    return { ok: false, error: "Mac-hoofdchat: geen centrale bridge gepind in de configuratie; tools/context kunnen niet veilig geleverd worden" };
  }
  if (!bridgeHost) {
    return { ok: false, error: "Mac-hoofdchat: centrale bridge is niet gemount op dit serve-proces" };
  }
  if (!registeredMacLaunchAdapter()) {
    return { ok: false, error: "Mac-hoofdchat: geen verse per-provider runtime-probe geregistreerd" };
  }

  // Central context + provider-specific bridge lease, all BEFORE the spawn.
  // Item 35: a REQUIRED instruction failure refuses the WHOLE launch here —
  // before any lease, journal entry or harness spawn — with the actionable
  // path+reason (never content). Optional skill/memory omissions stay
  // non-fatal inside the validated snapshot.
  const validatedContext = validatedCentralContext(provider, input.cwd);
  if (!validatedContext.ok) {
    return { ok: false, error: validatedContext.error };
  }
  const context = validatedContext.context;
  const namespaceMap = bridgeHost.buildNamespaces(provider, input.sessionId);
  const lease = bridgeHost.mintLease({
    sessionId: input.sessionId,
    provider,
    ...(input.role !== undefined ? { sessionRole: input.role } : {}),
    cwd: input.cwd,
    roots: [{ path: input.cwd, read: true, write: true }],
    instructions: context.instructions.map((i) => i.path),
    skillRoots: [...new Set(context.skills.map((s) => s.root))],
    memoryRoots: [...new Set(context.memory.map((m) => m.root))],
    namespaceMap,
  });
  const endpoint = { publicUrl: bridgeHost.publicUrl(), leaseToken: lease.token };
  const mcpNames = namespaceMap.mcpNames;

  // Pending remote start persisted BEFORE the harness (network) exists. The
  // minted requestId is the session's FIRST stream launch id — the harness
  // receives it via env and must use it for that launch; every later id is
  // journaled by the harness (recordMacStartRequest), so an unknown outcome
  // always reconciles by the id that is live on the Mac.
  const firstRequestId = crypto.randomUUID();
  const settings: MacStreamSettings = {
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
    ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
    ...(input.cyberAccessProgram !== undefined ? { cyberAccessProgram: input.cyberAccessProgram } : {}),
  };
  const contractSha256 = macStreamContractDigest({
    sessionId: input.sessionId,
    provider,
    settings,
    contextRevision: context.revision,
    mcpNames,
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
  });
  const pending = persistPendingMacStart({
    sessionId: input.sessionId,
    requestId: firstRequestId,
    contractSha256,
  });
  if (!pending.ok) return { ok: false, error: pending.error };

  const extraEnv: Record<string, string> = {
    [MAC_ENV_BRIDGE_URL]: bridgeHost.publicUrl(),
    [MAC_ENV_BRIDGE_TOKEN]: lease.token,
    [MAC_ENV_SSH_TARGET]: config.ssh.target,
    [MAC_ENV_NAMESPACES]: mcpNames.join(","),
    [MAC_ENV_REQUEST_ID]: firstRequestId,
  };
  void bridgeNamespaceUrl; // bridge URLs are derived identically in the harness

  const spawn = opts.spawn ?? defaultSpawner;
  const spawned = spawn(input, extraEnv);
  if (!spawned.ok) {
    bridgeHost.revoke(input.sessionId);
    return { ok: false, error: spawned.error ?? "mac-harness kon niet gestart worden" };
  }
  log(`[mac-chat] harness gestart voor sessie ${input.sessionId} (pid ${spawned.pid ?? "?"}); remoteInit pending`);
  return { ok: true, ...(spawned.pid !== undefined ? { pid: spawned.pid } : {}), harness: "local", remoteInit: "pending" };
}
