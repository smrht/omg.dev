/**
 * agentbox: kies je lettertype (Sam, 07-11-2026: "iets anders leesbaar").
 * The choice lives in localStorage and is applied as `data-font` on <html>;
 * agentbox.css maps each value to a --font-sans stack. Default is Inter:
 * tall x-height, open shapes, built for screens at 12-14 px.
 */
export const FONT_STORAGE_KEY = "agentbox:font";
export const FONT_CHANGE_EVENT = "agentbox-font-change";

export const FONTS = [
  { id: "inter", label: "Inter" },
  { id: "atkinson", label: "Atkinson" },
  { id: "systeem", label: "Systeem" },
  { id: "geist", label: "Geist" },
] as const;
export type FontId = (typeof FONTS)[number]["id"];
export const DEFAULT_FONT: FontId = "inter";

export function getFont(): FontId {
  try {
    const v = window.localStorage.getItem(FONT_STORAGE_KEY);
    if (FONTS.some((f) => f.id === v)) return v as FontId;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_FONT;
}

export function applyFont(font: FontId = getFont()): void {
  document.documentElement.dataset.font = font;
}

export function setFont(font: FontId): void {
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, font);
  } catch {
    /* storage blocked: still apply for this page */
  }
  applyFont(font);
  window.dispatchEvent(new Event(FONT_CHANGE_EVENT));
}

export function nextFont(font: FontId): FontId {
  const i = FONTS.findIndex((f) => f.id === font);
  return FONTS[(i + 1) % FONTS.length].id;
}

export function fontLabel(font: FontId): string {
  return FONTS.find((f) => f.id === font)?.label ?? font;
}
