// Mac stream client: opens `ssh … stream`, writes the metadata line, waits
// for the handshake, then exposes raw native stdin/stdout pipes. Shared by the
// Claude SDK spawn seam and the Codex app-server transport.
//
// This module NEVER blocks the Bun eventloop on ssh: spawning is
// non-blocking, the handshake wait is an async race with a timeout, and the
// caller decides what a failed/late handshake means (fail closed).
import {
  encodeMacStreamMetadata,
  createHandshakeDecoder,
  sanitizeStreamReason,
  type MacStreamHandshake,
  type MacStreamMetadata,
} from "./wire.ts";
import { assertNoSecretsOnArgv, macSshArgv } from "./ssh.ts";

export type SpawnedSshChild = {
  pid: number;
  stdin: { write(data: Uint8Array | string): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
};

export type MacStreamSpawnFn = (argv: readonly string[]) => SpawnedSshChild;

/**
 * Production spawn adapter: pipes both directions (the supervisor owns the
 * data plane) and inherits stderr (bounded, never parsed by us). Plain
 * Bun.spawn(argv) would default stdin/stdout to "ignore" and kill the
 * stream at the first byte — this adapter is what the harnesses use.
 */
export function macSshSpawn(argv: readonly string[]): SpawnedSshChild {
  const child = Bun.spawn({
    cmd: [...argv],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  return {
    pid: child.pid ?? 0,
    stdin: {
      write(data) {
        child.stdin!.write(data as never);
      },
      end() {
        child.stdin!.end();
      },
    },
    stdout: child.stdout as ReadableStream<Uint8Array>,
    exited: child.exited as Promise<number>,
    kill(signal) {
      child.kill(signal);
    },
  };
}

export type MacStreamDeps = {
  spawn: MacStreamSpawnFn;
  /** Handshake deadline. Default 45s (ssh connect + supervisor checks). */
  handshakeTimeoutMs?: number;
};

export type OpenMacStreamOptions = {
  target: string;
  metadata: MacStreamMetadata;
  /** Called once the handshake resolved (ready or rejected). */
  onHandshake?: (handshake: MacStreamHandshake) => void;
};

export type MacStreamReady =
  | {
      ok: true;
      requestId: string;
      handshake: MacStreamHandshake & { status: "ready" };
      /** Raw native stdin (metadata already written). */
      stdin: { write(data: Uint8Array | string): void; end(): void };
      /** Raw native stdout (handshake line already stripped). */
      stdout: ReadableStream<Uint8Array>;
      exited: Promise<number>;
      childPid: number;
      kill(signal?: NodeJS.Signals): void;
    }
  | { ok: false; requestId: string; error: string };

/**
 * Synchronous facade over one opening stream. The spawn (when validation
 * passes) happens synchronously, so stdin writes are ordered behind the
 * metadata line by the stream itself. `whenReady` settles exactly once.
 */
export type MacStreamHandle = {
  requestId: string;
  whenReady: Promise<MacStreamReady>;
  stdin: { write(data: Uint8Array | string): void; end(): void };
  kill(signal?: NodeJS.Signals): void;
};

/**
 * Open one native provider stream. The metadata line is validated and
 * encoded BEFORE the spawn; the argv passes the no-secret screen; the
 * handshake (first stdout line) is stripped and everything after it is piped
 * through byte-for-byte. A validation failure never spawns anything.
 */
export function openMacStream(deps: MacStreamDeps, opts: OpenMacStreamOptions): MacStreamHandle {
  const requestId = opts.metadata.requestId;
  let writeFn: (data: Uint8Array | string) => void = () => {};
  let endFn: () => void = () => {};
  let killFn: (signal?: NodeJS.Signals) => void = () => {};

  const encoded = encodeMacStreamMetadata(opts.metadata);
  const handshakePromise: Promise<MacStreamReady> = (async () => {
    if (!encoded.ok) return { ok: false, requestId, error: `metadata invalid: ${encoded.error}` };
    const argv = macSshArgv(opts.target, { kind: "stream" });
    if (!Array.isArray(argv)) return { ok: false, requestId, error: "invalid ssh target" };
    try {
      assertNoSecretsOnArgv(argv);
    } catch (error) {
      return { ok: false, requestId, error: error instanceof Error ? error.message : String(error) };
    }
    const timeoutMs = deps.handshakeTimeoutMs ?? 45_000;
    let child: SpawnedSshChild;
    try {
      child = deps.spawn(argv);
    } catch (error) {
      return { ok: false, requestId, error: `ssh spawn failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    let killed = false;
    const kill = (signal?: NodeJS.Signals): void => {
      if (killed) return;
      killed = true;
      try {
        child.kill(signal ?? "SIGTERM");
      } catch {}
    };
    writeFn = (data) => {
      try {
        child.stdin.write(data);
      } catch {}
    };
    endFn = () => {
      try {
        child.stdin.end();
      } catch {}
    };
    killFn = kill;
    // Metadata FIRST; stdin then stays raw for native bytes.
    try {
      child.stdin.write(encoded.line);
    } catch (error) {
      kill("SIGKILL");
      return { ok: false, requestId, error: `failed writing metadata: ${error instanceof Error ? error.message : String(error)}` };
    }

    let settled = false;
    return await new Promise<MacStreamReady>((resolve) => {
      const decoder = createHandshakeDecoder(requestId);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        kill("SIGKILL");
        resolve({ ok: false, requestId, error: "geen handshake van de Mac-stream binnen de tijd" });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      const settle = (r: MacStreamReady): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const failBeforeReady = (message: string): void => {
        kill("SIGKILL");
        settle({ ok: false, requestId, error: message });
      };

      const reader = child.stdout.getReader();
      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              failBeforeReady("ssh stream sloot vóór de handshake");
              return;
            }
            if (!value?.byteLength) continue;
            const step = decoder.push(value);
            if ("pending" in step) continue;
            if (!step.ok) {
              failBeforeReady(`handshake ongeldig: ${step.error}`);
              return;
            }
            opts.onHandshake?.(step.handshake);
            if (step.handshake.status !== "ready") {
              kill("SIGKILL");
              settle({
                ok: false,
                requestId,
                error: sanitizeStreamReason(step.handshake.reason) || `Mac-stream weigerde (${step.handshake.status})`,
              });
              return;
            }
            // Ready: pipe raw stdout. The decoder's explicit `remainder`
            // carries the bytes that shared THIS chunk with the handshake
            // tail — never slice by a cumulative offset (item 33).
            const rest = step.remainder;
            // Pull-based forwarding: one chunk is read from ssh per consumer
            // pull, so a slow consumer (Claude PauseThrough etc.) applies
            // backpressure to the ssh pipe instead of ballooning an eager
            // start() pump (item 33 — no unbounded stream buffers).
            let pending: Uint8Array | null = rest.byteLength ? rest : null;
            settle({
              ok: true,
              requestId,
              handshake: step.handshake,
              stdin: child.stdin,
              stdout: new ReadableStream<Uint8Array>({
                async pull(controller): Promise<void> {
                  try {
                    while (!pending) {
                      const next = await reader.read();
                      if (next.done) {
                        controller.close();
                        return;
                      }
                      if (next.value?.byteLength) {
                        pending = next.value;
                        break;
                      }
                    }
                    controller.enqueue(pending!);
                    pending = null;
                  } catch (error) {
                    controller.error(error);
                  }
                },
                cancel(reason) {
                  void reader.cancel(reason).catch(() => {});
                },
              }),
              exited: child.exited,
              childPid: child.pid,
              kill,
            });
            return;
          }
        } catch (error) {
          failBeforeReady(`ssh stream fout: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      void pump();
    });
  })();

  return {
    requestId,
    whenReady: handshakePromise,
    stdin: {
      write: (data) => writeFn(data),
      end: () => endFn(),
    },
    kill: (signal) => killFn(signal),
  };
}

/**
 * One-shot supervisor command (`probe`, `status <uuid>`, `cancel <uuid>`):
 * bounded optional stdin JSON, bounded stdout answer. Resolution requires
 * BOTH a drained stdout (EOF) AND the real exit status (item 30): resolving
 * on `exited` alone raced the stdout reader and lost the JSON when the
 * process died with bytes still buffered. Nonzero exit is an ERROR even when
 * stdout carried text; stdin write failures and over-bound output fail the
 * exchange and kill our own child.
 */
export async function macSshOneShot(
  deps: MacStreamSpawnFn,
  target: string,
  verb: { kind: "probe" } | { kind: "status"; requestId: string } | { kind: "cancel"; requestId: string },
  opts: { stdinJson?: unknown; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const argv = macSshArgv(target, verb);
  if (!Array.isArray(argv)) return { ok: false, error: "invalid ssh target" };
  assertNoSecretsOnArgv(argv);
  let child: SpawnedSshChild;
  try {
    child = deps(argv);
  } catch (error) {
    return { ok: false, error: `ssh spawn failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const cap = opts.maxOutputBytes ?? 256 * 1024;
  return await new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    let stdoutDone = false;
    let exitCode: number | null = null;
    const killChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const finish = (r: { ok: true; stdout: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killChild();
      finish({ ok: false, error: "ssh command timed out" });
    }, timeoutMs);
    const assemble = (): string => {
      const total = new Uint8Array(bytes);
      let at = 0;
      for (const chunk of chunks) {
        total.set(chunk, at);
        at += chunk.byteLength;
      }
      return new TextDecoder().decode(total);
    };
    const maybeResolve = (): void => {
      if (settled || !stdoutDone || exitCode === null) return;
      if (exitCode !== 0) {
        // Protocol failure: the answer is incomplete by definition. Include a
        // bounded, sanitized excerpt for diagnosis (never secrets).
        const excerpt = sanitizeStreamReason(assemble().trim(), 160);
        finish({
          ok: false,
          error: `ssh command exited ${exitCode}${excerpt ? `: ${excerpt}` : ""}`,
        });
        return;
      }
      finish({ ok: true, stdout: assemble() });
    };
    if (opts.stdinJson !== undefined) {
      try {
        child.stdin.write(new TextEncoder().encode(`${JSON.stringify(opts.stdinJson)}\n`));
      } catch (error) {
        killChild();
        finish({ ok: false, error: `ssh stdin write failed: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
    }
    try {
      child.stdin.end();
    } catch {
      // already closed: not fatal for a one-shot that needs no stdin
    }
    void child.exited
      .then((code) => {
        exitCode = code;
        maybeResolve();
      })
      .catch(() => {
        killChild();
        finish({ ok: false, error: "ssh process failed" });
      });
    void (async () => {
      const reader = child.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          bytes += value.byteLength;
          if (bytes > cap) {
            killChild();
            finish({ ok: false, error: "ssh answer exceeded bound" });
            return;
          }
          chunks.push(value);
        }
        stdoutDone = true;
        maybeResolve();
      } catch (error) {
        killChild();
        finish({ ok: false, error: `ssh stdout read failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    })();
  });
}
