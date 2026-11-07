import { beforeEach, expect, test } from "bun:test";
import "../test-support/render"; // happy-dom: localStorage + document

const { getFont, setFont, nextFont, FONTS, DEFAULT_FONT } = await import("./font");

beforeEach(() => localStorage.clear());

test("Inter is the default and an unknown stored value falls back to it", () => {
  expect(getFont()).toBe(DEFAULT_FONT);
  localStorage.setItem("agentbox:font", "comic-sans");
  expect(getFont()).toBe("inter");
});

test("setFont stores the choice and applies it to <html>", () => {
  setFont("atkinson");
  expect(getFont()).toBe("atkinson");
  expect(document.documentElement.dataset.font).toBe("atkinson");
});

test("nextFont cycles through every font and wraps around", () => {
  let f = FONTS[0].id;
  const seen = new Set<string>();
  for (let i = 0; i < FONTS.length; i++) { seen.add(f); f = nextFont(f); }
  expect(seen.size).toBe(FONTS.length);
  expect(f).toBe(FONTS[0].id);
});
