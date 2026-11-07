import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { agentboxConfig } from "@/lib/agentbox-config";
import { Check, Clock, CornerDownRight, ExternalLink, Eye, Loader2, MessageSquare, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAskOptional, stripMd, type Question } from "@/components/ask-center";

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
  /** Bezos: welke knoppen de vraag krijgt (agentbox/taken/beslis.py). */
  beslis?: Beslis;
  /** Wat er gebeurde, in één zin uit het laatste bericht. */
  wat?: string;
  /** Wat de agent bij zijn vraag liet zien: beeld, video, audio, bestand, links. */
  presentatie?: Presentatie[];
};
export type Presentatie =
  | { soort: "image" | "video" | "audio" | "file" | "html"; id: string; naam: string; onderschrift?: string }
  | { soort: "link"; url: string; naam: string };
export type Beslis =
  | { vorm: "janee"; vraag?: string | null; ja?: string | null; eerst?: string | null }
  | { vorm: "ab"; vraag: string; opties: string[]; uitleg?: string[] | null; toelichting?: string | null }
  | { vorm: "taak"; vraag: string }
  | { vorm: "open" };
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
let wachtend: { ids: string[]; tekst: string } | null = null;
let lopend: { ids: string[]; tekst: string } | null = null;

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
  wachtend = { ids: [t.id], tekst: opdrachtTekst(t) };
  window.dispatchEvent(new Event(OPDRACHT_EVENT));
}

/** Eén opdracht voor een hele bundel gelijke meldingen (Sam: niet 30 losse taken). */
export function geefBundelOpdracht(taken: Taak[], naam: string) {
  const regels = taken.slice(0, 40).map(t => `- ${t.titel}${t.wie ? ` (${t.wie})` : ""}${t.tijd ? `, ${new Date(t.tijd).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" })}` : ""}${t.link ? ` ${t.link}` : ""}`);
  wachtend = { ids: taken.map(t => t.id), tekst: `Meldingen (${taken.length}x): ${naam}\n${regels.join("\n")}\n\nOpdracht: ` };
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
  if (!l || !prompt.includes(l.tekst.split("\n")[0]!)) return;
  if (l.ids.length === 1) void zetTaak(l.ids[0]!, "gedaan");
  else void handelBundelAf(l.ids);
}

export function useTaken() {
  const [data, setData] = useState<TakenData | null>(cache);
  const [fout, setFout] = useState(false);
  useEffect(() => {
    // agentbox: only Sam's box has a Taken API; elsewhere nothing is polled.
    if (!agentboxConfig().taken) return;
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
                <button type="button" onClick={() => zet(taak.id, "gedaan")} className="taak-knop" aria-label={`Gedaan: ${taak.titel}`} title={taak.bron === "mail" ? "Afvinken, de mail gaat uit je inbox" : "Afvinken"}>
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
          <span className="font-medium">Bezos</span>
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


/** Een bundel meldingen afhandelen: de server archiveert de mails één voor één. */
async function handelBundelAf(ids: string[]): Promise<{ id: string; ok: boolean }[] | null> {
  const r = await fetch("/api/taken/alles-gezien", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
    .then(x => x.json() as Promise<{ resultaat?: { id: string; ok: boolean }[] }>).catch(() => null);
  laad().catch(() => undefined);
  return r?.resultaat ?? null;
}

/**
 * Bundelsleutel: zelfde afzender en zelfde onderwerp zodra getallen en namen eruit zijn.
 * "[SamAutomation] Marco has waited 5 min" en "... Jan has waited 12 min" vallen samen,
 * net als "Nieuwe bestelling #31084" en "#31085", en "Backlink offline: <url>" per URL.
 */
function bundelSleutel(t: Taak): string {
  const woorden = t.titel.replace(/\bhttps?:\/\/\S+/g, "<url>").replace(/[#€$]?\d[\d.,:/-]*/g, "#").split(/\s+/);
  const kern = woorden.map((w, i) => (i > 0 && /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(w) && !/^\[/.test(w) ? "*" : w.toLowerCase())).join(" ");
  return `${(t.wie ?? "").toLowerCase()}|${kern}`;
}

/** Kop van een bundel: het gedeelde begin van de titels, plus per melding wat afwijkt. */
function bundelKop(ts: Taak[]): { gemeen: string; rest: string[] } {
  const w = ts.map(t => t.titel.split(/\s+/));
  let n = 0;
  while (w.every(x => n < x.length - 1 && x[n] === w[0]![n])) n++;
  if (n < 2) return { gemeen: ts[0]!.titel, rest: [] };
  const kort = (r: string) => r.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return { gemeen: w[0]!.slice(0, n).join(" ").replace(/[:\s·-]+$/, ""), rest: w.map(x => kort(x.slice(n).join(" "))) };
}

function bundel(taken: Taak[]): ({ los: Taak } | { groep: Taak[] })[] {
  const per = new Map<string, Taak[]>();
  for (const t of taken) {
    const k = t.soort === "vast" ? `vast|${t.id}` : bundelSleutel(t);
    per.set(k, [...(per.get(k) ?? []), t]);
  }
  return [...per.values()].map(g => g.length > 1 ? { groep: g.sort((a, b) => (b.tijd ?? "").localeCompare(a.tijd ?? "")) } : { los: g[0]! });
}

/* ───────────────────────── Bezos ─────────────────────────
 * Sam, 07-11-2026: "ik ben het meesterbrein en de agents mijn uitvoerders. Ze vragen
 * alleen een keuze of een richting aan mij en gaan dan uitvoeren." Dit scherm staat op
 * de oude plek van Meldingen. Bovenaan wat een besluit van Sam vraagt, met de keuze als
 * knop; daaronder wat hij zelf moet doen; onderaan, dicht, wat alleen ter info is.
 *
 * Een knop stuurt het antwoord naar de chat die de vraag stelde, via de taken-API. Die
 * controleert eerst of de vraag daar nog precies zo staat en stuurt per vraag één keer.
 */
export type BezosBevinding = {
  id: string; agentId: string; naam: string; titel: string; voorstel?: string;
  ernst: "high" | "med" | "low"; wanneer: string;
};

const NIKS_TE_DOEN = /^(niks|niets|geen actie|geen)\b|niks te doen|niets te doen|geen actie nodig|no action|nothing to do/i;
const SAM_ZELF = /\b(sam|jij)\b[^.]{0,60}\b(zelf|moet|kan|handmatig)\b/i;
const MELDING_ACTIE = /storing|misbruik|wacht|waited|fout|mislukt|error|offline|\bdown\b|klacht|retour|dispute|chargeback|geweigerd|failed|verlop|expired|waarschuwing|alert|blokkade|geblokkeerd/i;

type Kaart =
  | { soort: "ask"; id: string; q: Question; tijd?: number }
  | { soort: "vraag"; id: string; t: Taak }
  | { soort: "bevinding"; id: string; b: BezosBevinding; zelf: boolean }
  | { soort: "melding"; id: string; t: Taak }
  | { soort: "bundel"; id: string; taken: Taak[] };

function bezosAntwoord(id: string, antwoord: string) {
  return fetch(`/api/taken/item/${encodeURIComponent(id)}/antwoord`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ antwoord }),
  }).then(async r => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) as { error?: string; verouderd?: boolean } }));
}

export function BezosPagina({ onOpenSession, bevindingen = [], onBekijk, onOplossen, onWeg, oplossenBezig = false }: {
  onOpenSession?: (sid: string) => void;
  bevindingen?: BezosBevinding[];
  onBekijk?: (agentId: string) => void;
  onOplossen?: (ids: string[]) => void;
  onWeg?: (ids: string[]) => void;
  oplossenBezig?: boolean;
}) {
  const { data, fout, zet } = useTaken();
  const ask = useAskOptional();
  const [weg, setWeg] = useState<Set<string>>(() => new Set());
  const verberg = useCallback((id: string) => setWeg(w => new Set(w).add(id)), []);

  const delen = useMemo(() => {
    const items = (data?.items ?? []).filter(i => i.status === "open" && !weg.has(i.id));
    const beslis: Kaart[] = [], zelf: Kaart[] = [], info: Kaart[] = [];
    for (const q of ask?.questions ?? []) if (!weg.has(`ask:${q.id}`)) beslis.push({ soort: "ask", id: `ask:${q.id}`, q });
    for (const t of items.filter(i => i.soort === "vraag")) {
      const v = t.beslis?.vorm ?? "open";
      (v === "taak" ? zelf : beslis).push({ soort: "vraag", id: t.id, t });
    }
    for (const b of bevindingen) {
      if (weg.has(b.id)) continue;
      if (b.ernst === "low" || NIKS_TE_DOEN.test((b.voorstel ?? "").trim())) info.push({ soort: "bevinding", id: b.id, b, zelf: false });
      else if (SAM_ZELF.test(b.voorstel ?? "")) zelf.push({ soort: "bevinding", id: b.id, b, zelf: true });
      else beslis.push({ soort: "bevinding", id: b.id, b, zelf: false });
    }
    const actieM: Taak[] = [], infoM: Taak[] = [];
    for (const t of items.filter(isMelding)) {
      // Een bot die al dagen vastzit is geen besluit meer van vandaag: ter info.
      const vers = !t.tijd || Date.now() - new Date(t.tijd).getTime() < 48 * 3600_000;
      const actie = t.soort === "vast" ? vers : MELDING_ACTIE.test(`${t.titel} ${t.wie ?? ""}`);
      (actie ? actieM : infoM).push(t);
    }
    // Gelijke meldingen worden één kaart met één keuze voor allemaal.
    for (const [lijst, doel] of [[actieM, beslis], [infoM, info]] as const)
      for (const b of bundel(lijst))
        doel.push("los" in b ? { soort: "melding", id: b.los.id, t: b.los } : { soort: "bundel", id: `bundel:${b.groep[0]!.id}`, taken: b.groep });
    // Keuzes met knoppen eerst, dan vragen die een antwoord in woorden nodig hebben.
    const rang = (k: Kaart) => k.soort === "ask" ? 0 : k.soort === "vraag" ? (k.t.beslis?.vorm === "open" ? 2 : 1) : k.soort === "bevinding" ? 3 : k.soort === "bundel" ? 4 : 5;
    beslis.sort((a, b) => rang(a) - rang(b));
    return { beslis, zelf, info };
  }, [data, ask?.questions, bevindingen, weg]);

  const totaal = delen.beslis.length + delen.zelf.length;
  return (
    <section aria-label="Bezos" className="taken bezos mx-auto w-full max-w-2xl px-4 pb-16 pt-8 md:px-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-tight">Bezos {totaal > 0 ? <span className="ml-1 text-base font-normal tabular-nums text-muted-foreground">{totaal}</span> : null}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Jij kiest, de agents voeren uit.</p>
      </header>
      {!data && !ask ? <p role="status" className="py-6 text-sm text-muted-foreground">{fout ? "Niet bereikbaar." : "Laden…"}</p> : null}
      {data || ask ? <>
        <BezosKop aantal={delen.beslis.length}>Beslis</BezosKop>
        {delen.beslis.length ? <ul className="bezos-lijst">{delen.beslis.map(k => <BezosRij key={k.id} k={k} ask={ask} zet={zet} verberg={verberg} onOpenSession={onOpenSession} onBekijk={onBekijk} onOplossen={onOplossen} onWeg={onWeg} oplossenBezig={oplossenBezig} />)}</ul>
          : <p className="py-4 text-sm text-muted-foreground">Niets te beslissen. De agents kunnen door.</p>}
        {delen.zelf.length > 0 && <>
          <BezosKop aantal={delen.zelf.length}>Zelf doen</BezosKop>
          <ul className="bezos-lijst">{delen.zelf.map(k => <BezosRij key={k.id} k={k} ask={ask} zet={zet} verberg={verberg} onOpenSession={onOpenSession} onBekijk={onBekijk} onOplossen={onOplossen} onWeg={onWeg} oplossenBezig={oplossenBezig} />)}</ul>
        </>}
        {delen.info.length > 0 && <TerInfo kaarten={delen.info} zet={zet} verberg={verberg} onOpenSession={onOpenSession} onBekijk={onBekijk} onWeg={onWeg} />}
      </> : null}
      {data && <Bronregel data={data} />}
    </section>
  );
}

function BezosKop({ children, aantal }: { children: string; aantal: number }) {
  return <h2 className="taken-kop mt-8 mb-1 flex min-h-8 items-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground first:mt-0">
    {children}<span className="ml-1.5 font-normal tabular-nums">{aantal}</span>
  </h2>;
}

type Knop = { label: string; hoofd?: boolean; doe: () => Promise<void> | void; titel?: string };

function BezosRij({ k, ask, zet, verberg, onOpenSession, onBekijk, onOplossen, onWeg, oplossenBezig }: {
  k: Kaart; ask: ReturnType<typeof useAskOptional>; zet: (id: string, s: Taak["status"]) => void; verberg: (id: string) => void;
  onOpenSession?: (sid: string) => void; onBekijk?: (agentId: string) => void; onOplossen?: (ids: string[]) => void; onWeg?: (ids: string[]) => void; oplossenBezig: boolean;
}) {
  const [bezig, setBezig] = useState<string | null>(null);
  const [klaar, setKlaar] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [dicht, setDicht] = useState(false);
  const [zeker, setZeker] = useState(false);
  const [lijstOpen, setLijstOpen] = useState(false);
  useEffect(() => {
    if (!zeker) return;
    const t = window.setTimeout(() => setZeker(false), 5000);
    return () => window.clearTimeout(t);
  }, [zeker]);
  // Na het antwoord even "Verstuurd: Ja" laten staan, dan dichtvouwen en weg:
  // zo zie je dat de keuze is aangekomen en waar de rij bleef.
  useEffect(() => {
    if (!klaar) return;
    const a = window.setTimeout(() => setDicht(true), 1200);
    const b = window.setTimeout(() => verberg(k.id), 1500);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [klaar, k.id, verberg]);

  const stuur = (antwoord: string, label = antwoord) => async () => {
    if (k.soort !== "vraag" && k.soort !== "melding") return;
    setBezig(label); setMelding(null);
    const r = await bezosAntwoord(k.id, antwoord).catch(() => ({ ok: false, error: "geen verbinding", verouderd: false }));
    setBezig(null);
    if (r.ok) { setKlaar(label); laad().catch(() => undefined); }
    else setMelding(r.verouderd ? "De vraag is veranderd. Open het gesprek." : `Niet verstuurd: ${r.error ?? "onbekende fout"}.`);
  };

  let meta = "", vraag = "", context: string | undefined, ja: string | undefined;
  let uitleg: [string, string][] = [];
  let bundelTaken: Taak[] = [];
  const pres = k.soort === "vraag" ? (k.t.presentatie ?? []) : [];
  let knoppen: Knop[] = [];
  let open: (() => void) | undefined;
  let stip = "bg-primary";
  if (k.soort === "ask") {
    const q = k.q;
    meta = "Vraag van een agent";
    const tekst = stripMd(q.question);
    vraag = tekst.length > 180 ? `${tekst.slice(0, 179).replace(/\s+\S*$/, "")}…` : tekst;
    knoppen = (q.options ?? []).slice(0, 4).map((o, i) => ({ label: o.length > 30 ? `${o.slice(0, 29)}…` : o, titel: o, hoofd: i === 0,
      doe: async () => { setBezig(o); await ask?.answer(q, o); setBezig(null); setKlaar(o.length > 30 ? `${o.slice(0, 29)}…` : o); } }));
    if (q.sessionId && onOpenSession) open = () => onOpenSession(q.sessionId as string);
  } else if (k.soort === "vraag") {
    const t = k.t, b = t.beslis ?? { vorm: "open" as const };
    meta = t.detail ?? "Gesprek";
    context = t.wat;
    if (t.sessie && onOpenSession) open = () => onOpenSession(t.sessie as string);
    if (b.vorm === "janee") {
      // Kop = waar je ja of nee op zegt: de vraag, anders wat ja doet, anders wat je eerst bekijkt.
      vraag = b.vraag || b.ja || b.eerst || t.wat || t.titel;
      if (b.vraag && b.ja) ja = b.ja;
      if (vraag === t.wat) context = undefined;
      knoppen = [{ label: "Ja", hoofd: true, doe: stuur("Ja") }, { label: "Nee", doe: stuur("Nee") }];
    } else if (b.vorm === "ab") {
      vraag = b.toelichting ? `${b.vraag}: ${b.toelichting}` : b.vraag;
      uitleg = (b.uitleg ?? []).map((u, i) => [b.opties[i] ?? "", u.charAt(0).toUpperCase() + u.slice(1)]);
      knoppen = b.opties.slice(0, 3).map(o => ({ label: o, doe: stuur(o) }));
    } else if (b.vorm === "taak") {
      vraag = b.vraag; stip = "bg-[var(--info)]";
      knoppen = [{ label: "Gedaan", hoofd: true, titel: "De agent hoort dat het gedaan is en gaat verder", doe: stuur("Gedaan") },
        { label: "Morgen", doe: () => zet(t.id, "later") }];
    } else {
      vraag = t.titel.charAt(0).toUpperCase() + t.titel.slice(1);
      knoppen = open ? [{ label: "Antwoorden", hoofd: true, titel: "Open het gesprek en typ je antwoord", doe: open }, { label: "Morgen", doe: () => zet(t.id, "later") }] : [];
      open = undefined;
    }
  } else if (k.soort === "bevinding") {
    const b = k.b;
    meta = `${b.naam}${b.wanneer ? ` · ${b.wanneer}` : ""}`;
    vraag = b.titel; context = b.voorstel ? `Voorstel: ${b.voorstel}` : undefined;
    stip = b.ernst === "high" ? "bg-destructive" : "bg-primary";
    if (onBekijk) open = () => onBekijk(b.agentId);
    knoppen = k.zelf
      ? [{ label: "Gedaan", hoofd: true, doe: () => { onWeg?.([b.id]); setKlaar("Gedaan"); } },
         { label: "Niet nodig", doe: () => { onWeg?.([b.id]); setKlaar("Weggezet"); } }]
      : [{ label: "Laat oplossen", hoofd: true, titel: "Een agent voert het voorstel uit", doe: () => { onOplossen?.([b.id]); setKlaar("Agent gestart"); } },
         { label: "Niet nodig", doe: () => { onWeg?.([b.id]); setKlaar("Weggezet"); } }];
  } else if (k.soort === "bundel") {
    const ts = k.taken, eerste = ts[0]!;
    const mails = ts.filter(t => t.bron === "mail").length;
    meta = [eerste.wie, `${ts.length} keer`, `laatste ${wanneer(eerste.tijd)}`].filter(Boolean).join(" · ");
    const { gemeen, rest } = bundelKop(ts);
    vraag = `${ts.length}× ${gemeen || eerste.titel}`;
    context = lijstOpen ? undefined : rest.slice(0, 3).join(" · ") + (rest.length > 3 ? ` en ${rest.length - 3} meer` : "");
    bundelTaken = ts;
    knoppen = [{ label: "Eén opdracht", hoofd: true, titel: `Eén nieuwe chat met alle ${ts.length} meldingen`, doe: () => geefBundelOpdracht(ts, eerste.titel) },
      { label: zeker ? `Zeker? ${mails} mails uit je inbox` : `Alle ${ts.length} afhandelen`,
        doe: async () => {
          if (mails > 0 && !zeker) { setZeker(true); return; }
          setZeker(false); setBezig(`Alle ${ts.length} afhandelen`);
          const r = await handelBundelAf(ts.map(t => t.id));
          setBezig(null);
          const mis = r ? r.filter(x => !x.ok).length : ts.length;
          if (mis) setMelding(`${mis} van ${ts.length} niet gelukt. Probeer het later nog eens.`); else setKlaar(`${ts.length} afgehandeld`);
        } }];
  } else {
    const t = k.t;
    meta = [t.soort === "vast" ? "Vastgelopen" : t.wie, wanneer(t.tijd)].filter(Boolean).join(" · ");
    vraag = t.titel; context = t.detail;
    stip = t.soort === "vast" ? "bg-destructive" : "bg-primary";
    if (t.sessie && onOpenSession) open = () => onOpenSession(t.sessie as string);
    else if (t.link) open = () => window.open(t.link, "_blank", "noopener");
    if (t.soort === "vast") {
      const herstart = /capaciteit|onverwacht/i.test(t.detail ?? "");
      knoppen = [herstart ? { label: "Ga verder", hoofd: true, titel: "Stuur 'Ga verder' naar deze chat", doe: stuur("Ga verder") }
        : { label: "Opdracht geven", hoofd: true, doe: () => geefOpdracht(t) }, { label: "Laat staan", doe: () => { zet(t.id, "gedaan"); setKlaar("Weggezet"); } }];
    } else {
      knoppen = [{ label: "Opdracht geven", hoofd: true, titel: "Nieuwe chat met deze melding al ingevuld", doe: () => geefOpdracht(t) },
        { label: "Afhandelen", titel: t.bron === "mail" ? "De mail gaat uit je inbox" : undefined, doe: () => { zet(t.id, "gedaan"); setKlaar("Afgehandeld"); } }];
    }
  }

  return (
    <li className="bezos-rij" data-dicht={dicht ? "" : undefined}>
      <div className="bezos-rij-binnen">
        <div className="flex items-start gap-3 py-4">
          <span aria-hidden="true" className={cn("mt-[9px] size-2 shrink-0 rounded-full", stip)} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-muted-foreground">{meta}</p>
            <p className="mt-0.5 text-base font-semibold leading-snug text-foreground">{vraag}</p>
            {uitleg.length ? <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm leading-relaxed">
              {uitleg.map(([l, u]) => <div key={l} className="contents"><dt className="font-semibold tabular-nums text-foreground">{l}</dt><dd className="text-foreground/80">{u}</dd></div>)}
            </dl> : null}
            {ja ? <p className="mt-1 text-sm leading-relaxed text-foreground/80">{ja}</p> : null}
            {context ? <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{context}</p> : null}
            {pres.length ? <PresentatieBlok items={pres} /> : null}
            {bundelTaken.length ? <>
              <button type="button" onClick={() => setLijstOpen(o => !o)} aria-expanded={lijstOpen}
                className="mt-1 inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary">
                {lijstOpen ? "Verberg de lijst" : `Bekijk alle ${bundelTaken.length}`}
              </button>
              {lijstOpen && <ul className="mt-1 border-l-2 border-border pl-3">{bundelTaken.map(t => (
                <li key={t.id} className="py-1 text-sm leading-snug">
                  {t.link ? <a href={t.link} target="_blank" rel="noopener" className="text-foreground hover:underline">{t.titel}</a> : <span className="text-foreground">{t.titel}</span>}
                  <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">{wanneer(t.tijd)}</span>
                </li>))}</ul>}
            </> : null}
            {klaar ? (
              <p role="status" className="bezos-verstuurd mt-3 inline-flex h-10 items-center gap-1.5 text-sm font-medium text-primary">
                <Check className="size-4" aria-hidden="true" />{k.soort === "vraag" || k.soort === "ask" ? `Verstuurd: ${klaar}` : klaar}
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {knoppen.map((kn, i) => (
                  <button key={i} type="button" title={kn.titel} disabled={!!bezig || (oplossenBezig && kn.label === "Laat oplossen")}
                    onClick={() => void kn.doe()}
                    className={cn("bezos-knop inline-flex h-10 min-w-[4.5rem] items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-4 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      kn.hoofd ? "bezos-knop-hoofd" : "bezos-knop-neven")}>
                    {bezig && (bezig === kn.label || bezig === kn.titel || (kn.label.startsWith("Zeker") && bezig.startsWith("Alle"))) ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{kn.label}
                  </button>
                ))}
                {open ? <button type="button" onClick={open} className="ml-auto inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
                  {k.soort === "bevinding" ? <Eye className="size-4" aria-hidden="true" /> : k.soort === "melding" && !k.t.sessie ? <ExternalLink className="size-4" aria-hidden="true" /> : <MessageSquare className="size-4" aria-hidden="true" />}<span className="max-sm:sr-only">{k.soort === "bevinding" ? "Bekijken" : k.soort === "melding" && !k.t.sessie ? "Openen" : "Gesprek"}</span>
                </button> : null}
              </div>
            )}
            {melding ? <p role="alert" className="mt-2 text-sm text-destructive">{melding}</p> : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Wat de agent liet zien, direct speelbaar in de kaart: beeld, video, audio, bestand, link. */
function PresentatieBlok({ items }: { items: Presentatie[] }) {
  const media = items.filter((p): p is Exclude<Presentatie, { soort: "link" }> => p.soort !== "link");
  const links = items.filter((p): p is Extract<Presentatie, { soort: "link" }> => p.soort === "link");
  const bron = (id: string, preview = "") => `/api/artifacts/${encodeURIComponent(id)}${preview ? `?preview=${preview}` : ""}`;
  return (
    <div className="bezos-presentatie mt-3 flex flex-col gap-2.5">
      {media.map(p => (
        <figure key={p.id} className="m-0">
          {p.soort === "image" ? (
            <a href={bron(p.id)} target="_blank" rel="noopener" className="block">
              <img src={bron(p.id, "1")} alt={p.onderschrift || p.naam} loading="lazy" className="max-h-72 w-auto max-w-full rounded-md bg-muted object-contain" />
            </a>
          ) : p.soort === "video" ? (
            <video src={bron(p.id)} poster={bron(p.id, "1")} controls playsInline preload="none" className="max-h-80 w-full rounded-md bg-black" />
          ) : p.soort === "audio" ? (
            <audio src={bron(p.id)} controls preload="none" className="w-full" />
          ) : (
            <a href={bron(p.id)} target="_blank" rel="noopener" className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              <ExternalLink className="size-4" aria-hidden="true" />{p.naam || "Bestand openen"}
            </a>
          )}
          {p.onderschrift || (p.soort === "audio" && p.naam) ? <figcaption className="mt-1 text-xs text-muted-foreground">{p.onderschrift || p.naam}</figcaption> : null}
        </figure>
      ))}
      {links.length ? <div className="flex flex-wrap gap-x-4 gap-y-1">{links.map(l => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener" className="inline-flex min-h-9 max-w-full items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <ExternalLink className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{l.naam}</span>
        </a>))}</div> : null}
    </div>
  );
}

function TerInfo({ kaarten, zet, verberg, onOpenSession, onBekijk, onWeg }: {
  kaarten: Kaart[]; zet: (id: string, s: Taak["status"]) => void; verberg: (id: string) => void;
  onOpenSession?: (sid: string) => void; onBekijk?: (agentId: string) => void; onWeg?: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [zeker, setZeker] = useState(false);
  const [bezig, setBezig] = useState(false);
  const [uitslag, setUitslag] = useState<string | null>(null);
  useEffect(() => {
    if (!zeker) return;
    const t = window.setTimeout(() => setZeker(false), 5000);
    return () => window.clearTimeout(t);
  }, [zeker]);
  const meldingen = kaarten.flatMap(k => k.soort === "melding" ? [k.t] : k.soort === "bundel" ? k.taken : []);
  const [uitgeklapt, setUitgeklapt] = useState<string | null>(null);
  const mails = meldingen.filter(t => t.bron === "mail").length;
  const bev = kaarten.flatMap(k => k.soort === "bevinding" ? [k.b.id] : []);
  const allesGezien = async () => {
    // Elke melding uit Gmail is één archivering: eerst bevestigen, met het aantal erbij.
    if (mails > 0 && !zeker) { setZeker(true); return; }
    setZeker(false); setBezig(true); setUitslag(null);
    if (bev.length) onWeg?.(bev);
    const r = await fetch("/api/taken/alles-gezien", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: meldingen.map(t => t.id) }) })
      .then(x => x.json() as Promise<{ resultaat?: { id: string; ok: boolean }[] }>).catch(() => null);
    setBezig(false);
    const mis = (r?.resultaat ?? []).filter(x => !x.ok).length;
    if (!r) setUitslag("Niet gelukt: geen verbinding.");
    else if (mis) setUitslag(`${mis} ${mis === 1 ? "mail bleef" : "mails bleven"} in je inbox. Probeer het later nog eens.`);
    for (const x of r?.resultaat ?? []) if (x.ok) verberg(x.id);
    for (const id of bev) verberg(id);
    laad().catch(() => undefined);
  };
  return (
    <div className="mt-8">
      <div className="flex min-h-10 items-center gap-2">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="taken-kop inline-flex min-h-10 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
          Ter info <span className="font-normal tabular-nums">{meldingen.length + bev.length}</span>
          <span className="font-normal normal-case tracking-normal">{open ? "verbergen" : "tonen"}</span>
        </button>
        <button type="button" onClick={() => void allesGezien()} disabled={bezig}
          className={cn("ml-auto inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50",
            zeker ? "bg-destructive/10 font-medium text-destructive" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
          {bezig ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}
          {zeker ? `Zeker? ${mails} ${mails === 1 ? "mail gaat" : "mails gaan"} uit je inbox` : "Alles gezien"}
        </button>
      </div>
      {uitslag ? <p role="alert" className="mt-1 text-sm text-destructive">{uitslag}</p> : null}
      {open && <ul className="mt-1">
        {kaarten.map(k => {
          // Ter info is lezen, geen werk: één regel per melding, tik opent de bron.
          const [titel, sub, doe] = k.soort === "melding"
            ? [k.t.titel, [k.t.wie, wanneer(k.t.tijd), k.t.detail].filter(Boolean).join(" · "),
               k.t.sessie && onOpenSession ? () => onOpenSession(k.t.sessie as string) : k.t.link ? () => window.open(k.t.link, "_blank", "noopener") : undefined]
            : k.soort === "bevinding" ? [k.b.titel, [k.b.naam, k.b.voorstel].filter(Boolean).join(" · "), () => onBekijk?.(k.b.agentId)]
            : k.soort === "bundel" ? [`${k.taken.length}× ${bundelKop(k.taken).gemeen}`, [k.taken[0]!.wie, `laatste ${wanneer(k.taken[0]!.tijd)}`].filter(Boolean).join(" · "),
               () => setUitgeklapt(u => u === k.id ? null : k.id)]
            : ["", "", undefined];
          return (
            <li key={k.id} className="taak flex items-start gap-3 py-2.5" data-soort="melding">
              <span aria-hidden="true" className="taak-stip mt-[7px] size-2 shrink-0 rounded-full" />
              <button type="button" onClick={doe} disabled={!doe} className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default">
                <span className="block text-[13px] font-medium leading-snug text-foreground">{titel}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{sub}</span>
                {k.soort === "bundel" && uitgeklapt === k.id ? <span className="mt-1.5 block border-l-2 border-border pl-3">{k.taken.map(t => (
                  <span key={t.id} className="block py-0.5 text-xs leading-snug text-foreground">{t.titel} <span className="tabular-nums text-muted-foreground">{wanneer(t.tijd)}</span></span>))}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>}
    </div>
  );
}
