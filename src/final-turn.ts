import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Compare-and-close/relay precondition. Nothing supplied by the caller can
 * override the actual runtime, pending command bytes or process identity. */
export function finalTurnAllowed(s: any, expected: any, entry: any,
  identity: { start: string; cgroup: string }, pending: boolean): boolean {
  return !!(s && expected && entry && s.managed && !s.persistent && !s.botId && !s.launching &&
    s.busy === false && s.status === "ok" && s.last?.role === "assistant" && s.last?.kind === "text" &&
    s.last.text?.trim() && s.pid === expected.pid && s.lastActivityAt === expected.lastActivityAt &&
    identity.start === expected.start && /^lfg-[a-zA-Z0-9-]+$/.test(s.tmuxName ?? "") &&
    identity.cgroup.endsWith(`/lfg-agent-${s.tmuxName}.service`) &&
    entry.harnessPid === s.pid && entry.busy === false && !entry.prompt && !entry.draftText && !pending);
}

export function inspectFinalTurn(s: any, expected: any, cached: any, data: string): boolean {
  try {
    if (!s || !expected || !cached || !s.managed || s.persistent || s.botId || s.launching ||
        s.busy !== false || s.status !== "ok" || s.last?.role !== "assistant" || s.last?.kind !== "text" ||
        !s.last.text?.trim() || s.pid !== expected.pid || s.lastActivityAt !== expected.lastActivityAt ||
        cached.sessionId !== s.sessionId || !/^[0-9a-f-]{36}$/i.test(s.sessionId)) return false;
    const stat = readFileSync(`/proc/${s.pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    const group = readFileSync(`/proc/${s.pid}/cgroup`, "utf8").trim().split("::")[1];
    if (start !== expected.start || !/^lfg-[a-zA-Z0-9-]+$/.test(s.tmuxName ?? "") ||
        !group?.endsWith(`/lfg-agent-${s.tmuxName}.service`)) return false;
    const entry = JSON.parse(readFileSync(join(data, "aisdk", s.sessionId + ".json"), "utf8"));
    if (entry.harnessPid !== s.pid || entry.busy !== false || entry.prompt || entry.draftText) return false;
    const command = join(data, "aisdk", s.sessionId + ".cmd");
    let size = 0;
    try { size = statSync(command).size; } catch (e: any) { if (e.code !== "ENOENT") return false; }
    const consumed = size ? Number(readFileSync(command + ".cursor", "utf8").trim()) : 0;
    return finalTurnAllowed(s, expected, entry, { start: start!, cgroup: group! }, consumed !== size);
  } catch { return false; }
}
