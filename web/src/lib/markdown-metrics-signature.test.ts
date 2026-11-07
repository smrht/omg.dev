import { expect, test } from "bun:test";
import "../test-support/render"; // happy-dom

const { typographySignature } = await import("./markdown-metrics");

test("layout-only writes on <html> keep the typography signature", () => {
  const root = document.documentElement;
  const before = typographySignature(document);
  root.style.setProperty("--lfg-app-height", "700px");
  root.style.setProperty("--lfg-mobile-header-height", "96px");
  root.classList.add("lfg-keyboard-open");
  expect(typographySignature(document)).toBe(before);
  root.classList.remove("lfg-keyboard-open");
  root.style.removeProperty("--lfg-app-height");
});

test("theme and font changes do change it", () => {
  const root = document.documentElement;
  const before = typographySignature(document);
  root.classList.toggle("dark");
  expect(typographySignature(document)).not.toBe(before);
  root.classList.toggle("dark");
  const font = root.dataset.font;
  root.dataset.font = font === "atkinson" ? "geist" : "atkinson";
  expect(typographySignature(document)).not.toBe(before);
  if (font === undefined) delete root.dataset.font;
  else root.dataset.font = font;
});
