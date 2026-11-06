# mac-chat-bridge — central source/tool bridge for manual Mac main chats

Implementation of `BRIDGE-TASK.md` (build `mac-headchat-build-20261003`, 2026-10-03).
Self-contained directory: no file outside `src/mac-chat-bridge/` was changed.
Not mounted anywhere by default; nothing here is deployed or live.

## What this is

A session-bound, authenticated HTTP handler factory that a later private Bun
server on the Agentbox can mount. The central Agentbox stays authoritative for
cwd/project/instructions/skills/memory and every existing OMG/MCP namespace.
A remote Mac main chat speaks to this bridge only, with:

- `/mcp/workspace` — owned MCP endpoint (direct JSON-RPC): `list_files`,
  `read_file`, `write_file` (CAS + idempotency journal), `get_context`,
  `readiness`.
- `/mcp/<namespace>` — verbatim proxy to the exact loopback upstream
  registered in the lease (omg, connectors, computer, executor,
  chrome-work, ...). Remote-supplied authorization/host/session headers are
  stripped and replaced with server-owned identity; redirects refused; SSE
  lifecycle headers and text/media payloads preserved up to hard caps.

## Mount example (integration, not done in this tranche)

```ts
import { createMacChatBridge, LeaseRegistry, newLeaseToken } from "./mac-chat-bridge/index.ts";

const registry = new LeaseRegistry();
// Control-plane (trusted local code only — never the bridge itself) registers
// one short-lived lease per Mac main chat session:
const token = newLeaseToken(); // hand to the Mac session over the existing ssh channel
registry.register({
  id: "mac-main-<uuid>",
  token,
  expiresAt: Date.now() + 30 * 60_000,
  cwd: "/home/samht/worktrees/mac-chat-<uuid>",
  roots: [{ path: "/home/samht/worktrees/mac-chat-<uuid>", read: true, write: true }],
  instructions: ["/home/samht/AGENTS.md", "/home/samht/worktrees/mac-chat-<uuid>/AGENTS.md"],
  skillRoots: ["/home/samht/.agents/skills"],
  memoryRoots: ["/home/samht/.agents/memory"],
  role: "mac-chat",
  namespaces: {
    omg: {
      url: "http://127.0.0.1:8766/mcp?session=<central-session-id>",
      headers: { "x-omg-session-id": "<central-session-id>", "x-omg-session-token": "<server-minted>" },
    },
    // connectors/computer/... exactly as the central config resolves them
  },
});

const bridge = createMacChatBridge({
  registry,
  journalDir: "/var/lib/omg/mac-chat-journal", // bridge-owned, NOT the lease cwd
});
Bun.serve({ hostname: "127.0.0.1", port: 8767, fetch: bridge.handle });
```

Revoke with `bridge.registry.revoke(leaseId)`; expiry is enforced per request.

## Security model (what is enforced, in code)

- Leases are registered programmatically by trusted local control-plane only.
  Token plaintext exists at registration and in the remote session's memory;
  the registry stores only SHA-256 and nothing logs tokens or headers.
- 401 unknown session / missing or wrong token; 403 cross-session token,
  expired lease (via lookup), unsupported role; 404 namespace not in lease —
  explicitly, never silently omitted. There is no anonymous or owner path.
- Remote cannot choose cwd, roots, role or upstream URL: those fields come
  from the lease; request query/headers cannot alter them.
- Workspace paths: inside approved roots only (deepest root wins), read/write
  per root; `.git*`, `.env*`, `.ssh/.aws/.gnupg`, `*.pem|.key|.keystore|.kdbx`,
  `id_rsa*`, `*credentials*/*secrets*` segments rejected even inside broad
  roots; symlinks rejected on every path component (root realpath included).
- Writes: mandatory `expectedSha256` (null only for a new file), atomic
  tmp+fsync+rename under a per-path single-writer lock, UUID `callId` claimed
  in a file-backed journal BEFORE mutation. Same id+payload → recorded result;
  same id+different payload → conflict; unfinished claim (crash) →
  `outcome_unknown`, never replayed. Lease activity re-checked under the lock.
- Proxy: loopback-only upstream (validated at registration AND at request
  time), `redirect: "error"`, per-request timeout, body cap (413) and output
  cap (502/stream error), GET/POST/DELETE only (MCP streamable-HTTP
  lifecycle), `mcp-session-id`/`mcp-protocol-version`/`last-event-id`
  forwarded, SSE responses streamed with the cap enforced.
- No shell tool, no delegation tool. `readiness` reports both as `not_ready`
  with reasons; that is the contract until the centralized runner integration
  exists. No owner permission expansion anywhere.

## Capability statement (honest)

| Capability | Status |
| --- | --- |
| Workspace list/read with guards | ready, unit-tested with local fixtures |
| Workspace CAS write + idempotency journal | ready, unit-tested (concurrency, crash-after-claim, conflicts) |
| get_context (full ordered instructions + manifests, re-hashed per call) | ready, unit-tested |
| Namespace proxy (auth replacement, SSE, caps, redirect refusal) | ready, unit-tested against injected fetch fixtures |
| Shell / delegation parity | **not_ready** — needs the existing centralized runner integration |
| Live mount on a private Bun server | **not done** — serve.ts untouched (other worker owns it) |
| Real Mac ↔ Agentbox transport (ssh forward etc.) | **not done** — INTEGRATION.md route, separate tranche |
| Provider/tool/workflow E2E parity | **not done** — CONTEXT-CONTRACT hard evidence boundary applies |

## Tests

`bun test src/mac-chat-bridge/` — local handler fixtures under
`/Users/samht/.cache/...` only; no network, no real upstream, no home access.
