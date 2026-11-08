// agentbox (08-11-2026): meting van "terugswipen uit een chat hangt seconden" op
// Sams iPhone. Chrome-emulatie liet het niet zien (127 ms), dus dit meet op het
// echte toestel: na een terugnavigatie (popstate) of de sluitknop 5 s lang
// frame-gaten, wanneer het chatpaneel weg is, en wanneer de eerste tik
// binnenkomt. Eén regel per keer naar /api/taken/perf. Alleen op aanraakschermen.

type Meting = {
  soort: "terug" | "knop";
  van: string;
  t0: number;
  nodes: number;
  frames: number;
  eersteFrame: number | null;
  maxGat: number;
  gaten: number[];
  paneelWeg: number | null;
  tikken: Tik[];
  klikken: number[];
  paden: { t: number; p: string }[];
  lang: { t: number; d: number }[];
};

// Per aanraking: start/eind (ms na t0), max beweging (px), doel, of het doel bij
// touchend nog in de DOM zat, en na hoeveel ms een echte (isTrusted) klik volgde.
// Ronde 3: richting (dx/dy), of de dichtstbijzijnde scroller echt meeschoof
// (sc = scrollTop-verschil bij touchend, sc2 = 300 ms later), hoeveel touchmoves
// een handler tegenhield (pd) en body-overflow bij de start (bo).
type Tik = {
  s: number; e?: number; mv: number; doel: string; los?: boolean; klik?: number;
  dx?: number; dy?: number; sc?: number; sc2?: number; scr?: string; pd?: number; bo?: string;
};

function scroller(el: Element | null): HTMLElement | null {
  for (let n = el; n; n = n.parentElement) {
    const st = getComputedStyle(n);
    if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) return n as HTMLElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

function naam(el: Element | null) {
  if (!el) return "geen";
  const c = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
  return (el.tagName.toLowerCase() + (c ? "." + c : "")).slice(0, 60);
}

let bezig: Meting | null = null;
let tik: { t: Tik; x: number; y: number; el: Element | null; sc: HTMLElement | null; top: number } | null = null;

function rond(n: number) {
  return Math.round(n);
}

function start(soort: Meting["soort"], van = location.pathname) {
  if (bezig) return;
  const t0 = performance.now();
  const m: Meting = {
    soort,
    van,
    t0,
    nodes: document.getElementsByTagName("*").length,
    frames: 0,
    eersteFrame: null,
    maxGat: 0,
    gaten: [],
    paneelWeg: null,
    tikken: [],
    klikken: [],
    paden: [],
    lang: [],
  };
  bezig = m;
  let vorig = t0;
  let pad = location.pathname;
  const frame = (now: number) => {
    if (bezig !== m) return;
    m.frames++;
    if (m.eersteFrame === null) m.eersteFrame = rond(now - t0);
    const gat = now - vorig;
    if (gat > m.maxGat) m.maxGat = rond(gat);
    if (gat > 100 && m.gaten.length < 20) m.gaten.push(rond(now - t0), rond(gat));
    vorig = now;
    if (m.paneelWeg === null && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
      m.paneelWeg = rond(now - t0);
    }
    if (location.pathname !== pad) {
      pad = location.pathname;
      if (m.paden.length < 10) m.paden.push({ t: rond(now - t0), p: pad.slice(0, 40) });
    }
    if (now - t0 < 5000) requestAnimationFrame(frame);
    else verstuur(m);
  };
  requestAnimationFrame(frame);
}

function verstuur(m: Meting) {
  bezig = null;
  tik = null;
  const sa = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  const body = JSON.stringify({
    ...m,
    t0: undefined,
    naar: location.pathname,
    standalone: !!sa,
    ua: navigator.userAgent.slice(0, 200),
    zichtbaar: document.visibilityState,
    breed: window.innerWidth,
    scrollHerstel: history.scrollRestoration,
    scrollY: Math.round(window.scrollY),
  });
  try {
    if (!navigator.sendBeacon?.("/api/taken/perf", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/taken/perf", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true });
    }
  } catch {}
}

export function installTerugMeting() {
  if (typeof window === "undefined") return;
  if (!window.matchMedia?.("(pointer: coarse)").matches) return;
  // Alleen terug uit een open chat telt. De router kan al vóór deze listener
  // renderen, dus het vorige pad houden we zelf bij.
  let laatstePad = location.pathname;
  for (const k of ["pushState", "replaceState"] as const) {
    const orig = history[k].bind(history);
    history[k] = (...a: Parameters<History["pushState"]>) => {
      orig(...a);
      laatstePad = location.pathname;
    };
  }
  window.addEventListener("popstate", () => {
    if (laatstePad.startsWith("/sessions/") && !location.pathname.startsWith("/sessions/")) start("terug", laatstePad);
    laatstePad = location.pathname;
  });
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('[aria-label="Close session details"]') : null;
      if (el) start("knop");
    },
    true,
  );
  const soortDoel = (el: Element | null) =>
    !el ? "geen" : el.closest("[data-overview-row]") ? "rij" : el.closest("button,[role=button]") ? "knop" : el.closest("a[href]") ? "link" : "anders";
  window.addEventListener(
    "touchstart",
    (e) => {
      const m = bezig;
      const p = e.touches[0];
      if (!m || !p || m.tikken.length >= 12) return;
      const el = e.target instanceof Element ? e.target : null;
      const sc = scroller(el);
      const t: Tik = { s: rond(performance.now() - m.t0), mv: 0, doel: soortDoel(el), scr: naam(sc), pd: 0, bo: document.body.style.overflow || "-" };
      m.tikken.push(t);
      tik = { t, x: p.clientX, y: p.clientY, el, sc, top: sc?.scrollTop ?? 0 };
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      const p = e.touches[0];
      if (tik && p) {
        tik.t.mv = Math.max(tik.t.mv, rond(Math.hypot(p.clientX - tik.x, p.clientY - tik.y)));
        tik.t.dx = rond(p.clientX - tik.x);
        tik.t.dy = rond(p.clientY - tik.y);
      }
    },
    { capture: true, passive: true },
  );
  // Bubble-fase: hier is defaultPrevented van de app-handlers al gezet.
  window.addEventListener(
    "touchmove",
    (e) => {
      if (tik && e.defaultPrevented) tik.t.pd = (tik.t.pd ?? 0) + 1;
    },
    { passive: true },
  );
  const eind = () => {
    const m = bezig;
    if (!tik || !m) return;
    const h = tik;
    h.t.e = rond(performance.now() - m.t0);
    h.t.los = h.el ? !h.el.isConnected : undefined;
    if (h.sc) {
      h.t.sc = rond(h.sc.scrollTop - h.top);
      setTimeout(() => {
        if (h.sc) h.t.sc2 = rond(h.sc.scrollTop - h.top);
      }, 300);
    }
  };
  window.addEventListener("touchend", eind, { capture: true, passive: true });
  window.addEventListener("touchcancel", eind, { capture: true, passive: true });
  window.addEventListener(
    "click",
    (e) => {
      const m = bezig;
      if (!m || !e.isTrusted) return;
      const nu = rond(performance.now() - m.t0);
      if (m.klikken.length < 12) m.klikken.push(nu);
      const t = tik?.t;
      if (t && t.e !== undefined && t.klik === undefined && nu - t.e < 400) t.klik = nu - t.e;
    },
    { capture: true, passive: true },
  );
  try {
    new PerformanceObserver((list) => {
      const m = bezig;
      if (!m) return;
      for (const e of list.getEntries()) if (m.lang.length < 20) m.lang.push({ t: rond(e.startTime - m.t0), d: rond(e.duration) });
    }).observe({ type: "longtask", buffered: false });
  } catch {}
}

// agentbox (08-11-2026): "Opdracht geven doet niks" in Sams desktop-Firefox, terwijl een
// schone Firefox 159 het wel doet. Meldt per druk op die knop: welke build, of pointerdown
// en click aankomen, en of er iets bovenop de knop ligt dat de klik opvangt.
const BUILD = (() => { try { return new URL(import.meta.url).pathname.split("/").pop() ?? "?"; } catch { return "?"; } })();
export function meldOpdrachtKlik(fase: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ soort: "opdrachtklik", fase, build: BUILD, breed: window.innerWidth, pad: location.pathname, ua: navigator.userAgent.slice(0, 160), ...extra });
  try { navigator.sendBeacon?.("/api/taken/perf", new Blob([body], { type: "application/json" })); } catch {}
}
export function installOpdrachtKlikMeting() {
  if (typeof window === "undefined") return;
  const label = (el: Element | null) => (el?.getAttribute("aria-label") ?? "").slice(0, 60);
  window.addEventListener("pointerdown", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const knop = el?.closest('[aria-label^="Opdracht geven"]') ?? null;
    if (knop) return meldOpdrachtKlik("pointerdown", { knop: label(knop), stage: !!knop.closest("[data-testid='new-session-stage']") });
    // Ligt er een Opdracht-knop onder het element dat de klik kreeg? Dan vangt iets hem af.
    const onder = document.elementsFromPoint(e.clientX, e.clientY).find(n => n.closest('[aria-label^="Opdracht geven"]'));
    if (onder) meldOpdrachtKlik("bedekt", { knop: label(onder.closest('[aria-label^="Opdracht geven"]')), boven: naam(el), boven2: naam(el?.parentElement ?? null) });
  }, true);
  window.addEventListener("click", (e) => {
    const knop = e.target instanceof Element ? e.target.closest('[aria-label^="Opdracht geven"]') : null;
    if (knop) meldOpdrachtKlik("click", { knop: label(knop), trusted: e.isTrusted });
  }, true);
}
