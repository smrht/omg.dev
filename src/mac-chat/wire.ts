// Mac native-provider stream transport — wire codec.
//
// THIS IS THE ONE FROZEN CONTRACT (primary decision, WIRE-RECONCILIATION):
// the ORIGINAL INTEGRATION-WIRE shape, which the Mac supervisor is adapting
// to. INTEGRATION-WIRE.md documents it; no second schema exists. Exactly
// four ssh verbs exist (probe|stream|status|cancel) — there is NO provision
// verb and NO out-of-band Mac lease provisioning: everything rides the
// authenticated stream stdin, and the supervisor materializes MCP config and
// secrets into private files/env itself, validating mcp URLs against the
// admin-pinned bridge base.
//
// Request (first stdin line, ONE bounded JSON object, \n-terminated):
//   {transport:1, requestId, sessionId, provider:"claude"|"codex",
//    args:[native args, executable excluded],
//    context:{revision, instructions:[{order,path,sha256,content}],
//             skills:[...], memory:[...]},
//    mcp:{servers:{<name>:{type:"http", url, bearerToken,
//                          headerName:"authorization"}}},
//    settings:{model?, thinkingLevel?, fastMode?, serviceTier?,
//              cyberAccessProgram?},
//    model?, cwd?}
//
// Response (first stdout line): {"transport":1,"requestId",...,
//   "status":"ready"|...,"pid",...} — then RAW native stdout bytes.
// The client accepts "ready" and treats every other status (rejected,
// refused, exists, conflict, failed) as a non-ready terminal answer with the
// sanitized reason, so both the frozen wording and the peer's current
// spelling degrade safely.
import { createHash, randomUUID } from "node:crypto";

/** Wire schema version (metadata.transport / handshake.transport). */
export const MAC_STREAM_TRANSPORT = 1;

/** Bound on the metadata line — the frozen INTEGRATION-WIRE limit. */
export const MAC_METADATA_MAX_BYTES = 512 * 1024;

/** Bound on the handshake line (generous; supervisor lines are tiny). */
export const MAC_HANDSHAKE_MAX_BYTES = 16 * 1024;

export type MacStreamProvider = "claude" | "codex";

export type MacStreamContextInstruction = {
  order: number;
  path: string;
  sha256: string;
  content: string;
};

export type MacStreamContextSkill = {
  root: string;
  name: string;
  skillFile: string;
  sha256: string;
};

export type MacStreamContextMemoryFile = { root: string; path: string; sha256: string };

export type MacStreamContext = {
  revision: string;
  instructions: MacStreamContextInstruction[];
  skills: MacStreamContextSkill[];
  memory: MacStreamContextMemoryFile[];
};

export type MacStreamMcpServer = {
  type: "http";
  url: string;
  bearerToken: string;
  headerName?: string;
};

export type MacStreamSettings = {
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  serviceTier?: string;
  cyberAccessProgram?: string;
};

export type MacStreamMetadata = {
  transport: typeof MAC_STREAM_TRANSPORT;
  requestId: string;
  sessionId: string;
  provider: MacStreamProvider;
  /** Native argv EXCLUDING the executable, after client-side adaptation. */
  args: string[];
  context: MacStreamContext;
  mcp: { servers: Record<string, MacStreamMcpServer> };
  settings: MacStreamSettings;
  /** Optional exact model echo (display/audit). */
  model?: string;
  /** Optional: must equal the supervisor's provisioned scratch or it rejects. */
  cwd?: string;
};

export type MacStreamHandshake =
  | {
      transport: typeof MAC_STREAM_TRANSPORT;
      requestId: string | null;
      status: "ready";
      pid?: number;
      pgid?: number;
      cwd?: string;
      sessionId?: string;
      contractSha256?: string;
    }
  | {
      transport: typeof MAC_STREAM_TRANSPORT;
      requestId: string | null;
      status: "rejected" | "refused" | "exists" | "conflict" | "failed" | "reused";
      reason?: string;
      detail?: string;
      state?: string;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMacStreamUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Non-secret session-start digest for the LOCAL pending journal: binds
 * provider + central selections + context revision + lease namespace names.
 * (The supervisor computes its own contract digest over the stream request;
 * both are reconciliation keys, never success proofs.)
 */
export function macStreamContractDigest(meta: {
  sessionId: string;
  provider: MacStreamProvider;
  settings?: Record<string, unknown>;
  contextRevision?: string | null;
  mcpNames?: string[];
  resume?: string | null;
}): string {
  return sha256Hex(JSON.stringify({
    transport: MAC_STREAM_TRANSPORT,
    sessionId: meta.sessionId,
    provider: meta.provider,
    settings: meta.settings ?? {},
    contextRevision: meta.contextRevision ?? null,
    mcpServers: [...(meta.mcpNames ?? [])].sort(),
    resume: meta.resume ?? null,
  }));
}

export function newRequestId(): string {
  return randomUUID();
}

export type MetadataEncodeResult =
  | { ok: true; line: Uint8Array }
  | { ok: false; error: string };

/** Validate + encode the metadata document as the first stdin line. */
export function encodeMacStreamMetadata(meta: MacStreamMetadata): MetadataEncodeResult {
  if (meta.transport !== MAC_STREAM_TRANSPORT) return { ok: false, error: `transport must be ${MAC_STREAM_TRANSPORT}` };
  if (!isMacStreamUuid(meta.requestId)) return { ok: false, error: "requestId must be a UUID" };
  if (!isMacStreamUuid(meta.sessionId)) return { ok: false, error: "sessionId must be a UUID" };
  if (meta.provider !== "claude" && meta.provider !== "codex") {
    return { ok: false, error: 'provider must be "claude" or "codex"' };
  }
  if (!Array.isArray(meta.args) || meta.args.length === 0 || meta.args.some((a) => typeof a !== "string" || !a)) {
    return { ok: false, error: "args must be a non-empty list of native argument strings" };
  }
  if (meta.args.some((a) => a.includes("\0") || a.length > 8192)) {
    return { ok: false, error: "args contain NUL or an over-long token" };
  }
  if (!meta.context || typeof meta.context !== "object" ||
    typeof meta.context.revision !== "string" || !meta.context.revision ||
    !Array.isArray(meta.context.instructions)) {
    return { ok: false, error: "context must carry a revision and full ordered instructions" };
  }
  for (const instruction of meta.context.instructions) {
    if (!instruction || typeof instruction.path !== "string" ||
      typeof instruction.sha256 !== "string" || typeof instruction.content !== "string") {
      return { ok: false, error: "context.instructions entries must carry path, sha256 and FULL content" };
    }
  }
  if (!meta.mcp || typeof meta.mcp !== "object" || !meta.mcp.servers || typeof meta.mcp.servers !== "object") {
    return { ok: false, error: "mcp.servers object required" };
  }
  for (const [name, server] of Object.entries(meta.mcp.servers)) {
    if (!name || !/^[a-z0-9_.-]+$/i.test(name)) {
      return { ok: false, error: `mcp server name invalid: ${name}` };
    }
    if (!server || server.type !== "http" || typeof server.url !== "string" ||
      !/^https?:\/\//.test(server.url) || typeof server.bearerToken !== "string" || server.bearerToken.length < 16) {
      return { ok: false, error: `mcp server "${name}" must be {type:"http", url, bearerToken}` };
    }
  }
  if (!meta.settings || typeof meta.settings !== "object") {
    return { ok: false, error: "settings object required" };
  }
  if (meta.cwd !== undefined && (typeof meta.cwd !== "string" || !meta.cwd.startsWith("/"))) {
    return { ok: false, error: "cwd must be an absolute path when present" };
  }
  const json = JSON.stringify(meta);
  const bytes = new TextEncoder().encode(`${json}\n`);
  if (bytes.byteLength > MAC_METADATA_MAX_BYTES) {
    return { ok: false, error: `metadata exceeds ${MAC_METADATA_MAX_BYTES} bytes` };
  }
  return { ok: true, line: bytes };
}

export type HandshakeParseResult =
  | { ok: true; handshake: MacStreamHandshake; consumed: number; remainder: Uint8Array }
  | { ok: false; error: string; fatal: true };

/**
 * Incremental handshake decoder: feed stdout chunks until the first complete
 * JSON line arrives. On success `remainder` carries the bytes that followed
 * the handshake newline INSIDE THE CURRENT CHUNK (native provider output that
 * coalesced with the handshake — the stream client pipes them on verbatim),
 * and `consumed` is the byte offset WITHIN THAT SAME CHUNK where the raw
 * native stdout starts (newlineAt + 1). It is NOT the cumulative prefix
 * length: after a split handshake the current chunk restarts at its own
 * offset, and slicing the current chunk by the cumulative count would drop
 * payload bytes (item 33 — a 20+64 byte split dropped the entire payload).
 * The size bound applies ONLY to the handshake PREFIX (bytes before the
 * newline), never to the total buffer: one chunk may legitimately coalesce a
 * short handshake line with megabytes of native provider output (item 26 — a
 * 32 KiB coalesced chunk falsely tripped the total-buffer bound). The prefix
 * bound itself is incremental across chunks.
 */
export function createHandshakeDecoder(requestId: string): {
  push: (chunk: Uint8Array) => HandshakeParseResult | { pending: true };
  buffer: () => Uint8Array;
} {
  let prefix = new Uint8Array(0);
  let done = false;
  const appendPrefix = (chunk: Uint8Array): boolean => {
    const next = new Uint8Array(prefix.byteLength + chunk.byteLength);
    next.set(prefix, 0);
    next.set(chunk, prefix.byteLength);
    prefix = next;
    return prefix.byteLength <= MAC_HANDSHAKE_MAX_BYTES;
  };
  return {
    push(chunk) {
      if (done) throw new Error("handshake decoder used after completion");
      // Only bytes that could still belong BEFORE the newline count against
      // the prefix bound; the post-newline native data never does.
      const newlineAt = chunk.indexOf(0x0a);
      if (newlineAt < 0) {
        if (!appendPrefix(chunk)) {
          return { ok: false, error: "handshake line exceeds bound", fatal: true };
        }
        return { pending: true };
      }
      if (!appendPrefix(chunk.subarray(0, newlineAt))) {
        return { ok: false, error: "handshake line exceeds bound", fatal: true };
      }
      const rest = chunk.subarray(newlineAt + 1);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(prefix).trim();
      done = true;
      // The remainder is explicit: raw native bytes that shared this chunk
      // with the handshake tail. `consumed` is the offset within THIS chunk
      // (newlineAt + 1) so slicing the current chunk can never drop payload.
      const consumed = newlineAt + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, error: "handshake is not valid JSON", fatal: true };
      }
      const v = parsed as Partial<MacStreamHandshake> & { transport?: unknown };
      if (!v || typeof v !== "object" || v.transport !== MAC_STREAM_TRANSPORT) {
        return { ok: false, error: "handshake does not match the stream contract", fatal: true };
      }
      const rid = typeof v.requestId === "string" ? v.requestId : null;
      if (rid !== null && rid !== requestId) {
        return { ok: false, error: "handshake requestId mismatch", fatal: true };
      }
      if (v.status === "ready") {
        return {
          ok: true,
          consumed,
          remainder: rest,
          handshake: {
            transport: MAC_STREAM_TRANSPORT,
            requestId: rid,
            status: "ready",
            ...(typeof v.pid === "number" && Number.isFinite(v.pid) ? { pid: v.pid } : {}),
            ...(typeof v.pgid === "number" && Number.isFinite(v.pgid) ? { pgid: v.pgid } : {}),
            ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
            ...(typeof v.sessionId === "string" ? { sessionId: v.sessionId } : {}),
            ...(typeof v.contractSha256 === "string" ? { contractSha256: v.contractSha256 } : {}),
          },
        };
      }
      const status = v.status;
      if (status === "rejected" || status === "refused" || status === "exists" || status === "conflict" || status === "failed" || status === "reused") {
        return {
          ok: true,
          consumed,
          remainder: rest,
          handshake: {
            transport: MAC_STREAM_TRANSPORT,
            requestId: rid,
            status,
            ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
            ...(typeof v.detail === "string" ? { detail: v.detail } : {}),
            ...(typeof v.state === "string" ? { state: v.state } : {}),
          },
        };
      }
      return { ok: false, error: `unknown handshake status "${String(status)}"`, fatal: true };
    },
    buffer: () => prefix,
  };
}

/** One-line, secret-free reason text for user surfaces. */
export function sanitizeStreamReason(raw: string | undefined | null, maxLen = 240): string {
  if (!raw) return "";
  const collapsed = String(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen - 1)}…` : collapsed;
}
