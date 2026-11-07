/**
 * agentbox: one tree, two boxes (07-11-2026).
 *
 * Unset AGENTBOX_PROFILE means Sam's box, exactly as before. "neutral" is any
 * other box running this fork (Albin's): no Sam tools, no Sam runtime-contract
 * lines, no Taken tab, and the greeting uses AGENTBOX_OWNER_NAME.
 */
export type AgentboxProfile = "sam" | "neutral";

export function agentboxProfile(env: NodeJS.ProcessEnv = process.env): AgentboxProfile {
  return env.AGENTBOX_PROFILE?.trim().toLowerCase() === "neutral" ? "neutral" : "sam";
}

export function isSamBox(env: NodeJS.ProcessEnv = process.env): boolean {
  return agentboxProfile(env) === "sam";
}

/** The first name the UI greets. Sam's box keeps "Sam"; another box its own name or none. */
export function agentboxOwnerName(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.AGENTBOX_OWNER_NAME?.trim();
  if (name) return name;
  return isSamBox(env) ? "Sam" : null;
}

/** What the web app learns about the box, injected as window.__LFG_CONFIG__.agentbox. */
export function agentboxWebConfig(env: NodeJS.ProcessEnv = process.env) {
  const sam = isSamBox(env);
  return { profile: agentboxProfile(env), ownerName: agentboxOwnerName(env), taken: sam, defaultProject: sam ? "sites-beheer" : null };
}
