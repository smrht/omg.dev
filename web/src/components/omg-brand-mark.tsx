import { cn } from "@/lib/utils";

/**
 * The omg.dev mark: a disc with a bite taken out of the upper right.
 *
 * Drawn in `currentColor` rather than a baked hex so one component covers both
 * builds. The hosted product wears it in the brand orange; a locally hosted
 * runtime wears the same shape in muted grey (see `ProductBrand`), which is how
 * you can tell at a glance which one you are looking at. It used to be a hard
 * `#ff5530`, so the only way to say "local" was to show a different logo
 * entirely — that is what the old LFG mark was doing here.
 */
export function OmgBrandMark({ className }: { className?: string }) {
  // agentbox: een doos met een agent erin. De doos volgt de tekstkleur, de
  // stip is het accent, zodat het merk in licht en donker hetzelfde zegt.
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6 shrink-0", className)} aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="12" cy="12" r="3.6" fill="var(--primary)" />
    </svg>
  );
}

/**
 * The colour the mark and wordmark take, by build.
 *
 * Hosted is the brand orange. Local is muted grey — the same product, running
 * on your own machine, said quietly rather than said with a different logo.
 */
export function omgBrandToneClass(hosted: boolean): string {
  return hosted ? "text-foreground" : "text-foreground";
}
