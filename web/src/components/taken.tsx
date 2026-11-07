import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Check, Clock, CornerDownRight, ExternalLink, Eye, Loader2, MessageSquare, RotateCcw, Sparkles } from "lucide-react";
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

/** Status zetten buiten de hook om (ook vanuit de composer na een opdracht). */
export async function zetTaak(id: string, status: Taak["status"]) {
  if (cache) {
    cache = { ...cache, items: cache.items.map(i => i.id === id ? { ...i, status, afgevinkt: status === "open" ? null : new Date().toISOString() } : i) };
    window.dispatchEvent(new Event(EVENT));
  }
  await fetch(`/api/taken/item/${encodeURIComponent(id)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  }).catch(() => undefined);
  laad().catch(() => undefined);
}

// Opdracht geven: Sam reageert op een melding vaker met werk dan met wegklikken.
// De knop zet de melding als tekst in de composer van een nieuwe sessie; pas als
// die sessie echt start, gaat de melding naar "gedaan". Annuleren laat hem staan.
export const OPDRACHT_EVENT = "agentbox-opdracht";
export const MELDINGEN_EVENT = "agentbox-meldingen";
let wachtend: { id: string; tekst: string } | null = null;
let lopend: { id: string; tekst: string } | null = null;

export function opdrachtTekst(t: Taak): string {
  const kop = t.soort === "melding" ? "Melding" : t.soort === "vast" ? "Vastgelopen" : LABEL[t.soort];
  const regels = [`${kop}: ${t.titel}`];
  const meta = [t.wie, t.tijd ? new Date(t.tijd).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" }) : ""].filter(Boolean).join(" · ");
  if (meta) regels.push(meta);
  if (t.detail) regels.push(t.detail);
  if (t.sessie) regels.push(`Sessie: ${t.sessie}`);
  if (t.link) regels.push(`Link: ${t.link}`);
  return `${regels.join("\n")}\n\nOpdracht: `;
}

export function geefOpdracht(t: Taak) {
  wachtend = { id: t.id, tekst: opdrachtTekst(t) };
  window.dispatchEvent(new Event(OPDRACHT_EVENT));
}

/** De composer pakt de wachtende opdracht één keer op. */
export function neemOpdracht(): string | null {
  const w = wachtend;
  wachtend = null;
  if (!w) return null;
  lopend = w;
  return w.tekst;
}

/** Na een echte start: staat de meldingstekst nog in de prompt, dan is hij afgehandeld. */
export function opdrachtVerstuurd(prompt: string) {
  const l = lopend;
  lopend = null;
  if (l && prompt.includes(l.tekst.split("\n")[0]!)) void zetTaak(l.id, "gedaan");
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
  const zet = useCallback((id: string, status: Taak["status"]) => zetTaak(id, status), []);
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

// Een vastgelopen bot (Copyreviewer e.d.) is geen werk voor Sam: dat is een melding.
export const isMelding = (i: Taak) => i.soort === "melding" || (!!i.machine && i.soort === "vast");

/** Open werk voor de teller op de Taken-tab: voor jou + meldingen. Zo zie je het ook vanuit Aandacht. */
/* agentbox: open bevindingen van auto-agents tellen mee in de Taken-tab.
   App zet het aantal (de lijst zelf leeft daar); de tab leest het hier. */
let bevindingenAantal = 0;
const bevindingenLuisteraars = new Set<() => void>();
export function zetBevindingenAantal(n: number) {
  if (n === bevindingenAantal) return;
  bevindingenAantal = n;
  for (const l of bevindingenLuisteraars) l();
}
export function useBevindingenAantal(): number {
  return useSyncExternalStore(
    (l) => { bevindingenLuisteraars.add(l); return () => { bevindingenLuisteraars.delete(l); }; },
    () => bevindingenAantal,
    () => 0,
  );
}

export function useTakenTelling(): { voorJou: number; meldingen: number } {
  const { data } = useTaken();
  const bevindingen = useBevindingenAantal();
  return useMemo(() => {
    const d = deelTaken(data?.items ?? []);
    return { voorJou: d.open.length, meldingen: d.meldingen.length + bevindingen };
  }, [data, bevindingen]);
}

export function deelTaken(items: Taak[]) {
  const open = items.filter(i => i.status === "open" && i.soort !== "gedaan" && !isMelding(i))
    .sort((a, b) => RANG[a.soort] - RANG[b.soort] || (b.tijd ?? "").localeCompare(a.tijd ?? ""));
  const meldingen = items.filter(i => i.status === "open" && isMelding(i));
  const later = items.filter(i => i.status === "later");
  const gedaan = items.filter(i => (i.soort === "gedaan" && i.status !== "later") || (i.status === "gedaan" && isVandaag(i.afgevinkt)))
    .sort((a, b) => (b.afgevinkt ?? b.tijd ?? "").localeCompare(a.afgevinkt ?? a.tijd ?? ""));
  return { open, meldingen, later, gedaan };
}

function TaakRij({ taak, onOpenSession, zet, klein }: {
  taak: Taak; onOpenSession?: (sid: string) => void; zet: (id: string, s: Taak["status"]) => void; klein?: boolean; smal?: boolean;
}) {
  const kanOpenen = !!(taak.sessie && onOpenSession) || !!taak.link;
  const open = () => {
    if (taak.sessie && onOpenSession) onOpenSession(taak.sessie);
    else if (taak.link) window.open(taak.link, "_blank", "noopener");
  };
  const klaar = taak.status === "gedaan" || taak.soort === "gedaan";
  // Een vraag met sessie wacht op antwoord in DIE chat: daar hoort "Beantwoorden",
  // geen nieuwe sessie (die agent zou het antwoord nooit krijgen).
  const beantwoorden = taak.soort === "vraag" && !!taak.sessie && !!onOpenSession;
  return (
    <li className="taak group relative flex items-start gap-3 py-2.5" data-soort={taak.soort} data-status={taak.status}>
      <span aria-hidden="true" className="taak-stip mt-[7px] size-2 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={open} disabled={!kanOpenen}
          className="block w-full min-w-0 text-left focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default">
          <span className={cn("taak-titel block font-medium leading-snug text-foreground", klein ? "text-[13px]" : "text-sm", klaar && "text-muted-foreground")}>{taak.titel}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            <span className="taak-soort font-medium">{LABEL[taak.soort]}</span>
            {" · "}<span className="tabular-nums">{wanneer(taak.afgevinkt && taak.status === "gedaan" ? taak.afgevinkt : taak.tijd)}</span>
            {taak.wie ? <> · {taak.wie}</> : null}
            {taak.detail ? <> · {taak.detail}</> : null}
            {taak.link && !taak.sessie ? <ExternalLink aria-hidden="true" className="ml-1 inline size-3 align-[-2px]" /> : null}
          </span>
        </button>
        {taak.soort !== "gedaan" && (
          <div className="taak-knoppen mt-1.5 flex flex-wrap items-center gap-1">
            {taak.status === "open" ? (
              <>
                {beantwoorden ? (
                  <button type="button" onClick={open} className="taak-knop taak-knop-hoofd" aria-label={`Beantwoorden in het gesprek: ${taak.titel}`}>
                    <MessageSquare aria-hidden="true" />Beantwoorden
                  </button>
                ) : (
                  <button type="button" onClick={() => geefOpdracht(taak)} className="taak-knop taak-knop-hoofd" aria-label={`Opdracht geven: ${taak.titel}`}
                    title="Start een nieuwe sessie met deze taak al ingevuld">
                    <CornerDownRight aria-hidden="true" />Opdracht geven
                  </button>
                )}
                <button type="button" onClick={() => zet(taak.id, "later")} className="taak-knop" aria-label={`Morgen terug: ${taak.titel}`} title="Verbergen tot morgen">
                  <Clock aria-hidden="true" />Morgen
                </button>
                <button type="button" onClick={() => zet(taak.id, "gedaan")} className="taak-knop" aria-label={`Gedaan: ${taak.titel}`} title="Afvinken">
                  <Check aria-hidden="true" />Gedaan
                </button>
              </>
            ) : (
              <button type="button" onClick={() => zet(taak.id, "open")} className="taak-knop" aria-label={`Terugzetten: ${taak.titel}`}>
                <RotateCcw aria-hidden="true" />Terugzetten
              </button>
            )}
          </div>
        )}
      </div>
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
export function TakenLijst({ onOpenSession, onMeldingen = () => window.dispatchEvent(new Event(MELDINGEN_EVENT)), smal, zoek = "" }: { onOpenSession?: (sid: string) => void; onMeldingen?: () => void; smal?: boolean; zoek?: string }) {
  const { data, fout, zet } = useTaken();
  const [meldingenOpen, setMeldingenOpen] = useState(false);
  const delen = useMemo(() => {
    const naald = zoek.trim().toLowerCase();
    const items = (data?.items ?? []).filter(t => !naald || [t.titel, t.wie, t.detail].some(v => (v ?? "").toLowerCase().includes(naald)));
    return deelTaken(items);
  }, [data, zoek]);
  if (!data) return <p role="status" className="px-3 py-6 text-sm text-muted-foreground">{fout ? "Taken niet bereikbaar." : "Taken laden…"}</p>;
  return (
    <section aria-label="Taken" className="taken px-3 pb-4">
      <Kop aantal={delen.open.length}>Voor jou</Kop>
      {delen.open.length ? <ul>{delen.open.map(t => <TaakRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} smal={smal} />)}</ul>
        : <p className="py-2 text-sm text-muted-foreground">Niets dat op jou wacht.</p>}
      {delen.meldingen.length > 0 && onMeldingen && (
        <button type="button" onClick={onMeldingen}
          className="taken-meldingen-link mt-3 flex min-h-10 w-full items-center gap-2 rounded-md border border-border/70 px-3 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary">
          <span className="font-medium">Meldingen</span>
          <span className="tabular-nums text-muted-foreground">{delen.meldingen.length}</span>
          <span className="ml-auto text-xs text-muted-foreground">openen</span>
        </button>
      )}
      {delen.meldingen.length > 0 && !onMeldingen && <>
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
    <section aria-label="Taken vandaag" className="taken taken-vandaag mx-auto w-full max-w-2xl px-4 pb-8">
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

/**
 * Meldingen als eigen scherm (vervangt het oude Notifications-scherm, dat de
 * stilgevallen Shipped-feed was). Hoofdactie is "Opdracht geven"; afhandelen
 * is de tweede knop.
 */
export type BevindingGroep = { id: string; naam: string; titel: string; aantal: number; wanneer: string; stip: string };

export function MeldingenPagina({ onOpenSession, bevindingen = [], onBekijk, onOplossen, onWegzetten, oplossenBezig = false }: {
  onOpenSession?: (sid: string) => void;
  /** Open findings from auto agents, one row per agent (the old "1 bevinding" pill). */
  bevindingen?: BevindingGroep[];
  onBekijk?: (id: string) => void;
  onOplossen?: (id?: string) => void;
  onWegzetten?: (id: string) => void;
  oplossenBezig?: boolean;
}) {
  const { data, fout, zet } = useTaken();
  const [toonAf, setToonAf] = useState(false);
  const items = data?.items ?? [];
  const open = useMemo(() => items.filter(i => i.status === "open" && isMelding(i))
    .sort((a, b) => Number(!!b.machine && b.soort === "vast") - Number(!!a.machine && a.soort === "vast") || (b.tijd ?? "").localeCompare(a.tijd ?? "")), [items]);
  const af = useMemo(() => items.filter(i => isMelding(i) && i.status === "gedaan" && isVandaag(i.afgevinkt)), [items]);
  return (
    <section aria-label="Meldingen" className="taken meldingen-pagina mx-auto w-full max-w-3xl px-4 pb-16 pt-8 md:px-8">
      <header className="mb-4">
        <h1 className="text-[22px] font-semibold tracking-tight">Meldingen <span className="ml-1 text-base font-normal tabular-nums text-muted-foreground">{open.length + bevindingen.reduce((n, b) => n + b.aantal, 0)}</span></h1>
        <p className="mt-1 text-sm text-muted-foreground">Shopmeldingen, facturen, monitors, vastgelopen bots en wat de auto-agents vonden. Geef een opdracht of handel af.</p>
      </header>
      {bevindingen.length > 0 && <div className="mb-6">
        <div className="mb-1 flex min-h-9 items-center gap-2">
          <h2 className="taken-kop text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Van auto-agents <span className="ml-1 font-normal tabular-nums">{bevindingen.reduce((n, b) => n + b.aantal, 0)}</span>
          </h2>
          {onOplossen && bevindingen.length > 1 ? <button type="button" onClick={() => onOplossen()} disabled={oplossenBezig}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-primary">
            {oplossenBezig ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="size-3.5" aria-hidden="true" />}Alles laten oplossen
          </button> : null}
        </div>
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {bevindingen.map(b => <BevindingRij key={b.id} b={b} onBekijk={onBekijk} onOplossen={onOplossen} onWegzetten={onWegzetten} bezig={oplossenBezig} />)}
        </ul>
      </div>}
      {bevindingen.length > 0 && <h2 className="taken-kop mb-1 flex min-h-9 items-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Van shops en monitors <span className="ml-1.5 font-normal tabular-nums">{open.length}</span></h2>}
      {!data ? <p role="status" className="py-6 text-sm text-muted-foreground">{fout ? "Meldingen niet bereikbaar." : "Meldingen laden…"}</p>
        : open.length === 0 ? <p className="py-6 text-sm text-muted-foreground">{bevindingen.length ? "Geen open shopmeldingen." : "Geen open meldingen."}</p>
        : <ul className="divide-y divide-border/70 border-y border-border/70">{open.map(t => <MeldingRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} />)}</ul>}
      {af.length > 0 && <div className="mt-6">
        <button type="button" onClick={() => setToonAf(v => !v)} aria-expanded={toonAf}
          className="taken-kop flex min-h-9 items-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground">
          Vandaag afgehandeld <span className="ml-1.5 font-normal tabular-nums">{af.length}</span>
        </button>
        {toonAf && <ul>{af.map(t => <TaakRij key={t.id} taak={t} zet={zet} onOpenSession={onOpenSession} klein />)}</ul>}
      </div>}
      {data && <Bronregel data={data} />}
    </section>
  );
}

function BevindingRij({ b, onBekijk, onOplossen, onWegzetten, bezig }: { b: BevindingGroep; onBekijk?: (id: string) => void; onOplossen?: (id?: string) => void; onWegzetten?: (id: string) => void; bezig: boolean }) {
  // Wegzetten wist alle bevindingen van deze agent en kent geen ongedaan maken:
  // eerste tik vraagt "Zeker?", tweede tik binnen 4 s voert uit.
  const [zeker, setZeker] = useState(false);
  useEffect(() => {
    if (!zeker) return;
    const t = window.setTimeout(() => setZeker(false), 4000);
    return () => window.clearTimeout(t);
  }, [zeker]);
  return (
    <li className="taak melding-rij flex flex-col gap-2 py-3.5 sm:flex-row sm:items-start sm:gap-4" data-soort="bevinding">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span aria-hidden="true" className={cn("mt-[7px] size-2 shrink-0 rounded-full", b.stip)} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium leading-snug text-foreground">{b.titel}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium">{b.naam}</span>
            {b.aantal > 1 ? <> · <span className="tabular-nums">{b.aantal} bevindingen</span></> : null}
            {b.wanneer ? <> · <span className="tabular-nums">{b.wanneer}</span></> : null}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-5 sm:flex-nowrap sm:pl-0">
        {onOplossen ? <button type="button" onClick={() => onOplossen(b.id)} disabled={bezig}
          title="Een agent zoekt uit wat ervan klopt en lost het op"
          className="melding-opdracht inline-flex h-9 items-center whitespace-nowrap gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <Sparkles className="size-4" aria-hidden="true" />Laten oplossen
        </button> : null}
        {onBekijk ? <button type="button" onClick={() => onBekijk(b.id)}
          className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
          <Eye className="size-4" aria-hidden="true" />Bekijken
        </button> : null}
        {onWegzetten ? <button type="button" onClick={() => (zeker ? onWegzetten(b.id) : setZeker(true))}
          title={zeker ? "Nog een keer tikken om weg te zetten" : "Wegzetten"}
          aria-label={zeker ? `Zeker wegzetten: ${b.naam}, ${b.aantal} ${b.aantal === 1 ? "bevinding" : "bevindingen"}` : `Wegzetten: ${b.naam}`}
          className={cn("flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm focus-visible:outline-2 focus-visible:outline-primary",
            zeker ? "bg-destructive/10 px-3 font-medium text-destructive" : "w-9 text-muted-foreground hover:bg-muted hover:text-foreground")}>
          <Check className="size-4" aria-hidden="true" />{zeker ? "Zeker?" : null}
        </button> : null}
      </div>
    </li>
  );
}

function MeldingRij({ taak, zet, onOpenSession }: { taak: Taak; zet: (id: string, s: Taak["status"]) => void; onOpenSession?: (sid: string) => void }) {
  const kanOpenen = !!(taak.sessie && onOpenSession) || !!taak.link;
  const open = () => {
    if (taak.sessie && onOpenSession) onOpenSession(taak.sessie);
    else if (taak.link) window.open(taak.link, "_blank", "noopener");
  };
  return (
    <li className="taak melding-rij flex flex-col gap-2 py-3.5 sm:flex-row sm:items-start sm:gap-4" data-soort={taak.soort}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span aria-hidden="true" className="taak-stip mt-[7px] size-2 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium leading-snug text-foreground">{taak.titel}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="taak-soort font-medium">{taak.soort === "vast" ? "Vastgelopen" : LABEL[taak.soort]}</span>
            {" · "}<span className="tabular-nums">{wanneer(taak.tijd)}</span>
            {taak.wie ? <> · {taak.wie}</> : null}
          </p>
          {taak.detail ? <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{taak.detail}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-5 sm:flex-nowrap sm:pl-0">
        <button type="button" onClick={() => geefOpdracht(taak)}
          className="melding-opdracht inline-flex h-9 items-center whitespace-nowrap gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <CornerDownRight className="size-4" aria-hidden="true" />Opdracht geven
        </button>
        <button type="button" onClick={() => zet(taak.id, "gedaan")}
          className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
          <Check className="size-4" aria-hidden="true" />Afhandelen
        </button>
        {kanOpenen ? <button type="button" onClick={open} title={taak.sessie ? "Gesprek openen" : "Openen"} aria-label={`Openen: ${taak.titel}`}
          className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
          <ExternalLink className="size-4" />
        </button> : null}
      </div>
    </li>
  );
}
