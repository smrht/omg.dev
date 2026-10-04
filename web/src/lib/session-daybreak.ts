// Daybreak (cyber access programs) for ordinary codex-aisdk chat sessions.
//
// The Threads picker has its own program selection (thread-model selection on
// /api/threads); this module is deliberately NOT that path. It covers the
// session surfaces only: the new-session composer launch payload and the
// per-session toggle on /api/sessions/:id/cyber-access-program.
//
// The vocabulary and the per-model metadata come from the server's model
// discovery (ModelCatalogItem.modelCapabilities), so the picker advertises
// only what the connected account's live catalog offered — never a static
// seed. Controls appear only for the codex-aisdk backend and only when the
// selected model offers a nonstandard program.
import { api } from "./omg-client";

export const CYBER_ACCESS_PROGRAMS = ["standard", "daybreakBlue", "daybreakRed"] as const;
export type CyberAccessProgram = (typeof CYBER_ACCESS_PROGRAMS)[number];

/** Per-model capability metadata as /api/coding-agents reports it. */
export type DaybreakModelCapabilities = {
  reasoningEfforts?: string[];
  cyberAccessPrograms?: string[];
};

/** Structural slice of the app's AgentModelCatalog; keeps this module App-free. */
export type DaybreakCatalogLike = {
  modelCapabilities?: Record<string, Record<string, DaybreakModelCapabilities | undefined>>;
};

/** The one backend whose ordinary chat sessions carry a Daybreak toggle. */
export const DAYBREAK_SESSION_AGENT = "codex-aisdk";

const PROGRAM_LABELS: Record<CyberAccessProgram, string> = {
  standard: "Uit",
  daybreakBlue: "Blue",
  daybreakRed: "Red",
};

/** Shown for the default "no explicit program" state. */
export const AUTOMATIC_PROGRAM_LABEL = "Automatisch";

export function parseCyberAccessProgram(value: unknown): CyberAccessProgram | null {
  return typeof value === "string" && (CYBER_ACCESS_PROGRAMS as readonly string[]).includes(value)
    ? (value as CyberAccessProgram)
    : null;
}

/** "Uit" / "Blue" / "Red"; anything absent or unknown reads as "Automatisch". */
export function daybreakLabel(value: string | null | undefined): string {
  const program = parseCyberAccessProgram(value);
  return program ? PROGRAM_LABELS[program] : AUTOMATIC_PROGRAM_LABEL;
}

export function isNonstandardProgram(value: string): boolean {
  return value === "daybreakBlue" || value === "daybreakRed";
}

/**
 * The full offered vocabulary for a selection, in fixed display order. Empty
 * unless the backend is codex-aisdk and live metadata listed programs for the
 * model — an unknown model honestly offers nothing, and no other backend gets
 * a toggle.
 */
export function cyberAccessProgramsFor(
  catalog: DaybreakCatalogLike | null | undefined,
  agent: string | null | undefined,
  model?: string | null,
): CyberAccessProgram[] {
  if (agent !== DAYBREAK_SESSION_AGENT || !model) return [];
  const offered = catalog?.modelCapabilities?.[agent]?.[model]?.cyberAccessPrograms;
  if (!offered?.length) return [];
  return CYBER_ACCESS_PROGRAMS.filter((program) => offered.includes(program));
}

/** A control exists only where at least one nonstandard program is offered. */
export function offersDaybreak(programs: readonly string[]): boolean {
  return programs.some(isNonstandardProgram);
}

/**
 * The launch-payload guard: a pending choice travels only when the model being
 * launched still offers it. A backend or model switch can leave a stale choice
 * in composer state for one render; this keeps it out of the request, so a
 * Daybreak flag is never sent to a model it was never picked for.
 */
export function resolveLaunchProgram(
  program: CyberAccessProgram | null,
  programs: readonly CyberAccessProgram[],
): CyberAccessProgram | null {
  return program && programs.includes(program) ? program : null;
}

/**
 * Set a live session's program. "Uit" is an explicit `standard` POST — once a
 * session is controlled, switching off is a real value, never an omission.
 */
export function setSessionCyberAccessProgram(
  sessionId: string,
  program: CyberAccessProgram,
  request: (path: string, init?: RequestInit) => Promise<unknown> = api,
): Promise<unknown> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/cyber-access-program`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cyberAccessProgram: program }),
  });
}
