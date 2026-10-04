// Fixture: fake `ssh` + fake Mac supervisor + fake native provider.
//
// Used by the mac-chat stream/harness tests as a REAL subprocess standing in
// for `ssh <target> <verb>` — Bun.spawn resolves it through PATH, so a test
// prepends its directory. Implements exactly the four frozen verbs:
//
//   stream: read ONE metadata line, write ONE ready handshake, then bridge
//           stdin/stdout to a native provider loop:
//             - claude: JSON-lines; control_request → control_response;
//               user turns → system init + assistant echo + result
//             - codex: app-server JSON-RPC (initialize/thread(resume)/
//               turn/start) emitting item + turn/completed notifications
//           Everything received on stdin AFTER the metadata line is recorded
//           to <out>/provider-stdin.jsonl (per turn, with context checks in
//           the test) so nonce/preamble/resume assertions read real bytes.
//           Handshake rejections: argv containing REJECT_ME.
//   probe / status <uuid> / cancel <uuid>: one JSON line answers.
//
// Env: FIXTURE_OUT=<dir> (required for stream), FIXTURE_PROVIDER_THREAD=<id>.
import { openSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
// argv: [-T, -o, BatchMode=yes, -o, StrictHostKeyChecking=yes, -o, ClearAllForwardings=yes, <target>, <verb>, ...]
const verbIndex = argv.findIndex((a) => a === "probe" || a === "stream" || a === "status" || a === "cancel");
const verb = verbIndex >= 0 ? argv[verbIndex] : null;
const verbArg = verbIndex >= 0 && argv.length > verbIndex + 1 ? argv[verbIndex + 1] : null;
const outDir = process.env.FIXTURE_OUT;
const threadId = process.env.FIXTURE_PROVIDER_THREAD ?? "thread-fixture-1";
// Regression knobs (opt-in, default behavior unchanged):
// - FIXTURE_HOLD_TURN: answer turn/start but keep the turn open (no item/
//   turn/completed) until a turn/interrupt arrives — a real mid-turn abort
//   window for the interrupt→resume regression. On turn/interrupt the RPC
//   result is answered and turn/completed status "interrupted" is emitted.
// - FIXTURE_RESUME_PAD_BYTES: pad the thread/resume result's history with N
//   filler bytes, reproducing the live ~1.07 MB resume line (codex-interrupt-2).
const holdTurn = !!process.env.FIXTURE_HOLD_TURN;
const resumePadBytes = Number(process.env.FIXTURE_RESUME_PAD_BYTES) || 0;

function log(line: unknown): void {
  if (!outDir) return;
  mkdirSync(outDir, { recursive: true });
  appendFileSync(join(outDir, "ssh-invocations.jsonl"), `${JSON.stringify({ argv })}\n`);
}

function writeHandshake(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function readStdinLine(): Promise<{ line: string; rest: string }> {
  const chunks: Buffer[] = [];
  let buffered = Buffer.alloc(0);
  for (;;) {
    // Read raw bytes; stop at the first newline.
    const chunk = await new Promise<Buffer>((resolve) => {
      process.stdin.once("data", (d: Buffer) => resolve(d));
      process.stdin.once("end", () => resolve(Buffer.alloc(0)));
      process.stdin.once("error", () => resolve(Buffer.alloc(0)));
    });
    if (!chunk.length) break;
    buffered = Buffer.concat([buffered, chunk]);
    const nl = buffered.indexOf(0x0a);
    if (nl >= 0) {
      // MUST pause further reads: put the remainder back for the pump below.
      chunks.length = 0;
      return {
        line: buffered.subarray(0, nl).toString("utf8"),
        rest: buffered.subarray(nl + 1).toString("utf8"),
      };
    }
  }
  return { line: buffered.toString("utf8"), rest: "" };
}

async function main(): Promise<number> {
  log({ argv });
  if (!verb) {
    process.stderr.write("fixture ssh: no verb\n");
    return 2;
  }
  if (verb === "probe") {
    process.stdout.write(`${JSON.stringify({ transport: 1, ok: true })}\n`);
    return 0;
  }
  if (verb === "status" || verb === "cancel") {
    process.stdout.write(`${JSON.stringify({ requestId: verbArg, state: "completed" })}\n`);
    return 0;
  }
  // stream
  const { line, rest } = await readStdinLine();
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(line) as Record<string, unknown>;
  } catch {
    writeHandshake({ transport: 1, requestId: null, status: "rejected", reason: "meta-json" });
    return 7;
  }
  const joined = JSON.stringify(meta.args ?? []);
  if (joined.includes("REJECT_ME")) {
    writeHandshake({ transport: 1, requestId: meta.requestId ?? null, status: "rejected", reason: "fixture rejection" });
    return 7;
  }
  if (outDir) {
    appendFileSync(join(outDir, "metadata.jsonl"), `${JSON.stringify(meta)}\n`);
  }
  const provider = meta.provider === "codex" ? "codex" : "claude";
  writeHandshake({
    transport: 1,
    requestId: meta.requestId ?? null,
    status: "ready",
    pid: process.pid,
    cwd: "/private/tmp/fixture-scratch",
    sessionId: meta.sessionId ?? null,
  });
  if (outDir && rest) {
    appendFileSync(join(outDir, "provider-stdin.jsonl"), rest.endsWith("\n") ? rest : `${rest}\n`);
  }
  // Native provider loop: line-based on top of the raw stream.
  let buffer = rest;
  let claudeSawInit = false;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) {
      const chunk = await new Promise<string>((resolve) => {
        process.stdin.once("data", (d: Buffer) => resolve(d.toString("utf8")));
        process.stdin.once("end", () => resolve(""));
        process.stdin.once("error", () => resolve(""));
      });
      if (!chunk) break;
      buffer += chunk;
      continue;
    }
    const lineStr = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!lineStr.trim()) continue;
    if (outDir) {
      appendFileSync(join(outDir, "provider-stdin.jsonl"), `${lineStr}\n`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lineStr) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (provider === "claude") {
      if (parsed.type === "control_request") {
        process.stdout.write(`${JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: parsed.request_id ?? null },
        })}\n`);
        continue;
      }
      if (parsed.type === "user") {
        if (!claudeSawInit) {
          claudeSawInit = true;
          process.stdout.write(`${JSON.stringify({
            type: "system", subtype: "init", session_id: meta.sessionId ?? "fx",
          })}\n`);
        }
        const message = parsed.message as { content?: unknown } | undefined;
        const text = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
        process.stdout.write(`${JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: `fixture-claude:${text.slice(0, 80)}` }] },
        })}\n`);
        process.stdout.write(`${JSON.stringify({
          type: "result", subtype: "success", result: "fixture", usage: { input_tokens: 1, output_tokens: 1 },
        })}\n`);
        continue;
      }
    } else {
      // codex app-server JSON-RPC
      const method = parsed.method as string | undefined;
      const id = parsed.id as number | string | null | undefined;
      if (method === "initialize") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { capabilities: { experimentalApi: true } } })}\n`);
        continue;
      }
      if (method === "thread/resume" || method === "thread/start") {
        const pad = method === "thread/resume" && resumePadBytes > 0 ? "x".repeat(resumePadBytes) : undefined;
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0", id, result: { thread: { id: threadId }, ...(pad ? { history: pad } : {}) },
        })}\n`);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { threadId } })}\n`);
        continue;
      }
      if (method === "turn/interrupt") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
        if (holdTurn) {
          process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0", method: "turn/completed",
            params: { threadId, turn: { id: "turn-1", status: "interrupted" } },
          })}\n`);
        }
        continue;
      }
      if (method === "turn/start") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { turn: { id: "turn-1", status: "inProgress" } } })}\n`);
        if (holdTurn) continue; // turn stays open until interrupted
        const params = parsed.params as { input?: Array<{ type?: string; text?: string }> } | undefined;
        const text = (params?.input ?? []).map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join("|").slice(0, 80);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/started", params: { threadId, item: { type: "agentMessage", id: "i1" } } })}\n`);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId, item: { type: "agentMessage", id: "i1", text: `fixture-codex:${text}` } } })}\n`);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } })}\n`);
        continue;
      }
      if (method === "thread/metadata/update") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
        continue;
      }
      if (method && id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
        continue;
      }
    }
  }
  return 0;
}

// Drain any final stdin without hanging when the parent half-closes.
process.stdin.on("end", () => {
  /* loop exits on empty chunk */
});
void openSync("/dev/null", "r"); // keep fds warm on platforms that need it
void readFileSync;
process.exit(await main());
