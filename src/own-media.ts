/**
 * OWN MEDIA: media generation on providers the USER chose, billed outside of
 * omg.dev credits. The honest sibling of media-generation.ts, which bills omg
 * credits through the sandbox router.
 *
 * Four routes, fixed in the catalog below:
 *   chatgpt      browser handoff to https://chatgpt.com — the model is chosen
 *                inside ChatGPT itself; no private ChatGPT API is promised.
 *   openai       direct OpenAI Images API (OPENAI_API_KEY, server only;
 *                official models gpt-image-1 / gpt-image-1.5 plus an
 *                admin-configurable allowlist).
 *   google-flow  browser handoff to https://labs.google/fx/tools/flow — the
 *                user picks the models that Flow actually offers (Gemini /
 *                Veo variants) in that browser. No API, no login or budget
 *                claims.
 *   kie          direct KIE jobs API (KIE_API_KEY, server only) using the
 *                verified createTask/recordInfo contract from
 *                sites-beheer/scripts/kie_image.py: {model, input:{prompt,
 *                aspect_ratio?, quality?}}. Default image models
 *                gpt-image-2-text-to-image and nano-banana-2-lite-text-to-image.
 *                Video adapters exist only as explicit admin catalog entries
 *                with their own schema; model ids are never passed through
 *                unvalidated.
 *
 * Money rules:
 * - No fake zeros and no invented prices. API jobs are refused until an admin
 *   configured a per-model quote AND cap (catalog JSON). A missing quote is
 *   reported as such, and the UI keeps submit disabled.
 * - Every job records its cost source (subscription / site credits / API).
 * - Idempotency: the client sends a stable requestId. A repeat submit returns
 *   the original job instead of a second paid provider call. Stale in-progress
 *   jobs are never retried automatically.
 * - Cancellation and timeouts are honest: no refund is claimed for API spend
 *   that already happened.
 *
 * Security rules:
 * - API keys live in env on the server; only booleans reach the client, and
 *   error messages are scrubbed of the key values.
 * - Manual results are only accepted as files under the uploads dir (realpath
 *   checked), validated by extension and size, then registered through the
 *   normal image/video artifact factories. No arbitrary paths.
 * - Provider result URLs are downloaded only over HTTPS, only from configured
 *   host suffixes, never from private addresses, with redirects refused and a
 *   byte cap.
 *
 * State: one JSON file per job under PATHS.data/own-media, private (0600) and
 * written atomically. Submits run under one in-process lock so concurrent
 * requests cannot double-spend or overwrite each other's index updates.
 */

import { mkdirSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { PATHS } from "./config.ts";
import { uploadsDir } from "./uploads.ts";
import { loadSharp } from "./native-deps.ts";
import { probeVideo } from "./video-tools.ts";
import {
  CHATGPT_HANDOFF_URL,
  GOOGLE_FLOW_HANDOFF_URL,
  OWN_MEDIA_PROVIDERS,
  ownMediaCostSourceLabel,
  ownMediaProviderLabel,
  type OwnMediaErrorCode,
  type OwnMediaJob,
  type OwnMediaJobStatus,
  type OwnMediaKind,
  type OwnMediaModelInfo,
  type OwnMediaProviderId,
  type OwnMediaProviderInfo,
  type OwnMediaQuote,
  type OwnMediaSubmitInput,
} from "../packages/protocol/src/own-media.ts";

export * from "../packages/protocol/src/own-media.ts";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class OwnMediaError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: OwnMediaErrorCode | "invalid_config",
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Options (everything injectable for offline tests)                   */
/* ------------------------------------------------------------------ */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OwnMediaArtifactMedia = { urlPath: string; name: string; width?: number | null; height?: number | null };

export type OwnMediaOptions = {
  /** Env with the provider keys. Defaults to process.env; values never leave the server. */
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => number;
  /** Root for job state. Defaults to PATHS.data/own-media. */
  dataDir?: string;
  /** Upload root for manual results. Defaults to uploadsDir(). */
  uploadsRoot?: string;
  /** Admin catalog JSON (quotes, caps, extra models). Defaults to env OMG_OWN_MEDIA_CATALOG. */
  catalogPath?: string | null;
  /** Validate a thread id exists. Defaults to the conversations store. */
  threadExists?: (threadId: string) => boolean;
  /** Registers a finished file as an artifact. Injectable for tests. */
  artifactFactory?: (input: { kind: OwnMediaKind; sessionId: string; path: string; caption: string; alt: string }) => Promise<OwnMediaArtifactMedia>;
  /** Host -> addresses, for the SSRF guard. Injectable for tests. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Called once when a job reaches a terminal result. Serve wiring posts to the thread here. */
  onJobCompleted?: (job: OwnMediaJob, media: OwnMediaArtifactMedia) => void;
  /** Non-terminal jobs older than this are failed by the sweep. Default 24h. */
  inProgressTimeoutMs?: number;
  /** Terminal jobs older than this are expired and cleaned. Default 14d. */
  maxAgeMs?: number;
  /** Download cap for provider results. Default 64 MiB. */
  maxDownloadBytes?: number;
  minPollIntervalMs?: number;
  apiTimeoutMs?: number;
  downloadTimeoutMs?: number;
};

const DEFAULT_IN_PROGRESS_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_POLL_MS = 2000;

const OPENAI_API_BASE = "https://api.openai.com/v1";
const KIE_API_BASE = "https://api.kie.ai/api/v1";
const PROMPT_MAX = 4000;
const MODEL_HINT_MAX = 80;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,99}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm", ".mov", ".ogv"]);
const IMAGE_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** OpenAI aspect ratio -> Images API size. Fixed mapping, not configurable guesswork. */
const OPENAI_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
};

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

type ResolvedModel = OwnMediaModelInfo & { origin: "builtin" | "config" };

export type OwnMediaCatalog = {
  openai: ResolvedModel[];
  kie: ResolvedModel[];
  /** Extra host suffixes allowed for KIE result downloads. */
  kieResultHostSuffixes: string[];
};

const BUILTIN_OPENAI: ResolvedModel[] = [
  // Current models the OpenAI image-generation guide recommends, plus the
  // documented older ones still accepted. Sizes verified there:
  // 1024x1024, 1536x1024, 1024x1536; 2.5 also xhigh|max|auto. No quotes:
  // prices are admin-configured, never invented here.
  { origin: "builtin", id: "gpt-image-2.5-sunburst", label: "gpt-image-2.5-sunburst", kind: "image", aspectRatios: ["1:1", "3:2", "2:3"], qualities: ["low", "medium", "high", "xhigh", "max", "auto"] },
  { origin: "builtin", id: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare", kind: "image", aspectRatios: ["1:1", "3:2", "2:3"], qualities: ["low", "medium", "high", "xhigh", "max", "auto"] },
  { origin: "builtin", id: "gpt-image-2", label: "gpt-image-2", kind: "image", aspectRatios: ["1:1", "3:2", "2:3"], qualities: ["low", "medium", "high"] },
  { origin: "builtin", id: "gpt-image-1.5", label: "gpt-image-1.5", kind: "image", aspectRatios: ["1:1", "3:2", "2:3"], qualities: ["low", "medium", "high"] },
  { origin: "builtin", id: "gpt-image-1", label: "gpt-image-1", kind: "image", aspectRatios: ["1:1", "3:2", "2:3"], qualities: ["low", "medium", "high"] },
];

// KIE image models: the two documented GPT-Image 2.5 ids (docs.kie.ai
// /market/gpt/gpt-image-2-5-{flare,sunburst}-text-to-image: input prompt,
// aspect_ratio, resolution "1K"|"2K"|"4K", background) plus the two ids the
// verified local helper script uses (input prompt, aspect_ratio, quality).
const KIE_2_5_RATIOS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "9:16", "16:9", "9:8", "8:9", "27:16", "16:27", "21:9"];
const BUILTIN_KIE: ResolvedModel[] = [
  {
    origin: "builtin",
    id: "gpt-image-2-5-flare-text-to-image",
    label: "gpt-image-2.5 flare",
    kind: "image",
    aspectRatios: KIE_2_5_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    backgrounds: ["transparent", "opaque", "auto"],
  },
  {
    origin: "builtin",
    id: "gpt-image-2-5-sunburst-text-to-image",
    label: "gpt-image-2.5 sunburst",
    kind: "image",
    aspectRatios: KIE_2_5_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    backgrounds: ["transparent", "opaque", "auto"],
  },
  // The one documented video adapter (docs.kie.ai /market/wan/2-6-text-to-video):
  // input prompt, duration "5"|"10"|"15", resolution "720p"|"1080p",
  // multi_shots. nsfw_checker is deliberately NOT sent: the provider default
  // stays active. Video support is exactly this model, not a generic config.
  {
    origin: "builtin",
    id: "wan/2-6-text-to-video",
    label: "Wan 2.6 text-to-video",
    kind: "video",
    durations: ["5", "10", "15"],
    resolutions: ["720p", "1080p"],
  },
  {
    origin: "builtin",
    id: "gpt-image-2-text-to-image",
    label: "gpt-image-2-text-to-image",
    kind: "image",
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"],
    qualities: ["low", "medium", "high"],
  },
  {
    origin: "builtin",
    id: "nano-banana-2-lite-text-to-image",
    label: "nano-banana-2-lite-text-to-image",
    kind: "image",
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"],
  },
];

function isQuote(v: unknown): v is OwnMediaQuote {
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  return typeof q.amount === "number" && Number.isFinite(q.amount) && q.amount > 0 && (q.unit === "credits" || q.unit === "usd");
}

function parseConfigModel(raw: unknown, at: string): ResolvedModel {
  if (!raw || typeof raw !== "object") throw new OwnMediaError(`Catalogfout ${at}: model moet een object zijn.`, 500, "invalid_config");
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id.trim() : "";
  if (!id || id.length > 120) throw new OwnMediaError(`Catalogfout ${at}: ongeldig model-id.`, 500, "invalid_config");
  // kind is optional here: an entry that only adds quote/maxCredits to a
  // built-in model inherits its kind. mergeModel enforces kind for new ids.
  const kind = m.kind === "image" || m.kind === "video" ? m.kind : undefined;
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.length <= 16) ? (v as string[]) : undefined;
  const model = {
    origin: "config" as const,
    id,
    label: typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, 120) : id,
    ...(kind ? { kind } : {}),
    ...(strList(m.aspectRatios) ? { aspectRatios: strList(m.aspectRatios) } : {}),
    ...(strList(m.qualities) ? { qualities: strList(m.qualities) } : {}),
    ...(strList(m.resolutions) ? { resolutions: strList(m.resolutions) } : {}),
    ...(strList(m.backgrounds) ? { backgrounds: strList(m.backgrounds) } : {}),
    ...(strList(m.durations) ? { durations: strList(m.durations) } : {}),
  } as ResolvedModel;
  if (m.quote !== undefined) {
    if (!isQuote(m.quote)) throw new OwnMediaError(`Catalogfout ${at}: quote van ${id} is ongeldig.`, 500, "invalid_config");
    if (typeof m.maxCredits !== "number" || !Number.isFinite(m.maxCredits) || m.maxCredits <= 0) {
      throw new OwnMediaError(`Catalogfout ${at}: model ${id} heeft een quote maar geen geldig maxCredits-plafond.`, 500, "invalid_config");
    }
    if (m.maxCredits < m.quote.amount) {
      throw new OwnMediaError(`Catalogfout ${at}: plafond van ${id} ligt onder de quote; verhoog maxCredits.`, 500, "invalid_config");
    }
    model.quote = m.quote;
    model.maxCredits = m.maxCredits;
  }
  return model;
}

function mergeModel(provider: string, builtins: ResolvedModel[], configured: ResolvedModel[] | undefined): ResolvedModel[] {
  const byId = new Map(builtins.map((m) => [m.id, { ...m }]));
  for (const m of configured ?? []) {
    const base = byId.get(m.id);
    if (!base && !m.kind) {
      throw new OwnMediaError(`Catalogfout: nieuw model ${m.id} voor ${provider} moet een soort (image|video) meenemen.`, 500, "invalid_config");
    }
    byId.set(m.id, base ? { ...base, ...m, origin: "config" as const } : m);
  }
  return [...byId.values()];
}

export function resolveOwnMediaCatalog(opts: OwnMediaOptions = {}): OwnMediaCatalog {
  const env = opts.env ?? process.env;
  const path = opts.catalogPath !== undefined ? opts.catalogPath : env.OMG_OWN_MEDIA_CATALOG?.trim() || null;
  let openai: ResolvedModel[] | undefined;
  let kie: ResolvedModel[] | undefined;
  let hosts: string[] = [];
  if (path) {
    let rawText: string;
    try {
      rawText = readFileSync(path, "utf8");
    } catch (e) {
      throw new OwnMediaError(`Catalogbestand ${path} kon niet gelezen worden.`, 500, "invalid_config", { path });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new OwnMediaError(`Catalogbestand ${path} is geen geldige JSON.`, 500, "invalid_config", { path });
    }
    const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const providers = root.providers && typeof root.providers === "object" ? (root.providers as Record<string, unknown>) : root;
    for (const name of ["openai", "kie"] as const) {
      const p = providers[name];
      if (p === undefined) continue;
      if (!p || typeof p !== "object") throw new OwnMediaError(`Catalogfout: providers.${name} moet een object zijn.`, 500, "invalid_config");
      const section = p as Record<string, unknown>;
      const models = section.models === undefined ? [] : section.models;
      if (!Array.isArray(models)) throw new OwnMediaError(`Catalogfout: providers.${name}.models moet een lijst zijn.`, 500, "invalid_config");
      const parsedModels = models.map((m, i) => parseConfigModel(m, `providers.${name}.models[${i}]`));
      if (name === "openai") openai = parsedModels;
      else kie = parsedModels;
      if (Array.isArray(section.resultHostSuffixes)) {
        if (!section.resultHostSuffixes.every((h) => typeof h === "string" && /^[a-z0-9.-]+$/i.test(h))) {
          throw new OwnMediaError(`Catalogfout: providers.${name}.resultHostSuffixes is ongeldig.`, 500, "invalid_config");
        }
        if (name === "kie") hosts = section.resultHostSuffixes as string[];
      }
    }
  }
  return {
    openai: mergeModel("openai", BUILTIN_OPENAI, openai),
    kie: mergeModel("kie", BUILTIN_KIE, kie),
    kieResultHostSuffixes: hosts.length ? hosts : ["kie.ai"],
  };
}

/**
 * A KIE "video" entry that does not declare the WAN-style schema would be sent
 * a generic image payload while promising video — that false promise is a
 * config error, refused here.
 */
export function assertKieCatalogHonest(catalog: OwnMediaCatalog): void {
  for (const m of catalog.kie) {
    if (m.kind === "video" && m.id !== "wan/2-6-text-to-video") {
      throw new OwnMediaError(`Catalogfout: geen gedocumenteerde video-adapter voor ${m.id}; een modelnaam of schema alleen voegt geen ondersteuning toe.`, 500, "invalid_config");
    }
    if (m.kind === "video" && (!m.durations?.length || !m.resolutions?.length)) {
      throw new OwnMediaError(
        `Catalogfout: KIE-video-adapter ${m.id} moet durations en resolutions expliciet declareren (zie wan/2-6-text-to-video); een generieke payload doet alsof video ondersteund wordt.`,
        500,
        "invalid_config",
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Private store                                                       */
/* ------------------------------------------------------------------ */

function jobsDir(dataDir: string): string {
  return join(dataDir, "own-media", "jobs");
}
function jobPath(dataDir: string, id: string): string {
  return join(jobsDir(dataDir), id + ".json");
}
function indexPath(dataDir: string): string {
  return join(dataDir, "own-media", "request-index.json");
}
function downloadsDir(dataDir: string): string {
  return join(dataDir, "own-media", "downloads");
}

/** Atomic, 0600, fsynced write. Same discipline as the conversations store. */
function writePrivateJson(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  try {
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function readJob(dataDir: string, id: string): OwnMediaJob | null {
  try {
    const job = JSON.parse(readFileSync(jobPath(dataDir, id), "utf8")) as OwnMediaJob;
    return job && typeof job === "object" && job.id === id ? job : null;
  } catch {
    return null;
  }
}

function writeJob(dataDir: string, job: OwnMediaJob): void {
  writePrivateJson(jobPath(dataDir, job.id), job);
}

type RequestIndex = Record<string, string>;

function readIndex(dataDir: string): RequestIndex {
  try {
    const data = JSON.parse(readFileSync(indexPath(dataDir), "utf8")) as RequestIndex;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

// One lock around submit (index read + provider call + job write) and around
// index writes, so two concurrent requests with the same requestId cannot both
// reach the paid provider call.
let storeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = storeLock.then(fn, fn);
  storeLock = next.catch(() => {});
  return next;
}

/**
 * Atomic status transition. readJob + writeJob here are both synchronous, so
 * between them no other transition can interleave on this event loop. Every
 * status change on an existing job goes through this: a cancellation that
 * lands while a poll or upload is awaiting can never be overwritten by the
 * late result, and a finished job can never be finished twice.
 */
function transitionJobIf(
  dataDir: string,
  id: string,
  expected: OwnMediaJobStatus | "non_terminal",
  build: (job: OwnMediaJob) => OwnMediaJob,
): { ok: true; job: OwnMediaJob } | { ok: false; job: OwnMediaJob | null } {
  const current = readJob(dataDir, id);
  if (!current) return { ok: false, job: null };
  const matches = expected === "non_terminal" ? !TERMINAL.includes(current.status) : current.status === expected;
  if (!matches) return { ok: false, job: current };
  const next = build(current);
  writeJob(dataDir, next);
  return { ok: true, job: next };
}

// One in-flight status operation per job: parallel GETs of the same job share
// a single provider poll and a single result download, so a double click can
// never produce two paid downloads or two artifacts. Cancellation does NOT go
// through this: it is a synchronous transition and must land immediately,
// even mid-download.
const jobInFlight = new Map<string, Promise<OwnMediaJob>>();
function awaitOrRunJobOp(jobId: string, run: () => Promise<OwnMediaJob>): Promise<OwnMediaJob> {
  const existing = jobInFlight.get(jobId);
  if (existing) return existing;
  const op = run();
  jobInFlight.set(jobId, op);
  const clear = () => {
    if (jobInFlight.get(jobId) === op) jobInFlight.delete(jobId);
  };
  op.then(clear, clear);
  return op;
}

function ownDataDir(opts: OwnMediaOptions): string {
  return opts.dataDir ?? PATHS.data;
}

/* ------------------------------------------------------------------ */
/* Settings snapshot                                                   */
/* ------------------------------------------------------------------ */

type Settings = {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  now: () => number;
  dataDir: string;
  catalog: OwnMediaCatalog;
  threadExists: (threadId: string) => boolean;
  resolveHost: (host: string) => Promise<string[]>;
  inProgressTimeoutMs: number;
  maxAgeMs: number;
  maxDownloadBytes: number;
  minPollIntervalMs: number;
  /** Bound on provider API calls, signal-based. Default 30s. */
  apiTimeoutMs: number;
  /** Bound on result downloads including body reads. Default 120s. */
  downloadTimeoutMs: number;
};

const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Signal that bounds one network call; null where the runtime lacks it. */
function timeoutSignal(ms: number): AbortSignal | null {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return null;
  }
}

/**
 * Race a promise against a deadline: the abort signal (handed to the real
 * fetch, so it cuts the connection and stream) AND a plain timer. The second
 * mechanism matters twice: an injected or non-conforming transport ignores the
 * signal, and some runtimes starve AbortSignal timers under test. Listeners
 * and timers are always cleaned up on settle.
 */
function abortRace<T>(p: Promise<T>, ms: number, signal: AbortSignal | null, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(onTimeout()));
    timer = setTimeout(() => finish(() => reject(onTimeout())), ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

function uploadsRootReal(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function defaultThreadExists(threadId: string): boolean {
  // Historical job metadata is retained, but new thread-bound jobs are unavailable.
  return false;
}

function settings(opts: OwnMediaOptions): Settings {
  return {
    env: opts.env ?? process.env,
    fetch: opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
    now: opts.now ?? (() => Date.now()),
    dataDir: ownDataDir(opts),
    catalog: (() => {
      const catalog = resolveOwnMediaCatalog(opts);
      assertKieCatalogHonest(catalog);
      return catalog;
    })(),
    threadExists: opts.threadExists ?? defaultThreadExists,
    resolveHost: opts.resolveHost ?? ((host) => lookup(host, { all: true }).then((rows) => rows.map((r) => r.address)).catch(() => { throw new Error("dns"); })),
    inProgressTimeoutMs: opts.inProgressTimeoutMs ?? DEFAULT_IN_PROGRESS_TIMEOUT_MS,
    maxAgeMs: opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    maxDownloadBytes: opts.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
    minPollIntervalMs: opts.minPollIntervalMs ?? DEFAULT_MIN_POLL_MS,
    apiTimeoutMs: opts.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    downloadTimeoutMs: opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  };
}

function secretsOf(s: Settings): string[] {
  return [s.env.OPENAI_API_KEY, s.env.KIE_API_KEY].filter((v): v is string => !!v && v.length > 8);
}

/** Provider-derived text is scrubbed of the configured key values before it can reach a client. */
function sanitize(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[sleutel verwijderd]");
  // Authorization headers must never survive either, whatever carried them.
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [sleutel verwijderd]");
  return out.slice(0, 600);
}

/* ------------------------------------------------------------------ */
/* Providers listing                                                   */
/* ------------------------------------------------------------------ */

function isApiProvider(provider: OwnMediaProviderId): boolean {
  return provider === "openai" || provider === "kie";
}

/** Catalog of an API provider; browser providers have no catalog. */
function apiCatalogFor(s: Settings, provider: OwnMediaProviderId): ResolvedModel[] {
  return provider === "openai" ? s.catalog.openai : provider === "kie" ? s.catalog.kie : [];
}

function providerAvailable(s: Settings, provider: OwnMediaProviderId): boolean {
  if (provider === "openai") return !!s.env.OPENAI_API_KEY?.trim();
  if (provider === "kie") return !!s.env.KIE_API_KEY?.trim();
  return true;
}

function providerKinds(provider: OwnMediaProviderId): OwnMediaKind[] {
  switch (provider) {
    case "chatgpt":
      return ["image", "video"];
    case "openai":
      return ["image"];
    case "google-flow":
      return ["video"];
    case "kie":
      return ["image", "video"];
  }
}

function providerNote(s: Settings, provider: OwnMediaProviderId): string {
  switch (provider) {
    case "chatgpt":
      return "Je opent ChatGPT zelf en kiest daar het model; er is geen chatgpt.com-API aan deze site gekoppeld. Plak de prompt en upload het resultaat hier.";
    case "openai":
      return s.env.OPENAI_API_KEY?.trim()
        ? "Genereert direct via de OpenAI Images API met de sleutel die de server beheert."
        : "Stel OPENAI_API_KEY in op de server om deze route te gebruiken.";
    case "google-flow":
      return "Je opent Google Flow zelf en kiest daar een model dat Flow op dat moment aanbiedt; er is geen API gekoppeld en wij doen geen uitspraken over je login of credits-saldo.";
    case "kie":
      return s.env.KIE_API_KEY?.trim()
        ? "Genereert direct via de KIE-jobs-API met de sleutel die de server beheert."
        : "Stel KIE_API_KEY in op de server om deze route te gebruiken.";
  }
}

export function listOwnMediaProviders(opts: OwnMediaOptions = {}): { providers: OwnMediaProviderInfo[] } {
  const s = settings(opts);
  const providers: OwnMediaProviderInfo[] = OWN_MEDIA_PROVIDERS.map((id) => {
    const route = isApiProvider(id) ? "api" : "browser";
    const costSource = id === "chatgpt" ? "subscription" : id === "google-flow" ? "site_credits" : "api";
    const base: OwnMediaProviderInfo = {
      id,
      label: ownMediaProviderLabel(id),
      route,
      kinds: providerKinds(id),
      costSource,
      billingLabel: ownMediaCostSourceLabel(costSource),
      handoffUrl: id === "chatgpt" ? CHATGPT_HANDOFF_URL : id === "google-flow" ? GOOGLE_FLOW_HANDOFF_URL : null,
      available: providerAvailable(s, id),
      note: providerNote(s, id),
      models: route === "api" ? apiCatalogFor(s, id).map(({ origin, ...m }) => m) : [],
    };
    return base;
  });
  return { providers };
}

/* ------------------------------------------------------------------ */
/* SSRF-guarded download                                               */
/* ------------------------------------------------------------------ */

function isPrivateAddress(address: string): boolean {
  if (/^127\./.test(address) || /^10\./.test(address) || /^0\./.test(address) || /^169\.254\./.test(address)) return true;
  if (/^192\.168\./.test(address)) return true;
  const m172 = address.match(/^172\.(\d+)\./);
  if (m172) {
    const n = Number(m172[1]);
    if (n >= 16 && n <= 31) return true;
  }
  const m100 = address.match(/^100\.(\d+)\./);
  if (m100 && Number(m100[1]) >= 64 && Number(m100[1]) <= 127) return true;
  if (address === "::1" || address === "::" || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address)) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

function hostAllowed(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) => {
    const suffix = s.toLowerCase();
    return h === suffix || h.endsWith("." + suffix);
  });
}

/**
 * Sniff the actual media kind from magic bytes. Extensions and content-type
 * headers are claims; these bytes are the file. A provider answer that is
 * really an HTML error page must never become an artifact.
 */
export function sniffMediaKind(bytes: Uint8Array): "image" | "video" | null {
  const startsWith = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  const asciiAt = (offset: number, len: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + len));
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image"; // PNG
  if (startsWith(0xff, 0xd8, 0xff)) return "image"; // JPEG
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image"; // GIF87a/GIF89a
  if (startsWith(0x52, 0x49, 0x46, 0x46)) {
    const tag = asciiAt(8, 4);
    if (tag === "WEBP") return "image";
    if (tag === "AVI ") return "video";
    return null;
  }
  if (asciiAt(4, 4) === "ftyp") return "video"; // MP4/MOV/M4V
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return "video"; // WebM/Matroska
  return null;
}

export async function guardedProviderDownload(
  s: Settings,
  input: { url: string; kind: OwnMediaKind; suffixes: string[] },
): Promise<{ bytes: Uint8Array; contentType: string | null; ext: string }> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new OwnMediaError("De provider gaf een ongeldig resultaat-URL.", 502, "download_refused");
  }
  if (url.protocol !== "https:") {
    throw new OwnMediaError("Resultaat-URL van de provider moet https zijn; gedownload werd geweigerd.", 502, "download_refused", { host: url.hostname });
  }
  // Userinfo ("https://user:pass@host/") has no place in a provider result
  // URL and is a classic SSRF/confusion vector. Refuse it outright.
  if (url.username || url.password) {
    throw new OwnMediaError("Resultaat-URL van de provider bevat inloggegevens; download geweigerd.", 502, "download_refused", { host: url.hostname });
  }
  if (!hostAllowed(url.hostname, input.suffixes)) {
    throw new OwnMediaError(`Resultaat-URL van ${url.hostname} staat niet op de toegestane lijst van deze provider; download geweigerd.`, 502, "download_refused", { host: url.hostname });
  }
  let addresses: string[];
  try {
    addresses = await s.resolveHost(url.hostname);
  } catch {
    throw new OwnMediaError(`Host ${url.hostname} van het resultaat kon niet controleerbaar opgelost worden; download geweigerd.`, 502, "download_refused", { host: url.hostname });
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a))) {
    throw new OwnMediaError(`Host ${url.hostname} van het resultaat wijst naar een privaat adres; download geweigerd.`, 502, "download_refused", { host: url.hostname });
  }
  let res: Response;
  const signal = timeoutSignal(s.downloadTimeoutMs);
  try {
    res = await s.fetch(url.toString(), {
      redirect: "error",
      headers: { "User-Agent": "omg-own-media/1.0" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new OwnMediaError("De resultaat-download mocht niet doorgaan (time-out, netwerk of omleiding geweigerd).", 502, "download_refused");
  }
  if (!res.ok) {
    throw new OwnMediaError(`De resultaat-download gaf HTTP ${res.status}.`, 502, "download_refused");
  }
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
  if (contentType) {
    const expect = input.kind === "image" ? "image/" : "video/";
    if (!contentType.startsWith(expect)) {
      throw new OwnMediaError(`De provider stuurde ${contentType}, geen ${input.kind}.`, 502, "download_refused");
    }
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > s.maxDownloadBytes) {
    throw new OwnMediaError("Het resultaat is groter dan de downloadlimiet.", 502, "download_refused");
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      for (;;) {
        if (signal?.aborted) throw new OwnMediaError("De resultaat-download duurde te lang.", 502, "download_refused");
        const { done, value } = await abortRace(
          reader.read(),
          s.downloadTimeoutMs,
          signal,
          () => new OwnMediaError("De resultaat-download duurde te lang.", 502, "download_refused"),
        );
        if (done) break;
        total += value.byteLength;
        if (total > s.maxDownloadBytes) {
          throw new OwnMediaError("Het resultaat is groter dan de downloadlimiet.", 502, "download_refused");
        }
        chunks.push(value);
      }
    } finally {
      // Also on timeout/limit errors: release the stream, never leak a reader.
      try {
        await reader.cancel();
      } catch {}
    }
  } else {
    const buf = new Uint8Array(
      await abortRace(
        res.arrayBuffer(),
        s.downloadTimeoutMs,
        signal,
        () => new OwnMediaError("De resultaat-download duurde te lang.", 502, "download_refused"),
      ),
    );
    if (buf.byteLength > s.maxDownloadBytes) throw new OwnMediaError("Het resultaat is groter dan de downloadlimiet.", 502, "download_refused");
    chunks.push(buf);
    total = buf.byteLength;
  }
  if (total === 0) throw new OwnMediaError("De provider stuurde een leeg resultaat.", 502, "download_refused");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  // The bytes, not the labels: an HTML error page with a stolen content-type
  // never becomes an artifact.
  const sniffed = sniffMediaKind(bytes);
  if (sniffed !== input.kind) {
    throw new OwnMediaError(`De inhoud van het resultaat is geen ${input.kind}; download geweigerd.`, 502, "download_refused");
  }
  const ext = contentType === "video/mp4" ? ".mp4" : contentType === "video/webm" ? ".webm" : contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : contentType === "image/gif" ? ".gif" : contentType === "image/jpeg" ? ".jpg" : input.kind === "video" ? ".mp4" : ".png";
  return { bytes, contentType, ext };
}

/* ------------------------------------------------------------------ */
/* Provider calls                                                      */
/* ------------------------------------------------------------------ */

async function readBodyJson(res: Response, apiTimeoutMs: number, signal: AbortSignal | null): Promise<Record<string, unknown> | null> {
  const text = await abortRace(
    res.text().catch(() => "") as Promise<string>,
    apiTimeoutMs,
    signal,
    () => new OwnMediaError("De provider antwoordde te langzaam.", 502, "provider_error"),
  );
  try {
    const json = JSON.parse(text);
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function providerHttpError(provider: string, res: Response, body: Record<string, unknown> | null, secrets: string[]): OwnMediaError {
  const raw = typeof body?.error === "object" && body.error && typeof (body.error as Record<string, unknown>).message === "string"
    ? (body.error as Record<string, unknown>).message as string
    : typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : "";
  const detail = sanitize(raw || `HTTP ${res.status}`, secrets);
  if (res.status === 401 || res.status === 403) {
    return new OwnMediaError(`${provider} weigerde de API-sleutel (HTTP ${res.status}). Controleer de ingestelde omgevingsvariabele.`, 502, "provider_error");
  }
  return new OwnMediaError(`${provider} gaf HTTP ${res.status}${detail ? `: ${detail}` : ""}.`, 502, "provider_error");
}

async function callOpenAiImages(
  s: Settings,
  input: { model: string; prompt: string; size?: string; quality?: string },
): Promise<{ bytes: Uint8Array; ext: string }> {
  const key = s.env.OPENAI_API_KEY?.trim();
  if (!key) throw new OwnMediaError("OPENAI_API_KEY is niet ingesteld op de server.", 400, "key_missing");
  const signal = timeoutSignal(s.apiTimeoutMs);
  let res: Response;
  try {
    res = await abortRace(
      s.fetch(`${OPENAI_API_BASE}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        // Exactly one image per job: n is pinned, never client-settable.
        body: JSON.stringify({
          model: input.model,
          prompt: input.prompt,
          n: 1,
          ...(input.size ? { size: input.size } : {}),
          ...(input.quality ? { quality: input.quality } : {}),
        }),
        ...(signal ? { signal } : {}),
      }),
      s.apiTimeoutMs,
      signal,
      () => new OwnMediaError("OpenAI Images API reageerde te langzaam.", 502, "provider_error"),
    );
  } catch (e) {
    if (e instanceof OwnMediaError) throw e;
    throw new OwnMediaError("Kon de OpenAI Images API niet bereiken (time-out of netwerk).", 502, "provider_error");
  }
  const body = await readBodyJson(res, s.apiTimeoutMs, signal);
  if (!res.ok) throw providerHttpError("OpenAI", res, body, secretsOf(s));
  const data = Array.isArray(body?.data) ? (body!.data as Array<Record<string, unknown>>) : [];
  const first = data[0];
  if (typeof first?.b64_json === "string" && first.b64_json) {
    // Bound the allocation before decoding: a runaway base64 string is
    // refused instead of atob'd into memory.
    if (first.b64_json.length > s.maxDownloadBytes * 1.4 + 1024) {
      throw new OwnMediaError("Het OpenAI-resultaat is groter dan de limiet.", 502, "provider_error");
    }
    let bytes: Uint8Array;
    try {
      const bin = atob(first.b64_json);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      throw new OwnMediaError("OpenAI stuurde een onleesbaar resultaat.", 502, "provider_error");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > s.maxDownloadBytes) {
      throw new OwnMediaError("Het OpenAI-resultaat is leeg of groter dan de limiet.", 502, "provider_error");
    }
    if (sniffMediaKind(bytes) !== "image") {
      throw new OwnMediaError("Het OpenAI-resultaat is geen afbeelding.", 502, "provider_error");
    }
    return { bytes, ext: ".png" };
  }
  if (typeof first?.url === "string" && first.url) {
    const dl = await guardedProviderDownload(s, { url: first.url, kind: "image", suffixes: ["openai.com", "oaiusercontent.com", "chatgpt.com"] });
    return { bytes: dl.bytes, ext: dl.ext };
  }
  throw new OwnMediaError("OpenAI stuurde geen afbeelding terug.", 502, "provider_error");
}

/**
 * Build the KIE jobs/createTask input strictly from the model's documented
 * schema. Image-legacy models take prompt/aspect_ratio/quality; GPT-Image 2.5
 * takes prompt/aspect_ratio/resolution/background; the WAN video adapter
 * takes prompt/duration/resolution/multi_shots. Nothing else is ever sent —
 * notably nsfw_checker stays unset so the provider safety default applies.
 */
export function kieTaskInput(
  model: OwnMediaModelInfo,
  params: { prompt: string; aspectRatio?: string; quality?: string; resolution?: string; background?: string; duration?: string },
): Record<string, string | boolean> {
  const input: Record<string, string | boolean> = { prompt: params.prompt };
  if (model.kind === "video") {
    if (model.id !== "wan/2-6-text-to-video") {
      throw new OwnMediaError(`Geen gedocumenteerde video-adapter voor ${model.id}.`, 500, "invalid_config");
    }
    // The one documented video body (wan/2-6-text-to-video). A video model
    // without this schema can never be sent a generic payload.
    if (!model.durations?.length || !model.resolutions?.length) {
      throw new OwnMediaError(
        `Video-adapter ${model.id} heeft geen geldig gedocumenteerd schema (durations/resolutions); hij wordt niet verstuurd.`,
        500,
        "invalid_config",
      );
    }
    if (params.duration) input.duration = params.duration;
    if (params.resolution) input.resolution = params.resolution;
    input.multi_shots = false;
    return input;
  }
  if (params.aspectRatio) input.aspect_ratio = params.aspectRatio;
  if (model.resolutions && params.resolution) input.resolution = params.resolution;
  if (model.backgrounds && params.background) input.background = params.background;
  if (model.qualities && params.quality) input.quality = params.quality;
  return input;
}

async function callKieCreateTask(
  s: Settings,
  input: { model: string; taskInput: Record<string, string | boolean> },
): Promise<string> {
  const key = s.env.KIE_API_KEY?.trim();
  if (!key) throw new OwnMediaError("KIE_API_KEY is niet ingesteld op de server.", 400, "key_missing");
  const signal = timeoutSignal(s.apiTimeoutMs);
  let res: Response;
  try {
    res = await abortRace(
      s.fetch(`${KIE_API_BASE}/jobs/createTask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: input.model, input: input.taskInput }),
        ...(signal ? { signal } : {}),
      }),
      s.apiTimeoutMs,
      signal,
      () => new OwnMediaError("KIE reageerde te langzaam op createTask.", 502, "provider_error"),
    );
  } catch (e) {
    if (e instanceof OwnMediaError) throw e;
    throw new OwnMediaError("Kon de KIE API niet bereiken (time-out of netwerk).", 502, "provider_error");
  }
  const body = await readBodyJson(res, s.apiTimeoutMs, signal);
  if (!res.ok) throw providerHttpError("KIE", res, body, secretsOf(s));
  if (body?.code !== 200) {
    const msg = typeof body?.msg === "string" ? body.msg : `code ${String(body?.code)}`;
    throw new OwnMediaError(`KIE weigerde de opdracht: ${sanitize(msg, secretsOf(s))}.`, 502, "provider_error");
  }
  const taskId = (body?.data as Record<string, unknown> | undefined)?.taskId;
  if (typeof taskId !== "string" || !taskId) throw new OwnMediaError("KIE gaf geen taskId terug.", 502, "provider_error");
  return taskId;
}

type KieRecord =
  | { state: "waiting" }
  | { state: "success"; url: string }
  | { state: "failed"; message: string };

async function callKieRecordInfo(s: Settings, taskId: string): Promise<KieRecord> {
  const key = s.env.KIE_API_KEY?.trim();
  if (!key) throw new OwnMediaError("KIE_API_KEY is niet ingesteld op de server.", 400, "key_missing");
  const signal = timeoutSignal(s.apiTimeoutMs);
  let res: Response;
  try {
    res = await abortRace(
      s.fetch(`${KIE_API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${key}` },
        ...(signal ? { signal } : {}),
      }),
      s.apiTimeoutMs,
      signal,
      () => new OwnMediaError("KIE reageerde te langzaam op recordInfo.", 502, "provider_error"),
    );
  } catch (e) {
    if (e instanceof OwnMediaError) throw e;
    throw new OwnMediaError("Kon de KIE API niet bereiken (time-out of netwerk).", 502, "provider_error");
  }
  const body = await readBodyJson(res, s.apiTimeoutMs, signal);
  if (!res.ok) throw providerHttpError("KIE", res, body, secretsOf(s));
  if (body?.code !== 200) {
    const msg = typeof body?.msg === "string" ? body.msg : `code ${String(body?.code)}`;
    throw new OwnMediaError(`KIE status kon niet gelezen worden: ${sanitize(msg, secretsOf(s))}.`, 502, "provider_error");
  }
  const data = body?.data as Record<string, unknown> | undefined;
  const state = typeof data?.state === "string" ? data.state : "";
  if (state === "success") {
    let urls: string[] = [];
    const raw = typeof data?.resultJson === "string" ? data.resultJson : null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(parsed.resultUrls)) urls = parsed.resultUrls.filter((u): u is string => typeof u === "string");
      } catch {}
    }
    if (!urls.length) return { state: "failed", message: "KIE rapporteerde succes maar geen resultaat-URL." };
    return { state: "success", url: urls[0] };
  }
  if (state === "fail" || state === "failed") {
    const message = typeof data?.failMsg === "string" ? data.failMsg : "zonder melding";
    return { state: "failed", message: sanitize(message, secretsOf(s)) };
  }
  return { state: "waiting" };
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

const KNOWN_IMAGE_FORMATS = new Set(["png", "jpeg", "webp", "gif"]);

/**
 * Deep content validation, shared by the manual-upload and provider-result
 * paths (both go through registerArtifact). The fast gates (extension, magic
 * bytes) run earlier; this is the real decode:
 *
 * - Images must decode through Sharp with a known format and real dimensions.
 *   createImageArtifact alone is not enough: it deliberately falls back to a
 *   dimensionless registration when decoding fails, which is right for its own
 *   callers and wrong for media this module presents as "generated".
 * - Videos must probe through ffprobe with a real video stream. When ffprobe
 *   is not installed the job FAILS with "validatie niet beschikbaar" — an
 *   unplayable file is never waved through as a header-validated success.
 */
async function validateMediaFile(kind: OwnMediaKind, path: string): Promise<void> {
  if (kind === "image") {
    const sharp = await loadSharp();
    const image = sharp(path, { animated: false, limitInputPixels: 40_000_000 });
    const metadata = await image.metadata().catch(() => null);
    if (!metadata || !metadata.format || !KNOWN_IMAGE_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
      throw new OwnMediaError("De afbeelding kon niet gelezen worden (geen geldige decodeerbare afbeelding).", 400, "invalid_result_path");
    }
    // Metadata reads headers, not pixels. Decode the stream as well, while
    // bounding input pixels and keeping the output tiny.
    await image.resize(1, 1).png().toBuffer().catch(() => {
      throw new OwnMediaError("De afbeelding bevat beschadigde beeldgegevens.", 400, "invalid_result_path");
    });
    return;
  }
  let probe: { width: number; height: number } | null = null;
  try {
    probe = await probeVideo(path);
  } catch {
    probe = null;
  }
  if (!probe || !probe.width || !probe.height) {
    throw new OwnMediaError(
      "De video kon niet gevalideerd worden: ffprobe ontbreekt of kon het bestand niet lezen. Een koppnummer-only check bewijst niet dat het bestand afspeelbaar is; het bestand wordt geweigerd.",
      400,
      "invalid_result_path",
    );
  }
}

async function defaultArtifactFactory(input: { kind: OwnMediaKind; sessionId: string; path: string; caption: string; alt: string }): Promise<OwnMediaArtifactMedia> {
  await validateMediaFile(input.kind, input.path);
  const { createImageArtifact, createVideoArtifact } = await import("./artifacts.ts");
  const artifact = input.kind === "image"
    ? await createImageArtifact({ sessionId: input.sessionId, path: input.path, caption: input.caption, alt: input.alt })
    : await createVideoArtifact({ sessionId: input.sessionId, path: input.path, caption: input.caption, alt: input.alt });
  return {
    urlPath: `/api/artifacts/${encodeURIComponent(artifact.id)}`,
    name: artifact.name ?? input.path,
    width: artifact.width ?? null,
    height: artifact.height ?? null,
  };
}

async function registerArtifact(
  opts: OwnMediaOptions,
  s: Settings,
  job: OwnMediaJob,
  file: { path: string; name: string },
): Promise<OwnMediaArtifactMedia> {
  const factory = opts.artifactFactory ?? defaultArtifactFactory;
  const media = await factory({
    kind: job.kind,
    sessionId: job.threadId && UUID_RE.test(job.threadId) ? job.threadId : job.id,
    path: file.path,
    caption: `Eigen media (${ownMediaProviderLabel(job.provider)}${job.model ? `, ${job.model}` : ""})`,
    alt: job.prompt.slice(0, 160),
  });
  return media;
}

/* ------------------------------------------------------------------ */
/* Submit                                                              */
/* ------------------------------------------------------------------ */

/** SHA-256 over the canonical submit intent: same requestId must mean same job. */
export function ownMediaRequestFingerprint(input: OwnMediaSubmitInput): string {
  const canonical = JSON.stringify([
    input.provider,
    input.model,
    input.kind,
    input.prompt,
    input.aspectRatio ?? null,
    input.quality ?? null,
    input.resolution ?? null,
    input.background ?? null,
    input.duration ?? null,
    input.threadId ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

type ValidatedSubmit = {
  requestId: string;
  provider: OwnMediaProviderId;
  model: string;
  kind: OwnMediaKind;
  prompt: string;
  aspectRatio?: string;
  quality?: string;
  resolution?: string;
  background?: string;
  duration?: string;
  threadId?: string;
  entry: ResolvedModel | null;
};

function badField(field: string): OwnMediaError {
  return new OwnMediaError(`Ongeldig veld '${field}'.`, 400, "invalid_request");
}

function validateSubmit(s: Settings, raw: unknown): ValidatedSubmit {
  if (!raw || typeof raw !== "object") throw new OwnMediaError("Verwacht een JSON-object met requestId, provider, model, kind en prompt.", 400, "invalid_request");
  const input = raw as Record<string, unknown>;
  // Every field is type-checked first: a number where a string belongs is a
  // 400, never a .trim() crash that becomes a 500.
  for (const field of ["requestId", "provider", "model", "kind", "prompt", "aspectRatio", "quality", "resolution", "background", "duration", "threadId"] as const) {
    const v = input[field];
    if (v !== undefined && v !== null && typeof v !== "string") throw badField(field);
  }
  if (input.costAcknowledged !== undefined && typeof input.costAcknowledged !== "boolean") throw badField("costAcknowledged");

  const requestId = (input.requestId ?? "") as string;
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new OwnMediaError("requestId moet 8-100 tekens zijn (letters, cijfers, punt, streep).", 400, "invalid_request");
  }
  const providerRaw = input.provider as string;
  if (!OWN_MEDIA_PROVIDERS.includes(providerRaw as OwnMediaProviderId)) {
    throw new OwnMediaError(`Onbekende aanbieder '${providerRaw}'.`, 400, "unknown_provider");
  }
  const provider = providerRaw as OwnMediaProviderId;
  const kindRaw = input.kind as string;
  if (kindRaw !== "image" && kindRaw !== "video") {
    throw new OwnMediaError("kind moet 'image' of 'video' zijn.", 400, "invalid_request");
  }
  const kind = kindRaw as OwnMediaKind;
  if (!providerKinds(provider).includes(kind)) {
    throw new OwnMediaError(`${ownMediaProviderLabel(provider)} ondersteunt geen ${kind}.`, 400, "invalid_request");
  }
  const prompt = ((input.prompt as string) ?? "").trim();
  if (!prompt || prompt.length > PROMPT_MAX) {
    throw new OwnMediaError(`De prompt moet 1-${PROMPT_MAX} tekens zijn.`, 400, "invalid_request");
  }
  const model = ((input.model as string) ?? "").trim();
  if (!model) throw new OwnMediaError("Vul een model in.", 400, "invalid_request");
  const optional = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const aspectRatio = optional(input.aspectRatio);
  const quality = optional(input.quality);
  const resolution = optional(input.resolution);
  const background = optional(input.background);
  const duration = optional(input.duration);
  const threadId = optional(input.threadId);

  if (isApiProvider(provider)) {
    const entry = apiCatalogFor(s, provider).find((m) => m.id === model);
    if (!entry) {
      throw new OwnMediaError(
        `Model '${model}' staat niet in de catalogus van ${ownMediaProviderLabel(provider)}. Modellennamen worden nooit ongecontroleerd doorgestuurd.`,
        400,
        "unknown_model",
      );
    }
    if (entry.kind !== kind) {
      throw new OwnMediaError(`Model ${entry.id} is een ${entry.kind}-model; deze opdracht is ${kind}.`, 400, "model_kind_mismatch");
    }
    if (aspectRatio && !(entry.aspectRatios ?? []).includes(aspectRatio)) {
      throw new OwnMediaError(`Beeldverhouding ${aspectRatio} is niet geconfigureerd voor ${entry.id}.`, 400, "invalid_request");
    }
    if (quality && !(entry.qualities ?? []).includes(quality)) {
      throw new OwnMediaError(`Kwaliteit ${quality} is niet geconfigureerd voor ${entry.id}.`, 400, "invalid_request");
    }
    if (resolution && !(entry.resolutions ?? []).includes(resolution)) {
      throw new OwnMediaError(`Resolutie ${resolution} is niet geconfigureerd voor ${entry.id}.`, 400, "invalid_request");
    }
    if (background && !(entry.backgrounds ?? []).includes(background)) {
      throw new OwnMediaError(`Achtergrond ${background} is niet geconfigureerd voor ${entry.id}.`, 400, "invalid_request");
    }
    if (duration && !(entry.durations ?? []).includes(duration)) {
      throw new OwnMediaError(`Duur ${duration} is niet geconfigureerd voor ${entry.id}.`, 400, "invalid_request");
    }
    if (entry.durations?.length && !duration) {
      throw new OwnMediaError(`Kies een duur voor ${entry.id}: ${entry.durations.join(", ")}.`, 400, "invalid_request");
    }
    if (provider === "openai" && aspectRatio && !OPENAI_SIZES[aspectRatio]) {
      throw new OwnMediaError(`Beeldverhouding ${aspectRatio} heeft geen OpenAI-maat.`, 400, "invalid_request");
    }
    // Fields that do not belong to this model's documented schema are refused
    // rather than silently dropped.
    if (quality && !entry.qualities) throw badField("quality");
    if (resolution && !entry.resolutions) throw badField("resolution");
    if (background && !entry.backgrounds) throw badField("background");
    if (duration && !entry.durations) throw badField("duration");
    return {
      requestId, provider, model, kind, prompt,
      ...(aspectRatio ? { aspectRatio } : {}), ...(quality ? { quality } : {}), ...(resolution ? { resolution } : {}), ...(background ? { background } : {}), ...(duration ? { duration } : {}), ...(threadId ? { threadId } : {}),
      entry,
    };
  }

  // Browser routes: the model is a free hint the user picked outside; it is
  // stored, never validated as a promise about the external site.
  if (model.length > MODEL_HINT_MAX || /[\u0000-\u001f]/.test(model)) {
    throw new OwnMediaError("De model-hint mag maximaal 80 leesbare tekens zijn.", 400, "invalid_request");
  }
  if (aspectRatio && !/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
    throw new OwnMediaError("Beeldverhouding moet op de vorm '16:9' zijn.", 400, "invalid_request");
  }
  for (const field of ["quality", "resolution", "background", "duration"] as const) {
    if (input[field] !== undefined && input[field] !== null && input[field] !== "") throw badField(field);
  }
  return { requestId, provider, model, kind, prompt, ...(aspectRatio ? { aspectRatio } : {}), ...(threadId ? { threadId } : {}), entry: null };
}

export type SubmitResult = { job: OwnMediaJob; idempotent: boolean };

export async function submitOwnMediaJob(input: OwnMediaSubmitInput, opts: OwnMediaOptions = {}): Promise<SubmitResult> {
  const s = settings(opts);
  const v = validateSubmit(s, input);
  const fingerprint = ownMediaRequestFingerprint(input);

  if (v.threadId !== undefined) {
    if (!UUID_RE.test(v.threadId) || !s.threadExists(v.threadId)) {
      throw new OwnMediaError("De opgegeven thread bestaat niet.", 404, "thread_not_found");
    }
  }

  const prompt = v.prompt;
  const model = v.model;
  const now = s.now();
  const costSource = v.provider === "chatgpt" ? "subscription" : v.provider === "google-flow" ? "site_credits" : "api";

  return withStoreLock(async () => {
    // Idempotency first, before any paid call. The same requestId must mean
    // the same job: a different input under a used id is a conflict, not a
    // silent second spend.
    const index = readIndex(s.dataDir);
    const existingId = index[v.requestId];
    if (existingId) {
      const existing = readJob(s.dataDir, existingId);
      if (existing) {
        if (existing.requestFingerprint && existing.requestFingerprint !== fingerprint) {
          throw new OwnMediaError(
            "Deze requestId is al gebruikt voor een andere opdracht. Gebruik een nieuwe requestId.",
            409,
            "conflict",
          );
        }
        return { job: existing, idempotent: true };
      }
    }

    const id = crypto.randomUUID();
    const base: Omit<OwnMediaJob, "status"> = {
      id,
      requestId: v.requestId,
      requestFingerprint: fingerprint,
      provider: v.provider,
      model,
      kind: v.kind,
      prompt,
      ...(v.aspectRatio ? { aspectRatio: v.aspectRatio } : {}),
      ...(v.quality ? { quality: v.quality } : {}),
      ...(v.resolution ? { resolution: v.resolution } : {}),
      ...(v.background ? { background: v.background } : {}),
      ...(v.duration ? { duration: v.duration } : {}),
      ...(v.threadId ? { threadId: v.threadId } : {}),
      cost: { source: costSource, acknowledged: !isApiProvider(v.provider) },
      createdAt: now,
      updatedAt: now,
    };

    if (!isApiProvider(v.provider)) {
      const job: OwnMediaJob = {
        ...base,
        status: "pending_handoff",
        handoffUrl: v.provider === "chatgpt" ? CHATGPT_HANDOFF_URL : GOOGLE_FLOW_HANDOFF_URL,
        note: "Niets wordt op deze site gegenereerd: open de externe site, maak het bestand daar en upload het resultaat hier.",
      };
      writeJob(s.dataDir, job);
      writePrivateJson(indexPath(s.dataDir), { ...index, [v.requestId]: id });
      return { job, idempotent: false };
    }

    // API routes: refuse to spend without an explicit acknowledged cost and a
    // configured quote+cap. No defaults spend money.
    const entry = v.entry!;
    if (input.costAcknowledged !== true) {
      throw new OwnMediaError("Bevestig eerst de kosten: deze generatie wordt via de API betaald.", 400, "cost_ack_required");
    }
    if (!providerAvailable(s, v.provider)) {
      throw new OwnMediaError(
        v.provider === "openai" ? "OPENAI_API_KEY is niet ingesteld op de server." : "KIE_API_KEY is niet ingesteld op de server.",
        400,
        "key_missing",
      );
    }
    if (!entry.quote || entry.maxCredits === undefined) {
      throw new OwnMediaError(
        `De beheerder heeft voor ${entry.id} nog geen prijs en plafond ingesteld. Genereren via de API is uitgeschakeld tot dat gebeurt; er wordt niets uitgegeven.`,
        422,
        "quote_unavailable",
      );
    }

    // Transient state before the first write: the branch below sets the real
    // status (succeeded/submitted) or the catch writes failed before anything
    // is ever persisted with this placeholder.
    let job: OwnMediaJob = { ...base, status: "submitted", cost: { source: "api", acknowledged: true, quote: entry.quote } };

    try {
      if (v.provider === "openai") {
        const size = v.aspectRatio ? OPENAI_SIZES[v.aspectRatio] : undefined;
        const result = await callOpenAiImages(s, { model: entry.id, prompt, ...(size ? { size } : {}), ...(v.quality ? { quality: v.quality } : {}) });
        const path = `${join(downloadsDir(s.dataDir), id)}${result.ext}`;
        mkdirSync(downloadsDir(s.dataDir), { recursive: true, mode: 0o700 });
        writeFileSync(path, result.bytes, { mode: 0o600 });
        const media = await registerArtifact(opts, s, job, { path, name: `${entry.id}${result.ext}` });
        job = { ...job, status: "succeeded", result: { urlPath: media.urlPath, name: media.name } };
      } else {
        const taskId = await callKieCreateTask(s, {
          model: entry.id,
          taskInput: kieTaskInput(entry, {
            prompt,
            ...(v.aspectRatio ? { aspectRatio: v.aspectRatio } : {}),
            ...(v.quality ? { quality: v.quality } : {}),
            ...(v.resolution ? { resolution: v.resolution } : {}),
            ...(v.background ? { background: v.background } : {}),
            ...(v.duration ? { duration: v.duration } : {}),
          }),
        });
        job = { ...job, status: "submitted", providerJobId: taskId };
      }
    } catch (e) {
      const err = e instanceof OwnMediaError ? e : new OwnMediaError(sanitize((e as Error)?.message || "onbekende fout", secretsOf(s)), 502, "provider_error");
      // The provider call failed. Persist the failure for the record, index it,
      // and surface the sanitized error: a repeat with the same requestId will
      // see this failed job instead of a second paid attempt.
      const failed: OwnMediaJob = { ...job, status: "failed", error: err.message, updatedAt: s.now() };
      writeJob(s.dataDir, failed);
      writePrivateJson(indexPath(s.dataDir), { ...index, [v.requestId]: id });
      throw err;
    }

    writeJob(s.dataDir, job);
    writePrivateJson(indexPath(s.dataDir), { ...index, [v.requestId]: id });
    if (job.status === "succeeded" && job.result) {
      try {
        opts.onJobCompleted?.(job, { urlPath: job.result.urlPath, name: job.result.name });
      } catch {}
    }
    return { job, idempotent: false };
  });
}

/* ------------------------------------------------------------------ */
/* Job status (poll at most once per interval; never resubmit)          */
/* ------------------------------------------------------------------ */

const TERMINAL: OwnMediaJobStatus[] = ["succeeded", "failed", "cancelled", "expired"];

function requireJobId(id: string): string {
  // Job ids come from the URL path. Refuse anything that is not a plain UUID
  // before it can reach a path join.
  if (!UUID_RE.test(id)) throw new OwnMediaError("Job niet gevonden.", 404, "not_found");
  return id;
}

export async function getOwnMediaJob(id: string, opts: OwnMediaOptions = {}): Promise<OwnMediaJob> {
  const s = settings(opts);
  const jobId = requireJobId(id);
  const initial = readJob(s.dataDir, jobId);
  if (!initial) throw new OwnMediaError("Job niet gevonden.", 404, "not_found");
  if (initial.provider !== "kie" || initial.status !== "submitted" || !initial.providerJobId) return initial;
  if (s.now() - initial.updatedAt < s.minPollIntervalMs) return initial;

  return awaitOrRunJobOp(jobId, async () => {
    let job = readJob(s.dataDir, jobId);
    if (!job) throw new OwnMediaError("Job niet gevonden.", 404, "not_found");
    // Re-check after winning the single-flight slot: another call may have
    // finished, cancelled, or timed the job out in the meantime.
    if (job.status !== "submitted" || !job.providerJobId || s.now() - job.updatedAt < s.minPollIntervalMs) return job;

    let record: KieRecord;
    try {
      record = await callKieRecordInfo(s, job.providerJobId);
    } catch {
      // A failed status poll says nothing about the paid task; leave the job
      // as-is. The sweep is what eventually times it out. No retry of the task.
      return job;
    }
    job = readJob(s.dataDir, jobId) ?? job;
    if (job.status !== "submitted") return job;

    if (record.state === "success") {
      try {
        const dl = await guardedProviderDownload(s, { url: record.url, kind: job.kind, suffixes: s.catalog.kieResultHostSuffixes });
        // A cancellation that landed during the download wins: no artifact,
        // no write, no post. The bytes are simply dropped.
        const afterDownload = readJob(s.dataDir, jobId);
        if (!afterDownload || afterDownload.status !== "submitted") return afterDownload ?? job;
        const path = `${join(downloadsDir(s.dataDir), job.id)}${dl.ext}`;
        mkdirSync(downloadsDir(s.dataDir), { recursive: true, mode: 0o700 });
        writeFileSync(path, dl.bytes, { mode: 0o600 });
        const media = await registerArtifact(opts, s, afterDownload, { path, name: `${job.model}${dl.ext}` });
        // Atomic compare-and-set: only a job still 'submitted' becomes
        // 'succeeded', exactly once, whatever else happened meanwhile.
        const transition = transitionJobIf(s.dataDir, jobId, "submitted", (current) => ({
          ...current,
          status: "succeeded",
          result: { urlPath: media.urlPath, name: media.name },
          updatedAt: s.now(),
        }));
        if (!transition.ok) return transition.job ?? job;
        try {
          opts.onJobCompleted?.(transition.job, media);
        } catch {}
        return transition.job;
      } catch (e) {
        // A refused download (wrong scheme, unknown host, private address,
        // redirect, oversize, sniffed content) fails the job honestly. The
        // paid task ran; the bytes are just not trusted to be pulled in.
        const err = e instanceof OwnMediaError ? e : new OwnMediaError(sanitize(`Resultaat kon niet worden opgehaald: ${(e as Error)?.message || e}`, secretsOf(s)), 502, "download_refused");
        const transition = transitionJobIf(s.dataDir, jobId, "submitted", (current) => ({
          ...current,
          status: "failed",
          error: err.message,
          updatedAt: s.now(),
        }));
        return transition.job ?? job;
      }
    }
    if (record.state === "failed") {
      const transition = transitionJobIf(s.dataDir, jobId, "submitted", (current) => ({
        ...current,
        status: "failed",
        error: record.message,
        updatedAt: s.now(),
      }));
      return transition.job ?? job;
    }
    return transitionJobIf(s.dataDir, jobId, "submitted", (current) => ({ ...current, updatedAt: s.now() })).job ?? job;
  });
}

/* ------------------------------------------------------------------ */
/* Manual result (browser handoff)                                     */
/* ------------------------------------------------------------------ */

export async function completeOwnMediaJob(
  id: string,
  input: { path?: unknown; name?: unknown },
  opts: OwnMediaOptions = {},
): Promise<OwnMediaJob> {
  const s = settings(opts);
  const jobId = requireJobId(id);
  return awaitOrRunJobOp(jobId, async () => {
    const job = readJob(s.dataDir, jobId);
    if (!job) throw new OwnMediaError("Job niet gevonden.", 404, "not_found");
    if (job.provider !== "chatgpt" && job.provider !== "google-flow") {
      throw new OwnMediaError("Alleen browserroutes (ChatGPT, Google Flow) worden met een handmatig bestand afgerond.", 409, "conflict");
    }
    if (job.status !== "pending_handoff") {
      throw new OwnMediaError(`Deze job is al '${job.status}' en kan niet meer afgerond worden.`, 409, "conflict");
    }
    if (typeof input?.path !== "string" || !input.path.trim()) {
      throw new OwnMediaError("Stuur { path } mee: het geüploade bestand.", 400, "invalid_request");
    }

    // Only a real file inside the uploads root is accepted. No symlink escapes,
    // no arbitrary machine paths.
    let real: string;
    try {
      real = realpathSync(input.path.trim());
    } catch {
      throw new OwnMediaError("Geüpload bestand niet gevonden.", 400, "invalid_result_path");
    }
    const root = uploadsRootReal(opts.uploadsRoot ?? uploadsDir());
    if (real !== root && !real.startsWith(root + sep)) {
      throw new OwnMediaError("Dit bestand ligt niet in de uploadmap; resultaten van buiten worden geweigerd.", 400, "invalid_result_path");
    }
    const ext = extname(real).toLowerCase();
    const allowed = job.kind === "image" ? IMAGE_EXTS : VIDEO_EXTS;
    if (!allowed.has(ext)) {
      throw new OwnMediaError(`Verwacht een ${job.kind === "image" ? "afbeelding (png, jpg, jpeg, webp, gif)" : "video (mp4, m4v, webm, mov, ogv)"}.`, 400, "invalid_result_path");
    }
    // The extension is a claim; the bytes decide. Read the head of the file
    // and sniff the real media kind before accepting it.
    const head = readHead(real, 16);
    if (!head || sniffMediaKind(head) !== job.kind) {
      throw new OwnMediaError(`De inhoud van dit bestand is geen ${job.kind === "image" ? "afbeelding" : "video"}.`, 400, "invalid_result_path");
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(real);
    } catch {
      throw new OwnMediaError("Geüpload bestand niet gevonden.", 400, "invalid_result_path");
    }
    const cap = job.kind === "image" ? IMAGE_MAX_UPLOAD_BYTES : VIDEO_MAX_UPLOAD_BYTES;
    if (!st.isFile() || st.size <= 0) throw new OwnMediaError("Het bestand is leeg.", 400, "invalid_result_path");
    if (st.size > cap) throw new OwnMediaError(`Het bestand is groter dan ${Math.round(cap / (1024 * 1024))} MB.`, 400, "invalid_result_path");

    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : real.split(sep).pop() || "resultaat";
    let media: OwnMediaArtifactMedia;
    try {
      media = await registerArtifact(opts, s, job, { path: real, name });
    } catch (e) {
      // Validation failures (undecodable image, unprobeable video) are user
      // errors about the uploaded file, not server faults.
      if (e instanceof OwnMediaError) throw e;
      throw new OwnMediaError(
        `Het bestand kon niet als geldig ${job.kind === "image" ? "beeld" : "video"} worden gevalideerd: ${(e as Error)?.message || e}`,
        400,
        "invalid_result_path",
      );
    }
    // Atomic compare-and-set: if the job was cancelled while the artifact was
    // being registered, that cancellation stands — no result write, no post.
    const transition = transitionJobIf(s.dataDir, jobId, "pending_handoff", (current) => ({
      ...current,
      status: "succeeded",
      result: { urlPath: media.urlPath, name },
      updatedAt: s.now(),
    }));
    if (!transition.ok) {
      throw new OwnMediaError(`Deze job is al '${transition.job?.status ?? "verdwenen"}' en kan niet meer afgerond worden.`, 409, "conflict");
    }
    try {
      opts.onJobCompleted?.(transition.job, media);
    } catch {}
    return transition.job;
  });
}

/** First `len` bytes of a file, without loading it. Null when unreadable. */
function readHead(path: string, len: number): Uint8Array | null {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = new Uint8Array(len);
      const read = readSync(fd, buf, 0, len, 0);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Cancel and sweep                                                    */
/* ------------------------------------------------------------------ */

export async function cancelOwnMediaJob(id: string, opts: OwnMediaOptions = {}): Promise<OwnMediaJob> {
  const s = settings(opts);
  const jobId = requireJobId(id);
  // Synchronous compare-and-set, deliberately NOT behind the in-flight slot:
  // cancellation lands immediately, even while a poll or download is running.
  // The in-flight operation re-checks state before its own transition and can
  // therefore never overwrite this.
  const transition = transitionJobIf(s.dataDir, jobId, "non_terminal", (job) => ({
    ...job,
    status: "cancelled",
    updatedAt: s.now(),
    // Honest: for API jobs the provider task may already be running and paid;
    // nothing here claims or performs a refund.
    note: job.providerJobId
      ? "Geannuleerd. Een bij de provider gestarte API-generatie wordt niet automatisch gestopt of terugbetaald."
      : "Geannuleerd. Er is niets gegenereerd of betaald via deze site.",
  }));
  if (!transition.ok) {
    if (!transition.job) throw new OwnMediaError("Job niet gevonden.", 404, "not_found");
    throw new OwnMediaError(`Een job met status '${transition.job.status}' kan niet geannuleerd worden.`, 409, "conflict");
  }
  return transition.job;
}

/** Every extension a provider download can be stored under. */
const DOWNLOAD_EXTS = [".png", ".jpg", ".webp", ".gif", ".mp4", ".webm", ".mov", ".m4v"];

/**
 * Remove exactly the cached download files of one job: `${id}${ext}` for each
 * known extension. No wildcard, no client-supplied path — the id is validated
 * as a UUID first. The artifact copy in the artifacts store stays untouched;
 * the job's audit record stays on disk (private, 0600).
 */
function cleanupDownloadFiles(dataDir: string, jobId: string): void {
  if (!UUID_RE.test(jobId)) return;
  for (const ext of DOWNLOAD_EXTS) {
    rmSync(join(downloadsDir(dataDir), jobId + ext), { force: true });
  }
}

/** Fail stale in-progress jobs and expire old terminal ones. Called on handler entry. */
export function sweepOwnMediaJobs(opts: OwnMediaOptions = {}): { timedOut: number; expired: number } {
  const s = settings(opts);
  const dir = jobsDir(s.dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { timedOut: 0, expired: 0 };
  }
  let timedOut = 0;
  let expired = 0;
  const now = s.now();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const job = readJob(s.dataDir, id);
    if (!job) continue;
    if (!TERMINAL.includes(job.status) && now - job.updatedAt > s.inProgressTimeoutMs) {
      const t = transitionJobIf(s.dataDir, id, "non_terminal", (current) => ({
        ...current,
        status: "failed",
        error: "De provider gaf te lang geen resultaat. Deze job wordt niet meer gevolgd en niet automatisch opnieuw geprobeerd.",
        updatedAt: now,
      }));
      if (t.ok) timedOut++;
      continue;
    }
    if (TERMINAL.includes(job.status) && job.status !== "expired" && now - job.updatedAt > s.maxAgeMs) {
      const t = transitionJobIf(s.dataDir, id, job.status, (current) => ({ ...current, status: "expired", updatedAt: now }));
      if (t.ok) {
        cleanupDownloadFiles(s.dataDir, id);
        expired++;
      }
    }
  }
  return { timedOut, expired };
}

/* ------------------------------------------------------------------ */
/* HTTP handler                                                        */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function errorResponse(e: unknown): Response {
  if (e instanceof OwnMediaError) return json({ error: e.message, code: e.code, ...e.extra }, e.httpStatus);
  return json({ error: "Interne fout bij eigen media.", code: "invalid_request" }, 500);
}

function plainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function isOwnMediaPath(path: string): boolean {
  return (
    path === "/api/own-media/providers" ||
    path === "/api/own-media/jobs" ||
    /^\/api\/own-media\/jobs\/[^/]+$/.test(path) ||
    /^\/api\/own-media\/jobs\/[^/]+\/(result|cancel)$/.test(path)
  );
}

/**
 * Routes:
 *   GET  /api/own-media/providers
 *   POST /api/own-media/jobs                      {requestId, provider, model, kind, prompt, ...}
 *   GET  /api/own-media/jobs/:id                  (polls the provider at most once per interval)
 *   POST /api/own-media/jobs/:id/result           {path, name?}  — upload-validated manual result
 *   POST /api/own-media/jobs/:id/cancel
 *
 * INTEGRATION CONTRACT (serve wiring, owned elsewhere — not done in this module):
 *   1. In src/commands/serve.ts, next to the handleMediaRequest call, run
 *      `await handleOwnMediaRequest(req, url)` before the media routes (or after;
 *      the paths do not overlap) and return its response when non-null.
 *   2. Optional: pass OwnMediaOptions with onJobCompleted to append a thread
 *      message when a job tied to a thread finishes. Default options need
 *      nothing: env keys, PATHS.data and fetch come from the process.
 *   3. Mount web/src/components/own-media.tsx (OwnMediaPanel) where wanted —
 *      in the Thread view with threadId, or on the home surface without.
 *   4. Admin pricing: create a catalog JSON (env OMG_OWN_MEDIA_CATALOG) with
 *      providers.{openai,kie}.models[] entries carrying quote {amount, unit}
 *      and maxCredits. Until then API models are listed but refuse to start.
 *
 * These routes are NOT reachable until step 1 lands; this module makes no
 * claim that they are already served.
 */
export async function handleOwnMediaRequest(req: Request, url: URL, opts: OwnMediaOptions = {}): Promise<Response | null> {
  const path = url.pathname;
  if (!isOwnMediaPath(path)) return null;
  try {
    try {
      sweepOwnMediaJobs(opts);
    } catch {}
    if (path === "/api/own-media/providers" && req.method === "GET") {
      return json(listOwnMediaProviders(opts));
    }
    if (path === "/api/own-media/jobs" && req.method === "POST") {
      const body = plainObject(await req.json().catch(() => null));
      if (!body) return json({ error: "JSON-body vereist.", code: "invalid_request" }, 400);
      const result = await submitOwnMediaJob(body as unknown as OwnMediaSubmitInput, opts);
      return json(result, result.idempotent ? 200 : 201);
    }
    const m = path.match(/^\/api\/own-media\/jobs\/([^/]+)$/);
    if (m && req.method === "GET") {
      return json({ job: await getOwnMediaJob(decodeURIComponent(m[1]), opts) });
    }
    const r = path.match(/^\/api\/own-media\/jobs\/([^/]+)\/result$/);
    if (r && req.method === "POST") {
      const body = plainObject(await req.json().catch(() => null));
      if (!body) return json({ error: "JSON-body vereist.", code: "invalid_request" }, 400);
      return json({ job: await completeOwnMediaJob(decodeURIComponent(r[1]), { path: body.path, name: body.name }, opts) });
    }
    const c = path.match(/^\/api\/own-media\/jobs\/([^/]+)\/cancel$/);
    if (c && req.method === "POST") {
      return json({ job: await cancelOwnMediaJob(decodeURIComponent(c[1]), opts) });
    }
    return json({ error: "Methode niet toegestaan.", code: "invalid_request" }, 405);
  } catch (e) {
    return errorResponse(e);
  }
}
