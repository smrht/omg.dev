// Agentbox issue 1029: conditional close, checked synchronously before enqueue.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
export function idleChildAllowed(s: any, expected: any, rows: any[], entry: any,
  identity: {start: string; cgroup: string}, queued: boolean, now = Date.now()): boolean {
  if (!expected || !s || !entry || !s.managed || s.persistent || s.botId ||
      s.busy !== false || s.launching || s.status !== "ok" ||
      !s.parentSessionId || s.parentSessionId === s.sessionId ||
      s.last?.role !== "assistant" || s.last?.kind !== "text") return false;
  if (s.pid !== expected.pid || s.lastActivityAt !== expected.lastActivityAt ||
      identity.start !== expected.start || s.parentSessionId !== expected.parentSessionId ||
      entry.harnessPid !== s.pid || entry.busy !== false || entry.prompt ||
      entry.draftText || queued) return false;
  if (!identity.cgroup.endsWith(`/lfg-agent-${s.tmuxName}.service`) ||
      !/^lfg-[a-zA-Z0-9-]+$/.test(s.tmuxName ?? "")) return false;
  if (rows.some(r => r.parentSessionId === s.sessionId ||
      (s.nativeSessionId && r.parentNativeSessionId === s.nativeSessionId))) return false;
  const parentLive = rows.some(r => r.sessionId === s.parentSessionId ||
    (s.parentNativeSessionId && r.nativeSessionId === s.parentNativeSessionId));
  const idle = now - s.lastActivityAt;
  return Number.isFinite(idle) && idle >= (parentLive ? 30 : 5) * 60_000;
}
export function inspectIdleChild(s: any, expected: any, rows: any[], cached: any, data: string): boolean {
  try {
    if (!cached) return false;
    const key = cached.sessionId;
    if (!/^[0-9a-f-]{36}$/.test(key)) return false;
    const entry = JSON.parse(readFileSync(join(data, "aisdk", key + ".json"), "utf8"));
    const cmd = join(data, "aisdk", key + ".cmd");
    let size = 0;
    try { size = statSync(cmd).size; } catch (e: any) { if (e.code !== "ENOENT") return false; }
    let consumed = 0;
    if (size) consumed = Number(readFileSync(cmd + ".cursor", "utf8").trim());
    const stat = readFileSync(`/proc/${s.pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]!;
    const cgroup = readFileSync(`/proc/${s.pid}/cgroup`, "utf8").trim().split("::")[1]!;
    return idleChildAllowed(s, expected, rows, entry, {start, cgroup}, consumed !== size);
  } catch { return false; }
}
