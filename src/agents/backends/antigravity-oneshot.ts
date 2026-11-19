// One-shot Antigravity run for the auto/report runner (19-11-2026).
//
// Same `agy acp` runtime as a live session, so an auto agent gets the omg,
// executor and computer MCP servers per run (agy's global config leaves those
// out on purpose). No transcript: the sink only collects text and logs tools.
// Returns the final assistant segment, the part after the last tool call, so
// narration between tools never reaches parseFinding.
import { randomUUID } from "node:crypto";
import { defaultModelForAgent } from "../../agent-catalog.ts";
import { createAntigravityRuntime } from "./antigravity-acp-session.ts";
import type { ManagedSdkEventSink } from "./managed-sdk-session.ts";

export function antigravityOneShotSink(log: (s: string) => void): ManagedSdkEventSink & { segments: string[] } {
  const segments: string[] = [];
  return {
    segments,
    draft() {},
    thinking() {},
    commitText(text) {
      if (text.trim()) segments.push(text.trim());
    },
    commitThinking() {},
    toolStart(_id, name) {
      log(`[antigravity] tool ${name}`);
    },
    toolEnd(_id, name, _output, error) {
      if (error) log(`[antigravity] tool ${name} failed`);
    },
    // Headless: nobody can answer. agy runs with skip-permissions, so this
    // only fires for a question the agent itself asks; cancel it.
    async ask(question) {
      log(`[antigravity] question cancelled (headless): ${question.slice(0, 120)}`);
      return null;
    },
    notice(text) {
      log(`[antigravity] ${text}`);
    },
  };
}

export async function pipeToAntigravityAcp(
  prompt: string,
  log: (s: string) => void,
  opts: { cwd?: string; model?: string; thinkingLevel?: string } = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const model = opts.model ?? defaultModelForAgent("antigravity");
  const sink = antigravityOneShotSink(log);
  log(`[runner] piping ${prompt.length} chars to agy acp (${model}${opts.thinkingLevel ? `, ${opts.thinkingLevel}` : ""})`);
  const runtime = await createAntigravityRuntime(
    {
      key: `auto-${randomUUID()}`,
      cwd,
      model,
      thinkingLevel: opts.thinkingLevel,
      quiet: false,
      recordLevels: async () => undefined,
    },
    sink,
  );
  try {
    const result = await runtime.runTurn(prompt, sink);
    const text = (result.text ?? "").trim() || sink.segments.at(-1) || "";
    // Silent by default, like the Claude report backend: nothing to say is no finding.
    if (!text) {
      log("[runner] antigravity produced no output — treating as silence");
      return "";
    }
    log(`[runner] antigravity done (${text.length} chars)`);
    return text;
  } finally {
    await runtime.close();
  }
}
