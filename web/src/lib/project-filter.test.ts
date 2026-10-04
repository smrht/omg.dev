import { describe, expect, test } from "bun:test";
import {
  cacheProjectFilter,
  NO_PROJECT_FILTER,
  PROJECT_FILTER_STORAGE_KEY,
  readCachedProjectFilter,
  projectFilterAfterPress,
  resolveInitialProjectFilter,
  NO_PROJECT_FILTER_LABEL,
  projectFilterLabel,
  sessionMatchesProjectFilter,
} from "./project-filter";

const shortProject = (project: string) => project.split("/").pop() || project;

describe("sessionMatchesProjectFilter", () => {
  test("__all keeps every session", () => {
    expect(sessionMatchesProjectFilter({ project: "duet" }, "__all")).toBe(true);
    expect(sessionMatchesProjectFilter({ project: "" }, "__all")).toBe(true);
    expect(sessionMatchesProjectFilter({}, "__all")).toBe(true);
  });

  test("a named project matches only itself", () => {
    expect(sessionMatchesProjectFilter({ project: "duet" }, "duet")).toBe(true);
    expect(sessionMatchesProjectFilter({ project: "lfg" }, "duet")).toBe(false);
    expect(sessionMatchesProjectFilter({ project: "" }, "duet")).toBe(false);
  });

  test("No project matches an explicit empty project", () => {
    expect(sessionMatchesProjectFilter({ project: "" }, NO_PROJECT_FILTER)).toBe(true);
    expect(sessionMatchesProjectFilter({ project: "duet" }, NO_PROJECT_FILTER)).toBe(false);
  });

  test("a legacy row with no project field is NOT a no-project chat", () => {
    // It predates the field and still falls back to its working directory.
    // Folding it in here would fill the scratch list with old repo sessions.
    expect(sessionMatchesProjectFilter({}, NO_PROJECT_FILTER)).toBe(false);
    expect(sessionMatchesProjectFilter({ project: null }, NO_PROJECT_FILTER)).toBe(false);
  });
});

describe("projectFilterLabel", () => {
  test("names both sentinels and shortens a real project", () => {
    expect(projectFilterLabel("__all", shortProject)).toBe("All projects");
    expect(projectFilterLabel(NO_PROJECT_FILTER, shortProject)).toBe(NO_PROJECT_FILTER_LABEL);
    expect(projectFilterLabel("/home/dev/repos/duet", shortProject)).toBe("duet");
  });
});

describe("projectFilterAfterPress", () => {
  test("an unselected pill scopes to it", () => {
    expect(projectFilterAfterPress("duet", "__all")).toBe("duet");
    expect(projectFilterAfterPress("duet", "lfg")).toBe("duet");
    expect(projectFilterAfterPress(NO_PROJECT_FILTER, "lfg")).toBe(NO_PROJECT_FILTER);
  });

  test("the selected pill clears the scope, including the no-project pill", () => {
    // The rail has no "All" pill, so a second press is the only way back to
    // every folder from the rail itself.
    expect(projectFilterAfterPress("duet", "duet")).toBe("__all");
    expect(projectFilterAfterPress(NO_PROJECT_FILTER, NO_PROJECT_FILTER)).toBe("__all");
  });
});

describe("resolveInitialProjectFilter", () => {
  const options = [NO_PROJECT_FILTER, "duet", "lfg", "vibes"];

  test("keeps a folder picked in this visit that still exists", () => {
    expect(resolveInitialProjectFilter({ saved: "lfg", options })).toBe("lfg");
    expect(resolveInitialProjectFilter({ saved: NO_PROJECT_FILTER, options })).toBe(
      NO_PROJECT_FILTER,
    );
  });

  test("keeps All projects once it was picked", () => {
    // The composer, not this resolver, keeps a new chat out of a folder
    // nobody picked (composerStartsUnassigned).
    expect(resolveInitialProjectFilter({ saved: "__all", options })).toBe("__all");
  });

  test("a folder that is gone opens on no project, never on another folder", () => {
    expect(resolveInitialProjectFilter({ saved: "gone", options })).toBe(NO_PROJECT_FILTER);
  });

  test("a folder that has gone away falls to no project", () => {
    expect(resolveInitialProjectFilter({ saved: "deleted", options })).toBe(NO_PROJECT_FILTER);
  });

  test("with nothing to choose from, it changes nothing", () => {
    // Options arrive after the first render. Resolving against an empty list
    // would overwrite the saved folder with a guess before the real list
    // lands, and the guess would stick.
    expect(resolveInitialProjectFilter({ saved: "lfg", options: [] })).toBe("lfg");
    expect(resolveInitialProjectFilter({ saved: "__all", options: [] })).toBe("__all");
  });
});

test("overview retains explicit all-projects scope across refreshes", () => {
  expect(
    resolveInitialProjectFilter({ saved: "__all", options: ["one", "two"], preferred: "one", allowAll: true }),
  ).toBe("__all");
});

describe("the remembered folder pick", () => {
  function memoryStorage() {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      data,
    };
  }

  test("an existing raw localStorage string is read back unchanged, on every read", () => {
    // The pick is a sticky preference: no expiry, no re-parse, no drift
    // between reads. It must survive the app update that changed the shape.
    const storage = memoryStorage();
    storage.setItem(PROJECT_FILTER_STORAGE_KEY, "duet");
    expect(readCachedProjectFilter(storage)).toBe("duet");
    expect(readCachedProjectFilter(storage)).toBe("duet");
    expect(readCachedProjectFilter(storage)).toBe("duet");
  });

  test("the all-projects sentinel persists the same way as a folder", () => {
    const storage = memoryStorage();
    storage.setItem(PROJECT_FILTER_STORAGE_KEY, "__all");
    expect(readCachedProjectFilter(storage)).toBe("__all");
    expect(readCachedProjectFilter(storage)).toBe("__all");
  });

  test("the no-project scope is a value like any other, not a fallback", () => {
    const storage = memoryStorage();
    storage.setItem(PROJECT_FILTER_STORAGE_KEY, NO_PROJECT_FILTER);
    expect(readCachedProjectFilter(storage)).toBe(NO_PROJECT_FILTER);
  });

  test("nothing stored, or no storage at all, reads as all projects", () => {
    expect(readCachedProjectFilter(memoryStorage())).toBe("__all");
    expect(readCachedProjectFilter(null)).toBe("__all");
  });

  test("a pick is written as a raw string and survives repeated reads", () => {
    const storage = memoryStorage();
    cacheProjectFilter("expo-go-probe", storage);
    expect(storage.getItem(PROJECT_FILTER_STORAGE_KEY)).toBe("expo-go-probe");
    expect(readCachedProjectFilter(storage)).toBe("expo-go-probe");
    expect(readCachedProjectFilter(storage)).toBe("expo-go-probe");
  });
});
