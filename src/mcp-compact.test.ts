import { describe, expect, test } from "bun:test";
import { compactTool, compactToolsListBody, LAZY_TOOL_BUDGET } from "./mcp-compact.ts";

const big = {
  name: "omg_create_subagent",
  description: "Create a managed runtime child session. ".repeat(20),
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      agent: { type: "string", description: "Runtime harness: claude, codex or antigravity. ".repeat(6) },
      mode: { type: "string", enum: ["queue", "steer"], description: "How to deliver. ".repeat(10) },
      prompt: { type: "string", minLength: 1, description: "The task. ".repeat(10) },
    },
    required: ["prompt"],
  },
};

describe("compact MCP tool listings", () => {
  test("a large tool fits the budget and keeps names, types, enums and required", () => {
    const out = compactTool(big);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LAZY_TOOL_BUDGET);
    const schema = out.inputSchema as any;
    expect(schema.$schema).toBeUndefined();
    expect(Object.keys(schema.properties)).toEqual(["agent", "mode", "prompt"]);
    expect(schema.properties.mode.enum).toEqual(["queue", "steer"]);
    expect(schema.properties.prompt.minLength).toBe(1);
    expect(schema.required).toEqual(["prompt"]);
  });

  test("a small tool is returned untouched", () => {
    const small = { name: "x", description: "Small.", inputSchema: { type: "object", properties: {} } };
    expect(compactTool(small)).toBe(small);
  });

  test("rewrites tools/list results, single and batched, and leaves kept tools alone", () => {
    const single = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [big, { ...big, name: "omg_ship" }] } });
    const tools = JSON.parse(compactToolsListBody(single, (n) => n === "omg_ship")).result.tools;
    expect(JSON.stringify(tools[0]).length).toBeLessThanOrEqual(LAZY_TOOL_BUDGET);
    expect(tools[1]).toEqual({ ...big, name: "omg_ship" });
    const batch = JSON.stringify([{ jsonrpc: "2.0", id: 2, result: { tools: [big] } }, { jsonrpc: "2.0", id: 3, result: {} }]);
    const parsed = JSON.parse(compactToolsListBody(batch));
    expect(JSON.stringify(parsed[0].result.tools[0]).length).toBeLessThanOrEqual(LAZY_TOOL_BUDGET);
    expect(parsed[1]).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  test("other bodies pass through byte for byte", () => {
    const call = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "ok" }] } });
    expect(compactToolsListBody(call)).toBe(call);
    expect(compactToolsListBody("not json")).toBe("not json");
  });
});
