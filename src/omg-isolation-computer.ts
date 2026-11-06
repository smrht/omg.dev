import { readFileSync } from "node:fs";

// Invoked only on an explicit desktop stop or an already-unhealthy stack.
// Never age-reap the shared browser. Read scope membership before killing PIDs.
export async function stopIsolationScopes(pids: { xvfb?: number; wm?: number; vnc?: number; chrome?: number }) {
  if (process.platform !== "linux") return;
  const names = new Set<string>();
  for (const [key, pid] of Object.entries(pids)) {
    if (!Number.isSafeInteger(pid) || !pid || pid <= 1) continue;
    const kind = key === "wm" ? "desktop" : key;
    names.add(`omg-computer-${kind}-${pid}.scope`);
    try {
      const path = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
      const match = path.match(/\/computer\.slice\/([^/]+\.scope)$/);
      if (match && new RegExp(`^omg-(?:computer-adopt-[a-z]+|adopt)-${pid}-[0-9]+\\.scope$`).test(match[1])) names.add(match[1]);
    } catch {}
  }
  if (!names.size) return;
  const proc = Bun.spawn(["systemctl", "--user", "--no-block", "stop", ...names], { stdout: "ignore", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([proc.exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
  if (timer) clearTimeout(timer);
  if (!done) proc.kill();
}

// Separate durable copy survives lost desktop.json; PID/starttime prevents reuse.
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const backupFile = join(homedir(), ".local/state/agentbox-isolation/desktop-backup.json");
function startTick(pid: number): string {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  return raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/)[19];
}
function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
export function persistIsolationDesktop(record: { pids: Record<string, number | undefined> }, path: string, backup = backupFile) {
  if (process.platform === "linux") {
    // The optional desktop launcher may have already exited. Keep the healthy
    // browser/display registration rather than losing both durable copies.
    record = { ...record, pids: { ...record.pids } };
    const starts: Record<string, string> = {};
    for (const [key, pid] of Object.entries(record.pids)) {
      if (!pid) continue;
      try { starts[key] = startTick(pid); }
      catch (error) {
        if (key !== "wm" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        delete record.pids.wm;
      }
    }
    atomicJson(backup, { record, starts, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() });
  }
  atomicJson(path, record);
}
export function recoverIsolationDesktop(path: string, backup = backupFile): any | null {
  if (process.platform !== "linux") return null;
  try {
    const data = JSON.parse(readFileSync(backup, "utf8"));
    if (data.boot !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()) return null;
    const expected: Record<string,string[]> = {xvfb:["Xvfb"], wm:["xfce4-session","openbox"], vnc:["x11vnc"], chrome:["chromium","chrome"]};
    for (const key of ["xvfb","vnc","chrome"]) if (!data.record.pids[key]) return null;
    for (const [key,pid] of Object.entries(data.record.pids) as [string,number][]) {
      if (!pid) continue;
      if (startTick(pid) !== data.starts[key]) return null;
      if (!expected[key]?.includes(readFileSync(`/proc/${pid}/comm`, "utf8").trim())) return null;
      if (!readFileSync(`/proc/${pid}/cgroup`, "utf8").includes("/computer.slice/")) return null;
    }
    atomicJson(path, data.record);
    return data.record;
  } catch { return null; }
}
