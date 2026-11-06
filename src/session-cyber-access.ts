/** Per-session Codex access-program choice, validated before any side effects. */
import { readModelDiscoveryCacheSync, type CodexModelCapabilities, type CyberAccessProgram } from "./model-discovery.ts";
import { resolveCyberAccessProgram } from "./codex-daybreak.ts";
import type { AisdkCommand, AisdkEntry } from "./aisdk-registry.ts";
import type { ManagedSession } from "./managed.ts";

type Choice = { ok: true; program?: CyberAccessProgram } | { ok: false; error: string };
export function resolveSessionCyberAccessProgram(input: {
  agent: string; model: string; requested?: unknown;
  capabilities?: Record<string, CodexModelCapabilities>;
}): Choice {
  if (input.requested === undefined || input.requested === null || input.requested === "") return { ok: true };
  if (input.agent !== "codex-aisdk") return { ok: false, error: "Daybreak is supported only by managed Codex chats" };
  if (typeof input.requested !== "string") return { ok: false, error: "cyberAccessProgram must be a program name" };
  try {
    const result = resolveCyberAccessProgram({ model: input.model, requested: input.requested,
      capabilities: input.capabilities ?? readModelDiscoveryCacheSync()?.providers["codex-aisdk"]?.modelCapabilities });
    return { ok: true, program: result.cyberAccessProgram };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type SessionRef = { agent?: string; model?: string | null; tmuxName?: string | null; busy?: boolean };
export function applySessionCyberAccessProgram(input: {
  session?: SessionRef | null; entry?: AisdkEntry | null; requested?: unknown;
  capabilities?: Record<string, CodexModelCapabilities>;
  append: (id: string, command: AisdkCommand) => unknown;
  patchEntry: (id: string, patch: Partial<AisdkEntry>) => unknown;
  patchManaged: (name: string, patch: Partial<ManagedSession>) => unknown;
}): ({ ok: true; program: CyberAccessProgram } | { ok: false; status: number; error: string }) {
  if (!input.session) return { ok: false, status: 404, error: "session not found" };
  const choice = resolveSessionCyberAccessProgram({ agent: input.session.agent ?? "", model: input.session.model ?? "",
    requested: input.requested, capabilities: input.capabilities });
  if (!choice.ok) return { ok: false, status: 400, error: choice.error };
  // Off is explicit Standard; omission must never accidentally inherit Daybreak.
  if (!choice.program) return { ok: false, status: 400, error: "expected { cyberAccessProgram: standard | daybreakBlue | daybreakRed }" };
  if (!input.entry || input.entry.agent !== "codex") return { ok: false, status: 409, error: "Codex control process is unavailable" };
  if (input.entry.cyberAccessProgramControl !== true) return { ok: false, status: 409,
    error: "This Codex chat predates Daybreak controls. Stop and resume this chat to retain its history and enable the control." };
  if (input.entry.busy || input.session.busy) return { ok: false, status: 409, error: "Wait for the current turn to finish before changing Daybreak" };
  input.append(input.entry.sessionId, { type: "set_cyber_access_program", cyberAccessProgram: choice.program });
  input.patchEntry(input.entry.sessionId, { cyberAccessProgram: choice.program });
  if (input.session.tmuxName) input.patchManaged(input.session.tmuxName, { cyberAccessProgram: choice.program });
  return { ok: true, program: choice.program };
}
