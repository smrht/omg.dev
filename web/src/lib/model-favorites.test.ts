import { describe, expect, test } from "bun:test";
import {
  MODEL_FAVORITES_VISIBLE,
  availableModelFavorites,
  modelFavoritesOrSelected,
  modelFavoritesStorageKey,
  readModelFavorites,
  toggleModelFavorite,
  writeModelFavorites,
} from "./model-favorites";

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    dump: () => Object.fromEntries(store),
  };
}

describe("model favorites storage", () => {
  test("round-trips a list per agent under its own key", () => {
    const storage = fakeStorage();
    writeModelFavorites(storage, "omg", ["omg/z-ai/glm-5.3", "omg/openai/gpt-5.6"]);
    expect(readModelFavorites(storage, "omg")).toEqual(["omg/z-ai/glm-5.3", "omg/openai/gpt-5.6"]);
    expect(modelFavoritesStorageKey("omg")).not.toBe(modelFavoritesStorageKey("claude"));
  });

  test("malformed storage reads as never stored and never throws", () => {
    const broken = fakeStorage({
      [modelFavoritesStorageKey("omg")]: "{not json",
      [modelFavoritesStorageKey("claude")]: JSON.stringify({ nope: true }),
      [modelFavoritesStorageKey("grok")]: JSON.stringify([1, null, "ok-model", "", "  ", true]),
    });
    expect(readModelFavorites(broken, "omg")).toBeNull();
    expect(readModelFavorites(broken, "claude")).toEqual([]);
    expect(readModelFavorites(broken, "grok")).toEqual(["ok-model"]);
    expect(readModelFavorites(broken, "never-touched")).toBeNull();
  });

  test("an explicitly stored empty list stays empty and is not a seed", () => {
    const storage = fakeStorage();
    writeModelFavorites(storage, "omg", []);
    expect(readModelFavorites(storage, "omg")).toEqual([]);
    expect(modelFavoritesOrSelected(readModelFavorites(storage, "omg"), ["m1"], "m1")).toEqual([]);
  });

  test("agents do not see each other's favorites", () => {
    const storage = fakeStorage();
    writeModelFavorites(storage, "omg", ["omg/z-ai/glm-5.3"]);
    const next = toggleModelFavorite(readModelFavorites(storage, "claude") ?? [], "opus");
    writeModelFavorites(storage, "claude", next);
    expect(readModelFavorites(storage, "omg")).toEqual(["omg/z-ai/glm-5.3"]);
    expect(readModelFavorites(storage, "claude")).toEqual(["opus"]);
  });

  test("toggle adds to the front and removes without silently evicting older favorites", () => {
    const start = ["a", "b"];
    expect(toggleModelFavorite(start, "c")).toEqual(["c", "a", "b"]);
    expect(toggleModelFavorite(start, "a")).toEqual(["b"]);
    const capped = toggleModelFavorite(
      Array.from({ length: 20 }, (_, i) => `m${i}`),
      "new",
    );
    expect(capped).toHaveLength(21);
    expect(capped).toContain("m19");
    expect(capped[0]).toBe("new");
    expect(MODEL_FAVORITES_VISIBLE).toBe(3);
  });

  test("favorites that are not available models are dropped from the visible list", () => {
    expect(availableModelFavorites(["gone", "kept", "also-gone"], ["kept", "other"])).toEqual(["kept"]);
    expect(
      modelFavoritesOrSelected(["gone", "kept"], ["kept"], "other"),
    ).toEqual(["kept"]);
  });

  test("a never-stored list seeds with the selected model only, when it runs", () => {
    expect(modelFavoritesOrSelected(null, ["m1", "m2"], "m2")).toEqual(["m2"]);
    expect(modelFavoritesOrSelected(null, ["m1"], "not-a-model")).toEqual([]);
  });
});
