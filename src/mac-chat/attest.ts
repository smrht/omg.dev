#!/usr/bin/env bun
// Attestation workflow for the Mac execution host (item 20), honest-proof
// rewrite (primary review 2026-10-03).
//
// The supervisor's probe answers the frozen MacRuntimeProbeReport, but its
// per-provider parity records come ONLY from a primary-generated attestation
// file (state/attestation.json on the Mac) — the transport never invents
// parity, and neither does this tool. What this tool DOES:
//
//   1. probe  — collect the live report (identity, health, coordinator,
//      capacity; NO parity claims).
//   2. e2e    — run REAL provider turns over the real transport (ssh stream
//      → supervisor → real claude/codex login) through the SAME production
//      adapters live sessions use:
//        - claude: the official Agent SDK query() driven through
//          macClaudeSpawnFactory (src/mac-chat/claude-transport.ts);
//        - codex: CodexAppServerThread (src/agents/backends/
//          codex-app-server-session.ts) over createRemoteCodexTransport
//          (src/mac-chat/codex-transport.ts).
//      A turn counts as proved ONLY on strict terminal evidence:
//        - claude: a result message with subtype exactly "success",
//          is_error not true, and the expected token present in the text;
//        - codex: turn/completed with status "completed" for the thread id
//          the server RETURNED, with the expected token in the agent
//          message. Errors, quota refusals, timeouts, lost streams and
//          missing tokens NEVER prove parity; they are recorded as
//          "failed" (definitive negative evidence) or "unknown" (contact
//          lost before evidence — the requestId UUID is preserved so the
//          primary can reconcile with `ssh <target> status <uuid>`).
//      --facts-only skips all provider traffic (no model calls) and marks
//      parity unproven.
//   3. emit   — print the attestation JSON; the PRIMARY reviews it and
//      installs it on the Mac (state/attestation.json via the operator).
//
// Honesty rules baked into the record builder (buildProviderRecord):
//   - testedSettings lists ONLY settings actually exercised by the e2e turn
//     (currently exactly "model"). There is no free-form --settings flag:
//     a flag list was never proof that those settings were exercised.
//   - parity.chat is true ONLY when outcome === "proved". tools/memory are
//     never claimed by this tool (separate bridge parity run owns those).
//   - every non-skip record carries evidence.requestId/sessionId (UUIDs)
//     for reconciliation; unknown outcomes repeat the UUID in a note.
//
// Output is bounded: reply text and pre-result messages are capped
// (ATTEST_MAX_REPLY_BYTES), details are sanitized and truncated.
//
// Usage:
//   bun src/mac-chat/attest.ts --target <ssh-alias> --providers claude,codex \
//        [--facts-only] [--timeout-ms 180000]
//   bun src/mac-chat/attest.ts --check-file <attestation.json>
//
// Exit codes: 0 = emitted and every e2e turn proved (or facts-only / file
// valid); 2 = usage error; 3 = probe failed or an e2e turn failed or stayed
// unknown (the honest document is still emitted for review first).
import { macSshSpawn } from "./stream.ts";
import type { MacStreamDeps } from "./stream.ts";
import { sshProbeRuntime } from "./probe.ts";
import { readFileSync, writeFileSync } from "node:fs";
import {
  isMacStreamUuid,
  sanitizeStreamReason,
  sha256Hex,
  type MacStreamContext,
  type MacStreamHandshake,
} from "./wire.ts";
import { canonJsonBytes } from "./context.ts";
import { macClaudeSpawnFactory } from "./claude-transport.ts";
import { createRemoteCodexTransport } from "./codex-transport.ts";
import { CodexAppServerThread } from "../agents/backends/codex-app-server-session.ts";
import { CodexDaybreakError } from "../codex-daybreak.ts";
import { MAC_CLAUDE_REMOTE_EXECUTABLE } from "../agents/backends/aisdk-session.ts";

export const ATTEST_DEFAULT_CLAUDE_MODEL = "opus";
export const ATTEST_DEFAULT_CODEX_MODEL = "gpt-5.5";
export const ATTEST_TURN_TIMEOUT_MS = 180_000;
/** Cap on accumulated provider output kept by one attest turn. */
export const ATTEST_MAX_REPLY_BYTES = 1_048_576;

export type AttestOutcome = "proved" | "failed" | "unknown";

export type AttestTurnOptions = {
  target: string;
  model: string;
  /** Explicit expected token (tests); default is a fresh random nonce. */
  expectedToken?: string;
  /** Whole-turn deadline in ms (default ATTEST_TURN_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Accumulated-output cap in bytes (default ATTEST_MAX_REPLY_BYTES). */
  maxReplyBytes?: number;
};

export type AttestTurnEvidence = {
  provider: "claude" | "codex";
  /** UUID of the stream request — the reconciliation key for unknowns. */
  requestId: string;
  /** UUID of the attest session this turn belonged to. */
  sessionId: string;
  outcome: AttestOutcome;
  /** Bounded, sanitized explanation of the observed evidence. */
  detail: string;
  model: string;
  /** Codex only: the thread id the server RETURNED (never a local constant). */
  threadId?: string;
};

function attestToken(options: AttestTurnOptions): string {
  return options.expectedToken ?? `ATTEST-${crypto.randomUUID().slice(0, 8)}`;
}

function boundedDetail(raw: unknown, maxLen = 300): string {
  const text = raw == null ? "" : typeof raw === "string" ? raw : String(raw);
  const sane = sanitizeStreamReason(text, maxLen);
  return sane || "no detail";
}

function emptyWireContext(): MacStreamContext {
  return {
    revision: sha256Hex(canonJsonBytes({ instructions: [], skills: [], memory: [] })),
    instructions: [],
    skills: [],
    memory: [],
  };
}

function turnEvidence(
  base: Omit<AttestTurnEvidence, "detail" | "outcome">,
  outcome: AttestOutcome,
  detail: string,
): AttestTurnEvidence {
  return { ...base, outcome, detail: boundedDetail(detail) };
}

// ---------------------------------------------------------------------------
// Claude turn: real Agent SDK query() through the Mac spawn seam
// ---------------------------------------------------------------------------

/**
 * One REAL claude turn over the Mac stream. The SDK owns the single stdout
 * reader through macClaudeSpawnFactory (no hand-rolled racing reads here);
 * this function only consumes SDK messages, bounds what it keeps, and
 * classifies the outcome strictly:
 *   proved  — result subtype "success", is_error !== true, token present;
 *   failed  — definitive negative evidence (error-subtype result, is_error,
 *             success result without the token, refused handshake, output
 *             over the bound);
 *   unknown — contact lost before evidence (deadline, stream/process end
 *             without a result, other transport errors). The requestId is
 *             preserved for `ssh <target> status <requestId>` reconciliation.
 */
export async function runClaudeAttestTurn(
  deps: MacStreamDeps,
  opts: AttestTurnOptions,
): Promise<AttestTurnEvidence> {
  const token = attestToken(opts);
  const timeoutMs = opts.timeoutMs ?? ATTEST_TURN_TIMEOUT_MS;
  const cap = opts.maxReplyBytes ?? ATTEST_MAX_REPLY_BYTES;
  const requestId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const base = { provider: "claude" as const, requestId, sessionId, model: opts.model };
  // Property container: TS keeps callback assignments visible at later reads.
  const state: { handshake: MacStreamHandshake | null } = { handshake: null };

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abort = new AbortController();
  const q = query({
    prompt: `Antwoord met exact deze token en verder niets: ${token}`,
    options: {
      model: opts.model,
      permissionMode: "bypassPermissions",
      disallowedTools: ["AskUserQuestion"],
      // Harness contract (aisdk-session.ts mac route): hermetic standing
      // context. `[]` makes the SDK emit `--setting-sources=` (empty) so the
      // remote claude loads NO Mac-local user/project settings beyond the
      // lease-provisioned ones; UNDEFINED would emit no flag at all and the
      // remote CLI would apply its own defaults.
      settingSources: [] as never[],
      abortController: abort,
      // No local native claude dependency: without an explicit executable the
      // SDK resolves its platform optional dependency BEFORE the custom spawn
      // and dies on hosts without it (linux-x64: "Native CLI binary ... not
      // found"). The inert selector skips that resolution; the Mac supervisor
      // pins the real CLI.
      pathToClaudeCodeExecutable: MAC_CLAUDE_REMOTE_EXECUTABLE,
      spawnClaudeCodeProcess: macClaudeSpawnFactory(deps, {
        sessionId,
        target: opts.target,
        context: emptyWireContext(),
        mcpServers: {},
        settings: { model: opts.model },
        nextRequestId: () => requestId,
        onHandshake: (handshake) => {
          state.handshake = handshake;
        },
      }),
    },
  });

  let deadlineFired = false;
  const timer = setTimeout(() => {
    deadlineFired = true;
    abort.abort();
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  try {
    let seen = 0;
    for await (const message of q) {
      const m = message as unknown as Record<string, unknown>;
      if (m?.type !== "result") {
        // Bound everything observed before the result, not just what we keep.
        seen += JSON.stringify(m ?? {}).length;
        if (seen > cap) {
          return turnEvidence(base, "failed", `pre-result output exceeded the ${cap} byte bound`);
        }
        continue;
      }
      if (m.subtype !== "success") {
        const errors = Array.isArray(m.errors)
          ? m.errors.filter((e): e is string => typeof e === "string").slice(0, 3).join("; ")
          : "";
        return turnEvidence(
          base,
          "failed",
          `result subtype "${String(m.subtype)}" is not success${errors ? `: ${errors}` : ""}`,
        );
      }
      if (m.is_error === true) {
        return turnEvidence(base, "failed", "result flagged is_error despite success subtype");
      }
      const result = typeof m.result === "string" ? m.result : "";
      if (!result.includes(token)) {
        return turnEvidence(
          base,
          "failed",
          `result text did not contain the expected token (${result.length} chars observed)`,
        );
      }
      return turnEvidence(
        base,
        "proved",
        `claude result subtype success; expected token verified in reply (${result.length} chars); requestId=${requestId}`,
      );
    }
    // The query ended without a result message: the turn outcome was never
    // observed. Never a parity claim; reconcile by requestId.
    return turnEvidence(
      base,
      "unknown",
      deadlineFired
        ? `deadline (${timeoutMs}ms) hit before a result message; outcome not observed`
        : "claude stream ended without a result message; outcome not observed",
    );
  } catch (error) {
    if (deadlineFired) {
      return turnEvidence(base, "unknown", `deadline (${timeoutMs}ms) hit; outcome not observed`);
    }
    const handshake = state.handshake;
    if (handshake && handshake.status !== "ready") {
      return turnEvidence(
        base,
        "failed",
        `Mac-stream ${handshake.status}: ${sanitizeStreamReason(handshake.reason) || "geen reden opgegeven"}`,
      );
    }
    return turnEvidence(
      base,
      "unknown",
      `claude turn error before evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    // Guarantee the spawned child stops on every early return (no-op when
    // the query already completed).
    abort.abort();
  }
}

// ---------------------------------------------------------------------------
// Codex turn: CodexAppServerThread over the remote Mac transport
// ---------------------------------------------------------------------------

/**
 * Error strings that mean "contact lost / answer never arrived", not a
 * definitive negative answer. "Codex app-server closed during the turn" is
 * the close sentinel CodexAppServerThread emits when the child or stream
 * dies mid-turn (src/agents/backends/codex-app-server-session.ts), and
 * "timed out" covers request timeouts surfaced as stream errors. Both leave
 * the REMOTE turn outcome unobserved — unknown, never failed, never proved.
 */
function isUnobservedCodexError(message: string): boolean {
  return message.includes("closed during the turn") || /\btimed out\b/i.test(message);
}

/**
 * One REAL codex app-server turn over the Mac stream, driven through the
 * production CodexAppServerThread adapter (initialize handshake awaited,
 * thread/start RETURNED id adopted, turn/start bound to that id, only
 * status "completed" proves, failed/interrupted statuses reject) on top of
 * createRemoteCodexTransport (one pending stdout read; requests queue
 * behind the supervisor handshake). Strict classification:
 *   proved  — turn/completed(status "completed") for the returned thread
 *             with the expected token in the agent message;
 *   failed  — turn.failed, fatal error notices, JSON-RPC errors, empty or
 *             token-less replies, refused handshake, output over the bound;
 *   unknown — deadline, stream/child loss before evidence, request
 *             timeouts (remote outcome unobserved; requestId preserved).
 */
export async function runCodexAttestTurn(
  deps: MacStreamDeps,
  opts: AttestTurnOptions,
): Promise<AttestTurnEvidence> {
  const token = attestToken(opts);
  const timeoutMs = opts.timeoutMs ?? ATTEST_TURN_TIMEOUT_MS;
  const cap = opts.maxReplyBytes ?? ATTEST_MAX_REPLY_BYTES;
  const requestId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const base = { provider: "codex" as const, requestId, sessionId, model: opts.model };
  const state: { handshake: MacStreamHandshake | null } = { handshake: null };

  const transport = createRemoteCodexTransport({
    deps,
    sessionId,
    target: opts.target,
    context: emptyWireContext(),
    mcpServers: {},
    settings: { model: opts.model },
    nextRequestId: () => requestId,
    onHandshake: (handshake) => {
      state.handshake = handshake;
    },
  });
  const adapter = new CodexAppServerThread({
    model: opts.model,
    transport,
    requestTimeoutMs: Math.max(1_000, Math.min(30_000, timeoutMs)),
  });

  let deadlineFired = false;
  const timer = setTimeout(() => {
    deadlineFired = true;
    void adapter.close();
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  let reply = "";
  let seen = 0;
  let threadId: string | null = null;
  let verdict: AttestTurnEvidence | null = null;

  try {
    const { events } = await adapter.runStreamed(
      `Reply with exactly this token and nothing else: ${token}`,
    );
    for await (const event of events) {
      if (deadlineFired) break; // post-deadline evidence proves nothing
      if (event.type === "thread.started") {
        threadId = event.thread_id;
        continue;
      }
      if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          seen += event.item.text.length;
          if (event.type === "item.completed") reply += event.item.text;
          if (seen > cap) {
            verdict = turnEvidence(base, "failed", `agent reply exceeded the ${cap} byte bound`);
            break;
          }
        }
        continue;
      }
      if (event.type === "turn.completed") {
        verdict = reply.includes(token)
          ? turnEvidence(
              { ...base, ...(threadId ? { threadId } : {}) },
              "proved",
              `codex turn completed; expected token verified in the agent message (${reply.length} chars); threadId=${threadId ?? "?"}; requestId=${requestId}`,
            )
          : turnEvidence(
              base,
              "failed",
              `turn completed but the expected token was absent from the agent message (${reply.length} chars)`,
            );
        break;
      }
      if (event.type === "turn.failed") {
        verdict = turnEvidence(base, "failed", `codex turn failed: ${event.error.message}`);
        break;
      }
      if (event.type === "error") {
        verdict = isUnobservedCodexError(event.message)
          ? turnEvidence(base, "unknown", `outcome not observed (${event.message})`)
          : turnEvidence(base, "failed", event.message);
        break;
      }
    }
  } catch (error) {
    if (deadlineFired) {
      verdict = turnEvidence(base, "unknown", `deadline (${timeoutMs}ms) hit; outcome not observed`);
    } else {
      const handshake = state.handshake;
      if (handshake && handshake.status !== "ready") {
        verdict = turnEvidence(
          base,
          "failed",
          `Mac-stream ${handshake.status}: ${sanitizeStreamReason(handshake.reason) || "geen reden opgegeven"}`,
        );
      } else if (error instanceof CodexDaybreakError) {
        switch (error.code) {
          case "codex-error":
          case "turn-failed":
          case "empty-reply":
          case "protocol":
            verdict = turnEvidence(base, "failed", error.message);
            break;
          case "timeout":
          case "closed":
            verdict = turnEvidence(base, "unknown", `outcome not observed (${error.message})`);
            break;
          default:
            verdict = turnEvidence(base, "unknown", `outcome not observed: ${error.message}`);
        }
      } else {
        verdict = turnEvidence(
          base,
          "unknown",
          `codex turn error before evidence: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    clearTimeout(timer);
    await adapter.close();
  }

  if (!verdict) {
    verdict = turnEvidence(
      base,
      "unknown",
      deadlineFired
        ? `deadline (${timeoutMs}ms) hit before a terminal turn event`
        : "event stream ended without a terminal turn event; outcome not observed",
    );
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Record assembly + document validation
// ---------------------------------------------------------------------------

export type AttestProviderRecord = {
  id: "aisdk" | "codex-aisdk";
  parity: { chat: boolean; tools: boolean; memory: boolean };
  testedSettings: string[];
  supportedContainment: { agentSlice: boolean; sandbox: string[]; egressProxy: boolean; restrictedRoles: boolean };
  testedAt: number;
  notes?: string[];
  /** What the e2e run actually observed (absent for facts-only records). */
  evidence?: {
    provider: "claude" | "codex";
    requestId: string;
    sessionId: string;
    outcome: AttestOutcome;
    model?: string;
    /** Codex only: the thread id the server returned for the proven turn. */
    threadId?: string;
  };
};

/**
 * Build one provider record from observed evidence (or null for facts-only).
 * parity.chat is true ONLY for outcome "proved"; testedSettings lists ONLY
 * the settings the e2e turn actually exercised — today that is exactly
 * "model" (the turn pins settings.model on the wire and in the thread).
 * Unknown outcomes keep the requestId visible for reconciliation.
 */
export function buildProviderRecord(input: {
  provider: "claude" | "codex";
  evidence: AttestTurnEvidence | null;
  target: string;
  testedAt?: number;
}): AttestProviderRecord {
  const { provider, evidence, target } = input;
  const proved = evidence?.outcome === "proved";
  const notes: string[] = [];
  if (!evidence) {
    notes.push("facts-only: chat parity NOT claimed");
  } else if (evidence.outcome === "proved") {
    notes.push(`e2e-turn-ok: ${evidence.detail}`);
  } else if (evidence.outcome === "failed") {
    notes.push(`e2e-turn-failed: ${evidence.detail}`);
  } else {
    notes.push(`e2e-outcome-unknown: ${evidence.detail}`);
    notes.push(`reconcile: ssh ${target} status ${evidence.requestId}`);
  }
  return {
    id: provider === "claude" ? "aisdk" : "codex-aisdk",
    parity: { chat: proved, tools: false, memory: false },
    testedSettings: proved ? ["model"] : [],
    supportedContainment: { agentSlice: false, sandbox: [], egressProxy: false, restrictedRoles: false },
    testedAt: input.testedAt ?? Date.now(),
    notes,
    ...(evidence
      ? {
          evidence: {
            provider: evidence.provider,
            requestId: evidence.requestId,
            sessionId: evidence.sessionId,
            outcome: evidence.outcome,
            ...(evidence.model ? { model: evidence.model } : {}),
            ...(evidence.threadId ? { threadId: evidence.threadId } : {}),
          },
        }
      : {}),
  };
}

/**
 * Validate an attestation document. Frozen-shape checks stay compatible with
 * files this tool emitted before; records that carry `evidence` must be
 * self-consistent: parity.chat exactly when the evidence outcome is
 * "proved", and a parity claim must name at least one tested setting. This
 * is the anti-fabrication gate for installed files.
 */
export function parseAttestationDocument(data: unknown): { valid: boolean; reason?: string } {
  if (!data || typeof data !== "object") return { valid: false, reason: "document is not an object" };
  const providers = (data as { providers?: unknown }).providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    return { valid: false, reason: "providers must be a non-empty array" };
  }
  for (const r of providers) {
    const row = r as Partial<AttestProviderRecord> & { evidence?: Partial<NonNullable<AttestProviderRecord["evidence"]>> };
    if (row.id !== "aisdk" && row.id !== "codex-aisdk") return { valid: false, reason: "provider id must be aisdk or codex-aisdk" };
    const parity = row.parity as Partial<AttestProviderRecord["parity"]> | undefined;
    if (
      typeof parity?.chat !== "boolean" || typeof parity.tools !== "boolean" || typeof parity.memory !== "boolean"
    ) {
      return { valid: false, reason: "parity booleans missing" };
    }
    if (!Array.isArray(row.testedSettings) || row.testedSettings.some((s) => typeof s !== "string")) {
      return { valid: false, reason: "testedSettings must be a string array" };
    }
    if (typeof row.testedAt !== "number") return { valid: false, reason: "testedAt must be a number" };
    const containment = row.supportedContainment as Partial<AttestProviderRecord["supportedContainment"]> | undefined;
    if (typeof containment?.agentSlice !== "boolean" || !Array.isArray(containment.sandbox)) {
      return { valid: false, reason: "supportedContainment shape invalid" };
    }
    const evidence = row.evidence;
    if (evidence !== undefined) {
      if (
        (evidence.provider !== "claude" && evidence.provider !== "codex") ||
        !isMacStreamUuid(evidence.requestId) || !isMacStreamUuid(evidence.sessionId) ||
        (evidence.outcome !== "proved" && evidence.outcome !== "failed" && evidence.outcome !== "unknown")
      ) {
        return { valid: false, reason: "evidence shape invalid (provider/UUIDs/outcome)" };
      }
      if (parity.chat !== (evidence.outcome === "proved")) {
        return { valid: false, reason: "parity.chat contradicts evidence.outcome" };
      }
      if (parity.chat && row.testedSettings.length === 0) {
        return { valid: false, reason: "parity.chat claimed with no tested settings" };
      }
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const bool = (name: string): boolean => args.includes(name);

  const checkFile = flag("--check-file");
  if (checkFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(checkFile, "utf8"));
    } catch (error) {
      console.error(`cannot read attestation file: ${error instanceof Error ? error.message : String(error)}`);
      console.log("ATTESTATION-FILE-INVALID");
      return 3;
    }
    const verdict = parseAttestationDocument(parsed);
    console.log(verdict.valid ? "ATTESTATION-FILE-OK" : `ATTESTATION-FILE-INVALID${verdict.reason ? `: ${verdict.reason}` : ""}`);
    return verdict.valid ? 0 : 3;
  }

  const target = flag("--target");
  const providers = (flag("--providers") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is "claude" | "codex" => p === "claude" || p === "codex");
  const factsOnly = bool("--facts-only");
  const timeoutMs = Number(flag("--timeout-ms") ?? ATTEST_TURN_TIMEOUT_MS);
  const claudeModel = flag("--claude-model") ?? ATTEST_DEFAULT_CLAUDE_MODEL;
  const codexModel = flag("--codex-model") ?? ATTEST_DEFAULT_CODEX_MODEL;
  if (!target || !providers.length || !Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    console.error(
      "usage: attest.ts --target <alias> --providers claude,codex [--facts-only] [--timeout-ms 180000] [--claude-model m] [--codex-model m] | --check-file <path>",
    );
    return 2;
  }

  // 1) live probe — real identity/health facts, zero parity claims.
  const probe = await sshProbeRuntime(target, macSshSpawn);
  if (!probe.ok) {
    console.error(`PROBE-FAILED: ${probe.error}`);
    return 3;
  }
  const report = probe.report;
  console.error(`probed machine=${report.machineIdentity} os=${report.os.version} health=${report.health.power}/${report.health.policy}`);

  // 2) per-provider E2E over the REAL transport (unless --facts-only).
  const records: AttestProviderRecord[] = [];
  let allProved = true;
  for (const provider of providers) {
    if (factsOnly) {
      records.push(buildProviderRecord({ provider, evidence: null, target }));
      continue;
    }
    const evidence = provider === "claude"
      ? await runClaudeAttestTurn({ spawn: macSshSpawn }, { target, model: claudeModel, timeoutMs })
      : await runCodexAttestTurn({ spawn: macSshSpawn }, { target, model: codexModel, timeoutMs });
    console.error(`${provider}: outcome=${evidence.outcome} requestId=${evidence.requestId} — ${evidence.detail}`);
    if (evidence.outcome !== "proved") allProved = false;
    records.push(buildProviderRecord({ provider, evidence, target }));
  }

  // 3) emit for the primary to review and install on the Mac.
  const out = flag("--out");
  const document = JSON.stringify({ version: 1, generatedBy: "omg src/mac-chat/attest.ts", providers: records }, null, 2);
  if (out) {
    writeFileSync(out, document);
    console.error(`attestation written to ${out}`);
  } else {
    console.log(document);
  }
  return allProved ? 0 : 3;
}

// CLI entry: only when executed directly (bun src/mac-chat/attest.ts …);
// importing the module for tests must not run or exit the CLI.
if (import.meta.main) {
  process.exit(await main());
}
