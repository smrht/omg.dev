// Agentbox issue 1029 (v2): conditional close plus durable terminal receipts.
// The server-side guard stays synchronous and fail-closed: identity, registry
// state, pending command bytes and receipts are all re-read here, never taken
// from the caller's word.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Single source of truth for the idle-child policy; the /api route serves it
 * verbatim and omg_subagent_cleanup.py refuses to run against anything else. */
export const IDLE_CHILD_POLICY = {
  version: 2,
  orphanIdleSeconds: 300,
  childIdleSeconds: 1800,
  terminalGraceSeconds: 300,
} as const;

/** Ingest skew is only an additional time check. The command-file digest
 * invalidates receipts for ANY newer turn, including one inside this window. */
export const RECEIPT_SKEW_MS = 120_000;

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const TERMINAL_PREFIX = /^[*_\s]*\[subagent (complete|blocked|failed)\]/i;

export type FinalVerdict = "protected" | "complete" | "unknown";

export type TerminalReceipt = {
  v: 2;
  child: string;
  parent: string;
  pid: number;
  start: string;
  reportAtMs: number;
  commandToken?: string;
  state: "complete" | "blocked" | "failed";
  text: string;
};

/** Conservative classification of a child's final report text. Protection
 * patterns are broad (a wrong "protected" only keeps a session open); the
 * completion markers are deliberately narrow conjunctions. Mirror this exactly
 * in omg_subagent_cleanup.py:classify_final_text. */
export function classifyFinalText(text: string): FinalVerdict {
  if (typeof text !== "string" || !text.trim()) return "unknown";
  if (/^[*_\s]*\[subagent (?:blocked|failed)\]/i.test(text)) return "protected";
  if (/gepauzeerd|paused/i.test(text)) return "protected";
  if (/\bwachten op\b|\bwacht op\b|\bwaiting\b|\bawaiting\b/i.test(text)) return "protected";
  if (text.includes("?") && /beslis|besluit|keuze|decision|akkoord|goedkeur|approval|confirm|bevestig/i.test(text))
    return "protected";
  // A rejected review is a completed worker job; waiting still protects it.
  if (/\b(?:her)?review\s+(?:afgerond|voltooid|klaar|opgeslagen)\b|\beindoordeel\s*:/i.test(text)) return "complete";
  if (/\bAFGEKEURD\b|\bHOLD\b/.test(text)) return "protected";
  if (/^[*_\s]*\[subagent complete\]/i.test(text)) return "complete";
  if (/hercontrole klaar/i.test(text)) return "complete";
  if (/eindstatus:/i.test(text) && /\d+\s+LIVE\b/.test(text)) return "complete";
  if (/levering:/i.test(text) && /\bcommit\b/i.test(text) && /gepusht/i.test(text)) return "complete";
  return "unknown";
}

function combineVerdict(a: FinalVerdict, b: FinalVerdict): FinalVerdict {
  if (a === "protected" || b === "protected") return "protected";
  if (a === "complete" || b === "complete") return "complete";
  return "unknown";
}

export function readTerminalReceipt(data: string, sessionId: unknown): TerminalReceipt | null {
  try {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
    const r = JSON.parse(readFileSync(join(data, "agentbox", "terminal-receipts", sessionId + ".json"), "utf8"));
    if (!r || typeof r !== "object" || r.v !== 2 ||
        typeof r.child !== "string" || typeof r.parent !== "string" ||
        typeof r.start !== "string" || typeof r.text !== "string" ||
        typeof r.pid !== "number" || typeof r.reportAtMs !== "number" ||
        !Number.isFinite(r.pid) || !Number.isFinite(r.reportAtMs)) return null;
    return r;
  } catch {
    return null;
  }
}

export function writeTerminalReceipt(data: string, receipt: TerminalReceipt): boolean {
  try {
    const dir = join(data, "agentbox", "terminal-receipts");
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, receipt.child + ".json");
    const tmp = fp + ".tmp-" + process.pid;
    writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(tmp, fp);
    return true;
  } catch {
    return false;
  }
}

/** Pure receipt construction: binds child, parent, pid and process start to
 * this exact report. Null on anything malformed — the caller then simply does
 * not mint a receipt and the old idle floors keep applying. */
export function terminalReceiptFor(
  sender: { sessionId?: unknown; pid?: unknown },
  parentId: string,
  rawText: string,
  start: string,
): TerminalReceipt | null {
  const m = TERMINAL_PREFIX.exec(rawText);
  const child = typeof sender?.sessionId === "string" ? sender.sessionId : "";
  if (!m || !child || !SESSION_ID.test(child) || !parentId ||
      typeof sender?.pid !== "number" || !Number.isFinite(sender.pid) || !start) return null;
  return {
    v: 2,
    child,
    parent: parentId,
    pid: sender.pid,
    start,
    reportAtMs: Date.now(),
    state: m[1]!.toLowerCase() as TerminalReceipt["state"],
    text: rawText.slice(0, 4096),
  };
}

/** No command content leaves this function. Appending a new turn invalidates
 * the receipt even after that turn has been consumed and finished. */
function commandToken(data: string, sessionId: string): string | null {
  try { return createHash("sha256").update(readFileSync(join(data, "aisdk", sessionId + ".cmd"))).digest("hex"); }
  catch (e: any) { return e.code === "ENOENT" ? "missing" : null; }
}

/** Server-side mint: reads the child's real process start from /proc and
 * persists the receipt. Returns false whenever identity cannot be established. */
export function mintTerminalReceipt(data: string, sender: any, parentId: string, rawText: string): boolean {
  try {
    const identity = procIdentity(sender?.pid);
    if (!identity) return false;
    const receipt = terminalReceiptFor(sender, parentId, rawText, identity.start);
    const token = commandToken(data, sender.sessionId);
    if (!receipt || token === null) return false;
    receipt.commandToken = token;
    if (sender.busy === false && sender.last?.role === "assistant" && sender.last?.kind === "text" && typeof sender.lastActivityAt === "number") receipt.reportAtMs = sender.lastActivityAt;
    return writeTerminalReceipt(data, receipt);
  } catch {
    return false;
  }
}

/** A receipt only counts when it names THIS child, THIS parent (canonical or
 * native id), THIS pid and process start, and its report time still matches
 * the session's final activity within the ingest skew. Blocked and failed
 * receipts protect outright; anything else classifies by its own text. */
export function receiptVerdict(
  receipt: unknown,
  s: any,
  rows: any[],
  identity: { start: string; cgroup: string } | null,
  currentCommandToken?: string | null,
): FinalVerdict {
  if (!receipt || typeof receipt !== "object" || !s || !identity) return "unknown";
  const r = receipt as any;
  if (typeof currentCommandToken !== "string" || r.commandToken !== currentCommandToken) return "unknown";
  if (r.v !== 2 || r.child !== s.sessionId || r.pid !== s.pid || r.start !== identity.start) return "unknown";
  const parentRow = rows.find((row: any) => row.sessionId === s.parentSessionId);
  const parentBound = r.parent === s.parentSessionId ||
    (parentRow?.nativeSessionId && r.parent === parentRow.nativeSessionId);
  if (!parentBound) return "unknown";
  if (typeof s.lastActivityAt !== "number" ||
      typeof r.reportAtMs !== "number" ||
      Math.abs(s.lastActivityAt - r.reportAtMs) > RECEIPT_SKEW_MS) return "unknown";
  if (r.state === "blocked" || r.state === "failed") return "protected";
  return classifyFinalText(typeof r.text === "string" ? r.text : "");
}

export function idleChildAllowed(s: any, expected: any, rows: any[], entry: any,
  identity: { start: string; cgroup: string }, queued: boolean, now = Date.now(),
  extra: { receipt?: unknown; finalText?: string; commandToken?: string | null } = {}): boolean {
  if (!expected || !s || !entry || !s.managed || s.spawnedBy !== "subagent" || s.persistent || s.botId ||
      s.busy !== false || s.launching || s.status !== "ok" ||
      !s.parentSessionId || s.parentSessionId === s.sessionId ||
      s.last?.role !== "assistant" || s.last?.kind !== "text") return false;
  if (s.pid !== expected.pid || s.lastActivityAt !== expected.lastActivityAt ||
      identity.start !== expected.start || s.parentSessionId !== expected.parentSessionId ||
      entry.harnessPid !== s.pid || entry.busy !== false || entry.prompt ||
      entry.draftText || queued) return false;
  if (!identity.cgroup.endsWith(`/lfg-agent-${s.tmuxName}.service`) ||
      !/^lfg-[a-zA-Z0-9-]+$/.test(s.tmuxName ?? "")) return false;
  if (rows.some(r => r.parentSessionId === s.sessionId ||
      (s.nativeSessionId && r.parentNativeSessionId === s.nativeSessionId))) return false;
  const parentLive = rows.some(r => r.sessionId === s.parentSessionId ||
      (s.parentNativeSessionId && r.nativeSessionId === s.parentNativeSessionId));
  // Receipts and the current final report are weighed together; protection
  // always wins, only a clear completion earns the short grace.
  const verdict = combineVerdict(
    classifyFinalText(typeof extra.finalText === "string" ? extra.finalText : ""),
    receiptVerdict(extra.receipt, s, rows, identity, extra.commandToken));
  if (verdict === "protected") return false;
  const floorSeconds = verdict === "complete"
    ? IDLE_CHILD_POLICY.terminalGraceSeconds
    : parentLive
      ? IDLE_CHILD_POLICY.childIdleSeconds
      : IDLE_CHILD_POLICY.orphanIdleSeconds;
  const idle = now - s.lastActivityAt;
  return Number.isFinite(idle) && idle >= floorSeconds * 1000;
}

function procIdentity(pid: unknown): { start: string; cgroup: string } | null {
  try {
    if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]!;
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("::")[1]!;
    return { start, cgroup };
  } catch {
    return null;
  }
}

export function inspectIdleChild(s: any, expected: any, rows: any[], cached: any, data: string, finalText?: string): boolean {
  try {
    if (!cached) return false;
    const key = cached.sessionId;
    if (!/^[0-9a-f-]{36}$/.test(key)) return false;
    const entry = JSON.parse(readFileSync(join(data, "aisdk", key + ".json"), "utf8"));
    const cmd = join(data, "aisdk", key + ".cmd");
    let size = 0;
    try { size = statSync(cmd).size; } catch (e: any) { if (e.code !== "ENOENT") return false; }
    let consumed = 0;
    if (size) consumed = Number(readFileSync(cmd + ".cursor", "utf8").trim());
    const identity = procIdentity(s?.pid);
    if (!identity) return false;
    return idleChildAllowed(s, expected, rows, entry, identity, consumed !== size, Date.now(),
      { receipt: readTerminalReceipt(data, s?.sessionId), finalText, commandToken: commandToken(data, key) });
  } catch { return false; }
}

/** Per-session verdict for the policy endpoint. Same inputs and rules as the
 * close guard, so the cleaner's plan and the server's decision can't diverge. */
export function sessionIdleReport(s: any, rows: any[], data: string, finalText?: string):
  { verdict: FinalVerdict; floorSeconds: number; delivered: boolean } {
  const identity = procIdentity(s?.pid);
  const verdict = combineVerdict(
    classifyFinalText(typeof finalText === "string" ? finalText : ""),
    receiptVerdict(readTerminalReceipt(data, s?.sessionId), s, rows, identity, commandToken(data, s?.sessionId)));
  const delivered = receiptVerdict(readTerminalReceipt(data, s?.sessionId), s, rows, identity, commandToken(data, s?.sessionId)) !== "unknown";
  if (verdict === "protected") return { verdict, floorSeconds: 0, delivered };
  const parentLive = !!s && rows.some(r => r.sessionId === s.parentSessionId ||
      (s.parentNativeSessionId && r.nativeSessionId === s.parentNativeSessionId));
  const floorSeconds = verdict === "complete"
    ? IDLE_CHILD_POLICY.terminalGraceSeconds
    : parentLive
      ? IDLE_CHILD_POLICY.childIdleSeconds
      : IDLE_CHILD_POLICY.orphanIdleSeconds;
  return { verdict, floorSeconds, delivered };
}
