import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock, ExternalLink, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

// Taken: wat er voor Sam ligt, automatisch verzameld uit mail, gesprekken en
// bestellingen (agentbox/taken/collect.py, elke 10 min). Alleen lezen: deze
// lijst verstuurt nooit iets. Afvinken of "later" bewaart alleen een status
// in ~/.local/state/taken/status.json via /api/taken.

export type TaakSoort = "vraag" | "vast" | "gedaan" | "mail" | "melding" | "bestelling";
export type Taak = {
  id: string;
  bron: "gesprek" | "gedaan" | "mail" | "bestelling";
  soort: TaakSoort;
  titel: string;
  detail?: string;
  wie?: string;
  link?: string;
  sessie?: string;
  tijd?: string;
  machine?: boolean;
  ongelezen?: boolean;
  status: "open" | "later" | "gedaan";
  afgevinkt?: string | null;
};
type TakenData = { bijgewerkt?: string; ververst?: boolean; bronnen: Record<string, { ok: boolean; aantal: number; fout?: string }>; items: Taak[] };

const LABEL: Record<TaakSoort, string> = {
  vraag: "Vraag", vast: "Vast", gedaan: "Gedaan", mail: "Mail", melding: "Melding", bestelling: "Bestelling",
};
// Volgorde van belang: een agent die op Sam wacht gaat voor een mail, een mail
// van een klant voor een bestelling die alleen traag is.
const RANG: Record<TaakSoort, number> = { vraag: 0, mail: 1, bestelling: 2, vast: 3, melding: 4, gedaan: 5 };

const EVENT = "omg-taken-changed";
let cache: TakenData | null = null;

async function laad(): Promise<TakenData> {
  const r = await fetch("/api/taken", { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  cache = (await r.json()) as TakenData;
  window.dispatchEvent(new Event(EVENT));
  return cache;
}

export function useTaken() {
  const [data, setData] = useState<TakenData | null>(cache);
  const [fout, setFout] = useState(false);
  useEffect(() => {
    let dood = false;
    const haal = () => laad().then(d => { if (!dood) { setData(d); setFout(false); } }, () => { if (!dood) setFout(true); });
    const opWijziging = () => { if (!dood && cache) setData(cache); };
    haal();
    const t = window.setInterval(haal, 60_000);
    const zicht = () => { if (document.visibilityState === "visible") haal(); };
    document.addEventListener("visibilitychange", zicht);
    window.addEventListener(EVENT, opWijziging);
    return () => { dood = true; window.clearInterval(t); document.removeEventListener("visibilitychange", zicht); window.removeEventListener(EVENT, opWijziging); };
  }, []);
  const zet = useCallback(async (id: string, status: Taak["status"]) => {
    if (cache) {
      cache = { ...cache, items: cache.items.map(i => i.id === id ? { ...i, status, afgevinkt: status === "open" ? null : new Date().toISOString() } : i) };
      window.dispatchEvent(new Event(EVENT));
    }
    await fetch(`/api/taken/item/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
    }).catch(() => undefined);
    laad().catch(() => undefined);
  }, []);
  return { data, fout, zet };
}

function isVandaag(iso?: string | null) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function wanneer(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return "nu";
  if (min < 60) return `${min} min`;
  if (isVandaag(iso)) return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  const dagen = Math.round(min / 1440);
  return dagen <= 1 ? "gisteren" : `${dagen} dagen`;
}

export function deelTaken(items: Taak[]) {
  const open = items.filter(i => i.status === "open" && i.soort !== "gedaan" && i.soort !== "melding")
    .sort((a, b) => RANG[a.soort] - RANG[b.soort] || (b.tijd ?? "").localeCompare(a.tijd ?? ""));
  const meldingen = items.filter(i => i.status === "open" && i.soort === "melding");
  const later = items.filter(i => i.status === "later");
  const gedaan = items.filter(i => (i.soort === "gedaan" && i.status !== "later") || (i.status === "gedaan" && isVandaag(i.afgevinkt)))
    .sort((a, b) => (b.afgevinkt ?? b.tijd ?? "").localeCompare(a.afgevinkt ?? a.tijd ?? ""));
  return { open, meldingen, later, gedaan };
}

function TaakRij({ taak, onOpenSession, zet, klein, smal }: {
  taak: Taak; onOpenSession?: (sid: string) => void; zet: (id: string, s: Taak["status"]) => void; klein?: boolean; smal?: boolean;
}) {
  const kanOpenen = !!(taak.sessie && onOpenSession) || !!taak.link;
  const open = () => {
    if (taak.sessie && onOpenSession) onOpenSession(taak.sessie);
    else if (taak.link) window.open(taak.link, "_blank", "noopener");
  };
  const klaar = taak.status === "gedaan" || taak.soort === "gedaan";
  return (
    <li className="taak group relative flex items-start gap-3 py-2.5" data-soort={taak.soort} data-status={taak.status}>
      <span aria-hidden="true" className="taak-stip mt-[7px] size-2 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={open} disabled={!kanOpenen}
          className="block w-full min-w-0 text-left focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 font-medium leading-snug text-foreground", klein ? "text-[13px]" : "text-sm", klaar && "text-muted-foreground", "line-clamp-2")}>{taak.titel}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{wanneer(taak.afgevinkt && taak.status === "gedaan" ? taak.afgevinkt : taak.tijd)}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            <span className="taak-soort font-medium">{LABEL[taak.soort]}</span>
            {taak.wie ? <> · {taak.wie}</> : null}
            {taak.detail ? <> · {taak.detail}</> : null}
            {taak.link && !taak.sessie ? <ExternalLink aria-hidden="true" className="ml-1 inline size-3 align-[-2px]" /> : null}
          </span>
        </button>
      </div>
      {taak.soort !== "gedaan" && (
        <div className="taak-knoppen flex shrink-0 items-center">
          {taak.status === "open" ? (
            <>
              {!smal && <button type="button" onClick={() => zet(taak.id, "later")} title="Later (morgen terug)" aria-label={`Later: ${taak.titel}`}
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><Clock className="size-4" /></button>}
              <button type="button" onClick={() => zet(taak.id, "gedaan")} title="Gedaan" aria-label={`Gedaan: ${taak.titel}`}
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><Check className="size-4" /></button>
            </>
          ) : (
            <button type="button" onClick={() => zet(taak.id, "open")} title="Terugzetten" aria-label={`Terugzetten: ${taak.titel}`}
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><RotateCcw className="size-4" /></button>
          )}
        </div>
      )}
    </li>
  );
}

function Kop({ children, aantal }: { children: string; aantal?: number }) {
  return <h3 className="taken-kop mt-4 mb-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground first:mt-1">
    {children}{aantal !== undefined ? <span className="ml-1.5 font-normal tabular-nums">{aantal}</span> : null}
  </h3>;
}

function Bronregel({ data }: { data: TakenData }) {
  const kapot = Object.entries(data.bronnen).filter(([, b]) => !b.ok).map(([n]) => n);
  return <p className="mt-4 text-[11px] text-muted-foreground">
    Bijgewerkt {data.bijgewerkt ? wanneer(data.bijgewerkt) : "nog niet"} uit mail, gesprekken en bestellingen
    {kapot.length ? <>; <span className="text-destructive">{kapot.join(", ")} niet bereikbaar, vorige stand getoond</span></> : null}.
  </p>;
}

/** De Taken-tab in de zijbalk: alles, gegroepeerd. */
export function TakenLijst({ onOpenSession, smal }: { onOpenSession?: (sid: string) => void; smal?: boolean }) {
  const { data, fout, zet } = useTaken();
  const [meldingenOpen, setMeldingenOpen] = useState(false);
  const delen = useMemo(() => deelTaken(data?.items ?? []), [data]);
  if (!data) return <p role="status" className="px-3 py-6 text-sm text-muted-foreground">{fout ? "Taken niet bereikbaar." : "Taken laden…"}</p>;
  return (
    <section aria-label="Taken" className="taken px-3 pb-4">
      <Kop aantal={delen.open.length}>Voor jou</Kop>
      {delen.open.length ? <ul>{delen.open.map(t => <TaakRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} smal={smal} />)}</ul>
        : <p className="py-2 text-sm text-muted-foreground">Niets dat op jou wacht.</p>}
      {delen.meldingen.length > 0 && <>
        <button type="button" onClick={() => setMeldingenOpen(o => !o)} aria-expanded={meldingenOpen}
          className="taken-kop mt-4 flex min-h-9 items-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground">
          Meldingen <span className="ml-1.5 font-normal tabular-nums">{delen.meldingen.length}</span><span className="ml-1.5 font-normal normal-case tracking-normal">{meldingenOpen ? "verbergen" : "tonen"}</span>
        </button>
        {meldingenOpen && <ul>{delen.meldingen.map(t => <TaakRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} klein smal={smal} />)}</ul>}
      </>}
      {delen.later.length > 0 && <><Kop aantal={delen.later.length}>Later</Kop>
        <ul>{delen.later.map(t => <TaakRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} klein />)}</ul></>}
      {delen.gedaan.length > 0 && <><Kop aantal={delen.gedaan.length}>Vandaag gedaan</Kop>
        <ul>{delen.gedaan.map(t => <TaakRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} klein />)}</ul></>}
      <Bronregel data={data} />
    </section>
  );
}

/** Onder de composer op het lege scherm: de bovenste taken en wat er vandaag af is. */
export function TakenVandaag({ onOpenSession, onAlles }: { onOpenSession?: (sid: string) => void; onAlles?: () => void }) {
  const { data, zet } = useTaken();
  const delen = useMemo(() => deelTaken(data?.items ?? []), [data]);
  if (!data) return null;
  const top = delen.open.slice(0, 6);
  return (
    <section aria-label="Taken vandaag" className="taken taken-vandaag mx-auto w-full max-w-xl px-4 pb-8">
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Voor jou <span className="ml-1 text-sm font-normal tabular-nums text-muted-foreground">{delen.open.length}</span></h2>
        {onAlles && delen.open.length > top.length ? <button type="button" onClick={onAlles} className="min-h-9 text-xs font-medium text-primary hover:underline">Alle {delen.open.length} taken</button> : null}
      </div>
      {top.length ? <ul>{top.map(t => <TaakRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} />)}</ul>
        : <p className="py-3 text-sm text-muted-foreground">Niets dat op jou wacht.</p>}
      {delen.gedaan.length > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Vandaag gedaan: </span>
          {delen.gedaan.slice(0, 4).map(t => t.titel).join(" · ")}{delen.gedaan.length > 4 ? ` en ${delen.gedaan.length - 4} meer` : ""}
        </p>
      )}
      <Bronregel data={data} />
    </section>
  );
}
