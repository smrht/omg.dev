import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { haptic } from "@/lib/haptics";

const LazyCampfireHost = lazy(() =>
  import("./UsageCampfire").then((m) => ({ default: m.UsageCampfireHost })),
);

const WAKE_EVENT = "agentbox:usage-campfire-wake";
let loaded = false;

async function triggerRealOpen() {
  const m = await import("./UsageCampfire");
  loaded = true;
  m.openUsageCampfire();
}

export function openUsageCampfire() {
  window.dispatchEvent(new Event(WAKE_EVENT));
  if (loaded) {
    void triggerRealOpen();
  }
}

const RING_LONG_PRESS_MS = 420;

export function useUsageRingLongPress(): {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onPointerLeave: (e: ReactPointerEvent) => void;
  shouldSuppressClick: () => boolean;
} {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const suppress = useRef(false);

  const clear = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      suppress.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        suppress.current = true;
        haptic("heavy");
        openUsageCampfire();
      }, RING_LONG_PRESS_MS);
    },
    [clear],
  );

  const end = useCallback(
    (e: ReactPointerEvent) => {
      clear();
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [clear],
  );

  const shouldSuppressClick = useCallback(() => {
    if (!suppress.current) return false;
    suppress.current = false;
    return true;
  }, []);

  return {
    onPointerDown,
    onPointerUp: end,
    onPointerCancel: end,
    onPointerLeave: end,
    shouldSuppressClick,
  };
}

export function UsageCampfireHost(props: {
  onSelectAgent?: (kind: string, accountId?: string) => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted) return;
    const wake = () => {
      setMounted(true);
      window.setTimeout(() => { void triggerRealOpen(); }, 40);
    };
    window.addEventListener(WAKE_EVENT, wake);
    return () => window.removeEventListener(WAKE_EVENT, wake);
  }, [mounted]);

  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <LazyCampfireHost {...props} />
    </Suspense>
  );
}
