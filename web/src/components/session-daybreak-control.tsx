/**
 * Daybreak (cyber access program) controls for ordinary codex-aisdk chat.
 *
 * Three exports:
 *  - `DaybreakProgramSelect`: the compact native-select picker for launch
 *    surfaces (the new-session composer on desktop, the compact mobile sheet).
 *    Default state is omitted/automatic; once a choice is made it is always
 *    explicit — "Uit" sends `standard`, never a silent omission.
 *  - `SessionDaybreakMenuBody`: the per-session choice list plus its
 *    metadata-only notes, self-contained so it mounts in tests without a menu.
 *  - `SessionDaybreakSubmenu`: the same body wrapped as a section of the
 *    session's three-dot dropdown menu, next to the thinking-level submenu.
 *
 * No new motion: these reuse the picker/menu vocabulary that already honours
 * reduced-motion. Errors surface as a readable `role="alert"` plus a toast;
 * a failed save never changes the checked program, because the checked state
 * is the session row the box still reports.
 */
import { useState } from "react";
import { Check, Loader2, Sunrise } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  AUTOMATIC_PROGRAM_LABEL,
  DAYBREAK_SESSION_AGENT,
  daybreakLabel,
  isNonstandardProgram,
  parseCyberAccessProgram,
  type CyberAccessProgram,
} from "../lib/session-daybreak";

/**
 * The launch picker. A native `<select>` with an explicit visible label, so
 * keyboard, pointer and assistive tech all get the same control. `automatic`
 * adds the omitted/automatic default as a real, chosen option: picking it
 * after picking something is a genuine return to default (onChange null), not
 * a fake disable.
 */
export function DaybreakProgramSelect({
  value,
  programs,
  onChange,
  automatic = false,
  disabled = false,
  flat = false,
}: {
  /** The explicit choice, or null for the omitted automatic default. */
  value: CyberAccessProgram | null;
  /** Everything the selected model offers, display-ordered. */
  programs: CyberAccessProgram[];
  onChange: (value: CyberAccessProgram | null) => void;
  automatic?: boolean;
  disabled?: boolean;
  flat?: boolean;
}) {
  // A stale value the current model no longer offers reads as automatic here;
  // the composer's reset effect and the launch guard keep it out of payloads.
  const shown = value && programs.includes(value) ? value : "";
  return (
    <label
      className={cn(
        "relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full text-foreground",
        flat ? "px-1" : "bg-muted px-3",
      )}
    >
      <Sunrise className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 text-xs font-medium">Daybreak:</span>
      <select
        value={shown}
        disabled={disabled}
        title="Cyber-toegangsprogramma voor dit model"
        onChange={(event) => {
          const next = event.target.value;
          onChange(next ? (next as CyberAccessProgram) : null);
        }}
        className="min-w-0 cursor-pointer bg-transparent text-xs font-medium text-foreground outline-none disabled:cursor-default disabled:opacity-50"
      >
        {automatic ? <option value="">{AUTOMATIC_PROGRAM_LABEL}</option> : null}
        {programs.map((program) => (
          <option key={program} value={program}>
            {daybreakLabel(program)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The per-session choice list. Renders one of three things:
 *  - a concise note when the session's model offers no nonstandard program
 *    (metadata only — e.g. a Sol model on a Codex session);
 *  - a note that the session must be resumed when the harness predates the
 *    toggle (`cyberAccessProgramControl` false) — no POST is pretended;
 *  - radio items for the offered programs, disabled while the session is busy
 *    or a save is in flight.
 */
export function SessionDaybreakMenuBody({
  program,
  offered,
  control,
  busy = false,
  onSave,
  onError,
  inMenu = false,
}: {
  inMenu?: boolean;
  /** The program the session row currently reports; null when unset. */
  program: CyberAccessProgram | null;
  /** The vocabulary the session's model offers, display-ordered. */
  offered: CyberAccessProgram[];
  /** `session.cyberAccessProgramControl`; undefined is treated as absent. */
  control: boolean | undefined;
  busy?: boolean;
  /** POSTs the program and resolves after the refetch — App owns the call. */
  onSave: (program: CyberAccessProgram) => Promise<void>;
  onError?: (message: string | null) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(next: CyberAccessProgram) {
    if (changing || busy || next === program) return;
    setChanging(true);
    setError(null);
    onError?.(null);
    try {
      await onSave(next);
      toast.success(`Daybreak: ${daybreakLabel(next)}`);
    } catch (cause) {
      // The session row was never touched optimistically, so the checked
      // program snaps back to what the box still reports.
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onError?.(message);
      toast.error(`Daybreak-keuze niet bevestigd: ${message}`);
    } finally {
      setChanging(false);
    }
  }

  if (!offered.some(isNonstandardProgram)) {
    return (
      <p className="px-3 py-2.5 text-xs text-muted-foreground">
        Dit model biedt geen Daybreak.
      </p>
    );
  }
  if (control !== true) {
    return (
      <p className="px-3 py-2.5 text-xs text-muted-foreground">
        Stop deze sessie en open haar via Resume. Je geschiedenis blijft behouden; daarna kun je Daybreak kiezen.
      </p>
    );
  }
  return (
    <div>
      <div className="px-3 py-2.5 text-xs text-muted-foreground">Daybreak-programma</div>
      {inMenu ? (
        <DropdownMenuRadioGroup value={program ?? ""} onValueChange={(value) => void pick(value as CyberAccessProgram)} aria-label="Daybreak-programma">
          {offered.map((item) => <DropdownMenuRadioItem key={item} value={item} disabled={busy || changing}>{daybreakLabel(item)}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      ) : <div role="group" aria-label="Daybreak-programma">
        {offered.map((item) => (
          <button
            key={item}
            type="button"
            role="menuitemradio"
            aria-checked={item === program}
            disabled={busy || changing}
            onClick={() => void pick(item)}
            className="flex w-full cursor-default items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm select-none outline-none focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {changing && item === program ? (
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : null}
            <span className="min-w-0 flex-1">{daybreakLabel(item)}</span>
            {item === program ? <Check className="size-4" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>}
      <p className="px-3 py-2 text-xs text-muted-foreground">Geldt vanaf je volgende bericht.</p>
      {error ? (
        <p role="alert" className="px-3 py-2.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The session shape this submenu reads; a structural slice of App's Session. */
export type DaybreakSessionLike = {
  sessionId?: string | null;
  agent?: string | null;
  model?: string | null;
  shippedReview?: boolean;
  cyberAccessProgram?: string | null;
  cyberAccessProgramControl?: boolean;
};

/**
 * The three-dot menu section. Renders nothing unless this is a codex-aisdk
 * session with an id: other backends never get the control, and a box that
 * predates the toggle (`cyberAccessProgramControl` absent while the catalog
 * offers programs) gets nothing rather than a control that would pretend.
 */
export function SessionDaybreakSubmenu({
  session,
  offered,
  busy = false,
  onSave,
  onError,
}: {
  session: DaybreakSessionLike;
  offered: CyberAccessProgram[];
  busy?: boolean;
  onSave: (program: CyberAccessProgram) => Promise<void>;
  onError?: (message: string | null) => void;
}) {
  if (!session.sessionId || session.shippedReview) return null;
  if (session.agent !== DAYBREAK_SESSION_AGENT) return null;
  const program = parseCyberAccessProgram(session.cyberAccessProgram);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={busy}>
        <Sunrise className="size-4" aria-hidden="true" />
        <span className="flex-1">Daybreak</span>
        <span className="text-xs text-muted-foreground">{daybreakLabel(program)}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent align="start" className="min-w-44">
        <SessionDaybreakMenuBody
          inMenu
          program={program}
          offered={offered}
          control={session.cyberAccessProgramControl}
          busy={busy}
          onSave={onSave}
          onError={onError}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
