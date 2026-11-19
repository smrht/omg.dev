/**
 * Compact MCP tool listings for clients that hide large tools.
 *
 * Antigravity (`agy`) loads an MCP tool eagerly only while the tool stays small
 * (measured 19-11-2026 on the serialized tool: 1160 chars eager, 1135 lazy for
 * a tool with an enum, so the real limit is not chars; the budget keeps margin).
 * A lazy tool from a server supplied over ACP `session/new` is "not enabled"
 * for the agent, so omg_create_subagent, the delegate tools and generate_image
 * were unreachable from an Antigravity session. This shortens a listing in
 * steps until each tool fits: drop `$schema`, then cut the tool description to
 * its first sentences, then shorten and finally drop parameter descriptions.
 * Names, types, enums and `required` are never touched, so calls stay valid.
 */
export const LAZY_TOOL_BUDGET = 850;

type JsonObject = Record<string, unknown>;
type Tool = { name?: string; description?: string; inputSchema?: unknown };

function size(tool: Tool): number {
  return JSON.stringify(tool).length;
}

function firstSentences(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function mapDescriptions(node: unknown, fn: (text: string) => string | undefined): unknown {
  if (Array.isArray(node)) return node.map((item) => mapDescriptions(item, fn));
  if (!node || typeof node !== "object") return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (key === "description" && typeof value === "string") {
      const next = fn(value);
      if (next !== undefined) out[key] = next;
    } else if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as JsonObject).map(([prop, schema]) => [prop, mapDescriptions(schema, fn)]),
      );
    } else {
      out[key] = mapDescriptions(value, fn);
    }
  }
  return out;
}

export function compactTool<T extends Tool>(tool: T, budget = LAZY_TOOL_BUDGET): T {
  if (size(tool) <= budget) return tool;
  let next: T = { ...tool };
  if (next.inputSchema && typeof next.inputSchema === "object") {
    const { $schema: _drop, ...schema } = next.inputSchema as JsonObject;
    next.inputSchema = schema;
  }
  const steps: Array<(t: T) => T> = [
    (t) => ({ ...t, description: firstSentences(t.description ?? "", 400) }),
    (t) => ({ ...t, inputSchema: mapDescriptions(t.inputSchema, (d) => firstSentences(d, 120)) }),
    (t) => ({ ...t, description: firstSentences(t.description ?? "", 220) }),
    (t) => ({ ...t, inputSchema: mapDescriptions(t.inputSchema, (d) => firstSentences(d, 50)) }),
    (t) => ({ ...t, inputSchema: mapDescriptions(t.inputSchema, () => undefined) }),
    (t) => ({ ...t, description: firstSentences(t.description ?? "", 120) }),
  ];
  for (const step of steps) {
    if (size(next) <= budget) break;
    next = step(next);
  }
  return next;
}

/** Rewrite a JSON-RPC body (single or batch) so every listed tool fits. */
export function compactToolsListBody(body: string, keep: (name: string) => boolean = () => false): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  let changed = false;
  const fix = (message: unknown): unknown => {
    const result = (message as { result?: { tools?: Tool[] } } | null)?.result;
    if (!result || !Array.isArray(result.tools)) return message;
    changed = true;
    return {
      ...(message as JsonObject),
      result: { ...result, tools: result.tools.map((tool) => (keep(tool.name ?? "") ? tool : compactTool(tool))) },
    };
  };
  const out = Array.isArray(parsed) ? parsed.map(fix) : fix(parsed);
  return changed ? JSON.stringify(out) : body;
}
