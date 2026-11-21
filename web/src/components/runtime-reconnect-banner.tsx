import { useEffect, useRef, useState } from "react";
import { RefreshCw, WifiOff, X } from "lucide-react";

function currentStylesheetHref(): string | null {
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="/assets/index-"]');
  return link?.getAttribute("href") ?? null;
}

/**
 * P5 (21-11-2026):
 * 1) Herkent wanneer omg kort herstart (3-4s) of onbereikbaar is, toont een
 *    subtiele balk bovenaan en herverbindt automatisch zodra /api/health 200 geeft.
 * 2) Detecteert bij focus of na een herstart of er een nieuwe web-build live staat
 *    en biedt een 1-klik "Herlaad"-knop i.p.v. stille asset-404's.
 */
export function RuntimeReconnectBanner() {
  const [offline, setOffline] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissedUpdate, setDismissedUpdate] = useState(false);
  const initialCssRef = useRef<string | null>(null);
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    initialCssRef.current = currentStylesheetHref();
    let cancelled = false;
    let fastTimer: number | null = null;

    const checkAssetVersion = async () => {
      const initial = initialCssRef.current;
      if (!initial) return;
      try {
        const res = await fetch("/", { cache: "no-store", headers: { Accept: "text/html" } });
        if (!res.ok) return;
        const html = await res.text();
        const match = html.match(/href="([^"]*\/assets\/index-[^"]+\.css)"/);
        if (match && match[1] && match[1] !== initial && !cancelled) {
          setUpdateReady(true);
        }
      } catch {
        // Negeer: offline-check vangt dit al op.
      }
    };

    const ping = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      try {
        const ctl = new AbortController();
        const tid = window.setTimeout(() => ctl.abort(), 3500);
        const res = await fetch("/api/sessions?limit=1", { cache: "no-store", signal: ctl.signal });
        window.clearTimeout(tid);
        if (!res.ok) throw new Error(String(res.status));
        if (wasOfflineRef.current) {
          wasOfflineRef.current = false;
          setOffline(false);
          setReconnected(true);
          void checkAssetVersion();
          window.setTimeout(() => { if (!cancelled) setReconnected(false); }, 2500);
        }
        if (fastTimer != null) {
          window.clearInterval(fastTimer);
          fastTimer = null;
        }
      } catch {
        if (!cancelled) {
          wasOfflineRef.current = true;
          setOffline(true);
          setReconnected(false);
          if (fastTimer == null) {
            fastTimer = window.setInterval(() => { void ping(); }, 2000);
          }
        }
      }
    };

    const slowTimer = window.setInterval(() => {
      void ping();
      void checkAssetVersion();
    }, 45_000);

    const onOnline = () => { void ping(); };
    const onOffline = () => {
      wasOfflineRef.current = true;
      setOffline(true);
      if (fastTimer == null) fastTimer = window.setInterval(() => { void ping(); }, 2000);
    };
    const onFocus = () => {
      void ping();
      void checkAssetVersion();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(slowTimer);
      if (fastTimer != null) window.clearInterval(fastTimer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!offline && !reconnected && !(updateReady && !dismissedUpdate)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-2 z-[90] flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-border-strong bg-card px-3.5 py-1.5 text-xs font-medium text-foreground shadow-lg transition-opacity duration-150 motion-reduce:transition-none"
    >
      {offline ? (
        <>
          <WifiOff aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <span>Agentbox herstart even… verbindt automatisch opnieuw</span>
        </>
      ) : reconnected ? (
        <>
          <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>Weer verbonden</span>
        </>
      ) : (
        <>
          <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
          <span>Nieuwe Agentbox-versie klaar</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Herlaad
          </button>
          <button
            type="button"
            onClick={() => setDismissedUpdate(true)}
            aria-label="Melding sluiten"
            className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </>
      )}
    </div>
  );
}
