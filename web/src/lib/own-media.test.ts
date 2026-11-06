import { describe, expect, test } from "bun:test";
import {
  newOwnMediaRequestId,
  ownMediaCostKnown,
  ownMediaQuoteLabel,
  parseOwnMediaError,
} from "./own-media";
import type { OwnMediaModelInfo } from "./own-media";

describe("parseOwnMediaError", () => {
  test("quote_unavailable gets one fixed honest message", () => {
    const message = parseOwnMediaError({ error: "willekeurige providermelding", code: "quote_unavailable" });
    expect(message).toContain("nog geen prijs en plafond ingesteld");
    expect(message).toContain("er wordt niets uitgegeven");
  });

  test("other provider messages pass through, missing bodies get a fallback", () => {
    expect(parseOwnMediaError({ error: "Model 'x' staat niet in de catalogus." })).toContain("catalogus");
    expect(parseOwnMediaError(null, "Eigen media lukte niet.")).toBe("Eigen media lukte niet.");
  });
});

describe("cost labels", () => {
  test("credits and usd read differently, and always as an estimate", () => {
    expect(ownMediaQuoteLabel({ amount: 6, unit: "credits" })).toBe("geschat 6 credits per generatie");
    expect(ownMediaQuoteLabel({ amount: 0.04, unit: "usd" })).toBe("geschat US$ 0.04 per generatie");
  });

  test("cost is only known with both a quote and a cap", () => {
    const neither: OwnMediaModelInfo = { id: "m", label: "m", kind: "image" };
    const quoted: OwnMediaModelInfo = { id: "m", label: "m", kind: "image", quote: { amount: 6, unit: "credits" }, maxCredits: 10 };
    const withoutCap: OwnMediaModelInfo = { id: "m", label: "m", kind: "image", quote: { amount: 6, unit: "credits" } };
    expect(ownMediaCostKnown(neither)).toBe(false);
    expect(ownMediaCostKnown(withoutCap)).toBe(false);
    expect(ownMediaCostKnown(quoted)).toBe(true);
    expect(ownMediaCostKnown(null)).toBe(false);
  });
});

describe("request ids", () => {
  test("fresh per call, server-shaped", () => {
    const a = newOwnMediaRequestId();
    const b = newOwnMediaRequestId();
    expect(a).toMatch(/^om-/);
    expect(b).toMatch(/^om-/);
    expect(a).not.toBe(b);
  });
});
