// Independent host safety layer: provider payloads travel over stdin, never argv.
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDiskBackedTmpdir } from "./tmp-reclaim.ts";
import { agentboxResourceGate, agentboxResourcePolicyConfigured } from "./agentbox-resource-admission.ts";

export function workerCommand(command: string[], name: string, cwd: string, slice = "lfg-agents.slice") {
  if (process.platform !== "linux") return command;
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid worker unit name");
  // systemd workers leave a caller's private mount namespace. Give them a host-visible disk path.
  const temp = ensureDiskBackedTmpdir() ?? join(homedir(), ".cache", "lfg", "tmp");
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  return ["/usr/bin/systemd-run", "--user", "--quiet", "--pipe", "--wait", "--collect",
    `--unit=${name}`, `--slice=${slice}`, `--working-directory=${cwd}`,
    "--property=Type=exec", "--property=KillMode=control-group",
    "--property=MemoryHigh=3G", "--property=MemoryMax=4G",
    "--property=MemorySwapMax=1G", "--property=TasksMax=1024",
    // Bare variable names copy the client's environment, without exposing values in argv.
    ...Object.keys(process.env).filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(k => `--setenv=${k}`),
    ...(temp ? ["TMPDIR", "TMP", "TEMP"].map(k => `--setenv=${k}=${temp}`) : []),
    `--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${process.getuid!()}/omg-worker-no-session-bus`,
    "--", ...command];
}

export class ResourceCapacityDeferred extends Error {}

/** Shared policy for both scheduled backends and interactive thread replies. */
export function sharedWorkerCapacityReason(mode = "auto", options?: {
  stateFile?: string; env?: Record<string, string | undefined>; freshAvailableBytes?: number; pending?: number;
}): string | null {
  if (!options?.stateFile && !agentboxResourcePolicyConfigured(options?.env)) return null;
  let available = options?.freshAvailableBytes;
  if (available === undefined) {
    try { available = Number(readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024; }
    catch { available = 0; }
  }
  const gate = agentboxResourceGate(mode === "chat" ? "interactive" : "schedule", {
    ...options, freshAvailableBytes: available,
  });
  if (gate.status === "refused") return gate.message;
  if (gate.status === "allow" && gate.memory.availableBytes < gate.memory.reserveBytes + ((options?.pending ?? active) + 1) * gate.memory.launchBytes) {
    return "shared memory reserve is needed by interactive work; background run stays pending";
  }
  return null;
}

function pressureHigh(mode: string): boolean {
  if (agentboxResourcePolicyConfigured()) return sharedWorkerCapacityReason(mode) !== null;
  if (process.platform !== "linux") return false;
  const root = `/sys/fs/cgroup/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service`;
  const paths = ["/proc/pressure/memory", `${root}/lfg.slice/lfg-agents.slice/memory.pressure`,
    `${root}/omg.slice/omg-control.slice/memory.pressure`];
  for (const path of paths) {
    try {
      const match = readFileSync(path, "utf8").match(/^full avg10=([\d.]+)/m);
      if (match && Number(match[1]) >= 10) return true;
    } catch { if (path === "/proc/pressure/memory") return true; }
  }
  const available = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m);
  return !available || Number(available[1]) < 2 * 1024 * 1024;
}

let active = 0;
export async function boundedText(stream: ReadableStream<Uint8Array>, limit: number, onChunk?: (text: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new Error("Worker output exceeded safety limit");
      const text = decoder.decode(value, { stream: true });
      result += text;
      onChunk?.(text);
    }
  } finally { reader.releaseLock(); }
}

/**
 * One isolated worker run, shared by every caller so the concurrency slot and
 * the systemd containment stay identical. `capacityWaitMs` bounds how long a
 * chat reply may queue behind pressure; auto agents wait minutes, chat must
 * fail fast and visibly instead.
 */
async function isolatedWorkerRun(
  payload: unknown,
  input: { task: string; mode: string; cwd: string; capacityWaitMs: number },
  onLog: (s: string) => void,
): Promise<string> {
  const deadline = Date.now() + input.capacityWaitMs;
  let announced = false;
  while (active >= 3 || pressureHigh(input.mode)) {
    if (!announced) { onLog("[isolation] waiting for background capacity or memory pressure to clear"); announced = true; }
    if (Date.now() >= deadline) throw new ResourceCapacityDeferred(input.mode === "chat"
      ? "Thread reply deferred: memory pressure or capacity persisted"
      : "Background run deferred: memory pressure or capacity persisted for 10 minutes");
    await Bun.sleep(2000);
  }
  active++;
  try {
    const name = `omg-${input.mode}-${input.task}-${crypto.randomUUID()}`;
    onLog(`[isolation] worker=${name}.service`);
    const cmd = workerCommand([process.execPath, join(import.meta.dir, "omg-isolation-worker.ts")], name, input.cwd);
    const proc = Bun.spawn(cmd, { cwd: input.cwd, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();
    let result: string;
    let pending = "";
    const progress = (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("OMG_ISOLATION_LOG ")) continue;
        const value = JSON.parse(line.slice("OMG_ISOLATION_LOG ".length));
        if (typeof value === "string") onLog(value);
      }
    };
    try {
      [result] = await Promise.all([boundedText(proc.stdout, 8 * 1024 * 1024, progress), boundedText(proc.stderr, 1024 * 1024)]);
    } catch (error) {
      const stop = Bun.spawn(["systemctl", "--user", "stop", `${name}.service`], { stdout: "ignore", stderr: "ignore" });
      await stop.exited;
      throw error;
    }
    const code = await proc.exited;
    const line = result.split("\n").findLast(s => s.startsWith("OMG_ISOLATION_RESULT "));
    if (!line) throw new Error("Missing isolated backend result");
    const packet = JSON.parse(line.slice("OMG_ISOLATION_RESULT ".length));
    for (const line of packet.logs ?? []) onLog(line);
    // A chat reply that failed carries its own trimmed reason out of the
    // worker; the exit code alone would hide it from the thread.
    if (typeof packet.error === "string" && packet.error) throw new Error(packet.error);
    if (code !== 0) throw new Error(`Isolated backend failed (exit ${code}); inspect its unit journal`);
    if (typeof packet.result !== "string") throw new Error("Invalid isolated backend result");
    return packet.result;
  } finally { active--; }
}

export async function isolatedAutoBackend(agent: unknown, prompt: string, cwd: string, onLog: (s: string) => void, mode = "auto"): Promise<string> {
  const task = typeof agent === "object" && agent !== null && "id" in agent && typeof agent.id === "string"
    ? agent.id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40) : mode;
  return isolatedWorkerRun({ agent, prompt, cwd, mode }, { task, mode, cwd, capacityWaitMs: 10 * 60_000 }, onLog);
}
