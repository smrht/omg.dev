/**
 * agentbox: what this box is, from window.__LFG_CONFIG__.agentbox (serve.ts,
 * src/agentbox-profile.ts). Missing config (dev server, older serve) means
 * Sam's box, exactly as before.
 */
export type AgentboxWebConfig = { profile: "sam" | "neutral"; ownerName: string | null; taken: boolean; defaultProject: string | null };

const SAM: AgentboxWebConfig = { profile: "sam", ownerName: "Sam", taken: true, defaultProject: "sites-beheer" };

export function agentboxConfig(): AgentboxWebConfig {
  const raw = typeof window !== "undefined" ? (window as { __LFG_CONFIG__?: { agentbox?: Partial<AgentboxWebConfig> } }).__LFG_CONFIG__?.agentbox : undefined;
  if (!raw) return SAM;
  return {
    profile: raw.profile === "neutral" ? "neutral" : "sam",
    ownerName: raw.ownerName ?? null,
    taken: raw.taken !== false,
    defaultProject: raw.defaultProject ?? null,
  };
}

/** Greeting name: the box owner, else the roster name the caller already has. */
export function greetingName(fallback: string): string {
  return agentboxConfig().ownerName ?? fallback;
}
