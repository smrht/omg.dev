// SSH channel construction for the Mac provider stream transport.
//
// The ONLY ssh surface this repo builds. Host/user/identity/known_hosts come
// from the trusted local ssh client config; argv carries the pinned alias and
// the fixed forced-command verb, nothing else. No prompt, provider option,
// token or environment value ever lands on argv — the data plane is stdin.
import type { MacStreamProvider } from "./wire.ts";

/** Admin-pinned ssh alias (single token; everything else lives in ~/.ssh/config). */
export type MacSshTarget = string;

const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeSshTarget(target: string): boolean {
  return !!target && target.length <= 64 && SAFE_ALIAS.test(target);
}

export type SshVerb =
  | { kind: "probe" }
  | { kind: "stream" }
  | { kind: "status"; requestId: string }
  | { kind: "cancel"; requestId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Full ssh argv for one supervisor command. Deliberately rigid — EXACTLY the
 * four frozen verbs (probe|stream|status|cancel), nothing else:
 * - BatchMode: never prompt interactively from a harness context.
 * - StrictHostKeyChecking=yes: no new-host auto-accept; the trusted client
 *   config + known_hosts own the pinning.
 * - ClearAllForwardings: the transport must not open -R/-L channels.
 * - No -i/-p/User flags, no shell, no remote command construction beyond the
 *   fixed verb — the Mac side is a forced command (TRANSPORT-TASK).
 */
export function macSshArgv(target: MacSshTarget, verb: SshVerb): string[] | { error: string } {
  if (!isSafeSshTarget(target)) return { error: "ssh target alias is not a safe single token" };
  const tail: string[] = [];
  if (verb.kind === "probe" || verb.kind === "stream") {
    tail.push(verb.kind);
  } else {
    if (!UUID_RE.test(verb.requestId)) return { error: `${verb.kind} requires a UUID` };
    tail.push(verb.kind, verb.requestId);
  }
  return [
    "ssh",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=yes",
    target,
    ...tail,
  ];
}

/** Provider → supervisor verb mapping guard (never a free-form executable). */
export function providerAllowsStream(provider: MacStreamProvider): boolean {
  return provider === "claude" || provider === "codex";
}

/**
 * Assert that an argv we are about to hand to the OS carries no secret or
 * provider payload. Defense in depth: the builders above cannot produce one,
 * but a future edit must fail this check loudly instead of leaking.
 */
export function assertNoSecretsOnArgv(argv: readonly string[]): void {
  const joined = argv.join(" ");
  const banned = [
    /bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/,
    /--mcp-config\s+\//, // local temp mcp config path must not ride argv remotely
    /--append-system-prompt/,
    /--system-prompt\s+\S/,
    /--settings\s+\{/,
    /[A-Za-z0-9+/_=-]{40,}/,
  ];
  for (const pattern of banned) {
    if (pattern.test(joined)) {
      throw new Error("ssh argv failed the no-secret screen; refusing to spawn");
    }
  }
}
