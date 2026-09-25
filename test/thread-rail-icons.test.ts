import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const RAIL_ITEM = APP.slice(
  APP.indexOf("const RailItem = memo(function RailItem({"),
  APP.indexOf("\n/**\n * The bot roster's row", APP.indexOf("const RailItem = memo(function RailItem({")),
);

describe("thread rail identity marks", () => {
  test("hides Claude account numbers from both rail agent placements", () => {
    expect(RAIL_ITEM.match(/showAccountNumber=\{false\}/g)).toHaveLength(2);
  });

  test("marks working with a static dot, never a spinner", () => {
    const faviconBranch = RAIL_ITEM.slice(
      RAIL_ITEM.indexOf(") : showFavicon ? ("),
      RAIL_ITEM.indexOf(") : (", RAIL_ITEM.indexOf(") : showFavicon ? (") + 1),
    );
    expect(faviconBranch).toContain("src={faviconSrc}");
    // A spinner stood still in Firefox and under reduced motion.
    expect(RAIL_ITEM).not.toContain("animate-spin");
    expect(RAIL_ITEM).toContain("busy={busy && !drivingBot}");
    expect(RAIL_ITEM).toContain("font-semibold text-primary");
  });

  test("keeps the agent badge still when the favicon owns progress", () => {
    const badge = RAIL_ITEM.slice(RAIL_ITEM.indexOf("!drivingBot && showFavicon"));
    expect(badge).toContain("busy={false}");
    expect(badge).toContain("compact");
  });
});
