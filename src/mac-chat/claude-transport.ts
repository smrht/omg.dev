// Claude Agent SDK spawn seam for Mac-hosted sessions.
//
// `query({ ..., spawnClaudeCodeProcess })` hands us the NATIVE argv the SDK
// built (options.args — everything except the executable) and expects a
// SpawnedProcess back. We spawn `ssh <target> stream` instead: ONE metadata
// line (the agreed wire contract — native argv after client-side adaptation,
// lease MCP names, lease instructions reference, timeout), then the SDK's
// stdin bytes flow to the remote claude verbatim and the remote claude's
// stdout flows back verbatim after the handshake line.
//
// The local environment is NEVER forwarded (options.env ignored on purpose):
// the Mac runs its own signed-in provider. Flags that cannot ride argv
// (--settings, prompt text, local --mcp-config temp paths) are EXTRACTED by
// src/mac-chat/argv-adapter.ts and reported — never silently dropped.
import { Writable, PassThrough, Readable } from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { openMacStream, type MacStreamDeps, type MacStreamHandle } from "./stream.ts";
import { adaptClaudeArgv } from "./argv-adapter.ts";
import {
  MAC_STREAM_TRANSPORT,
  type MacStreamContext,
  type MacStreamHandshake,
  type MacStreamMetadata,
  type MacStreamMcpServer,
  type MacStreamSettings,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// Claude-reserved MCP server names (source- and live-verified 2026-10-04,
// claude 2.1.285 — the version pinned on the Mac route).
//
// The CLI derives reserved names from its BUILT-IN tool surface: 2.1.285 maps
// Bash -> mcp__workspace__bash and WebFetch -> mcp__workspace__web_fetch, so
// the server name "workspace" is reserved for internal use. A provisioned
// server with a reserved name is NOT LOADED — the only signal is a debug
// stderr WARN ("\"workspace\" is a reserved MCP server name and was not
// loaded"); the stream-json output stays healthy. Live proof (local 2.1.285,
// loopback MCP server, control protocol only, no model turn): with the name
// "workspace" the config entry is dropped and mcp_call answers "MCP server
// not connected: workspace" with ZERO dials; under the deterministic alias
// below the CLI performs the full handshake (initialize ->
// notifications/initialized -> tools/list) and mcp_call returns the tool
// result. That mismatch produced the mac-headchat live-run failure: init
// ready, two turns, context fresh — but "no workspace write_file tool" and
// zero bridge requests.
//
// The rename is CLIENT-SIDE ONLY (wire metadata key): the URL keeps naming
// the bridge namespace (/mcp/workspace?session=…), so the bridge, lease,
// journal and Mac-side manifests are unchanged. Codex has no such reserved
// list and keeps the literal names.
// ---------------------------------------------------------------------------
export const CLAUDE_RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  "workspace", // built-in mcp__workspace__bash / mcp__workspace__web_fetch surface
  "__proto__", // refused by the CLI's own config parse (prototype-pollution guard)
]);

/** Deterministic, collision-free alias for one reserved server name. */
export function claudeMcpServerAlias(name: string, occupied: ReadonlySet<string> = new Set()): string {
  let alias = `omg${name}`;
  for (let n = 2; occupied.has(alias); n++) alias = `omg${name}${n}`;
  return alias;
}

function isReservedClaudeMcpServerName(name: string): boolean {
  return CLAUDE_RESERVED_MCP_SERVER_NAMES.has(name) || CLAUDE_RESERVED_MCP_SERVER_NAMES.has(name.toLowerCase());
}

/**
 * Rename reserved names out of the lease MCP map for the Claude wire metadata.
 * Every entry SURVIVES (all central tools stay available) under a
 * deterministic alias; non-reserved names pass through verbatim.
 */
export function claudeLeaseMcpServers(
  servers: Record<string, MacStreamMcpServer>,
): { servers: Record<string, MacStreamMcpServer>; renames: Array<{ from: string; to: string }> } {
  const occupied = new Set(Object.keys(servers));
  const out: Record<string, MacStreamMcpServer> = {};
  const renames: Array<{ from: string; to: string }> = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!isReservedClaudeMcpServerName(name)) {
      out[name] = server;
      continue;
    }
    occupied.delete(name);
    const alias = claudeMcpServerAlias(name, occupied);
    occupied.add(alias);
    out[alias] = server;
    renames.push({ from: name, to: alias });
  }
  return { servers: out, renames };
}


export type ClaudeStreamLaunch = {
  /** Central OMG session/control key (UUID). */
  sessionId: string;
  /** Trusted ssh client-config alias from the admin pins. */
  target: string;
  /** FULL central context (re-read by the caller per launch). */
  context: MacStreamContext;
  /** Bridge MCP entries: name → {url, bearerToken} (frozen wire shape). */
  mcpServers: Record<string, MacStreamMcpServer>;
  /** Exact central settings selection (materialized natively by the Mac). */
  settings: MacStreamSettings;
  /** Remote scratch path (must equal the supervisor's provisioned path). */
  remoteCwd?: string;
  /** requestId source; the FIRST launch uses the journal-persisted id. */
  nextRequestId?: () => string;
  onArgvExtraction?: (notes: string[], extractedSettings: Record<string, unknown> | null) => void;
  onHandshake?: (handshake: MacStreamHandshake) => void;
};

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** Loosely-typed listener bookkeeping implementing the SDK's overloads. */
class SpawnListeners {
  private exit = new Set<ExitListener>();
  private error = new Set<ErrorListener>();
  onExit(listener: ExitListener): void {
    this.exit.add(listener);
  }
  onceExit(listener: ExitListener): void {
    const wrap: ExitListener = (code, signal) => {
      this.exit.delete(wrap);
      listener(code, signal);
    };
    this.exit.add(wrap);
  }
  onError(listener: ErrorListener): void {
    this.error.add(listener);
  }
  onceError(listener: ErrorListener): void {
    const wrap: ErrorListener = (error) => {
      this.error.delete(wrap);
      listener(error);
    };
    this.error.add(wrap);
  }
  off(event: "exit" | "error", listener: (...args: never[]) => void): void {
    if (event === "exit") this.exit.delete(listener as ExitListener);
    if (event === "error") this.error.delete(listener as ErrorListener);
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.exit]) listener(code, signal);
  }
}

/**
 * Build the spawnClaudeCodeProcess implementation for one remote session.
 * Hand the returned function to the SDK ONCE per query; the requestId comes
 * from nextRequestId so the session's FIRST stream uses the id already
 * persisted in the pending journal (unknown outcomes reconcile by it).
 */
export function macClaudeSpawnFactory(
  deps: MacStreamDeps,
  launch: ClaudeStreamLaunch,
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const adapted = adaptClaudeArgv(options.args ?? []);
    if (!adapted.ok) {
      launch.onHandshake?.({
        transport: MAC_STREAM_TRANSPORT,
        requestId: null,
        status: "rejected",
        reason: "argv-adaptation",
        detail: adapted.error,
      });
      return deadSpawnedProcess(`mac stream argv geweigerd: ${adapted.error}`);
    }
    const extraction = adapted.extraction;
    launch.onArgvExtraction?.(extraction.notes, extraction.settingsJson?.parsed ?? null);
    // Frozen wire shape: the extracted --settings object MERGES into the
    // metadata settings (the supervisor materializes it natively — argv
    // stays clean of prompt/settings text on both sides). CONFLICT RULE: the
    // supervisor refuses settings.thinkingLevel while args already carry
    // --effort (the SDK emits it) — drop the metadata duplicate in that case
    // so the native flag stays authoritative, never conflicting.
    const effortOnArgv = extraction.argv.includes("--effort");
    const merged: MacStreamSettings = {
      ...launch.settings,
      ...(extraction.settingsJson?.parsed as MacStreamSettings | undefined ?? {}),
    };
    const settings: MacStreamSettings = effortOnArgv && merged.thinkingLevel !== undefined
      ? (() => {
          const { thinkingLevel: _drop, ...rest } = merged;
          launch.onArgvExtraction?.(["settings.thinkingLevel dropped from metadata: args already carry --effort (supervisor conflict rule)"], null);
          return rest;
        })()
      : merged;
    // Reserved-name aliasing happens HERE, on the lease map, before the wire
    // document is built: the supervisor materializes mcp-claude.json keys
    // verbatim from metadata.mcp.servers, and claude 2.1.285 silently drops
    // reserved names at config load (see CLAUDE_RESERVED_MCP_SERVER_NAMES).
    // The URL — and therefore the bridge namespace, lease auth and journal —
    // is untouched; only the CLI-side server (tool prefix) changes.
    const lease = claudeLeaseMcpServers(launch.mcpServers);
    for (const rename of lease.renames) {
      launch.onArgvExtraction?.(
        [`mcp server "${rename.from}" renamed to "${rename.to}" on the claude wire: the name is reserved by the CLI (2.1.285 drops it at config load); the bridge URL and lease are unchanged`],
        null,
      );
    }
    const metadata: MacStreamMetadata = {
      transport: MAC_STREAM_TRANSPORT,
      requestId: launch.nextRequestId ? launch.nextRequestId() : crypto.randomUUID(),
      sessionId: launch.sessionId,
      provider: "claude",
      args: extraction.argv,
      context: launch.context,
      mcp: { servers: lease.servers },
      settings,
      ...(launch.settings.model ? { model: launch.settings.model } : {}),
      ...(launch.remoteCwd ? { cwd: launch.remoteCwd } : {}),
    };
    let handle: MacStreamHandle | null = null;
    try {
      handle = openMacStream(deps, {
        target: launch.target,
        metadata,
        onHandshake: (handshake) => launch.onHandshake?.(handshake),
      });
    } catch (error) {
      return deadSpawnedProcess(`mac stream kon niet geopend worden: ${error instanceof Error ? error.message : String(error)}`);
    }

    // SDK-side writable → ssh stdin WITH backpressure: a fast SDK writing
    // while ssh is slow must block on drain, not buffer unboundedly.
    let failed: Error | null = null;
    const stdin = new Writable({
      highWaterMark: 256 * 1024,
      write(chunk, _encoding, callback) {
        if (failed) return callback(failed);
        try {
          handle!.stdin.write(chunk as Uint8Array);
          // Bounded drain wait before acknowledging: a fast SDK writing while
          // ssh is slow blocks here instead of buffering unboundedly.
          void waitForDrain().then(() => callback()).catch((error) => callback(error instanceof Error ? error : new Error(String(error))));
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final(callback) {
        try {
          handle!.stdin.end();
        } catch {}
        callback();
      },
    });
    const waitForDrain = (): Promise<void> =>
      new Promise((resolve) => {
        // The ssh child's stdin is a plain pipe facade without an observable
        // drain signal; a small yield lets the pipe flush before the next
        // write is acknowledged (bounded, never hanging the SDK).
        setTimeout(resolve, 2);
      });

    // Remote stdout after handshake → SDK readable, backpressured through
    // the PassThrough's own watermarks (pause/resume respected by Bun).
    const stdout = new PassThrough({ highWaterMark: 256 * 1024 });
    const listeners = new SpawnListeners();
    let killed = false;
    let exitCode: number | null = null;
    let closed = false;
    const emitExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) return;
      closed = true;
      exitCode = code;
      try {
        stdout.end();
      } catch {}
      listeners.emitExit(code, signal);
    };
    void handle.whenReady.then((ready) => {
      if (!ready.ok) {
        // refused/exists/conflict or transport failure: the SDK must observe
        // a dead child; the sanitized reason surfaced via onHandshake.
        emitExit(127, null);
        return;
      }
      void (async () => {
        const reader = ready.stdout.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            // Backpressure: wait when the consumer is slow. A bounded wait
            // keeps a stalled SDK from wedging the pump permanently.
            if (!stdout.write(value)) {
              await new Promise<void>((resolve) => {
                let waited = 0;
                const tick = (): void => {
                  if (stdout.writableNeedDrain && waited < 30_000) {
                    waited += 25;
                    setTimeout(tick, 25);
                  } else {
                    resolve();
                  }
                };
                tick();
              });
            }
          }
        } catch {
          /* exit status below carries the news */
        }
        // TRUE exit status: the remote stream ending is NOT an exit code.
        // Await the supervisor's actual child exit, then propagate it.
        try {
          const code = await ready.exited;
          emitExit(code, null);
        } catch {
          emitExit(null, null);
        }
      })();
    });

    const processLike: SpawnedProcess = {
      stdin,
      stdout: stdout as unknown as Readable,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      kill(signal: NodeJS.Signals) {
        if (killed) return false;
        killed = true;
        handle?.kill(signal);
        emitExit(exitCode, signal);
        return true;
      },
      on(event: "exit" | "error", listener: (...args: never[]) => void): void {
        if (event === "exit") listeners.onExit(listener as ExitListener);
        if (event === "error") listeners.onError(listener as ErrorListener);
      },
      once(event: "exit" | "error", listener: (...args: never[]) => void): void {
        if (event === "exit") listeners.onceExit(listener as ExitListener);
        if (event === "error") listeners.onceError(listener as ErrorListener);
      },
      off(event: "exit" | "error", listener: (...args: never[]) => void): void {
        listeners.off(event, listener);
      },
    };
    return processLike;
  };
}

/** A SpawnedProcess that is already dead — used when opening failed hard. */
function deadSpawnedProcess(reason: string): SpawnedProcess {
  const stdin = new Writable({
    write(_chunk, _enc, callback) {
      callback(new Error(reason));
    },
    final(callback) {
      callback();
    },
  });
  const stdout = new PassThrough();
  stdout.end();
  const listeners = new SpawnListeners();
  return {
    stdin,
    stdout: stdout as unknown as Readable,
    killed: true,
    exitCode: 127,
    kill() {
      return true;
    },
    on(event: "exit" | "error", listener: (...args: never[]) => void): void {
      if (event === "exit") {
        listeners.onExit(listener as ExitListener);
        queueMicrotask(() => listeners.emitExit(127, null));
      }
      if (event === "error") listeners.onError(listener as ErrorListener);
    },
    once(event: "exit" | "error", listener: (...args: never[]) => void): void {
      if (event === "exit") listeners.onceExit(listener as ExitListener);
      if (event === "error") listeners.onceError(listener as ErrorListener);
    },
    off(event: "exit" | "error", listener: (...args: never[]) => void): void {
      listeners.off(event, listener);
    },
  };
}
