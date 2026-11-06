// Claude "Reset for free" grants (Opus 5.5 launch, program `cedar_ember`).
//
// Anthropic gates these grants to the claude.ai surface: the OAuth usage
// endpoint omg reads for the 5h/7d windows answers `ineligible_reason:
// "surface"` for the very same account. So the grant can only be read and
// redeemed as claude.ai itself does it: a same-origin fetch from a signed-in
// claude.ai page. The shared Computer browser holds that sign-in. We open a
// BACKGROUND tab (never the visible one a person may be watching), run the
// fetch inside the page, and close the tab again. No cookie ever leaves the
// browser.
//
// Reading never starts the Computer: when it is off we return the last result
// we saw (persisted), marked stale. Redeeming does start it, because the user
// explicitly asked for it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "./config.ts";
import { desktopStatus, startDesktop } from "./computer/desktop.ts";

export const CLAUDE_RESET_PROGRAM = "cedar_ember";
const CLAUDE_ORIGIN = "https://claude.ai";
// Lightweight same-origin document: the page fetch needs claude.ai's origin
// and cookies, not the 168-script app.
const ANCHOR_URL = `${CLAUDE_ORIGIN}/robots.txt`;
const READ_TIMEOUT_MS = 12_000;
const REDEEM_TIMEOUT_MS = 40_000;

export type ClaudeResetGrant = {
  id: string;
  label: string | null;
  resetsTotal: number;
  resetsLeft: number;
  startsAt: number | null; // epoch seconds
  endsAt: number | null; // epoch seconds
  clears: string[];
  usableNow: boolean;
  paused: boolean;
};

export type ClaudeResetState = {
  eligible: boolean;
  ineligibleReason: string | null;
  grants: ClaudeResetGrant[];
  nextGrantId: string | null;
  cooldownUntil: number | null; // epoch seconds
  checkedAt: number; // epoch ms
};

export type ClaudeResetRead =
  | { ok: true; state: ClaudeResetState; stale: boolean; note?: string }
  | { ok: false; note: string };

export type ClaudeResetOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed"
  | "cooldown"
  | "unavailable";

// ------------------------------------------------------------- parsing ----

function isoToSec(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.round(ms / 1000);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Map the `cedar_ember` block of claude.ai's usage payload. Null = not evaluated. */
export function parseClaudeResetBlock(block: unknown, now = Date.now()): ClaudeResetState | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const grants = Array.isArray(b.grants) ? b.grants : [];
  return {
    eligible: b.eligible === true,
    ineligibleReason: typeof b.ineligible_reason === "string" ? b.ineligible_reason : null,
    nextGrantId: typeof b.next_grant_id === "string" ? b.next_grant_id : null,
    cooldownUntil: isoToSec(b.cooldown_until),
    checkedAt: now,
    grants: grants
      .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
      .filter((g) => typeof g.id === "string" && g.id)
      .map((g) => ({
        id: g.id as string,
        label: typeof g.label === "string" ? g.label : null,
        resetsTotal: num(g.resets_total),
        resetsLeft: num(g.resets_left),
        startsAt: isoToSec(g.starts_at),
        endsAt: isoToSec(g.ends_at),
        clears: Array.isArray(g.clears) ? g.clears.filter((c): c is string => typeof c === "string") : [],
        usableNow: g.usable_now === true,
        paused: g.paused === true,
      })),
  };
}

/** Same shape the Codex banked-reset card renders. */
export function claudeResetCredits(state: ClaudeResetState, nowSec = Date.now() / 1000) {
  const credits = state.grants
    .filter((g) => g.resetsLeft > 0 && (g.endsAt == null || g.endsAt > nowSec))
    .map((g) => {
      const full = g.clears.includes("five_hour") && g.clears.includes("seven_day");
      const available = state.eligible && g.usableNow && !g.paused
        && (state.cooldownUntil == null || state.cooldownUntil <= nowSec);
      return {
        id: g.id,
        resetType: full ? "full" : g.clears.join(",") || null,
        status: available ? "available" : "unavailable",
        grantedAt: g.startsAt,
        expiresAt: g.endsAt,
        title: full ? "Full reset (5 hr + 7 day)" : "Rate-limit reset",
        description: g.label,
      };
    });
  const availableCount = state.grants
    .filter((g) => credits.some((c) => c.id === g.id))
    .reduce((sum, g) => sum + g.resetsLeft, 0);
  return { availableCount, credits };
}

// claude.ai's own result enum (reset_rate_limits): reset, already_used,
// not_limited, cooldown, ineligible, unavailable.
export function mapClaudeResetResult(body: unknown): ClaudeResetOutcome {
  const r = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  switch (r.result) {
    case "reset":
      return "reset";
    case "already_used":
      return "alreadyRedeemed";
    case "not_limited":
      return "nothingToReset";
    case "cooldown":
      return "cooldown";
    case "ineligible":
      return "noCredit";
    case "unavailable":
      return "unavailable";
  }
  throw new Error(
    `claude.ai answered an unknown reset result${typeof r.result === "string" ? ` (${r.result})` : ""}`,
  );
}

// ---------------------------------------------------------- persistence ----

const STATE_FILE = join(PATHS.data, "claude-web-resets.json");

function loadSaved(orgId: string): ClaudeResetState | null {
  try {
    const all = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, ClaudeResetState>;
    return all[orgId] ?? null;
  } catch {
    return null;
  }
}

function save(orgId: string, state: ClaudeResetState): void {
  try {
    let all: Record<string, ClaudeResetState> = {};
    try {
      all = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      /* first write */
    }
    all[orgId] = state;
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
  } catch {
    /* the cache is a nicety */
  }
}

// ------------------------------------------------------------ browser ----

type PageFetchResult = { status: number; body: unknown };

/**
 * Run one same-origin fetch inside a background claude.ai tab of the shared
 * Computer browser. Throws when the browser is off or unreachable.
 */
async function pageFetch(
  path: string,
  init: { method?: string; body?: unknown },
  timeoutMs: number,
): Promise<PageFetchResult> {
  const status = desktopStatus();
  if (!status.running || !status.cdpPort) throw new Error("computer-off");
  const ver = (await (await fetch(`http://127.0.0.1:${status.cdpPort}/json/version`, {
    signal: AbortSignal.timeout(3000),
  })).json()) as { webSocketDebuggerUrl?: string };
  if (!ver.webSocketDebuggerUrl) throw new Error("the Computer browser has no DevTools endpoint");

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let seq = 0;
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    const waiter = msg.id ? pending.get(msg.id) : undefined;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message ?? "CDP error"));
    else waiter.resolve(msg.result);
  };
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  let targetId: string | null = null;
  const deadline = Date.now() + timeoutMs;
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("cannot reach the Computer browser"));
      setTimeout(() => reject(new Error("Computer browser did not answer")), 3000);
    });
    ({ targetId } = await call("Target.createTarget", { url: ANCHOR_URL, background: true }));
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression: string) => {
      const r = await call(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page script failed");
      return r.result?.value;
    };
    // Wait for the anchor document to be on claude.ai's origin.
    for (;;) {
      const here = await evaluate("location.origin + '|' + document.readyState").catch(() => "");
      if (typeof here === "string" && here.startsWith(`${CLAUDE_ORIGIN}|`) && !here.endsWith("|loading")) break;
      if (Date.now() > deadline) throw new Error("claude.ai did not load in the Computer browser");
      await Bun.sleep(200);
    }
    const left = Math.max(2000, deadline - Date.now());
    const script = `(async () => {
      const init = ${JSON.stringify({
        method: init.method ?? "GET",
        headers: init.body === undefined ? {} : { "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })};
      const r = await fetch(${JSON.stringify(path)}, { ...init, credentials: "include", signal: AbortSignal.timeout(${left}) });
      let body = null; try { body = await r.json(); } catch {}
      return { status: r.status, body };
    })()`;
    return (await evaluate(script)) as PageFetchResult;
  } finally {
    if (targetId) await call("Target.closeTarget", { targetId }).catch(() => {});
    for (const w of pending.values()) w.reject(new Error("closed"));
    ws.close();
  }
}

function signedOut(status: number): boolean {
  return status === 401 || status === 403;
}

// ---------------------------------------------------------------- api ----

// Each live read opens (and closes) a background tab in the shared browser;
// the usage page refreshes every minute, the grant changes a few times a month.
const LIVE_TTL_MS = 5 * 60_000;
const live = new Map<string, { at: number; read: ClaudeResetRead }>();

/** Current grant state for one claude.ai organization. Never starts the Computer. */
export async function readClaudeWebResets(
  orgId: string,
  options: { force?: boolean } = {},
): Promise<ClaudeResetRead> {
  const hit = live.get(orgId);
  if (!options.force && hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.read;
  const read = await readClaudeWebResetsLive(orgId);
  if (read.ok && !read.stale) live.set(orgId, { at: Date.now(), read });
  else live.delete(orgId);
  return read;
}

async function readClaudeWebResetsLive(orgId: string): Promise<ClaudeResetRead> {
  const saved = loadSaved(orgId);
  try {
    const r = await pageFetch(
      `/api/organizations/${encodeURIComponent(orgId)}/usage?${CLAUDE_RESET_PROGRAM}=1&skip_spend=1`,
      {},
      READ_TIMEOUT_MS,
    );
    if (signedOut(r.status)) {
      return { ok: false, note: "Claude resets: sign in to claude.ai in the Computer browser" };
    }
    if (r.status !== 200) throw new Error(`claude.ai returned ${r.status}`);
    const block = (r.body as Record<string, unknown> | null)?.[CLAUDE_RESET_PROGRAM];
    const state = parseClaudeResetBlock(block);
    if (!state) throw new Error("claude.ai did not evaluate the reset program");
    save(orgId, state);
    return { ok: true, state, stale: false };
  } catch (error) {
    const off = error instanceof Error && error.message === "computer-off";
    if (saved) {
      return {
        ok: true,
        state: saved,
        stale: true,
        note: off
          ? "Claude resets as last seen; the Computer is off, so they were not rechecked."
          : "Claude resets as last seen; claude.ai could not be rechecked just now.",
      };
    }
    return {
      ok: false,
      note: off
        ? "Start the Computer once to check for Claude resets (claude.ai only)."
        : `Claude resets could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Redeem one grant exactly like claude.ai's "Reset for free" button. */
export async function consumeClaudeWebReset(input: {
  orgId: string;
  grantId: string;
  requestId: string;
}): Promise<ClaudeResetOutcome> {
  if (!desktopStatus().running) await startDesktop();
  const r = await pageFetch(
    `/api/organizations/${encodeURIComponent(input.orgId)}/reset_rate_limits`,
    {
      method: "POST",
      body: { program: CLAUDE_RESET_PROGRAM, grant_id: input.grantId, request_id: input.requestId },
    },
    REDEEM_TIMEOUT_MS,
  );
  if (signedOut(r.status)) throw new Error("Sign in to claude.ai in the Computer browser first");
  if (r.status === 429) throw new Error("claude.ai is rate limiting resets; try again in a minute");
  if (r.status < 200 || r.status >= 300) throw new Error(`claude.ai returned ${r.status}`);
  const outcome = mapClaudeResetResult(r.body);
  // Re-read so the card reflects the spent grant.
  await readClaudeWebResets(input.orgId, { force: true }).catch(() => {});
  return outcome;
}

/**
 * Worth looking at all? Only when the Computer browser is up or we saw a grant
 * before; otherwise the usage row stays exactly as it was (no extra requests).
 */
export function claudeWebResetsPossible(): boolean {
  if (desktopStatus().running) return true;
  try {
    return Object.keys(JSON.parse(readFileSync(STATE_FILE, "utf8"))).length > 0;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ org id ----

const orgByToken = new Map<string, string>();

/** The claude.ai organization behind a Claude Code OAuth token. */
export async function claudeOrgIdForToken(token: string): Promise<string | null> {
  const known = orgByToken.get(token);
  if (known) return known;
  const r = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const body = (await r.json().catch(() => null)) as { organization?: { uuid?: unknown } } | null;
  const uuid = typeof body?.organization?.uuid === "string" ? body.organization.uuid : null;
  if (uuid) orgByToken.set(token, uuid);
  return uuid;
}
