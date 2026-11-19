import { humanizeOmgModelName, omgModelLabel, parseOmgModel } from "../../../packages/protocol/src/omg-model-display";

const PROVIDERS: Record<string, string> = {
  "zai-coding-plan": "Z.ai",
  zaiplan: "Z.ai",
  zai: "Z.ai",
  "z-ai": "Z.ai",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
};

const EXTRA_TOKEN_CASE: Record<string, string> = {
  oss: "OSS",
  swe: "SWE",
  vl: "VL",
  gpt: "GPT",
  glm: "GLM",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  xai: "xAI",
  llama: "Llama",
  hy4: "HY4",
};

function formatModelToken(token: string): string {
  const lower = token.toLowerCase();
  if (EXTRA_TOKEN_CASE[lower]) return EXTRA_TOKEN_CASE[lower];
  // Sizes like 120b, 40b, 70b -> 120B, 40B
  if (/^\d+b$/.test(lower)) return lower.toUpperCase();
  // Version marks like v4, v2.6, k3, k3.1, m3
  if (/^[a-z]\d+(\.\d+)*$/.test(lower)) return lower.toUpperCase();
  if (/^\d/.test(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function humanizeSlug(slug: string): string {
  const tokens = slug.split("-").filter(Boolean);
  let out = "";
  tokens.forEach((token, index) => {
    const cased = formatModelToken(token);
    if (index === 0) {
      out = cased;
      return;
    }
    const prev = tokens[index - 1]!.toLowerCase();
    const glue =
      (prev === "gpt" && (/^\d/.test(token) || token.toLowerCase() === "oss")) ||
      (prev === "swe" && /^\d/.test(token))
        ? "-"
        : " ";
    out += glue + cased;
  });
  return out || slug;
}

function formatFusionLabel(raw: string): string {
  const body = raw.slice("fusion:".length);
  const parts = body.split("+").map((part) => {
    const cleaned = part.replace(/-(?:med|high|max|low)$/i, "");
    const tokens = cleaned.split("-").filter(Boolean);
    // Merge version pairs like ["astra", "6", "2"] -> "Astra 6.2", ["sonnet", "5", "5"] -> "Sonnet 5.5"
    const merged: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const cur = tokens[i]!;
      const next = tokens[i + 1];
      if (/^\d+$/.test(cur) && next && /^\d+$/.test(next)) {
        merged.push(`${cur}.${next}`);
        i++;
      } else {
        merged.push(formatModelToken(cur));
      }
    }
    return merged.join(" ");
  });
  return parts.join(" + ");
}

/** Display only: the original router id always remains the selected value. */
export function pickerModelDisplay(id: string): { label: string; provider?: string } {
  const hosted = parseOmgModel(id);
  if (hosted) return { label: hosted.label, provider: hosted.providerLabel };

  if (id.startsWith("fusion:")) {
    return { label: formatFusionLabel(id), provider: "Fusion" };
  }

  const slash = id.indexOf("/");
  const route = slash < 0 ? "" : id.slice(0, slash);
  const name = slash < 0 ? id : id.slice(slash + 1);
  let provider = route ? PROVIDERS[route] ?? route : undefined;

  let cleanName = name;
  if (route === "opencode" && /-free$/i.test(cleanName)) {
    cleanName = cleanName.replace(/-free$/i, "");
    provider = "Gratis";
  }

  const base = omgModelLabel(cleanName) || cleanName;
  let label = base;
  if (base !== cleanName) {
    label = base;
  } else if (/^gemini-pro-orchestrator-(.+)$/i.test(cleanName)) {
    const variant = cleanName.replace(/^gemini-pro-orchestrator-/i, "");
    label = `Gemini Pro Orchestrator · ${humanizeSlug(variant)}`;
  } else if (/^gemini-pro-orchestrator$/i.test(cleanName)) {
    label = "Gemini Pro Orchestrator";
  } else if (/^(?:gemini|grok|deepseek|muse|glm|gpt|kimi|nemotron|swe|composer|beam|flint|hy4|iceman|longcat|mimo|tidepool)-/i.test(cleanName)) {
    label = humanizeSlug(cleanName);
  } else if (cleanName === "auto" || cleanName === "adaptive") {
    label = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
  } else if (route === "opencode" && cleanName !== name) {
    label = humanizeOmgModelName(cleanName);
  }

  return { label, provider };
}

const AGENT_DISPLAY_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  opencode: "OpenCode",
  fx: "fx",
  muse: "Muse",
  deepseek: "DeepSeek",
  devin: "Devin",
  antigravity: "Antigravity",
  "omg agent": "OMG",
  jcode: "JCode",
  zcode: "ZCode",
  pi: "Pi",
  copilot: "Copilot",
};

export function pickerAgentLabel(label: string, hasMultipleClaudeAccounts = false): string {
  const trimmed = label.trim();
  if (!hasMultipleClaudeAccounts && trimmed === "Claude · Auto") return "Claude";
  return AGENT_DISPLAY_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

export function pickerThinkingLabel(label: string): string {
  return ({ Low: "Laag", Medium: "Normaal", High: "Hoog", Xhigh: "Extra hoog", Max: "Max", Minimal: "Minimaal", None: "Uit" } as Record<string, string>)[label] ?? label;
}
