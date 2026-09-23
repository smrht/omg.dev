// Independent host safety layer: provider payloads travel over stdin, never argv.
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDiskBackedTmpdir } from "./tmp-reclaim.ts";

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

function pressureHigh(): boolean {
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

export async function isolatedAutoBackend(agent: unknown, prompt: string, cwd: string, onLog: (s: string) => void, mode = "auto"): Promise<string> {
  const deadline = Date.now() + 10 * 60_000;
  let announced = false;
  while (active >= 3 || pressureHigh()) {
    if (!announced) { onLog("[isolation] waiting for background capacity or memory pressure to clear"); announced = true; }
    if (Date.now() >= deadline) throw new Error("Background run deferred: memory pressure or capacity persisted for 10 minutes");
    await Bun.sleep(2000);
  }
  active++;
  try {
    const task = typeof agent === "object" && agent !== null && "id" in agent && typeof agent.id === "string"
      ? agent.id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40) : mode;
    const name = `omg-auto-${task}-${crypto.randomUUID()}`;
    onLog(`[isolation] worker=${name}.service`);
    const cmd = workerCommand([process.execPath, join(import.meta.dir, "omg-isolation-worker.ts")], name, cwd);
    const proc = Bun.spawn(cmd, { cwd, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify({ agent, prompt, cwd, mode }));
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
    if (code !== 0) throw new Error(`Isolated backend failed (exit ${code}); inspect its unit journal`);
    const line = result.split("\n").findLast(s => s.startsWith("OMG_ISOLATION_RESULT "));
    if (!line) throw new Error("Missing isolated backend result");
    const packet = JSON.parse(line.slice("OMG_ISOLATION_RESULT ".length));
    for (const line of packet.logs ?? []) onLog(line);
    if (typeof packet.result !== "string") throw new Error("Invalid isolated backend result");
    return packet.result;
  } finally { active--; }
}
