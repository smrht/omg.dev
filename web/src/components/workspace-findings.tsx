import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Popover } from "@base-ui/react/popover";

import { AutoReportRow } from "./auto-report-row";
import { ClearFindingsButton } from "./clear-findings-button";
import { groupFindingsByAgent, type GroupableFinding } from "../lib/finding-groups";
import { cn } from "../lib/utils";

// The workspace header is 48px tall (desktop-workspace.tsx) and clips
// anything taller put next to its controls, so the rail's expanded Updates
// panel cannot simply be reused there: its open state rendered a
// max-h-[50%] list inside headerControls. The header instead carries this
// compact trigger, and the list itself opens in a popover that portals to
// the body, anchors to the trigger (side bottom, align end) and sizes
// itself against the viewport instead of the header box. The rail keeps the
// inline panel; the mobile sheet is untouched. Escape, outside clicks and
// focus return are the Popover library's own behaviour.
export function WorkspaceFindingsMenu<F extends GroupableFinding & { title: string }>({
  findings,
  nameFor,
  onOpenReport,
  onTriageFindings,
  onClearFindings,
  clearFindingsBusy = false,
  triageBusy = false,
  actions = null,
}: {
  findings: readonly F[];
  nameFor: (id: string) => string;
  onOpenReport: (agentId: string) => void;
  onTriageFindings: (targets?: F[]) => void;
  onClearFindings: (targets: F[]) => void;
  clearFindingsBusy?: boolean;
  /** Disables the per-report triage while a triage run is in flight. */
  triageBusy?: boolean;
  /** The triage control, built by the caller (AutoTriageButton lives in App.tsx). */
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!findings.length) return null;
  const count = findings.length;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            data-testid="workspace-findings-trigger"
            aria-label={`${count} update${count === 1 ? "" : "s"} from auto agents. Open`}
            className="group flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/90 px-2.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-xl transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
          >
            <span className="tabular-nums">
              {count} update{count === 1 ? "" : "s"}
            </span>
            <ChevronUp className="size-3 shrink-0 opacity-70 group-data-[popup-open]:hidden" />
            <ChevronDown className="hidden size-3 shrink-0 opacity-70 group-data-[popup-open]:block" />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="isolate z-[170] outline-none"
        >
          <Popover.Popup
            data-testid="workspace-findings-popover"
            aria-label="Updates"
            className={cn(
              "flex max-h-[min(70dvh,var(--available-height))] w-[min(480px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5 outline-none",
              // Short anchored fade only: the panel drops from the trigger,
              // so no travel is needed to show where it came from.
              "animate-in fade-in duration-150 motion-reduce:animate-none",
            )}
          >
            <div className="flex h-10 shrink-0 items-center gap-2 pl-3 pr-1.5">
              <span className="text-[13px] font-semibold">Updates</span>
              <span className="text-xs tabular-nums text-muted-foreground">{count} open</span>
              <span className="ml-auto flex items-center gap-1">
                {actions}
                <ClearFindingsButton
                  count={count}
                  busy={clearFindingsBusy}
                  onClear={() => onClearFindings([...findings])}
                />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close updates"
                  title="Close updates"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ChevronDown className="size-4" />
                </button>
              </span>
            </div>
            <div
              data-testid="workspace-findings-list"
              className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-1.5 pb-2"
            >
              {groupFindingsByAgent(findings).map((report) => (
                <AutoReportRow
                  key={report.agentId}
                  report={report}
                  agentName={nameFor(report.agentId)}
                  onOpen={() => {
                    // Opening the report swaps this panel for the report
                    // surface, so the popover must not stay open behind it.
                    setOpen(false);
                    onOpenReport(report.agentId);
                  }}
                  onTriage={() => onTriageFindings(report.findings)}
                  triageBusy={triageBusy}
                />
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
