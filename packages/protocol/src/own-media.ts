/**
 * OWN MEDIA: user-chosen media providers, not omg credits.
 *
 * Shared contract between `omg serve` (src/own-media.ts) and the web panel
 * (web/src/components/own-media.tsx). Four routes:
 *
 * - chatgpt      browser handoff to https://chatgpt.com (subscription; the
 *                model is chosen inside ChatGPT — no private API is promised)
 * - openai       direct OpenAI Images API, server-side OPENAI_API_KEY only
 * - google-flow  browser handoff to https://labs.google/fx/tools/flow
 *                (site credits; model chosen in the actual browser)
 * - kie          direct KIE jobs API, server-side KIE_API_KEY only
 *
 * Nothing here bills omg.dev credits and nothing hides the cost source: every
 * provider declares where the money comes from (subscription, site credits, or
 * API) and API jobs are refused until an admin has configured a quote and a
 * cap. No price is invented in code.
 */

export type OwnMediaProviderId = "chatgpt" | "openai" | "google-flow" | "kie";
export type OwnMediaKind = "image" | "video";
export type OwnMediaRoute = "browser" | "api";
export type OwnMediaCostSource = "subscription" | "site_credits" | "api";

export const OWN_MEDIA_PROVIDERS: readonly OwnMediaProviderId[] = ["chatgpt", "openai", "google-flow", "kie"];

/** External handoff targets. Fixed https URLs; never client-supplied. */
export const CHATGPT_HANDOFF_URL = "https://chatgpt.com";
export const GOOGLE_FLOW_HANDOFF_URL = "https://labs.google/fx/tools/flow";

export type OwnMediaQuote = {
  /**
   * Admin-configured price of one generation. This is an ESTIMATE for the
   * user, not an enforced provider limit: providers that bill variable output
   * can charge more. Never invented in code.
   */
  amount: number;
  unit: "credits" | "usd";
};

/** One selectable model of an API provider, exactly as configured. */
export type OwnMediaModelInfo = {
  id: string;
  label: string;
  kind: OwnMediaKind;
  aspectRatios?: string[];
  qualities?: string[];
  /** KIE GPT-Image 2.5: resolution tier "1K" | "2K" | "4K". */
  resolutions?: string[];
  /** KIE GPT-Image 2.5: "transparent" | "opaque" | "auto". */
  backgrounds?: string[];
  /** KIE WAN video: duration in seconds as a string ("5" | "10" | "15"). */
  durations?: string[];
  /** Present only when the admin configured a price. */
  quote?: OwnMediaQuote;
  /**
   * LOCAL submission ceiling in the quote unit, checked before submit. The
   * provider does NOT enforce this cap; combined with quote it is an estimate
   * guard, not a billing limit. Required together with quote.
   */
  maxCredits?: number;
};

export type OwnMediaProviderInfo = {
  id: OwnMediaProviderId;
  label: string;
  route: OwnMediaRoute;
  kinds: OwnMediaKind[];
  costSource: OwnMediaCostSource;
  /** Dutch billing label, e.g. "ChatGPT-abonnement". */
  billingLabel: string;
  /** Browser routes: the safe external URL to open. API routes: null. */
  handoffUrl: string | null;
  /** API routes: is the server-side key present? Never the key itself. */
  available: boolean;
  /** Honest Dutch note about model choice / setup. */
  note: string;
  models: OwnMediaModelInfo[];
};

export type OwnMediaJobStatus =
  | "pending_handoff"
  | "submitted"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type OwnMediaJob = {
  id: string;
  /** Stable client-chosen id: a repeat submit returns this job, never a second paid call. */
  requestId: string;
  /** Hash of the submit input. A repeat with the same requestId but different input is a conflict. */
  requestFingerprint: string;
  provider: OwnMediaProviderId;
  /** Catalog id for API routes; free hint for browser routes. */
  model: string;
  kind: OwnMediaKind;
  prompt: string;
  aspectRatio?: string;
  quality?: string;
  status: OwnMediaJobStatus;
  threadId?: string;
  cost: {
    source: OwnMediaCostSource;
    acknowledged: boolean;
    quote?: OwnMediaQuote;
  };
  providerJobId?: string;
  handoffUrl?: string;
  error?: string | null;
  /** Dutch, honest notes (e.g. cancellation does not refund API spend). */
  note?: string | null;
  result?: { urlPath: string; name: string };
  createdAt: number;
  updatedAt: number;
};

/** POST /api/own-media/jobs body. */
export type OwnMediaSubmitInput = {
  requestId: string;
  provider: OwnMediaProviderId;
  model: string;
  kind: OwnMediaKind;
  prompt: string;
  aspectRatio?: string;
  quality?: string;
  /** KIE GPT-Image 2.5 resolution tier ("1K" | "2K" | "4K"). */
  resolution?: string;
  /** KIE GPT-Image 2.5 background ("transparent" | "opaque" | "auto"). */
  background?: string;
  /** KIE WAN video duration in seconds as a string ("5" | "10" | "15"). */
  duration?: string;
  threadId?: string;
  /** API routes only: the user explicitly accepted the estimated cost. */
  costAcknowledged?: boolean;
};

/** Machine-readable refusal codes; the UI maps these to fixed Dutch text. */
export type OwnMediaErrorCode =
  | "invalid_request"
  | "unknown_provider"
  | "unknown_model"
  | "model_kind_mismatch"
  | "thread_not_found"
  | "cost_ack_required"
  | "quote_unavailable"
  | "cap_exceeded"
  | "not_found"
  | "conflict"
  | "invalid_result_path"
  | "download_refused"
  | "provider_error"
  | "key_missing";

/* ------------------------------------------------------------------ */
/* Dutch labels (kept here so server responses and the panel agree)   */
/* ------------------------------------------------------------------ */

export function ownMediaProviderLabel(id: OwnMediaProviderId): string {
  switch (id) {
    case "chatgpt":
      return "ChatGPT (browser)";
    case "openai":
      return "OpenAI Images API";
    case "google-flow":
      return "Google Flow (browser)";
    case "kie":
      return "KIE API";
  }
}

export function ownMediaCostSourceLabel(source: OwnMediaCostSource): string {
  switch (source) {
    case "subscription":
      return "ChatGPT-abonnement";
    case "site_credits":
      return "Google Flow-credits";
    case "api":
      return "API, betaald per gebruik";
  }
}

export function ownMediaKindLabel(kind: OwnMediaKind): string {
  return kind === "image" ? "afbeelding" : "video";
}

export function ownMediaStatusLabel(status: OwnMediaJobStatus): string {
  switch (status) {
    case "pending_handoff":
      return "wacht op jouw handmatige actie";
    case "submitted":
      return "aangeboden bij de provider";
    case "succeeded":
      return "klaar";
    case "failed":
      return "mislukt";
    case "cancelled":
      return "geannuleerd";
    case "expired":
      return "verlopen";
  }
}
