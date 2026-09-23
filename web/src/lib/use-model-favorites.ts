import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { modelFavoritesOrSelected, modelFavoritesStorageKey, readModelFavorites, toggleModelFavorite } from "./model-favorites";

const changeEvent = "omg-model-favorites-change";
const volatile = new Map<string, string>();
function snapshot(key: string): string | null {
  if (volatile.has(key)) return volatile.get(key)!;
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string[]) {
  const raw = JSON.stringify(value);
  try { window.localStorage.setItem(key, raw); volatile.delete(key); }
  catch { volatile.set(key, raw); }
  window.dispatchEvent(new Event(changeEvent));
}
function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(changeEvent, notify);
  };
}
export function useModelFavorites(agent: string, models: string[], selected: string) {
  const key = modelFavoritesStorageKey(agent);
  const getSnapshot = useCallback(() => snapshot(key), [key]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const stored = useMemo(() => readModelFavorites({ getItem: () => raw }, agent), [raw, agent]);
  const favorites = useMemo(() => modelFavoritesOrSelected(stored, models, selected), [stored, models, selected]);
  // Seed once, only after the selected model is confirmed available. An
  // explicitly emptied list is respected and unavailable favorites are kept.
  useEffect(() => {
    if (stored === null && selected && models.includes(selected)) save(key, [selected]);
  }, [key, stored, selected, models]);
  const toggle = useCallback((id: string) => {
    const current = readModelFavorites({ getItem: () => snapshot(key) }, agent);
    save(key, toggleModelFavorite(current ?? favorites, id));
  }, [key, agent, favorites]);
  return { favorites, toggle };
}
