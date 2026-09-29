/**
 * Eigen media: compact panel to generate media on a provider the user chose —
 * ChatGPT or Google Flow by manual handoff, OpenAI or KIE directly through
 * server-side API keys. Costs are always shown by source (subscription, site
 * credits, API); the price line says "geschat" plus the LOCAL ceiling because
 * the provider does not enforce our cap. API submits stay disabled until an
 * admin-configured price exists and the user acknowledged it.
 *
 * Usable in a Thread (threadId set → the result is registered on that thread)
 * or on the home surface. One bordered panel, no nested cards, no animation.
 * All element ids derive from useId, so several panels can coexist.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  defaultOwnMediaApi,
  newOwnMediaRequestId,
  ownMediaCostKnown,
  ownMediaQuoteLabel,
  type OwnMediaApi,
  type OwnMediaJob,
  type OwnMediaKind,
  type OwnMediaModelInfo,
  type OwnMediaProviderId,
  type OwnMediaProviderInfo,
} from "../lib/own-media";
import {
  ownMediaKindLabel,
  ownMediaStatusLabel,
} from "../../../packages/protocol/src/own-media";

const COMMON_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
const POLL_FAILURES_BEFORE_ERROR = 2;

export function OwnMediaPanel({
  threadId = null,
  api,
  onJob,
  pollIntervalMs = 4000,
}: {
  threadId?: string | null;
  api?: OwnMediaApi;
  onJob?: (job: OwnMediaJob) => void;
  pollIntervalMs?: number;
}) {
  const a = useMemo(() => api ?? defaultOwnMediaApi(), [api]);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const [providers, setProviders] = useState<OwnMediaProviderInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<OwnMediaProviderId | "">("");
  const [kind, setKind] = useState<OwnMediaKind>("image");
  const [modelId, setModelId] = useState("");
  const [modelHint, setModelHint] = useState("");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [quality, setQuality] = useState("");
  const [resolution, setResolution] = useState("");
  const [background, setBackground] = useState("");
  const [duration, setDuration] = useState("");
  const [ack, setAck] = useState(false);
  const [job, setJob] = useState<OwnMediaJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const requestId = useRef(newOwnMediaRequestId());

  const provider = providers?.find((p) => p.id === providerId) ?? null;
  const model = provider?.route === "api" ? provider.models.find((m) => m.id === modelId) ?? null : null;
  const costKnown = provider?.route === "api" ? ownMediaCostKnown(model) : true;

  useEffect(() => {
    let live = true;
    a.providers()
      .then((list) => {
        if (!live) return;
        setProviders(list);
        setProviderId((current) => (current && list.some((p) => p.id === current) ? current : list[0]?.id ?? ""));
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : "Kon de aanbieders niet laden."));
    return () => {
      live = false;
    };
  }, [a]);

  // Follow the provider kinds and models of the chosen provider.
  useEffect(() => {
    if (!provider) return;
    setKind((current) => (provider.kinds.includes(current) ? current : provider.kinds[0]));
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!provider || provider.route !== "api") return;
    const options = provider.models.filter((m) => m.kind === kind);
    setModelId((current) => (options.some((m) => m.id === current) ? current : options[0]?.id ?? ""));
  }, [provider?.id, provider?.route, kind, provider?.models]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stale options never survive a provider, model or kind switch: every
  // schema-driven select resets unless its value is still offered.
  const schemaKey = `${providerId}|${kind}|${modelId}`;
  useEffect(() => {
    setAspectRatio((cur) => (model?.aspectRatios?.includes(cur) || (!model?.aspectRatios && cur === "") ? cur : ""));
    setQuality((cur) => (model?.qualities?.includes(cur) ? cur : ""));
    setResolution((cur) => (model?.resolutions?.includes(cur) ? cur : ""));
    setBackground((cur) => (model?.backgrounds?.includes(cur) ? cur : ""));
    setDuration((cur) => (model?.durations?.includes(cur) ? cur : model?.durations?.length ? "" : ""));
  }, [schemaKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const intentKey = `${providerId}|${kind}|${modelId}|${modelHint}|${prompt}|${aspectRatio}|${quality}|${resolution}|${background}|${duration}|${threadId ?? ""}`;
  const lastIntent = useRef(intentKey);
  useEffect(() => {
    if (lastIntent.current === intentKey) return;
    lastIntent.current = intentKey;
    requestId.current = newOwnMediaRequestId();
    setJob(null);
    setAck(false);
    setError(null);
  }, [intentKey]);

  useEffect(() => {
    if (job && onJob) onJob(job);
  }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll API jobs while they run: at most one in-flight request, errors become
  // visible after repeated failures, and unmount aborts the pending request.
  // Nothing here retries a submit.
  const pollInFlight = useRef(false);
  useEffect(() => {
    if (job?.status !== "submitted") return;
    const controller = new AbortController();
    let failures = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled || pollInFlight.current) return;
      pollInFlight.current = true;
      a.job(job.id, controller.signal)
        .then((next) => {
          if (cancelled) return;
          failures = 0;
          setPollError(null);
          setJob(next);
        })
        .catch((e) => {
          if (cancelled || controller.signal.aborted) return;
          failures++;
          if (failures >= POLL_FAILURES_BEFORE_ERROR) {
            setPollError(
              `Status opvragen lukt niet (${failures} keer pogingen${e instanceof Error ? `: ${e.message}` : ""}). Controleer de verbinding; de opdracht blijft gewoon staan.`,
            );
          }
        })
        .finally(() => {
          pollInFlight.current = false;
        });
    };
    const timer = setInterval(() => {
      if (!document.hidden) tick();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [job?.status, job?.id, a, pollIntervalMs]);

  if (loadError) {
    return (
      <section aria-label="Eigen media" className="rounded-xl border bg-card p-3 text-sm">
        <p role="alert">{loadError}</p>
      </section>
    );
  }
  if (!providers || !provider) return null;

  const kindOptions = provider.kinds;
  const modelOptions = provider.route === "api" ? provider.models.filter((m) => m.kind === kind) : [];
  const ratioOptions = model?.aspectRatios ?? (provider.route === "api" ? [] : COMMON_RATIOS);
  const needsAck = provider.route === "api";
  const apiBlocked = provider.route === "api" && (!provider.available || !costKnown || !model);
  const canSubmit =
    !busy &&
    !apiBlocked &&
    prompt.trim().length > 0 &&
    (!needsAck || ack) &&
    (provider.route === "api" ? modelId !== "" : modelHint.trim().length > 0) &&
    (!model?.durations?.length || duration !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await a.submit({
        requestId: requestId.current,
        provider: provider!.id,
        model: provider!.route === "api" ? modelId : modelHint.trim(),
        kind,
        prompt: prompt.trim(),
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(quality ? { quality } : {}),
        ...(resolution ? { resolution } : {}),
        ...(background ? { background } : {}),
        ...(duration ? { duration } : {}),
        ...(threadId ? { threadId } : {}),
        ...(provider!.route === "api" ? { costAcknowledged: true } : {}),
      });
      setJob(result.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Job aanmaken lukte niet.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadResult(file: File) {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      setJob(await a.completeWithFile(job.id, file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Uploaden van het resultaat lukte niet.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    setBusy(true);
    try {
      setJob(await a.cancel(job.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Annuleren lukte niet.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setJob(null);
    setAck(false);
    setError(null);
    setPollError(null);
    requestId.current = newOwnMediaRequestId();
  }

  return (
    <section aria-label="Eigen media" className="rounded-xl border bg-card p-3 text-sm">
      <form onSubmit={submit}>
        <fieldset disabled={!!job}>
          <legend className="px-1 font-medium">Eigen media</legend>

          <div className="mt-2 grid gap-2">
            <div>
              <label htmlFor={id("provider")} className="text-muted-foreground">
                Aanbieder
              </label>
              <select
                id={id("provider")}
                name="provider"
                className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                value={providerId}
                aria-describedby={id("provider-note")}
                onChange={(e) => setProviderId(e.target.value as OwnMediaProviderId)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} — {p.billingLabel}
                  </option>
                ))}
              </select>
              <p id={id("provider-note")} className="mt-1 text-muted-foreground">
                {provider.note}
              </p>
            </div>

            {kindOptions.length > 1 && (
              <div>
                <label htmlFor={id("kind")} className="text-muted-foreground">
                  Soort
                </label>
                <select
                  id={id("kind")}
                  name="kind"
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as OwnMediaKind)}
                >
                  {kindOptions.map((k) => (
                    <option key={k} value={k}>
                      {ownMediaKindLabel(k)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {provider.route === "api" ? (
              <div>
                <label htmlFor={id("model")} className="text-muted-foreground">
                  Model
                </label>
                {modelOptions.length ? (
                  <select
                    id={id("model")}
                    name="model"
                    className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  >
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="mt-1 text-muted-foreground">Geen {ownMediaKindLabel(kind)}modellen geconfigureerd voor deze aanbieder.</p>
                )}
              </div>
            ) : (
              <div>
                <label htmlFor={id("model-hint")} className="text-muted-foreground">
                  Model (hint)
                </label>
                <input
                  id={id("model-hint")}
                  name="modelHint"
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                  value={modelHint}
                  maxLength={80}
                  placeholder={provider.id === "chatgpt" ? "bijv. het model dat ChatGPT aanbiedt" : "bijv. het Veo/Gemini-model dat Flow aanbiedt"}
                  aria-describedby={id("model-hint-note")}
                  onChange={(e) => setModelHint(e.target.value)}
                />
                <p id={id("model-hint-note")} className="mt-1 text-muted-foreground">
                  Je kiest het echte model in de externe site; dit veld is alleen een hint bij de opdracht.
                </p>
              </div>
            )}

            <div>
              <label htmlFor={id("prompt")} className="text-muted-foreground">
                Prompt
              </label>
              <textarea
                id={id("prompt")}
                name="prompt"
                className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                rows={3}
                maxLength={4000}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                required
              />
            </div>

            {ratioOptions.length > 0 && (
              <div>
                <label htmlFor={id("ratio")} className="text-muted-foreground">
                  Beeldverhouding
                </label>
                <select
                  id={id("ratio")}
                  name="aspectRatio"
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                >
                  <option value="">niet opgegeven</option>
                  {ratioOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {model?.qualities?.length ? (
              <div>
                <label htmlFor={id("quality")} className="text-muted-foreground">
                  Kwaliteit
                </label>
                <select
                  id={id("quality")}
                  name="quality"
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                >
                  <option value="">niet opgegeven</option>
                  {model.qualities.map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {model?.resolutions?.length ? (
              <div>
                <label htmlFor={id("resolution")} className="text-muted-foreground">
                  Resolutie
                </label>
                <select
                  id={id("resolution")}
                  name="resolution"
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                >
                  <option value="">niet opgegeven</option>
                  {model.resolutions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {model?.backgrounds?.length ? (
              <div>
                <label htmlFor={id("background")} className="text-muted-foreground">
                  Achtergrond
                </label>
                <select
                  id={id("background")}
                  name="background"
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                >
                  <option value="">niet opgegeven</option>
                  {model.backgrounds.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {model?.durations?.length ? (
              <div>
                <label htmlFor={id("duration")} className="text-muted-foreground">
                  Duur (seconden)
                </label>
                <select
                  id={id("duration")}
                  name="duration"
                  className="mt-1 w-full rounded-lg border bg-background px-2 py-1.5"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  required
                >
                  {duration === "" && <option value="">kies een duur</option>}
                  {model.durations.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <p className="text-muted-foreground">
              Kosten: {provider.billingLabel}
              {provider.route === "api" && model
                ? costKnown
                  ? ` — ${ownMediaQuoteLabel(model.quote!)} (lokaal plafond ${model.maxCredits} ${model.quote!.unit === "credits" ? "credits" : "USD"}; de provider dwingt dit niet af)`
                  : " — prijs niet ingesteld, starten is uitgeschakeld"
                : ""}
              .
            </p>

            {needsAck && costKnown && !job && (
              <label className="flex items-start gap-2">
                <input type="checkbox" name="costAck" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
                <span>Ik accepteer deze geschatte kosten; de generatie draait via de API en het werkelijke bedrag kan afwijken.</span>
              </label>
            )}

            {!job && (
              <button
                type="submit"
                disabled={!canSubmit}
                className="w-full rounded-lg bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50"
              >
                {provider.route === "api" ? `Genereer via ${provider.label}` : "Opdracht klaarzetten"}
              </button>
            )}
            {!job && apiBlocked && (
              <p role="alert" className="text-muted-foreground">
                {!provider.available
                  ? "De server heeft geen API-sleutel voor deze aanbieder."
                  : !model
                    ? `Geen ${ownMediaKindLabel(kind)}modellen geconfigureerd voor deze aanbieder.`
                    : "De beheerder heeft voor dit model nog geen prijs en plafond ingesteld. Starten staat uit tot dat gebeurt; er wordt niets uitgegeven."}
              </p>
            )}
            {!job && !apiBlocked && model?.durations?.length && duration === "" && (
              <p role="alert" className="text-muted-foreground">
                Kies eerst een duur; zonder duur wordt er niets verstuurd.
              </p>
            )}
          </div>
        </fieldset>
      </form>

      {job && (
        <div className="mt-2 grid gap-2" role="status">
          <p>
            Status: <strong>{ownMediaStatusLabel(job.status)}</strong>
            {job.cost.source === "api" && job.cost.quote ? ` — ${ownMediaQuoteLabel(job.cost.quote)} via API` : ""}
          </p>

          {job.status === "pending_handoff" && job.handoffUrl && (
            <>
              <p className="text-muted-foreground">
                Niets wordt op deze site gegenereerd. Open de externe site, maak daar het {ownMediaKindLabel(job.kind)} met de prompt hieronder, en upload het bestand daarna hier.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={job.handoffUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                >
                  Open {job.provider === "chatgpt" ? "ChatGPT" : "Google Flow"}
                </a>
                <button
                  type="button"
                  className="font-medium text-primary underline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(job.prompt);
                      setCopied(true);
                    } catch {
                      setError("Kon de prompt niet kopiëren; kopieer hem handmatig.");
                    }
                  }}
                >
                  Kopieer prompt
                </button>
                {copied && <span className="text-muted-foreground">gekopieerd</span>}
              </div>
              <div>
                <label htmlFor={id("result")} className="text-muted-foreground">
                  Resultaat uploaden ({job.kind === "image" ? "png, jpg, webp of gif" : "mp4, webm of mov"})
                </label>
                <input
                  id={id("result")}
                  name="result"
                  type="file"
                  accept={job.kind === "image" ? "image/png,image/jpeg,image/webp,image/gif" : "video/mp4,video/webm,video/quicktime"}
                  className="mt-1 w-full"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadResult(file);
                  }}
                />
              </div>
            </>
          )}

          {job.status === "submitted" && (
            <p className="text-muted-foreground">
              De provider is aan het werk. Deze pagina ververs de status zelf; er wordt niets opnieuw aangeboden.
            </p>
          )}
          {job.status === "submitted" && pollError && (
            <p role="alert">
              {pollError}
            </p>
          )}

          {job.status === "succeeded" && job.result && (
            <div className="grid gap-2">
              {job.kind === "image" ? (
                <img src={job.result.urlPath} alt={job.prompt.slice(0, 120)} className="max-h-64 w-auto rounded-lg" />
              ) : (
                <a href={job.result.urlPath} target="_blank" rel="noreferrer" className="font-medium text-primary underline">
                  Bekijk de video
                </a>
              )}
            </div>
          )}

          {(job.status === "failed" || job.status === "cancelled" || job.status === "expired") && (
            <p role="alert">{job.error ?? job.note ?? ownMediaStatusLabel(job.status)}</p>
          )}

          <div className="flex flex-wrap gap-3">
            {!["succeeded", "failed", "cancelled", "expired"].includes(job.status) && (
              <button type="button" className="text-muted-foreground underline" disabled={busy} onClick={() => void cancelJob()}>
                Annuleer opdracht
              </button>
            )}
            <button type="button" className="font-medium text-primary underline" onClick={reset}>
              Nieuwe opdracht
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2">
          {error}
        </p>
      )}
    </section>
  );
}
