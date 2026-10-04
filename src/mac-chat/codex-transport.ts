// Remote Codex app-server transport for Mac-hosted sessions.
//
// ALL remote codex turns — standard included — run through the existing
// CodexAppServerThread with this transport injected (task: preserve exact
// Daybreak/fast/tier/reasoning/resume; don't reinvent protocol). The
// transport is line-delimited JSON-RPC over the ssh stream: ONE metadata
// line (agreed wire contract), then verbatim native bytes both ways. One
// transport instance = one app-server child on the Mac = one turn (the
// existing per-turn adapter lifecycle closes us after each turn, which also
// reaps the remote child).
//
// Config overrides are whitelisted to the Mac schema (model, reasoning
// effort/summary, verbosity). service_tier/features (Fast) is REFUSED
// explicitly here — the Mac schema refuses those keys, and a silent tier
// drop is a contract violation. argv[0] never comes from us: the supervisor
// runs its own installed codex at a fixed path.
import type { CodexAppServerTransport } from "../codex-daybreak.ts";
import { openMacStream, type MacStreamDeps } from "./stream.ts";
import { adaptCodexConfigArgv } from "./argv-adapter.ts";
import {
  MAC_STREAM_TRANSPORT,
  type MacStreamContext,
  type MacStreamHandshake,
  type MacStreamMetadata,
  type MacStreamMcpServer,
  type MacStreamSettings,
} from "./wire.ts";
import { extractAttachments, readAsBase64 } from "../attachment-images.ts";
import type { Input } from "@openai/codex-sdk";

export type CodexStreamLaunch = {
  sessionId: string;
  target: string;
  /** FULL central context, re-read by the caller per turn. */
  context: MacStreamContext;
  /** Bridge MCP entries: name → {url, bearerToken} (frozen wire shape). */
  mcpServers: Record<string, MacStreamMcpServer>;
  /** Exact central settings selection (frozen wire shape). */
  settings: MacStreamSettings;
  /** Trusted config overrides — whitelist-checked against the Mac schema. */
  codexConfig?: Record<string, unknown> | null;
  nextRequestId?: () => string;
  onHandshake?: (handshake: MacStreamHandshake) => void;
};

export type RemoteCodexTransportOptions = CodexStreamLaunch & {
  deps: MacStreamDeps;
};

/**
 * Native argv (excluding executable) for a remote app-server turn. Throws on
 * non-whitelisted config keys (explicit refusal, never a silent drop).
 */
export function remoteCodexAppServerArgs(codexConfig?: Record<string, unknown> | null): string[] {
  const adapted = adaptCodexConfigArgv(codexConfig);
  if (!adapted.ok) throw new Error(adapted.error);
  return adapted.extraction.argv;
}

/**
 * Build the CodexAppServerTransport for one remote turn. Construction does
 * not spawn; the first write opens the stream (spawn is non-blocking). A
 * refused handshake fails the first write and closes the transport — the
 * adapter's initialize request then times out or errors visibly, and the
 * per-turn finally closes us (the supervisor also cancels on disconnect).
 */
export function createRemoteCodexTransport(options: RemoteCodexTransportOptions): CodexAppServerTransport {
  const lineListeners: Array<(chunk: string) => void> = [];
  const closeListeners: Array<() => void> = [];
  let opened = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let openError: string | null = null;
  let stream: {
    stdin: { write(data: Uint8Array | string): void; end(): void };
    stdout: ReadableStream<Uint8Array>;
    kill(sig?: NodeJS.Signals): void;
    exited: Promise<number>;
  } | null = null;
  /** Pending writes issued before the handshake resolved; flushed in order. */
  const writeQueue: string[] = [];

  async function open(): Promise<boolean> {
    if (closed) return false;
    if (stream) return true;
    if (openError) return false;
    if (opened) return false;
    opened = true;
    const adapted = adaptCodexConfigArgv(options.codexConfig ?? null);
    if (!adapted.ok) {
      openError = adapted.error;
      options.onHandshake?.({
        transport: MAC_STREAM_TRANSPORT,
        requestId: null,
        status: "rejected",
        reason: "argv-adaptation",
        detail: adapted.error,
      });
      for (const listener of [...closeListeners]) listener();
      return false;
    }
    const metadata: MacStreamMetadata = {
      transport: MAC_STREAM_TRANSPORT,
      requestId: options.nextRequestId ? options.nextRequestId() : crypto.randomUUID(),
      sessionId: options.sessionId,
      provider: "codex",
      args: adapted.extraction.argv,
      context: options.context,
      mcp: { servers: options.mcpServers },
      settings: options.settings,
      ...(options.settings.model ? { model: options.settings.model } : {}),
    };
    const handle = openMacStream(options.deps, {
      target: options.target,
      metadata,
      onHandshake: (handshake) => options.onHandshake?.(handshake),
    });
    const ready = await handle.whenReady;
    if (!ready.ok) {
      openError = ready.error;
      for (const listener of [...closeListeners]) listener();
      return false;
    }
    stream = {
      stdin: ready.stdin,
      stdout: ready.stdout,
      kill: (sig) => ready.kill(sig),
      exited: ready.exited,
    };
    // Pump raw remote stdout → line listeners (native JSON-RPC framing is
    // newline-delimited; the client owns bounds).
    void (async () => {
      const decoder = new TextDecoder();
      const reader = ready.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          const text = decoder.decode(value, { stream: true });
          for (const listener of [...lineListeners]) listener(text);
        }
      } catch {
        /* close below */
      }
      for (const listener of [...closeListeners]) listener();
    })();
    void ready.exited
      .then(() => {
        for (const listener of [...closeListeners]) listener();
      })
      .catch(() => {
        for (const listener of [...closeListeners]) listener();
      });
    // Flush writes that queued during the handshake, in order.
    for (const queued of writeQueue.splice(0)) {
      try {
        stream.stdin.write(`${queued}\n`);
      } catch {
        /* close listeners carry the news */
      }
    }
    return true;
  }

  return {
    write(line: string) {
      if (closed) return;
      if (stream) {
        try {
          stream.stdin.write(`${line}\n`);
        } catch {
          /* close listeners carry the news */
        }
        return;
      }
      if (writeQueue.length > 1024) return; // bounded pre-handshake queue
      writeQueue.push(line);
      void open();
    },
    onLine(listener: (chunk: string) => void) {
      lineListeners.push(listener);
    },
    onClose(listener: () => void) {
      closeListeners.push(listener);
    },
    close() {
      if (closed) return closePromise!;
      closed = true;
      closePromise = (async () => {
        // Deterministic teardown beyond closing our side: the supervisor
        // cancels the child on stream EOF, and close() ends stdin + kills
        // the local ssh. 30ms grace lets the final bytes flush.
        if (stream) {
          try {
            stream.stdin.end();
          } catch {}
          stream.kill("SIGTERM");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      })();
      return closePromise;
    },
  };
}

// ---------------------------------------------------------------------------
// Remote UserInput: local_image → base64 image parts + per-turn context
// ---------------------------------------------------------------------------

/**
 * Convert a central Input for a REMOTE turn: text parts stay text (optionally
 * wrapped with a fresh central-context preamble), image attachments
 * (extractAttachments reuses the existing central parsing) are inlined as
 * base64 image parts — a `localImage` path would point at the Agentbox
 * filesystem the remote codex cannot read.
 */
export function remoteCodexUserInput(input: Input, contextPreamble?: string | null): Array<Record<string, unknown>> {
  if (typeof input === "string") {
    return convertPrompt(input, contextPreamble);
  }
  const parts: Array<Record<string, unknown>> = [];
  let firstText = true;
  for (const part of input) {
    if (part.type === "text") {
      parts.push(...convertPrompt(part.text, firstText ? contextPreamble : null));
      firstText = false;
    } else if (part.type === "local_image") {
      const b64 = readAsBase64(part.path);
      if (b64) {
        parts.push({ type: "image", data: b64 });
      }
    } else {
      parts.push({ type: "text", text: JSON.stringify(part) });
    }
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
}

/** A prompt string may itself carry attachment markers — expand them too. */
function convertPrompt(prompt: string, contextPreamble?: string | null): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (contextPreamble) {
    parts.push({ type: "text", text: contextPreamble });
  }
  const extracted = extractAttachments(prompt);
  if (!extracted.attachments.length) {
    parts.push({ type: "text", text: prompt });
    return parts;
  }
  parts.push({ type: "text", text: extracted.cleanText || "(image attachment)" });
  for (const att of extracted.attachments) {
    const b64 = readAsBase64(att.path);
    if (b64) parts.push({ type: "image", data: b64 });
  }
  return parts;
}
