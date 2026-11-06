/**
 * Client helpers for the own-media panel: typed calls against the
 * /api/own-media routes plus the pure payload/label helpers, so the panel
 * stays dumb and testable offline.
 *
 * The API surface is injected (OwnMediaApi): the component takes it as a prop
 * and tests pass fakes. `defaultOwnMediaApi` is the real transport over
 * omgFetch, including the upload step for manual results through the existing
 * POST /api/uploads route (files land under the uploads dir; the server only
 * accepts manual results from there).
 */
import { omgFetch } from "./omg-client";
import {
  ownMediaProviderLabel,
  type OwnMediaJob,
  type OwnMediaKind,
  type OwnMediaModelInfo,
  type OwnMediaProviderId,
  type OwnMediaProviderInfo,
  type OwnMediaQuote,
  type OwnMediaSubmitInput,
} from "../../../packages/protocol/src/own-media";

export type { OwnMediaJob, OwnMediaKind, OwnMediaModelInfo, OwnMediaProviderId, OwnMediaProviderInfo, OwnMediaQuote, OwnMediaSubmitInput };
export { ownMediaProviderLabel };

export class OwnMediaClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/** Dutch message for a refusal body; fixed per code so wording cannot drift per view. */
export function parseOwnMediaError(body: unknown, fallback = "Eigen media lukte niet."): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string") {
    const code = (body as Record<string, unknown>).code;
    if (code === "quote_unavailable") return "De beheerder heeft voor dit model nog geen prijs en plafond ingesteld. Starten staat uit tot dat gebeurt; er wordt niets uitgegeven.";
    return (body as Record<string, unknown>).error as string;
  }
  return fallback;
}

export function ownMediaQuoteLabel(quote: OwnMediaQuote): string {
  // "geschat" on purpose: the quote is an admin estimate, not an enforced
  // provider limit.
  return quote.unit === "credits"
    ? `geschat ${quote.amount} credits per generatie`
    : `geschat US$ ${quote.amount.toFixed(2)} per generatie`;
}

export function ownMediaCostKnown(model: OwnMediaModelInfo | null | undefined): boolean {
  return !!model?.quote && typeof model.maxCredits === "number";
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function expectOk(res: Response, fallback: string): Promise<Record<string, unknown>> {
  const body = (await readJson(res)) as Record<string, unknown> | null;
  if (!res.ok) throw new OwnMediaClientError(parseOwnMediaError(body, fallback), String(body?.code ?? "error"), res.status);
  return (body ?? {}) as Record<string, unknown>;
}

export type OwnMediaApi = {
  providers(): Promise<OwnMediaProviderInfo[]>;
  submit(input: OwnMediaSubmitInput): Promise<{ job: OwnMediaJob; idempotent: boolean }>;
  job(id: string, signal?: AbortSignal): Promise<OwnMediaJob>;
  cancel(id: string): Promise<OwnMediaJob>;
  /** Uploads the local result through /api/uploads and completes the job with its path. */
  completeWithFile(id: string, file: File): Promise<OwnMediaJob>;
};

export function defaultOwnMediaApi(): OwnMediaApi {
  return {
    async providers() {
      const res = await omgFetch("/api/own-media/providers");
      const body = await expectOk(res, "Kon de aanbieders niet laden.");
      return (body.providers as OwnMediaProviderInfo[]) ?? [];
    },
    async submit(input) {
      const res = await omgFetch("/api/own-media/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await expectOk(res, "Job aanmaken lukte niet.");
      return { job: body.job as OwnMediaJob, idempotent: body.idempotent === true };
    },
    async job(id, signal) {
      const res = await omgFetch(`/api/own-media/jobs/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) });
      const body = await expectOk(res, "Jobstatus kon niet gelezen worden.");
      return body.job as OwnMediaJob;
    },
    async cancel(id) {
      const res = await omgFetch(`/api/own-media/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      const body = await expectOk(res, "Annuleren lukte niet.");
      return body.job as OwnMediaJob;
    },
    async completeWithFile(id, file) {
      // The existing upload route from serve.ts: POST /api/uploads?filename=…
      // with raw bytes answers { ok, path, name }; `path` is the absolute
      // uploads-dir path the result endpoint requires.
      const upload = await omgFetch(`/api/uploads?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: file.type ? { "Content-Type": file.type } : undefined,
        body: file,
      });
      const uploaded = await expectOk(upload, "Uploaden van het resultaat lukte niet.");
      if (typeof uploaded.path !== "string") throw new OwnMediaClientError("De server gaf geen uploadpad terug.", "upload_failed", 500);
      const res = await omgFetch(`/api/own-media/jobs/${encodeURIComponent(id)}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: uploaded.path, name: file.name }),
      });
      const body = await expectOk(res, "Afgerond met het bestand lukte niet.");
      return body.job as OwnMediaJob;
    },
  };
}

/** A fresh id per intent: retries of the same content reuse it, so the server returns the original job. */
export function newOwnMediaRequestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `om-${c.randomUUID()}`;
  return `om-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
