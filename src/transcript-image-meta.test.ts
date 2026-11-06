import { describe, expect, test } from "bun:test";
import { buildChatRenderItems, isImageReadMeta } from "./transcript-rows.ts";

describe("image read meta lines", () => {
  test("drops Claude's [Image: original ...] line and keeps the work run whole", () => {
    const rows = buildChatRenderItems([
      { id: "1", role: "user", kind: "text", text: "hoi" },
      { id: "2", role: "assistant", kind: "tool_use", text: "Read: shot.png" },
      { id: "3", role: "user", kind: "text", text: "[Image: original 1280x2170, displayed at 1180x2000. Multiply coordinates by 1.08 to map to original image.]" },
      { id: "4", role: "assistant", kind: "tool_use", text: "Bash: ls" },
    ]);
    expect(rows.map((row) => row.type)).toEqual(["msg", "tools"]);
  });

  test("keeps a real message that happens to start with [Image", () => {
    expect(isImageReadMeta({ role: "user", kind: "text", text: "[Image hier] kijk even" })).toBe(false);
    expect(isImageReadMeta({ role: "assistant", kind: "text", text: "[Image: original 1x1, displayed at 1x1." })).toBe(false);
  });
});
