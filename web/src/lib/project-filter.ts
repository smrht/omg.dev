export const PROJECT_FILTER_STORAGE_KEY = "lfg_v2_project_filter";

type ProjectFilterStorage = Pick<Storage, "getItem" | "setItem">;

// localStorage, and raw strings, and deliberately so: the picked folder is a
// preference of this browser that must survive restarts and app updates.
// The 2026-09 upstream merge briefly moved this to expiring sessionStorage,
// which silently dropped every existing pick on update — Sam's included.
// A raw string cannot carry an expiry, which is the point.
function browserStorage(): ProjectFilterStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The folder this browser last picked, or the all-projects scope. */
export function readCachedProjectFilter(
  storage: ProjectFilterStorage | null = browserStorage(),
): string {
  try {
    return storage?.getItem(PROJECT_FILTER_STORAGE_KEY) || "__all";
  } catch {
    return "__all";
  }
}

export function cacheProjectFilter(
  projectFilter: string,
  storage: ProjectFilterStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(PROJECT_FILTER_STORAGE_KEY, projectFilter);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // current page still keeps the selection in React state.
  }
}

/**
 * The filter value for chats that were started without a project.
 *
 * It cannot be the empty string the server stores on the session, because
 * `readCachedProjectFilter` reads "" back as no saved value and falls to
 * "__all". It also cannot be a real project key, so it carries the same
 * "__"-prefix as "__all". It matches the group key `groupNodesByProject`
 * already uses for the folder-less group, so the rail group header and the
 * filter pill name the same thing.
 */
export const NO_PROJECT_FILTER = "__no_project";

/**
 * What the no-project filter is called in the folder menu, the sheet and the
 * composer chip.
 *
 * "New project", not "No project". The scope exists to start something that
 * has no folder yet, and it sits at the head of a list of folders, where
 * "No project" read as a folder by that name.
 */
export const NO_PROJECT_FILTER_LABEL = "New project";

/**
 * Does this session belong in the list the current filter is showing?
 *
 * The no-project filter matches ONLY an explicit empty project. A legacy row
 * has no project field at all and still falls back to its working directory
 * (see docs/no-project-chat.md), so folding `undefined` in here would drag
 * every pre-project session into a list of scratch chats.
 */
export function sessionMatchesProjectFilter(
  session: { project?: string | null },
  projectFilter: string,
): boolean {
  if (projectFilter === "__all") return true;
  if (projectFilter === NO_PROJECT_FILTER) return session.project === "";
  return session.project === projectFilter;
}

/** The label for one entry of the project filter, sentinels included. */
export function projectFilterLabel(
  value: string,
  shortProject: (project: string) => string,
): string {
  if (value === "__all") return "All projects";
  if (value === NO_PROJECT_FILTER) return NO_PROJECT_FILTER_LABEL;
  return shortProject(value);
}

/**
 * The filter a rail press produces.
 *
 * Pressing the pill that is already selected clears the scope. The rail lost
 * its "All" pill, so this is the only way back to every folder from the rail
 * itself, and without it choosing a folder on a phone would be a one-way
 * door: the other clear control lives on the list's group headers, and a
 * scoped list has only one header.
 *
 * Here rather than in the rail because the rail owns no selection state, and
 * here rather than at each call site because there are two rails, one per
 * width, and they have already drifted once.
 */
export function projectFilterAfterPress(pressed: string, current: string): string {
  return pressed === current ? "__all" : pressed;
}

/**
 * The scope to open on, when nothing usable is remembered.
 *
 * The rail has no "All" pill, so an unscoped list showed every folder with no
 * pill lit. It resolves to the no-project scope instead: that scope is also
 * where a new chat from Home goes, and a new chat goes into a folder only when
 * the person picked that folder in this visit.
 */
export function resolveInitialProjectFilter(input: {
  /** What this visit remembered. May be "__all", or a folder that is gone. */
  saved: string;
  /** Every selectable value, as the rail lists them. */
  options: readonly string[];
  preferred?: string | null;
  /** Overview has a visible all-projects control, so retain that explicit scope. */
  allowAll?: boolean;
}): string {
  const { saved, options, preferred } = input;
  if (!options.length) return saved;
  if (input.allowAll && saved === "__all") return saved;
  const has = (value: string | null | undefined): value is string =>
    !!value && value !== "__all" && options.includes(value);
  if (has(saved)) return saved;
  if (has(preferred)) return preferred;
  // Never unscoped by default: the rail has no "All" pill, and a folder
  // nobody picked is where a new chat from Home would land. An unscoped
  // filter, or a folder that has gone away, resolves to the no-project
  // scope — the same scope a new chat from Home goes to unless a folder
  // was picked in this visit. See resolveInitialProjectFilter's callers.
  return options.includes(NO_PROJECT_FILTER) ? NO_PROJECT_FILTER : options[0]!;
}
