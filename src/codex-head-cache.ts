// Compact, non-blocking codex rollout head cache (v3).
//
// The v2 cache (codex-heads.json) stored each rollout's FULL first user
// prompt, which grew the live file to ~700MB. Reading, parsing and
// re-serializing that blob blocked the server's event loop for seconds at
// boot and on every dirty flush. This module replaces it with a compact,
// append-only JSONL cache (codex-heads-v3.jsonl) that never stores a full
// prompt:
//
//   - matching (`samePrompt`) is preserved by hashing the whitespace-
//     normalized FULL prompt (sha256/base64url),
//   - managed-title matching (`promptStartsWithTitle`) is preserved by a
//     prefix preview of the normalized FULL prompt plus its full length and
//     hash; when a title is longer than the stored preview the answer is
//     "unknown" and callers must decide from the immutable rollout file —
//     never silently,
//   - display text (`promptDisplayText`) is preserved as a preview derived
//     from the FULL prompt AFTER runtime-contract stripping, so an envelope
//     never eats the preview.
//
// The v2 file is kept untouched forever: it is a migration input and a
// fallback, never rewritten or deleted by this code. Migration streams it in
// bounded chunks and only trusts files whose header is exactly the v2 shape
// ({"version":2,"heads":{…); anything else — future versions, corruption,
// foreign shapes — is ignored, never migrated, never marked complete.
//
// Concurrency: appends and compactions run under an advisory kernel flock on
// a permanent-inode lock file, the same primitive and discipline as the
// transcript write queue (see transcript-write-queue.ts): the lock file is
// never unlinked, and the kernel releases the lease on close or crash, so a
// slow live writer can never have its lock stolen — contenders fail closed
// and retry. A crash mid-append leaves at worst a short torn tail line,
// which the loader skips as malformed.
//
// This module must stay importable without sessions.ts (no circular deps,
// no side effects at import) so a worker thread can use it directly. Its
// only non-builtin imports are the pure stripOmgRuntimeContract helper and
// the lazy flock binding.
import { createHash } from "node:crypto";
import { appendFile, stat, writeFile, rm, rename, open } from "node:fs/promises";
import { existsSync, openSync, closeSync, fstatSync, constants } from "node:fs";
import { dlopen, read } from "bun:ffi";
import { stripOmgRuntimeContract } from "./omg-capabilities.ts";

/** Whitespace-only collapse used by sessions' old samePrompt comparison. */
export function normalizeMatchText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip an AI-SDK speaker prefix ("Human:"/"User:") from a prompt head. */
export function stripConversationPrefix(text: string): string {
  return text.replace(/^(?:Human|User):[ \t]+/i, "");
}

/** Normalization used by sessions' old promptStartsWithTitle comparison. */
export function normalizeTitleText(s: string): string {
  return stripConversationPrefix(s).replace(/\s+/g, " ").trim();
}

/**
 * One-line projection of a user prompt, identical to sessions.promptDisplayText:
 * strip the OMG runtime contract envelope and speaker prefix from the FULL
 * text, then collapse whitespace. Truncation for the stored preview happens
 * AFTER this, never before, so a long envelope cannot hide the actual task.
 */
export function displayTextOf(text: string): string {
  return stripConversationPrefix(stripOmgRuntimeContract(text)).trim().replace(/\s+/g, " ");
}

function hashText(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("base64url");
}

/** How much of the title-normalized prompt is kept to answer prefix tests. */
export const TITLE_PREVIEW_CHARS = 192;
/** How much of the display projection is kept for titles/cards/history. */
export const DISPLAY_PREVIEW_CHARS = 280;

/**
 * The prompt projection stored per rollout head. Compact by construction:
 * no field can carry a full prompt.
 */
export type PromptProjection = {
  /** Hash of the samePrompt-normalized FULL prompt; null ⇔ empty/absent. */
  promptHash: string | null;
  /** First TITLE_PREVIEW_CHARS of the title-normalized FULL prompt. */
  titlePreview: string;
  /** Full length of the title-normalized prompt. */
  titleLen: number;
  /** Hash of the title-normalized FULL prompt; null ⇔ empty. */
  titleHash: string | null;
  /** First DISPLAY_PREVIEW_CHARS of the display projection of the FULL prompt. */
  displayPreview: string;
  /** Whether displayPreview was cut short. */
  displayTruncated: boolean;
};

/** The compact v3 head: v2's CodexHead with firstUserText replaced. */
export type CodexHeadEntry = {
  id: string;
  cwd: string | null;
  createdAt: number | null;
  originator: string | null;
  sourceKind: string | null;
  prompt: PromptProjection;
};

const EMPTY_PROJECTION: PromptProjection = {
  promptHash: null,
  titlePreview: "",
  titleLen: 0,
  titleHash: null,
  displayPreview: "",
  displayTruncated: false,
};

/** Derive the compact prompt projection from a rollout's full first prompt. */
export function derivePromptProjection(firstUserText: string | null): PromptProjection {
  if (firstUserText === null || firstUserText === "") return EMPTY_PROJECTION;
  const match = normalizeMatchText(firstUserText);
  const title = normalizeTitleText(firstUserText);
  const display = displayTextOf(firstUserText);
  return {
    promptHash: match === "" ? null : hashText(match),
    titlePreview: title.slice(0, TITLE_PREVIEW_CHARS),
    titleLen: title.length,
    titleHash: title === "" ? null : hashText(title),
    displayPreview: display.slice(0, DISPLAY_PREVIEW_CHARS),
    displayTruncated: display.length > DISPLAY_PREVIEW_CHARS,
  };
}

/** Build a full head entry from parsed rollout meta plus its first prompt. */
export function deriveCodexHead(
  meta: {
    id: string;
    cwd: string | null;
    createdAt: number | null;
    originator: string | null;
    sourceKind: string | null;
  },
  firstUserText: string | null,
): CodexHeadEntry {
  return { ...meta, prompt: derivePromptProjection(firstUserText) };
}

/**
 * Hashed equivalent of sessions' old samePrompt(a, b): the caller holds the
 * cached side as a hash and the live side (a process command line) in full.
 */
export function samePromptHashed(promptHash: string | null, other: string | null): boolean {
  if (!promptHash || !other) return false;
  const cleaned = normalizeMatchText(other);
  if (cleaned === "") return false;
  return promptHash === hashText(cleaned);
}

/**
 * Prefix/equality test against the cached title projection. Returns false,
 * true, or "unknown" when the title is longer than the stored preview and
 * the prompt is longer than the preview — the one case the compact cache
 * cannot decide. Callers must then answer from the immutable rollout file,
 * never silently guess.
 */
export function titleMatches(prompt: PromptProjection, title: string | null | undefined): boolean | "unknown" {
  const t = title === null || title === undefined ? "" : normalizeTitleText(title);
  if (t === "") return false;
  if (prompt.titleLen === 0) return false;
  if (t.length <= TITLE_PREVIEW_CHARS) {
    return prompt.titleLen >= t.length && prompt.titlePreview.startsWith(t);
  }
  // Title longer than the preview: divergence inside the window is still
  // decidable from the stored prefix.
  if (!prompt.titlePreview.startsWith(t.slice(0, TITLE_PREVIEW_CHARS))) return false;
  // Equality stays decidable via hash+length.
  if (prompt.titleLen === t.length && prompt.titleHash !== null && prompt.titleHash === hashText(t)) {
    return true;
  }
  if (prompt.titleLen < t.length) return false;
  return "unknown";
}

// ---------------------------------------------------------------------------
// v3 file format (JSONL, one record per line, last record wins per path):
//   {"v":3,"p":"<rollout path>","h":<compact head>|null}   head or negative
//   {"v":3,"del":"<rollout path>"}                          tombstone
//   {"v":3,"end":1}                                         migration complete
// Compact head keys: i=id, c=cwd, a=createdAt, o=originator, s=sourceKind,
// ph=promptHash, th=titleHash, tp=titlePreview, tl=titleLen, dp=displayPreview,
// dtr=displayTruncated.
// ---------------------------------------------------------------------------

type WireHead = {
  i: string;
  c: string | null;
  a: number | null;
  o: string | null;
  s: string | null;
  ph: string | null;
  th: string | null;
  tp: string;
  tl: number;
  dp: string;
  dtr: boolean;
};

function entryToWire(e: CodexHeadEntry): WireHead {
  return {
    i: e.id,
    c: e.cwd,
    a: e.createdAt,
    o: e.originator,
    s: e.sourceKind,
    ph: e.prompt.promptHash,
    th: e.prompt.titleHash,
    tp: e.prompt.titlePreview,
    tl: e.prompt.titleLen,
    dp: e.prompt.displayPreview,
    dtr: e.prompt.displayTruncated,
  };
}

function wireToEntry(w: unknown): CodexHeadEntry | null {
  if (!w || typeof w !== "object") return null;
  const h = w as Partial<WireHead>;
  if (typeof h.i !== "string" || h.i === "") return null;
  return {
    id: h.i,
    cwd: typeof h.c === "string" ? h.c : null,
    createdAt: typeof h.a === "number" && Number.isFinite(h.a) ? h.a : null,
    originator: typeof h.o === "string" ? h.o : null,
    sourceKind: typeof h.s === "string" ? h.s : null,
    prompt: {
      promptHash: typeof h.ph === "string" ? h.ph : null,
      titlePreview: typeof h.tp === "string" ? h.tp : "",
      titleLen: typeof h.tl === "number" && Number.isFinite(h.tl) ? h.tl : 0,
      titleHash: typeof h.th === "string" ? h.th : null,
      displayPreview: typeof h.dp === "string" ? h.dp : "",
      displayTruncated: h.dtr === true,
    },
  };
}

function encodeSetLine(path: string, head: CodexHeadEntry | null): string {
  return JSON.stringify({ v: 3, p: path, h: head === null ? null : entryToWire(head) });
}

function encodeDeleteLine(path: string): string {
  return JSON.stringify({ v: 3, del: path });
}

const END_LINE = JSON.stringify({ v: 3, end: 1 });

/** Apply one v3 JSONL line to the map. "end" marks a completed migration. */
function applyV3Line(line: string, map: Map<string, CodexHeadEntry | null>): "end" | "ok" | "bad" {
  let rec: { v?: number; p?: string; h?: unknown; del?: string; end?: number };
  try {
    rec = JSON.parse(line) as typeof rec;
  } catch {
    return "bad";
  }
  if (!rec || typeof rec !== "object" || rec.v !== 3) return "bad";
  if (rec.end === 1) return "end";
  if (typeof rec.del === "string" && rec.del !== "") {
    map.delete(rec.del);
    return "ok";
  }
  if (typeof rec.p === "string" && rec.p !== "") {
    if (rec.h === null) {
      map.set(rec.p, null);
      return "ok";
    }
    const e = wireToEntry(rec.h);
    if (e) {
      map.set(rec.p, e);
      return "ok";
    }
    map.delete(rec.p); // malformed head: treat as absent (re-parse on demand)
    return "bad";
  }
  return "bad";
}

// ---------------------------------------------------------------------------
// flock on a permanent-inode lock file — same primitive and invariants as the
// transcript write queue (transcript-write-queue.ts): the file is never
// unlinked, ownership is a kernel lease released on close/crash, and there is
// deliberately NO stale-steal path: a lock that looks old may still belong to
// a live, slow writer, so contenders fail closed and retry instead.
// ---------------------------------------------------------------------------

let nativeFlock: { flock: (fd: number, operation: number) => number; errno: () => number } | undefined;

function flockApi() {
  if (nativeFlock) return nativeFlock;
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") throw new Error("Unsupported codex-heads lock platform");
  const errnoName = linux ? "__errno_location" : "__error";
  const library = dlopen(linux ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    [errnoName]: { args: [], returns: "ptr" },
  });
  nativeFlock = {
    flock: library.symbols.flock as unknown as (fd: number, operation: number) => number,
    // eslint-disable-next-line -- mirrors the proven binding in transcript-write-queue.ts
    errno: () => read.i32((library.symbols[errnoName] as any)()),
  };  return nativeFlock;
}

/**
 * Take the exclusive lock, or undefined when it is held (or the lock file is
 * unusable — e.g. a foreign object sits at its path). Never blocks, never
 * steals, never unlinks.
 */
function acquireHeadLock(lockPath: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch {
    return undefined; // unwritable/foreign path: fail closed
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o600 || st.size !== 0) {
      // Unexpected metadata: treat as contended rather than repairing.
      closeSync(fd);
      return undefined;
    }
    const api = flockApi();
    if (api.flock(fd, 6) === 0) return fd; // LOCK_EX | LOCK_NB
    const errno = api.errno();
    if (errno !== (process.platform === "darwin" ? 35 : 11)) {
      closeSync(fd);
      return undefined;
    }
    closeSync(fd); // held by someone else: fail closed
    return undefined;
  } catch {
    closeSync(fd);
    return undefined;
  }
}

/** Release by closing: the kernel drops the lease. The inode stays. */
function releaseHeadLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {}
}

// ---------------------------------------------------------------------------
// v2 → v3 streaming migration scanner
// ---------------------------------------------------------------------------

/**
 * Incrementally scan the `heads` object of a v2 cache file and emit each
 * (pathRaw, rawValueJSON) pair. The header is validated strictly: the text
 * before "heads" must be exactly `{"version":2,` modulo whitespace, the shape
 * our own v2 writer produced. Future versions, foreign shapes and corrupt
 * prefixes are rejected outright (fail closed — no migration, no entries).
 * Values may be arbitrarily large (full prompts) and span chunks; string
 * escapes, braces and quotes inside prompt strings are handled, and a
 * truncated EOF never counts as a clean close.
 */
class V2HeadScanner {
  private mode: "seek" | "preKey" | "key" | "preValue" | "value" | "done" = "seek";
  private carry = "";
  private keyRaw = "";
  private valueBuf = "";
  private nullBuf = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  malformed = 0;
  rejectedHeader = false;

  constructor(private readonly emit: (pathRaw: string, valueRaw: string | null) => void) {}

  get done(): boolean {
    return this.mode === "done";
  }

  /** Feed one decoded chunk; consumes what it can and retains the carry. */
  feed(text: string): void {
    let buf = this.carry + text;
    this.carry = "";
    let pos = 0;
    const n = buf.length;
    while (pos < n && this.mode !== "done") {
      switch (this.mode) {
        case "seek": {
          // The header must be validated from byte 0 of the stream, so the
          // buffer accumulates (bounded) until "heads" is found; a v2 writer
          // emits it within the first bytes of the file.
          const at = buf.indexOf('"heads"', pos);
          if (at < 0) {
            if (buf.length > 4096) {
              this.rejectedHeader = true;
              this.mode = "done";
              return;
            }
            this.carry = buf.slice(pos); // keep everything until the key arrives
            return;
          }
          // Strict header: only the exact v2 shape is migrated.
          if (!/^\{\s*"version"\s*:\s*2\s*,\s*$/.test(buf.slice(0, at))) {
            this.rejectedHeader = true;
            this.mode = "done";
            return;
          }
          // Skip the key and require the opening brace of the heads object.
          let i = at + 7;
          while (i < n && (buf[i] === " " || buf[i] === "\t")) i++;
          if (i >= n || buf[i] !== ":") {
            this.rejectedHeader = true;
            this.mode = "done";
            return;
          }
          i++;
          while (i < n && (buf[i] === " " || buf[i] === "\t")) i++;
          if (i >= n) {
            this.carry = buf.slice(at); // brace arrives in the next chunk
            return;
          }
          if (buf[i] !== "{") {
            this.rejectedHeader = true;
            this.mode = "done";
            return;
          }
          pos = i + 1;
          this.mode = "preKey";
          break;
        }
        case "preKey": {
          const ch = buf[pos];
          if (ch === " " || ch === "," || ch === "\n" || ch === "\r" || ch === "\t") {
            pos++;
            break;
          }
          if (ch === "}") {
            pos++;
            this.mode = "done";
            break;
          }
          if (ch === '"') {
            pos++;
            this.keyRaw = "";
            this.mode = "key";
            break;
          }
          // Unexpected shape: the file is not machine-written v2; stop.
          this.malformed++;
          this.mode = "done";
          break;
        }
        case "key": {
          let end = -1;
          for (let i = pos; i < n; i++) {
            if (this.escaped) {
              this.escaped = false;
              continue;
            }
            const ch = buf[i];
            if (ch === "\\") this.escaped = true;
            else if (ch === '"') {
              end = i;
              break;
            }
          }
          if (end < 0) {
            this.keyRaw += buf.slice(pos);
            this.carry = "";
            return; // key continues in the next chunk
          }
          this.keyRaw += buf.slice(pos, end);
          pos = end + 1;
          this.mode = "preValue";
          break;
        }
        case "preValue": {
          const ch = buf[pos];
          if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
            pos++;
            break;
          }
          if (ch === ":") {
            pos++;
            break;
          }
          if (ch === "n") {
            pos++;
            this.nullBuf = "n";
            this.valueBuf = "";
            this.depth = 0;
            this.inString = false;
            this.mode = "value";
            break;
          }
          if (ch === "{") {
            pos++;
            this.valueBuf = "{";
            this.depth = 1;
            this.inString = false;
            this.mode = "value";
            break;
          }
          this.malformed++;
          this.mode = "done";
          break;
        }
        case "value": {
          if (this.nullBuf !== "") {
            while (pos < n && this.nullBuf.length < 4) {
              this.nullBuf += buf[pos];
              pos++;
            }
            if (this.nullBuf.length < 4) {
              this.carry = "";
              return; // literal spans chunks
            }
            if (this.nullBuf !== "null") {
              this.malformed++;
              this.mode = "done";
              break;
            }
            this.nullBuf = "";
            this.mode = "preKey";
            try {
              this.emit(this.keyRaw, null);
            } catch {
              this.malformed++;
            }
            break;
          }
          let closed = false;
          while (pos < n) {
            const ch = buf[pos];
            pos++;
            if (this.inString) {
              if (this.escaped) this.escaped = false;
              else if (ch === "\\") this.escaped = true;
              else if (ch === '"') this.inString = false;
              this.valueBuf += ch;
              continue;
            }
            if (ch === '"') {
              this.inString = true;
              this.valueBuf += ch;
              continue;
            }
            if (ch === "{") this.depth++;
            else if (ch === "}") {
              this.depth--;
              if (this.depth === 0) {
                this.valueBuf += ch;
                closed = true;
                break;
              }
            }
            this.valueBuf += ch;
          }
          if (!closed) {
            this.carry = "";
            return; // value continues in the next chunk
          }
          const raw = this.valueBuf;
          this.valueBuf = "";
          this.mode = "preKey";
          try {
            this.emit(this.keyRaw, raw);
          } catch {
            this.malformed++;
          }
          break;
        }
      }
    }
    this.carry = pos >= n ? "" : buf.slice(pos);
  }

  /** True only when the heads object closed cleanly on a '}' (never on EOF). */
  get closedCleanly(): boolean {
    return this.mode === "done" && !this.rejectedHeader;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const FLUSH_DELAY_MS = 5_000;
const LOCK_RETRY_DELAYS_MS = [0, 25, 50, 100, 200, 400, 800];
const DEFAULT_V2_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_V3_CHUNK_BYTES = 1024 * 1024;
const MIGRATION_BATCH_ENTRIES = 500;
const MIGRATION_BATCH_BYTES = 512 * 1024;
const COMPACT_MIN_LINES = 2_000;

export type StoreStats = {
  live: number;
  negative: number;
  lines: number;
  dirty: number;
  migrated: boolean;
  malformedLines: number;
};

export type StoreOptions = {
  v3Path: () => string;
  v2Path: () => string;
  /** Test hook: read granularity for streaming loads/migration. */
  chunkBytes?: number;
  /** Test hook: awaited inside the write lock just before each append. */
  beforeAppend?: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One store per process (sessions.ts creates the module-level instance with
 * lazy path closures so tests can repoint PATHS.data per fixture). All
 * public methods are safe to call concurrently; ready() is idempotent and
 * never rejects.
 */
export class CodexHeadStore {
  private readonly v3Path: () => string;
  private readonly v2Path: () => string;
  private readonly chunkBytes: number;
  private readonly beforeAppend?: () => Promise<void>;
  private readonly entries = new Map<string, CodexHeadEntry | null>();
  private readonly dirty = new Set<string>();
  private readonly dirtyRev = new Map<string, number>();
  private deletedPaths = new Set<string>();
  private readyPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInflight: Promise<boolean> | null = null;
  private compactInflight: Promise<void> | null = null;
  private totalLines = 0;
  private malformedLines = 0;
  private endMarked = false;

  constructor(opts: StoreOptions) {
    this.v3Path = opts.v3Path;
    this.v2Path = opts.v2Path;
    this.chunkBytes = opts.chunkBytes ?? DEFAULT_V3_CHUNK_BYTES;
    this.beforeAppend = opts.beforeAppend;
  }

  /** Load (and if needed migrate) the cache. Idempotent; never rejects. */
  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.load().catch(() => {
        // An unreadable cache is a slow start, not a failure — same contract
        // as v2: fall back to parsing rollout heads on demand.
      });
    }
    return this.readyPromise;
  }

  get(path: string): CodexHeadEntry | null | undefined {
    return this.entries.get(path);
  }

  /** Record a parsed head (or a negative result) and mark it dirty. */
  set(path: string, head: CodexHeadEntry | null): void {
    this.entries.set(path, head);
    this.dirty.add(path);
    this.dirtyRev.set(path, (this.dirtyRev.get(path) ?? 0) + 1);
    this.deletedPaths.delete(path);
  }

  /** Forget a path (rollout deleted). Persists as a tombstone. */
  delete(path: string): void {
    this.entries.delete(path);
    this.deletedPaths.add(path);
    this.dirty.add(path);
    this.dirtyRev.set(path, (this.dirtyRev.get(path) ?? 0) + 1);
  }

  stats(): StoreStats {
    let negative = 0;
    for (const v of this.entries.values()) if (v === null) negative++;
    return {
      live: this.entries.size - negative,
      negative,
      lines: this.totalLines,
      dirty: this.dirty.size,
      migrated: this.endMarked,
      malformedLines: this.malformedLines,
    };
  }

  /** Debounced persistence, mirroring v2's burst behavior. */
  scheduleFlush(): void {
    if (this.flushTimer || this.dirty.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_DELAY_MS);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Append every dirty record as one atomic batch under the flock. Returns
   * false (and keeps everything dirty for the next attempt) when the lock is
   * unavailable or the write fails. Records changed while a flush was in
   * flight stay dirty: each dirty path carries a revision counter and is
   * only cleared if it did not change since the batch snapshot.
   */
  flushNow(): Promise<boolean> {
    if (this.flushInflight) return this.flushInflight;
    this.flushInflight = this.doFlush().finally(() => {
      this.flushInflight = null;
    });
    return this.flushInflight;
  }

  private async appendLocked(data: string): Promise<boolean> {
    for (const delay of LOCK_RETRY_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      const fd = acquireHeadLock(this.lockPath());
      if (fd === undefined) continue;
      try {
        // Torn-tail guard: a crash can leave a truncated last line without a
        // trailing newline. Appending straight after it would concatenate
        // into one invalid line and silently lose the fresh record too, so a
        // separator newline is prepended (same single append, still atomic).
        let out = data;
        try {
          const st = await stat(this.v3Path());
          if (st.size > 0) {
            const fh = await open(this.v3Path(), "r");
            try {
              const b = Buffer.alloc(1);
              await fh.read(b, 0, 1, st.size - 1);
              if (b[0] !== 0x0a) out = "\n" + data;
            } finally {
              await fh.close();
            }
          }
        } catch {
          // Missing/unreadable file: a plain append creates it correctly.
        }
        if (this.beforeAppend) await this.beforeAppend();
        await appendFile(this.v3Path(), out, "utf8");
        return true;
      } catch {
        return false;
      } finally {
        releaseHeadLock(fd);
      }
    }
    return false;
  }

  private async doFlush(): Promise<boolean> {
    if (this.dirty.size === 0) return true;
    const batch: { path: string; rev: number; line: string }[] = [];
    for (const p of this.dirty) {
      batch.push({
        path: p,
        rev: this.dirtyRev.get(p) ?? 0,
        line: this.deletedPaths.has(p) ? encodeDeleteLine(p) : encodeSetLine(p, this.entries.get(p) ?? null),
      });
    }
    const data = batch.map((b) => b.line).join("\n") + "\n";
    const ok = await this.appendLocked(data);
    if (!ok) {
      // Best effort like v2: keep the records dirty for the next timer tick.
      this.scheduleFlush();
      return false;
    }
    this.totalLines += batch.length;
    // Only clear what this batch carried AND what did not change while the
    // append was in flight: a concurrent set/delete of the same path must
    // survive for the next flush.
    for (const b of batch) {
      if ((this.dirtyRev.get(b.path) ?? 0) === b.rev) {
        this.dirty.delete(b.path);
        this.dirtyRev.delete(b.path);
        this.deletedPaths.delete(b.path);
      }
    }
    void this.maybeCompact();
    return true;
  }

  private lockPath(): string {
    return `${this.v3Path()}.lock`;
  }

  private async maybeCompact(): Promise<void> {
    if (this.totalLines <= Math.max(COMPACT_MIN_LINES, 4 * this.entries.size)) return;
    if (this.compactInflight) return;
    this.compactInflight = this.compact().finally(() => {
      this.compactInflight = null;
    });
  }

  /**
   * Representation-only cleanup of DISK state: rewrite the file as one line
   * per committed record, last-record-wins, tombstones dropped. The
   * in-memory cache is deliberately NOT merged — another process may own
   * newer committed records or tombstones this instance has never seen, and
   * overlaying a stale local map would resurrect them. Pending dirty records
   * are not disk state either; they flush separately through appendLocked.
   *
   * The initial map read happens unlocked (so a concurrent append is never
   * blocked for the read), then the lock is taken and the file identity
   * (device/inode/size) re-checked: anything appended in between is picked
   * up by an authoritative re-read UNDER the lock, so no concurrent append
   * can be dropped by the rename. The END marker is preserved exactly as
   * found on disk, never from this instance's (possibly stale) state.
   * Publishes via tmp+rename; never unlinks the lock file.
   */
  private async compact(): Promise<void> {
    const v3 = this.v3Path();
    const before = await stat(v3).catch(() => null);
    if (!before) return;
    let loaded = await this.readV3Map().catch(() => null);
    if (!loaded) return;
    const fd = acquireHeadLock(this.lockPath());
    if (fd === undefined) return;
    try {
      const after = await stat(v3).catch(() => null);
      if (!after || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
        // The file changed during the unlocked read: re-read while holding
        // the lock so the rewrite starts from the true latest committed state.
        loaded = await this.readV3Map().catch(() => null);
        if (!loaded) return;
      }
      const disk = loaded.map;
      const paths = [...disk.keys()].sort(); // stable, deterministic output
      const parts: string[] = [];
      for (const p of paths) parts.push(encodeSetLine(p, disk.get(p) ?? null) + "\n");
      if (loaded.endMarked) parts.push(END_LINE + "\n");
      const tmp = `${v3}.${process.pid}.tmp`;
      await writeFile(tmp, parts.join(""), "utf8");
      try {
        await rename(tmp, v3);
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
        return;
      }
      this.totalLines = paths.length + (loaded.endMarked ? 1 : 0);
      this.endMarked = loaded.endMarked;
    } finally {
      releaseHeadLock(fd);
    }
  }

  /** Load v3, then finish a v2 migration if one is due or incomplete. */
  private async load(): Promise<void> {
    const v3 = this.v3Path();
    if (existsSync(v3)) {
      const loaded = await this.readV3File(v3);
      this.totalLines = loaded.lines;
      this.malformedLines = loaded.malformed;
      this.endMarked = loaded.endMarked;
      for (const [p, e] of loaded.map) this.entries.set(p, e);
    }
    const v2 = this.v2Path();
    // Never cold-rescan thousands of rollouts when a valid legacy cache
    // exists: an unmarked (missing or interrupted) migration resumes here,
    // skipping paths v3 already has. A v2 file that is not strictly version 2
    // is ignored entirely (fail closed), like v2's own version check was.
    if (!this.endMarked && existsSync(v2)) await this.migrateV2(v2);
  }

  private async readV3File(
    v3: string,
  ): Promise<{ map: Map<string, CodexHeadEntry | null>; lines: number; malformed: number; endMarked: boolean }> {
    const map = new Map<string, CodexHeadEntry | null>();
    let lines = 0;
    let malformed = 0;
    let endMarked = false;
    const handle = await open(v3, "r");
    try {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const buf = Buffer.alloc(Math.max(this.chunkBytes, 1));
      let carry = "";
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        carry += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
        let nl: number;
        while ((nl = carry.indexOf("\n")) >= 0) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          const r = applyV3Line(line, map);
          if (r === "end") endMarked = true;
          else if (r === "bad") malformed++;
          lines++;
        }
      }
      carry += decoder.decode();
      if (carry !== "") {
        lines++;
        const r = applyV3Line(carry, map);
        if (r === "end") endMarked = true;
        else if (r === "bad") malformed++;
      }
    } finally {
      await handle.close();
    }
    return { map, lines, malformed, endMarked };
  }

  /** Full disk state for compaction: committed records plus the END marker
   *  exactly as found on disk. Returns the whole load result so callers never
   *  have to fall back to their own (possibly stale) in-memory flags. */
  private async readV3Map(): Promise<{ map: Map<string, CodexHeadEntry | null>; lines: number; malformed: number; endMarked: boolean }> {
    return this.readV3File(this.v3Path());
  }

  /**
   * Stream the legacy v2 cache (a single ~700MB JSON object) in bounded
   * chunks, derive a compact entry from each full prompt, and append batches
   * to the v3 file. Skips paths already present, so an interrupted migration
   * resumes instead of restarting, and a live parse that raced the migration
   * wins. The v2 file itself is only ever read.
   */
  private async migrateV2(v2: string): Promise<void> {
    const handle = await open(v2, "r");
    const chunkBytes = Math.max(this.chunkBytes, 64); // keep tests sane but bounded
    let batch: string[] = [];
    let batchBytes = 0;
    const flushBatch = async (): Promise<boolean> => {
      if (!batch.length) return true;
      const data = batch.join("\n") + "\n";
      const ok = await this.appendLocked(data);
      if (ok) {
        this.totalLines += batch.length;
        batch = [];
        batchBytes = 0;
      }
      return ok;
    };
    try {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const buf = Buffer.alloc(chunkBytes);
      const scanner = new V2HeadScanner((pathRaw, valueRaw) => {
        let path: string;
        try {
          path = JSON.parse(`"${pathRaw}"`) as string;
        } catch {
          scanner.malformed++;
          return;
        }
        if (this.entries.has(path)) return; // resumed migration / fresher live parse
        let head: CodexHeadEntry | null = null;
        if (valueRaw !== null) {
          const e = wireToEntryFromV2(JSON.parse(valueRaw));
          if (!e) {
            scanner.malformed++;
            return;
          }
          head = e;
        }
        this.entries.set(path, head);
        const line = encodeSetLine(path, head);
        batchBytes += line.length + 1;
        batch.push(line);
      });
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        scanner.feed(decoder.decode(buf.subarray(0, bytesRead), { stream: true }));
        if (scanner.done) break;
        if (batchBytes >= MIGRATION_BATCH_BYTES || batch.length >= MIGRATION_BATCH_ENTRIES) {
          if (!(await flushBatch())) return; // lock exhausted: resume next boot
        }
        // Yield to the event loop between chunks so timers and requests keep
        // firing while a giant file streams through.
        await sleep(0);
      }
      if (!(await flushBatch())) return;
      this.malformedLines += scanner.malformed;
      // Only a cleanly-closed heads object may be marked complete; a rejected
      // header (foreign version/shape) or a truncated file stays unmarked so
      // the next boot re-evaluates it (and on-demand parsing covers gaps).
      if (scanner.closedCleanly) {
        const ok = await this.appendLocked(END_LINE + "\n");
        if (ok) {
          this.totalLines += 1;
          this.endMarked = true;
        }
      }
    } finally {
      await handle.close();
    }
  }
}

/** Validate and compact a v2 head object (the full CodexHead shape). */
function wireToEntryFromV2(w: unknown): CodexHeadEntry | null {
  if (!w || typeof w !== "object") return null;
  const h = w as {
    id?: unknown;
    cwd?: unknown;
    createdAt?: unknown;
    firstUserText?: unknown;
    originator?: unknown;
    sourceKind?: unknown;
  };
  if (typeof h.id !== "string" || h.id === "") return null;
  const first = typeof h.firstUserText === "string" ? h.firstUserText : null;
  return {
    id: h.id,
    cwd: typeof h.cwd === "string" ? h.cwd : null,
    createdAt: typeof h.createdAt === "number" && Number.isFinite(h.createdAt) ? h.createdAt : null,
    originator: typeof h.originator === "string" ? h.originator : null,
    sourceKind: typeof h.sourceKind === "string" ? h.sourceKind : null,
    prompt: derivePromptProjection(first),
  };
}
