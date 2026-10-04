// Bridge URL helper for remote MCP entries (frozen wire shape).
//
// A Mac-hosted provider NEVER sees local loopback MCP URLs: every namespace
// is reached through the bridge at <publicUrl>/mcp/<name> with the
// short-lived session lease bearer token. Tokens ride the stream metadata
// (stdin), never argv.
//
// The bridge authorizes by LEASE, not by bearer alone: its auth path is
// sessionOf(req) → registry.lookup(lease.id) → token-hash match, so a request
// that names no session is 401 session_required (bridge.ts). MacBridgeHost
// mints lease ids as `mac-<central sessionId>` (bridge-host.ts mintLease);
// the URL therefore carries that lease id as the `session` query. The query
// is a NAME, not a secret — the bearer token remains the credential, and
// naming another session's lease is detected as cross_session_token.
export type BridgeEndpoint = {
  /** Public base URL of the bridge, e.g. https://agentbox2.tailXXXX.ts.net/<mount>. */
  publicUrl: string;
  /** The session lease bearer token minted by the control-plane. */
  leaseToken: string;
  /** Bridge lease id (MacBridgeHost mintLease: `mac-<central sessionId>`). */
  leaseId: string;
};

/** Lease-id convention shared with MacBridgeHost.mintLease (bridge-host.ts). */
export function macChatLeaseId(sessionId: string): string {
  return `mac-${sessionId}`;
}

export function bridgeNamespaceUrl(endpoint: BridgeEndpoint, namespace: string): string {
  const base = endpoint.publicUrl.replace(/\/+$/, "");
  return `${base}/mcp/${encodeURIComponent(namespace)}?session=${encodeURIComponent(endpoint.leaseId)}`;
}

/**
 * One bridge MCP entry in the frozen wire shape. The supervisor validates
 * the URL against the admin-pinned bridge base and materializes auth into a
 * private file/env for the native child — the token never rides argv.
 */
export function bridgeMcpServer(endpoint: BridgeEndpoint, namespace: string): {
  type: "http";
  url: string;
  bearerToken: string;
  headerName: "authorization";
} {
  return {
    type: "http",
    url: bridgeNamespaceUrl(endpoint, namespace),
    bearerToken: endpoint.leaseToken,
    headerName: "authorization",
  };
}

/**
 * The ONE builder both mac harnesses (aisdk-session.ts / codex-aisdk-session.ts)
 * emit their bridge MCP entries through. `sessionId` is the CENTRAL session id
 * the launcher minted the lease for — the Claude `--session` uuid or the Codex
 * `--key` uuid (launch.ts passes the same id to both mintLease and the
 * harness) — converted here into the lease id the bridge looks up.
 */
export function macBridgeMcpServers(env: {
  bridgeUrl: string;
  bridgeToken: string;
  /** Central session id (Claude --session / Codex --key). */
  sessionId: string;
  namespaces: readonly string[];
}): Record<string, { type: "http"; url: string; bearerToken: string; headerName: "authorization" }> {
  const endpoint: BridgeEndpoint = {
    publicUrl: env.bridgeUrl,
    leaseToken: env.bridgeToken,
    leaseId: macChatLeaseId(env.sessionId),
  };
  const servers: Record<string, { type: "http"; url: string; bearerToken: string; headerName: "authorization" }> = {};
  for (const name of env.namespaces) {
    servers[name] = bridgeMcpServer(endpoint, name);
  }
  return servers;
}
