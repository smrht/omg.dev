// The /mcp/workspace endpoint of the Mac main-chat bridge.
//
// This is the ONLY tool surface the bridge implements itself: bounded file
// access inside the lease roots, compare-and-swap writes with a mandatory
// expected-revision SHA-256, and full central context (ordered instructions
// plus skill/memory manifests), re-read and re-hashed on every call. There is
// no shell tool and no delegation tool on purpose; `readiness` reports them
// as not_ready until the centralized runner integration exists (BRIDGE-TASK).
//
// The MCP layer is direct JSON-RPC 2.0 over HTTP POST, stateless, mirroring
// src/mcp-http.ts: one request, one buffered JSON reply, no session state.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeLease } from "./lease.ts";
import { sha256Hex } from "./lease.ts";
import { guardListedPath, listBounded, resolveWithinRoots } from "./guards.ts";
import { isUuid, payloadHashOf, type IdempotencyJournal } from "./journal.ts";
import { runExecCommand, type ExecResult } from "../exec.ts";

export const WORKSPACE_SERVER_NAME = "omg-mac-chat-workspace";
export const WORKSPACE_SERVER_VERSION = "1.0.0";

const KNOWN_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export interface WorkspaceLimits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
  maxListDepth: number;
}

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxReadBytes: 2 * 1024 * 1024,
  maxWriteBytes: 2 * 1024 * 1024,
  maxListEntries: 500,
  maxListDepth: 4,
};

export type WorkspaceDeps = {
  journal: IdempotencyJournal;
  limits?: Partial<WorkspaceLimits>;
  /** Re-checked right before a mutation lands; revoke must stop in-flight writes. */
  stillActive?: () => boolean;
  /**
   * Bounded shell execution for the `shell` tool (integration revision 2).
   * Default: the central one-shot runner (src/exec.ts). Injectable for tests.
   */
  exec?: (request: { command: string; cwd: string; timeoutMs?: number }) => Promise<ExecResult>;
  /** Per-lease shell admission: at most one concurrent command per lease. */
  shellGate?: () => { ok: true; release: () => void } | { ok: false; error: string };
};

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function jsonRpcResponse(id: JsonRpcId, result: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function toolError(id: JsonRpcId, text: string): Response {
  return jsonRpcResponse(id, {
    content: [{ type: "text", text }],
    isError: true,
  });
}

function toolOk(id: JsonRpcId, payload: unknown): Response {
  return jsonRpcResponse(id, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  });
}

/**
 * Honest, machine-readable capability statement. No fabricated readiness.
 * Item 24: namespace presence is NOT tool parity — every proxied namespace
 * reports whether its CENTRAL credential resolved (headers present) or rides
 * URL-only (auth-unresolved degraded state), without ever exposing values.
 */
export function workspaceReadiness(lease: BridgeLease): Record<string, unknown> {
  const namespaceAuth: Record<string, string> = {};
  for (const [name, target] of Object.entries(lease.namespaces)) {
    const adapted = target.url.includes("/mcp-adapted/");
    namespaceAuth[name] = adapted
      ? "stdio-adapted (central child, session identity env)"
      : Object.keys(target.headers).length > 0
        ? "auth-resolved (central credentials injected)"
        : "auth-unresolved (URL-only; baseline OAuth store not inherited — degraded, not tool parity)";
  }
  return {
    files: { list: "ready", read: "ready", write: "ready (CAS + idempotency journal)" },
    context: "ready (full ordered instructions, re-read and re-hashed per call)",
    shell: {
      status: "ready (bounded one-shot exec in the lease cwd; one concurrent command per lease; caps + timeout)",
    },
    proxiedNamespaces: Object.keys(lease.namespaces).sort(),
    namespaceAuth,
    delegation: {
      status: "via omg namespace",
      reason:
        "delegation runs through the original OMG tool on the proxied omg namespace with this session's identity; no bridge-local delegation tool exists",
    },
    live: false,
  };
}

export function workspaceTools(): unknown[] {
  return [
    {
      name: "list_files",
      description:
        "List files and directories under the session cwd (or a relative subpath). Bounded depth; skips .git, secrets and symlinks by policy.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path under the session cwd. Defaults to the cwd." },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "read_file",
      description:
        "Read one UTF-8 text file inside the approved roots. Returns content, byte size and the SHA-256 of the exact bytes returned.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite one text file with compare-and-swap: expectedSha256 must equal the file's current SHA-256, or null for a new file. callId is a caller-generated UUID used for exactly-once idempotency.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          expectedSha256: { type: ["string", "null"] },
          callId: { type: "string", format: "uuid" },
        },
        required: ["path", "content", "expectedSha256", "callId"],
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "get_context",
      description:
        "Full central context for this session: complete ordered instruction file contents with SHA-256 hashes, plus the discoverable skill and memory root manifests. Sources are re-read on every call.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "shell",
      description:
        "Run one bounded shell command in the session cwd on the Agentbox (login shell, hard output caps, timeout <= 120s). One command at a time per session. Long work belongs in a delegated session.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number", description: "Optional timeout in ms, clamped to [1000, 120000]." },
        },
        required: ["command"],
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: "readiness",
      description:
        "Capability statement of this bridge: what is implemented and tested, and what is explicitly not_ready (shell, delegation).",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
}

/** Hash + read one existing regular file without following symlinks. */
function readGuardedFile(absolute: string, cap: number): { ok: true; bytes: Buffer; sha256: string } | { ok: false; error: string } {
  let st;
  try {
    st = lstatSync(absolute);
  } catch {
    return { ok: false, error: "not found" };
  }
  if (!st.isFile()) return { ok: false, error: "not a regular file" };
  if (st.size > cap) return { ok: false, error: `file exceeds read cap (${st.size} > ${cap} bytes)` };
  const bytes = readFileSync(absolute);
  return { ok: true, bytes, sha256: sha256Hex(bytes) };
}

function atomicWrite(absolute: string, content: string): { sha256: string; bytes: number } {
  const dir = dirname(absolute);
  mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(content, "utf8");
  const tmp = join(dir, `.bridge-write-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeFileSync(fd, buf);
    // fsync the temp file so a crash after rename cannot leave empty content.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absolute);
  return { sha256: sha256Hex(buf), bytes: buf.length };
}

function fileShaOrNull(absolute: string): string | null {
  try {
    const st = lstatSync(absolute);
    if (!st.isFile()) return null;
    return sha256Hex(readFileSync(absolute));
  } catch {
    return null;
  }
}

async function callWriteFile(
  lease: BridgeLease,
  deps: WorkspaceDeps,
  limits: WorkspaceLimits,
  args: Record<string, unknown>,
  id: JsonRpcId,
): Promise<Response> {
  const fail = (text: string): Response =>
    toolError(id, text);

  const path = args.path;
  const content = args.content;
  const expected = args.expectedSha256;
  const callId = args.callId;
  if (typeof path !== "string" || typeof content !== "string") return fail("path and content (string) are required");
  if (expected !== null && typeof expected !== "string") return fail("expectedSha256 must be a hex string or null");
  if (expected !== null && !/^[0-9a-f]{64}$/i.test(expected)) return fail("expectedSha256 must be a 64-hex sha256 or null");
  if (!isUuid(callId)) return fail("callId must be a caller-generated UUID");
  if (Buffer.byteLength(content, "utf8") > limits.maxWriteBytes) {
    return fail(`content exceeds write cap (${limits.maxWriteBytes} bytes)`);
  }

  const guard = resolveWithinRoots(lease.roots, lease.cwd, path, "write");
  if (!guard.ok) return fail(`write denied: ${guard.reason}${guard.detail ? ` (${safeBasename(guard.detail)})` : ""}`);
  const absolute = guard.absolute;
  const payloadHash = payloadHashOf({ path, content, expectedSha256: expected });

  const claim = deps.journal.claim(lease.id, callId, payloadHash, absolute);
  if (claim.kind === "replay") {
    const outcome = claim.record.outcome;
    return toolOk(id, { replay: true, callId, recordedOutcome: outcome, isError: claim.record.isError ?? false });
  }
  if (claim.kind === "conflict") return fail("callId conflict: this callId was already used with a different payload");
  if (claim.kind === "unknown") {
    return fail(
      "outcome_unknown: this callId has an unfinished (in-flight or unreadable) claim, likely a crash; the write is NOT re-executed. Start a new callId after reconciling the file state.",
    );
  }

  return await deps.journal.withPathLock(absolute, async () => {
    if (deps.stillActive && !deps.stillActive()) {
      claim.finish({ kind: "denied", reason: "lease-revoked" }, true);
      return fail("write denied: lease no longer active");
    }
    // Re-run the symlink guard under the lock: the tree can change while we
    // waited for a previous writer on the same path.
    const reGuard = resolveWithinRoots(lease.roots, lease.cwd, path, "write");
    if (!reGuard.ok) {
      claim.finish({ kind: "denied", reason: reGuard.reason }, true);
      return fail(`write denied: ${reGuard.reason}`);
    }
    const actual = fileShaOrNull(absolute);
    const exists = existsSync(absolute);
    if (actual !== expected && !(expected === null && !exists)) {
      claim.finish({ kind: "cas-mismatch", path: absolute, expected, actual }, true);
      return fail(
        `revision conflict: expected ${expected ?? "null (new file)"}, found ${actual ?? "null"}; re-read the file and retry with a new callId`,
      );
    }
    let written: { sha256: string; bytes: number };
    try {
      written = atomicWrite(absolute, content);
    } catch (e) {
      // The mutation outcome is genuinely unknown (partial tmp is not renamed;
      // rename itself threw). Record in-flight and report honestly.
      return fail(`outcome_unknown: write attempt failed after claim (${(e as Error).name}); file state must be re-read before retry`);
    }
    claim.finish({ kind: "written", path: absolute, sha256: written.sha256, bytes: written.bytes }, false);
    return toolOk(id, { path: absolute, sha256: written.sha256, bytes: written.bytes, revision: written.sha256 });
  });
}

function safeBasename(p: string): string {
  return p.split("/").pop() ?? "";
}

function callGetContext(lease: BridgeLease, limits: WorkspaceLimits): Response {
  const instructions = lease.instructions.map((path, index) => {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return { order: index, path, error: "symlink rejected" };
      if (!st.isFile()) return { order: index, path, error: "not a regular file" };
      if (st.size > limits.maxReadBytes) return { order: index, path, error: "file exceeds read cap" };
      const bytes = readFileSync(path);
      return { order: index, path, sha256: sha256Hex(bytes), content: bytes.toString("utf8") };
    } catch {
      return { order: index, path, missing: true };
    }
  });

  const skills = lease.skillRoots.map((root) => {
    const guard = guardListedPath(root);
    if (!guard.ok) return { root, error: guard.reason };
    const discovered: { name: string; skillFile: string }[] = [];
    for (const entry of listBounded(root, limits.maxListEntries, 1)) {
      if (entry.type !== "dir") continue;
      const skillFile = join(entry.path, "SKILL.md");
      try {
        if (statSync(skillFile).isFile()) discovered.push({ name: entry.path.split("/").pop() ?? "", skillFile });
      } catch {}
    }
    return { root, skills: discovered };
  });

  const memory = lease.memoryRoots.map((root) => {
    const guard = guardListedPath(root);
    if (!guard.ok) return { root, error: guard.reason };
    const files = listBounded(root, limits.maxListEntries, 1)
      .filter((e) => e.type === "file")
      .map((e) => {
        const read = readGuardedFile(e.path, limits.maxReadBytes);
        return read.ok
          ? { path: e.path, bytes: read.bytes.length, sha256: read.sha256 }
          : { path: e.path, bytes: e.bytes, error: read.error };
      });
    return { root, files };
  });

  const revisionInput = JSON.stringify({
    instructions: instructions.map((i) => [i.path, i.sha256 ?? i.error ?? i.missing ?? null]),
    skills,
    memory,
  });

  return toolOk(null, {
    leaseId: lease.id,
    role: lease.role,
    cwd: lease.cwd,
    instructions,
    skills,
    memory,
    revision: sha256Hex(revisionInput),
    note: "complete ordered instruction contents; no summarized substitution",
  });
}

async function callShell(
  lease: BridgeLease,
  deps: WorkspaceDeps,
  args: Record<string, unknown>,
  id: JsonRpcId,
): Promise<Response> {
  const fail = (text: string): Response => toolError(id, text);
  if (typeof args.command !== "string" || !args.command.trim()) return fail("command (string) is required");
  if (args.command.length > 16_000) return fail("command exceeds the length cap");
  const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined;
  if (!deps.stillActive || !deps.stillActive()) return fail("shell denied: lease no longer active");
  const gate = deps.shellGate?.() ?? { ok: true as const, release: () => {} };
  if (!gate.ok) return fail(`shell denied: ${gate.error}`);
  try {
    const result = await (deps.exec ?? runExecCommand)({
      command: args.command,
      cwd: lease.cwd,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return toolOk(id, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      cwd: result.cwd,
    });
  } catch (error) {
    return fail(`shell failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    gate.release();
  }
}

/** Answer one /mcp/workspace HTTP request. Only POST carries JSON-RPC. */
export async function serveWorkspaceMcp(req: Request, lease: BridgeLease, deps: WorkspaceDeps): Promise<Response> {
  if (req.method === "DELETE") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "workspace MCP accepts POST (and DELETE for teardown) only" }), {
      status: 405,
      headers: { allow: "POST, DELETE", "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }
  if (Array.isArray(body) || typeof body !== "object" || body === null) {
    return jsonRpcError(null, -32600, "single JSON-RPC message expected (batching is not supported)");
  }
  const message = body as JsonRpcRequest;
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  switch (message.method) {
    case "initialize": {
      const requested = (message.params?.protocolVersion as string | undefined) ?? undefined;
      const negotiated = requested && KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return jsonRpcResponse(
        id,
        {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: WORKSPACE_SERVER_NAME, version: WORKSPACE_SERVER_VERSION },
        },
        { "mcp-protocol-version": negotiated },
      );
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
    case "ping":
      return jsonRpcResponse(id, {});
    case "tools/list":
      return jsonRpcResponse(id, { tools: workspaceTools() });
    case "tools/call": {
      const name = message.params?.name;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...deps.limits };
      if (name === "readiness") return toolOk(id, workspaceReadiness(lease));
      if (name === "get_context") return callGetContext(lease, limits);
      if (name === "shell") return await callShell(lease, deps, args, id);
      if (name === "write_file") return await callWriteFile(lease, deps, limits, args, id);
      if (name === "read_file" || name === "list_files") {
        const guard = resolveWithinRoots(
          lease.roots,
          lease.cwd,
          typeof args.path === "string" ? args.path : ".",
          "read",
        );
        if (!guard.ok) return toolError(id, `${name} denied: ${guard.reason}`);
        if (name === "list_files") {
          const entries = listBounded(guard.absolute, limits.maxListEntries, limits.maxListDepth).map((e) => ({
            path: e.path.slice(guard.absolute.length + 1) || e.path,
            type: e.type,
            bytes: e.bytes,
          }));
          return toolOk(id, { root: guard.absolute, entries });
        }
        const read = readGuardedFile(guard.absolute, limits.maxReadBytes);
        if (!read.ok) return toolError(id, `read_file: ${read.error}`);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
        } catch {
          return toolError(id, "read_file: content is not valid UTF-8 text");
        }
        return toolOk(id, { path: guard.absolute, bytes: read.bytes.length, sha256: read.sha256, content: text });
      }
      if (isNotification) return new Response(null, { status: 202 });
      return toolError(id, `unknown tool: ${String(name)}`);
    }
    default: {
      if (isNotification) return new Response(null, { status: 202 });
      if (!message.method) return jsonRpcError(id, -32600, "missing method");
      return jsonRpcError(id, -32601, `method not found: ${message.method}`);
    }
  }
}

/** Used by tests to place stray bytes without touching the UTF-8 path. */
export function writeRawBytesForTests(absolute: string, bytes: Uint8Array): void {
  writeFileSync(absolute, bytes);
}

/** Used by tests to remove fixtures; not part of the remote surface. */
export function removeForTests(absolute: string): void {
  try {
    unlinkSync(absolute);
  } catch {}
}
