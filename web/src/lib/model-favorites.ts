/**
 * Per-agent favorite models, persisted under one localStorage key per agent.
 *
 * Storage is the single source of truth: the composer derives the visible
 * list from it on every render, so a star toggled in one surface (the compact
 * sheet, the all-models list) is reflected everywhere for that agent. The
 * compact sheet shows at most MODEL_FAVORITES_VISIBLE rows; the stored list
 * may hold more.
 *
 * A missing key or invalid JSON reads as "never stored" (null). Other invalid
 * shapes normalize to an empty list. The
 * composer then seeds the list with the selected model only — the one
 * exception to "no invented defaults". An explicitly stored empty array is
 * respected as "every star was removed" and is never re-seeded, which is why
 * readModelFavorites distinguishes null from [].
 */

export const MODEL_FAVORITES_VISIBLE = 3;

type StorageReader = { getItem(key: string): string | null };
type StorageWriter = { setItem(key: string, value: string): void };

export function modelFavoritesStorageKey(agent: string): string {
  return `omg_model_favorites_${agent}`;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export function readModelFavorites(storage: StorageReader, agent: string): string[] | null {
  let raw: string | null;
  try {
    raw = storage.getItem(modelFavoritesStorageKey(agent));
  } catch {
    return null;
  }
  if (raw == null) return null;
  try {
    return normalizeList(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeModelFavorites(
  storage: StorageWriter,
  agent: string,
  favorites: readonly string[],
): void {
  try {
    storage.setItem(modelFavoritesStorageKey(agent), JSON.stringify(normalizeList(favorites)));
  } catch {
    // Best-effort persistence. A full or blocked localStorage must not break
    // the picker. The reactive hook separately provides an in-memory fallback.
  }
}

/** Toggle one id. A new favorite goes to the front, so it is visible at once. */
export function toggleModelFavorite(favorites: readonly string[], model: string): string[] {
  const rest = favorites.filter((id) => id !== model);
  if (rest.length !== favorites.length) return rest;
  return [model, ...favorites];
}

/** Only ids the agent can actually run right now. */
export function availableModelFavorites(
  favorites: readonly string[],
  models: readonly string[],
): string[] {
  const available = new Set(models);
  return favorites.filter((id) => available.has(id));
}

/**
 * The list the picker shows. "Never stored" seeds with the selected model; a
 * stored list (empty included) is filtered to the models this agent offers.
 */
export function modelFavoritesOrSelected(
  stored: string[] | null,
  models: readonly string[],
  selected: string | null | undefined,
): string[] {
  if (stored === null) {
    return selected && models.includes(selected) ? [selected] : [];
  }
  return availableModelFavorites(stored, models);
}
