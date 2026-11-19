import type { McpServer } from "@agentclientprotocol/sdk";
import { omgMcpServers } from "../../config.ts";

/**
 * The omg-served MCP endpoints for one session, in ACP's server shape.
 * `compactTools` asks the omg endpoint for a listing that fits clients which
 * hide large tools (Antigravity; see src/mcp-compact.ts).
 */
export function omgAcpMcpServers(sessionId: string, opts: { compactTools?: boolean } = {}): McpServer[] {
  const servers = omgMcpServers(sessionId).mcpServers ?? {};
  return Object.entries(servers).map(([name, server]) => ({
    type: "http",
    name,
    url: opts.compactTools && name === "omg" ? `${server.url}&tools=compact` : server.url,
    headers: Object.entries(server.headers).map(([hname, value]) => ({ name: hname, value })),
  }));
}
