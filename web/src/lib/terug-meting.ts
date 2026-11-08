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
  tikken: number[];
  klikken: number[];
  paden: { t: number; p: string }[];
  lang: { t: number; d: number }[];
};

let bezig: Meting | null = null;

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
  const tik = (lijst: "tikken" | "klikken") => () => {
    const m = bezig;
    if (m && m[lijst].length < 12) m[lijst].push(rond(performance.now() - m.t0));
  };
  window.addEventListener("touchstart", tik("tikken"), { capture: true, passive: true });
  window.addEventListener("click", tik("klikken"), { capture: true, passive: true });
  try {
    new PerformanceObserver((list) => {
      const m = bezig;
      if (!m) return;
      for (const e of list.getEntries()) if (m.lang.length < 20) m.lang.push({ t: rond(e.startTime - m.t0), d: rond(e.duration) });
    }).observe({ type: "longtask", buffered: false });
  } catch {}
}
