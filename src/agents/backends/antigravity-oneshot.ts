// One-shot Antigravity run for the auto/report runner (19-11-2026).
//
// Same `agy acp` runtime as a live session, so an auto agent gets the omg,
// executor and computer MCP servers per run (agy's global config leaves those
// out on purpose). No transcript: the sink only collects text and logs tools.
//
// agy moves a shell command that runs longer than ~10 s to the background and
// ends the turn with "I'll wait for it". The command's tool call stays open,
// and when it finishes agy continues on its own (measured 19-11: toolEnd at
// 42 s, continuation text after it, turn end at 32 s). So the run waits until
// no tool is open and the stream has been quiet, and only then takes the
// answer: the continuation text if there is one, else the last segment.
import { randomUUID } from "node:crypto";
import { defaultModelForAgent } from "../../agent-catalog.ts";
import { createAntigravityRuntime } from "./antigravity-acp-session.ts";
import type { ManagedSdkEventSink } from "./managed-sdk-session.ts";

export type OneShotSink = ManagedSdkEventSink & {
  segments: string[];
  openTools: Set<string>;
  lastActivity: number;
};

export function antigravityOneShotSink(log: (s: string) => void, now: () => number = Date.now): OneShotSink {
  const sink: OneShotSink = {
    segments: [],
    openTools: new Set(),
    lastActivity: now(),
    draft() {
      sink.lastActivity = now();
    },
    thinking() {
      sink.lastActivity = now();
    },
    commitText(text) {
      sink.lastActivity = now();
      if (text.trim()) sink.segments.push(text.trim());
    },
    commitThinking() {
      sink.lastActivity = now();
    },
    toolStart(id, name) {
      sink.lastActivity = now();
      sink.openTools.add(id);
      log(`[antigravity] tool ${name}`);
    },
    toolEnd(id, name, _output, error) {
      sink.lastActivity = now();
      sink.openTools.delete(id);
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
  return sink;
}

/** True while agy may still continue: a tool is open, or the stream spoke recently. */
export function antigravityStillWorking(sink: OneShotSink, now: number, quietMs: number): boolean {
  return sink.openTools.size > 0 || now - sink.lastActivity < quietMs;
}

export async function pipeToAntigravityAcp(
  prompt: string,
  log: (s: string) => void,
  opts: { cwd?: string; model?: string; thinkingLevel?: string; quietMs?: number; maxWaitMs?: number } = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const model = opts.model ?? defaultModelForAgent("antigravity");
  const quietMs = opts.quietMs ?? 20_000;
  const maxWaitMs = opts.maxWaitMs ?? 45 * 60_000;
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
    const turnText = (result.text ?? "").trim();
    const segmentsAtTurnEnd = sink.segments.length;
    sink.lastActivity = Date.now();
    const deadline = Date.now() + maxWaitMs;
    let waited = false;
    while (antigravityStillWorking(sink, Date.now(), quietMs) && Date.now() < deadline) {
      if (!waited && sink.openTools.size > 0) log(`[runner] antigravity: ${sink.openTools.size} tool(s) still running, waiting`);
      waited ||= sink.openTools.size > 0;
      await Bun.sleep(1000);
    }
    if (sink.openTools.size > 0) log(`[runner] antigravity: gave up waiting after ${Math.round(maxWaitMs / 60000)} min`);
    const continuation = (runtime.takeDraft?.().text ?? "").trim();
    const laterSegment = sink.segments.length > segmentsAtTurnEnd ? sink.segments.at(-1)! : "";
    const text = continuation || laterSegment || turnText || sink.segments.at(-1) || "";
    // Silent by default, like the Claude report backend: nothing to say is no finding.
    if (!text) {
      log("[runner] antigravity produced no output — treating as silence");
      return "";
    }
    log(`[runner] antigravity done (${text.length} chars${continuation || laterSegment ? ", after continuation" : ""})`);
    return text;
  } finally {
    await runtime.close();
  }
}
