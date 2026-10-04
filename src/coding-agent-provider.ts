import { composeDevinModel, defaultModelForAgent, OMG_MODELS } from "./agent-catalog.ts";
import {
  CODING_AGENT_ADAPTERS,
  type ActiveSessionAgentKind,
  type CodingAgentCapabilities,
  type CodingAgentDriver,
  type CodingAgentProduct,
} from "./coding-agent-adapters.ts";
import {
  guardExecutionHostLaunch,
  type ExecutionHostId,
} from "./execution-host.ts";
import { launchMacHostedSession } from "./mac-chat/launch.ts";
import { macBridgeHost } from "./mac-chat/bridge-host.ts";
import {
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  spawnManagedCopilotSdkSession,
  spawnManagedCursorAcpSession,
  spawnManagedFxAcpSession,
  spawnManagedDeepseekAcpSession,
  spawnManagedDevinAcpSession,
  spawnManagedGrokAcpSession,
  spawnManagedJcodeSdkSession,
  spawnManagedMuseMspSession,
  spawnManagedOpencodeAisdkSession,
  spawnManagedPiSession,
} from "./tmux.ts";
import type { CodexServiceTier } from "./service-tier.ts";
import type { SandboxMode } from "./sandbox/bwrap.ts";

export type CodingAgentLaunchRequest = {
  cyberAccessProgram?: import("./model-discovery.ts").CyberAccessProgram;
  agent: ActiveSessionAgentKind;
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  serviceTier?: CodexServiceTier;
  fastMode?: boolean;
  sessionId: string;
  omgUser?: string | null;
  containInAgentSlice?: boolean;
  claudeAccountId?: string;
  resume?: string;
  /**
   * Filesystem isolation for the session's harness (src/sandbox/bwrap.ts).
   * Only the process-supervised providers (aisdk, codex-aisdk, opencode, pi)
   * honour it; a terminal-backed agent ignores it because it reads its own
   * credentials from home.
   */
  sandbox?: SandboxMode;
  /**
   * Egress proxy URL for a restricted role (src/sandbox/egress-proxy.ts). When
   * set, the harness reaches only the allowlisted hosts. Same provider scope
   * as sandbox.
   */
  egressProxyUrl?: string;
  /**
   * Role the session runs under (restricted roles carry containment). Local
   * providers derive it from the owner row; the mac launch forwards it so an
   * unsupported restricted role is REFUSED remotely, never promoted to owner.
   */
  role?: string;
  /**
   * Host this launch runs on (src/execution-host.ts). Missing is the legacy
   * case and runs locally on the agentbox, exactly as before. "mac" passes
   * the central guard and, when a fresh per-provider verified runtime is
   * registered, hands the launch to the supervised adapter — never to a
   * local provider. Every setting below is forwarded in full or explicitly
   * refused there; nothing is silently dropped.
   */
  executionHost?: ExecutionHostId;
};

export type CodingAgentLaunchResult = {
  ok: boolean;
  error?: string;
  nativeSessionId?: string;
};

/**
 * One active coding-agent provider contract.
 *
 * Product identity is stable. Driver identity is an implementation detail.
 * Every new-session launch crosses this interface, including terminal-backed
 * providers that do not offer an SDK yet.
 */
export type CodingAgentProvider = {
  kind: ActiveSessionAgentKind;
  product: CodingAgentProduct;
  driver: CodingAgentDriver;
  capabilities: CodingAgentCapabilities;
  launch(request: CodingAgentLaunchRequest): CodingAgentLaunchResult;
};

function provider(
  kind: ActiveSessionAgentKind,
  launch: CodingAgentProvider["launch"],
): CodingAgentProvider {
  const adapter = CODING_AGENT_ADAPTERS[kind];
  return {
    kind,
    product: adapter.product,
    driver: adapter.driver,
    capabilities: adapter.capabilities,
    launch,
  };
}

export const ACTIVE_CODING_AGENT_PROVIDERS = {
  aisdk: provider("aisdk", (request) =>
    spawnManagedAisdkSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "opus",
      sessionId: request.sessionId,
      thinkingLevel: request.thinkingLevel,
      fastMode: request.fastMode,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      claudeAccountId: request.claudeAccountId,
      sandbox: request.sandbox,
      egressProxyUrl: request.egressProxyUrl,
    })),
  "codex-aisdk": provider("codex-aisdk", (request) =>
    spawnManagedCodexAisdkSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "gpt-5.5",
      key: request.sessionId,
      cyberAccessProgram: request.cyberAccessProgram,
      thinkingLevel: request.thinkingLevel,
      serviceTier: request.serviceTier,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
      sandbox: request.sandbox,
      egressProxyUrl: request.egressProxyUrl,
    })),
  omg: provider("omg", (request): CodingAgentLaunchResult => {
    const model = request.model ?? defaultModelForAgent("omg");
    if (!OMG_MODELS.includes(model)) return { ok: false, error: `unknown omg model "${model}"` };
    return ACTIVE_CODING_AGENT_PROVIDERS.opencode.launch({ ...request, model });
  }),
  opencode: provider("opencode", (request) => {
    if (!request.model) return { ok: false, error: "opencode model is required" };
    return spawnManagedOpencodeAisdkSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model,
      key: request.sessionId,
      thinkingLevel: request.thinkingLevel,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
      sandbox: request.sandbox,
      egressProxyUrl: request.egressProxyUrl,
    });
  }),
  jcode: provider("jcode", (request) =>
    spawnManagedJcodeSdkSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "auto",
      key: request.sessionId,
      thinkingLevel: request.thinkingLevel,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
    })),
  grok: provider("grok", (request) =>
    spawnManagedGrokAcpSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? defaultModelForAgent("grok"),
      key: request.sessionId,
      thinkingLevel: request.thinkingLevel,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
    })),
  cursor: provider("cursor", (request) =>
    spawnManagedCursorAcpSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "auto",
      key: request.sessionId,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
    })),
  fx: provider("fx", (request) =>
    spawnManagedFxAcpSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "auto",
      key: request.sessionId,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
    })),
  muse: provider("muse", (request) =>
    spawnManagedMuseMspSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? defaultModelForAgent("muse"),
      key: request.sessionId,
      thinkingLevel: request.thinkingLevel,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
    })),
  deepseek: provider("deepseek", (request) =>
    spawnManagedDeepseekAcpSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "deepseek-v4-flash",
      key: request.sessionId,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
    })),
  devin: provider("devin", (request) => {
    if (!request.model && !request.thinkingLevel && !request.fastMode) {
      return spawnManagedDevinAcpSession({
        name: request.name,
        cwd: request.cwd,
        prompt: request.prompt,
        model: "adaptive",
        key: request.sessionId,
        omgSessionId: request.sessionId,
        omgUser: request.omgUser,
        containInAgentSlice: request.containInAgentSlice,
      });
    }
    // Fast en denkniveau zijn variant-suffixen op de familieslug; composeer
    // hier de exacte uid (de harness krijgt dan geen apart thinkingLevel).
    const composed = composeDevinModel(
      request.model ?? "adaptive",
      request.thinkingLevel,
      request.fastMode,
    );
    return spawnManagedDevinAcpSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: composed,
      key: request.sessionId,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
    });
  }),
  pi: provider("pi", (request) =>
    spawnManagedPiSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "sonnet",
      key: request.sessionId,
      thinkingLevel: request.thinkingLevel,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
      sandbox: request.sandbox,
      egressProxyUrl: request.egressProxyUrl,
    })),
  copilot: provider("copilot", (request) =>
    spawnManagedCopilotSdkSession({
      name: request.name,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.model ?? "auto",
      key: request.sessionId,
      omgSessionId: request.sessionId,
      omgUser: request.omgUser,
      containInAgentSlice: request.containInAgentSlice,
      resume: request.resume,
    })),
} as const satisfies Record<ActiveSessionAgentKind, CodingAgentProvider>;

export function launchCodingAgentSession(
  request: CodingAgentLaunchRequest,
): CodingAgentLaunchResult {
  // Central host guard: every launch through this function passes it. Legacy
  // requests without a host run locally, unchanged. A mac launch goes through
  // the INTEGRATED route (src/mac-chat/launch.ts): the ordinary local harness
  // spawns with --execution-host mac, the provider subprocess streams to the
  // Mac over ssh, remote-init state is visible in the registry. It never
  // degrades to a local provider spawn; missing pins/probe fail closed.
  const decision = guardExecutionHostLaunch(request);
  if (!decision.ok) return { ok: false, error: decision.error };
  if (decision.transport === "adapter") {
    const launched = launchMacHostedSession(
      {
        agent: request.agent,
        sessionId: request.sessionId,
        name: request.name,
        cwd: request.cwd,
        ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
        ...(request.fastMode !== undefined ? { fastMode: request.fastMode } : {}),
        ...(request.serviceTier !== undefined ? { serviceTier: request.serviceTier } : {}),
        ...(request.cyberAccessProgram !== undefined ? { cyberAccessProgram: request.cyberAccessProgram } : {}),
        ...(request.claudeAccountId !== undefined ? { claudeAccountId: request.claudeAccountId } : {}),
        ...(request.resume !== undefined ? { resume: request.resume } : {}),
        ...(request.omgUser !== null && request.omgUser !== undefined ? { omgUser: request.omgUser } : {}),
        ...(request.containInAgentSlice !== undefined ? { containInAgentSlice: request.containInAgentSlice } : {}),
        ...(request.sandbox !== undefined ? { sandbox: request.sandbox } : {}),
        ...(request.egressProxyUrl !== undefined ? { egressProxyUrl: request.egressProxyUrl } : {}),
        ...(request.role !== undefined ? { role: request.role } : {}),
      },
      macBridgeHost(),
    );
    if (launched.ok) return { ok: true, ...(launched.pid !== undefined ? { pid: launched.pid } : {}) };
    return { ok: false, error: launched.error };
  }
  return ACTIVE_CODING_AGENT_PROVIDERS[request.agent].launch(request);
}
