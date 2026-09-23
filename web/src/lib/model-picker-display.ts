import { omgModelLabel, parseOmgModel } from "../../../packages/protocol/src/omg-model-display";

/** Display only: the original router id always remains the selected value. */
export function pickerModelDisplay(id: string): { label: string; provider?: string } {
  const hosted = parseOmgModel(id);
  if (hosted) return { label: hosted.label, provider: hosted.providerLabel };
  const slash = id.indexOf("/");
  const route = slash < 0 ? "" : id.slice(0, slash);
  const name = slash < 0 ? id : id.slice(slash + 1);
  const providers: Record<string, string> = {
    "zai-coding-plan": "Z.ai", zai: "Z.ai", "z-ai": "Z.ai",
    openai: "OpenAI", anthropic: "Anthropic", google: "Google",
    opencode: "OpenCode", openrouter: "OpenRouter",
  };
  let label = omgModelLabel(name) || name;
  if (/^glm-/i.test(name)) label = name.replace(/^glm-/i, "GLM ").replace(/-([a-z])/g, (_, c: string) => ` ${c.toUpperCase()}`);
  else if (/^gpt-/i.test(name)) label = name.replace(/^gpt-/i, "GPT-").replace(/-([a-z])/g, (_, c: string) => ` ${c.toUpperCase()}`);
  return { label, provider: route ? providers[route] ?? route : undefined };
}

export function pickerThinkingLabel(label: string): string {
  return ({ Low: "Laag", Medium: "Normaal", High: "Hoog", Xhigh: "Extra hoog", Max: "Max", Minimal: "Minimaal", None: "Uit" } as Record<string, string>)[label] ?? label;
}
