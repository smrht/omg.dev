// The redesigned desktop sessions surface (issue smrht/sites-beheer#1024).
//
// RailStage keeps every piece of session logic — grouping, cursor, keyboard
// order, stage columns — and mounts this as the DEFAULT shape of the "sessions"
// surface: a narrow global navigation, a compact workspace header, the shared
// new-session composer broad across the width, and a conversations list with a
// text summary of the selected row beside it.
//
// The summary pane is a SUMMARY, not a transcript: it renders only what the
// roster already loaded (title, project, model, status, latest line). No
// SessionCard is mounted here, so selecting a row never opens a transcript
// stream, never adds the session to the visible-transcript set and never marks
// it read — that all happens when "Open gesprek" promotes the session to the
// real stage.
//
// The component owns presentation only. Rows, the toolbar, the composer and
// the summary data all arrive as props from RailStage, which stays the single
// owner of selection state and overview preferences. While the full stage is
// up, RailStage keeps this surface mounted but hidden, so the composer draft,
// the filters and the list scroll survive the round-trip; the scroll offset is
// additionally mirrored into the passed-in ref and restored when the surface
// becomes active again.
import { useLayoutEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import {
  Bot,
  CalendarClock,
  ChevronDown,
  Folder,
  MessageSquare,
  Monitor,
  Settings,
} from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

export type DesktopWorkspaceSurface = "sessions" | "chat" | "auto" | "board";

export type WorkspaceSummary = {
  title: string;
  mark?: ReactNode;
  /** project · model · last activity, built by RailStage from roster data. */
  meta?: string;
  /** Real state only (working / blocked reason), or nothing. */
  status?: string;
  /** The latest line the roster already loaded. Never a fetched transcript. */
  body?: string;
};

type NavButtonProps = {
  label: string;
  icon: typeof MessageSquare;
  active?: boolean;
  unread?: boolean;
  onSelect: () => void;
};

function WorkspaceNavButton({ label, icon: Icon, active, unread, onSelect }: NavButtonProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      title={unread ? `${label} · ongelezen` : label}
      className={cn(
        "relative flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-xl outline-none transition-colors duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="text-[10px] font-medium leading-none">{label}</span>
      {unread ? (
        <span
          role="status"
          aria-label={`${label} heeft ongelezen berichten`}
          className="absolute right-2.5 top-2.5 size-2 rounded-full bg-primary"
        />
      ) : null}
    </button>
  );
}

export function DesktopWorkspace({
  brand,
  surface,
  onOpenSessions,
  onOpenBots,
  onOpenAuto,
  onOpenComputer,
  onOpenSettings,
  showBots = true,
  showSchedules = true,
  botsUnread = false,
  chatsUnread = false,
  projectFilter,
  projectOptions = [],
  onProjectChange,
  projectLabel,
  headerControls,
  navFooter,
  coach,
  composer,
  conversationsToolbar,
  density,
  selectedSid = null,
  summary = null,
  onOpenStage,
  listScrollMemory,
  active = true,
  children,
}: {
  /** Brand lockup with live connection state; built by RailStage. */
  brand: ReactNode;
  surface: DesktopWorkspaceSurface;
  onOpenSessions?: () => void;
  onOpenBots?: () => void;
  onOpenAuto?: () => void;
  /** Direct Computer page navigation, wired by the shell (setTab). */
  onOpenComputer?: () => void;
  /** Direct Settings navigation, wired by the shell (setTab). */
  onOpenSettings?: () => void;
  showBots?: boolean;
  showSchedules?: boolean;
  botsUnread?: boolean;
  chatsUnread?: boolean;
  projectFilter: string;
  projectOptions?: string[];
  onProjectChange?: (value: string) => void;
  /** Sentinel-aware label for one filter value (projectFilterLabel). */
  projectLabel: (value: string) => string;
  /** Account, pages and settings controls; composed by RailStage. */
  headerControls?: ReactNode;
  /** Bottom of the global nav: machine switcher, host slot. */
  navFooter?: ReactNode;
  /** Hosted getting-started panel; sits above the composer. */
  coach?: ReactNode;
  /** The new-session composer (NewSessionDialog, workspace variant). */
  composer: ReactNode;
  /** The Gesprekken toolbar, spanning the width above list and summary. */
  conversationsToolbar?: ReactNode;
  /** Overview density, applied to the list rows like the rail does. */
  density?: string;
  /** The row selected for the summary pane, or nothing. */
  selectedSid?: string | null;
  /** Summary data for the selected row. Absent = placeholder. */
  summary?: WorkspaceSummary | null;
  /** "Open gesprek": promote the selection to the full stage. */
  onOpenStage: (sid: string) => void;
  /** Survives the stage round-trip so the list scrolls back to where it was. */
  listScrollMemory: MutableRefObject<number>;
  /** False while the full stage is up (this surface stays mounted, hidden). */
  active?: boolean;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // Restore when the surface (re)appears: while the stage is up this tree is
  // display:none and some engines drop an overflow container's scroll offset,
  // so the parent mirrors it in the ref and this is the moment it comes back.
  useLayoutEffect(() => {
    if (!active) return;
    const el = listRef.current;
    if (el && listScrollMemory.current > 0) el.scrollTop = listScrollMemory.current;
  }, [active, listScrollMemory]);

  const projectSelect =
    onProjectChange && projectOptions.length > 0 ? (
      <label
        className="relative flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 pl-2.5 pr-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-within:border-primary"
        title="Project"
      >
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 max-w-44 truncate">{projectLabel(projectFilter)}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        {/* Native select under a styled trigger: keyboard and pointer both
            work, and no portal is needed for a list this short. */}
        <select
          aria-label="Project"
          value={projectFilter}
          onChange={(event) => onProjectChange(event.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          <option value="__all">{projectLabel("__all")}</option>
          {projectOptions.map((option) => (
            <option key={option} value={option}>
              {projectLabel(option)}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  return (
    <div data-desktop-workspace className="flex h-full min-h-0 min-w-0 w-full">
      <nav
        aria-label="Werkruimte"
        className="flex h-full w-20 shrink-0 flex-col items-center gap-1 border-r border-border bg-background py-2"
      >
        {brand}
        <div className="mt-2 flex flex-col items-center gap-1">
          {onOpenSessions ? (
            <WorkspaceNavButton
              label="Chats"
              icon={MessageSquare}
              active={surface === "sessions"}
              unread={chatsUnread}
              onSelect={onOpenSessions}
            />
          ) : null}
          {showBots && onOpenBots ? (
            <WorkspaceNavButton
              label="Bots"
              icon={Bot}
              active={surface === "chat"}
              unread={botsUnread}
              onSelect={onOpenBots}
            />
          ) : null}
          {showSchedules && onOpenAuto ? (
            <WorkspaceNavButton
              label="Planning"
              icon={CalendarClock}
              active={surface === "auto"}
              onSelect={onOpenAuto}
            />
          ) : null}
        </div>
        {/* Direct doors to the two pages the workspace itself cannot show.
            The full Pages menu stays in the header for everything else. */}
        {onOpenComputer ? (
          <WorkspaceNavButton label="Computer" icon={Monitor} onSelect={onOpenComputer} />
        ) : null}
        {onOpenSettings ? (
          <WorkspaceNavButton label="Instellingen" icon={Settings} onSelect={onOpenSettings} />
        ) : null}
        <div className="mt-auto flex flex-col items-center gap-1">{navFooter}</div>
      </nav>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
          <h1 className="shrink-0 text-[26px] font-semibold leading-none tracking-tight">
            Werkruimte
          </h1>
          {projectSelect}
          <div className="ml-auto flex min-w-0 items-center gap-1">{headerControls}</div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Broad: the composer spans the workspace width; only its own
              field shape keeps it readable. */}
          <div className="shrink-0 px-4 pt-4">
            {coach ? <div className="w-full">{coach}</div> : null}
            <div className="w-full" data-testid="workspace-composer">
              {composer}
            </div>
          </div>

          {/* The toolbar owns the whole width: search, unread, density and
              the view tabs scope BOTH columns below, not just the list. */}
          <div className="min-h-0 shrink-0">{conversationsToolbar}</div>

          <section className="flex min-h-0 flex-1 px-3 pb-3">
            <div className="flex min-h-0 min-w-0 flex-[2] flex-col">
              <div
                ref={listRef}
                data-overview-density={density}
                data-testid="workspace-conversations"
                onScroll={(event) => {
                  if (active) listScrollMemory.current = event.currentTarget.scrollTop;
                }}
                className="session-overview session-list-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-2"
              >
                {children}
              </div>
            </div>

            <aside
              aria-label="Geselecteerd gesprek"
              className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border/60"
            >
              {summary ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
                  <div className="flex items-start gap-3">
                    {summary.mark}
                    <div className="min-w-0">
                    <h3 className="text-xl font-semibold leading-snug">{summary.title}</h3>
                    {summary.meta ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {summary.meta}
                      </p>
                    ) : null}
                    {summary.status ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        {summary.status}
                      </p>
                    ) : null}
                    </div>
                  </div>
                  {summary.body ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80 line-clamp-6">
                      {summary.body}
                    </p>
                  ) : null}
                  <div className="shrink-0 pt-2">
                    <Button
                      type="button"
                      className="w-full h-11 rounded-lg"
                      disabled={!selectedSid}
                      onClick={() => selectedSid && onOpenStage(selectedSid)}
                    >
                      Open gesprek
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
                  Kies een gesprek om het hier te bekijken.
                </div>
              )}
            </aside>
          </section>
        </div>
      </div>
    </div>
  );
}
