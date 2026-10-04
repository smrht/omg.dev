/** Durable write-ahead queue for the derived transcript index.
 * Immutable, private records survive worker exit. Concurrent drainers are safe:
 * replay uses stable message IDs and SQLite INSERT OR IGNORE. Never replay tools.
 */
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function isSqliteContention(error: unknown): boolean {
  const e = error as { code?: string; errno?: number; message?: string };
  return /^SQLITE_(BUSY|LOCKED)(_|$)/.test(e?.code ?? "") ||
    (typeof e?.errno === "number" && [5,6].includes(e.errno & 255)) ||
    /^(database is locked|database table is locked|database schema is locked)(:|$)/i.test(e?.message ?? "");
}

type RecordData = { version: 1; sessionId: string; messages: any[] };
export class TranscriptWriteQueue {
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private lastStamp = 0;
  private lastWarning = 0;
  constructor(readonly directory: string, private readonly write: (sessionId: string, messages: any[]) => number) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.drain(); } catch (error) { this.warn("replay_failed", error); }
    }, 2000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private warn(event: string, error: unknown) {
    if (Date.now() - this.lastWarning < 60000) return;
    this.lastWarning = Date.now();
    const e = error as { code?: string; errno?: number };
    // Never put transcript content or arbitrary exception text into logs.
    console.error(`[transcript-persistence] ${JSON.stringify({event, database:"transcript-index.sqlite", queue:this.directory, code:e?.code, errno:e?.errno, retained:true})}`);
  }
  enqueue(sessionId: string, messages: any[]): number {
    if (!messages.some(m => m.id && m.text?.trim())) return 0;
    mkdirSync(this.directory, {recursive:true, mode:0o700});
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    const name = `${String(this.lastStamp).padStart(16,"0")}-${process.pid}-${randomUUID()}.json`;
    const target = join(this.directory, name), temp = target + ".tmp";
    const fd = openSync(temp,"wx",0o600);
    try { writeFileSync(fd, JSON.stringify({version:1,sessionId,messages} satisfies RecordData)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp,target);
    const dirfd = openSync(this.directory,"r");
    try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
    this.start();
    // Return inserted count when caught up; zero means durably queued, not lost.
    return this.drain();
  }
  drain(): number {
    if (this.draining) return 0;
    this.draining = true;
    let inserted = 0;
    try {
      let names: string[];
      try { names = readdirSync(this.directory).filter(n => /^\d{16}-\d+-[\da-f-]+\.json$/.test(n)).sort(); }
      catch (e: any) { if (e.code === "ENOENT") return 0; throw e; }
      const deadline = Date.now() + 250;
      for (const name of names.slice(0,32)) {
        const path = join(this.directory,name);
        let record: RecordData;
        try { record = JSON.parse(readFileSync(path,"utf8")); }
        catch (e: any) { if (e.code === "ENOENT") continue; throw e; }
        if (record.version !== 1 || typeof record.sessionId !== "string" || !Array.isArray(record.messages)) throw new Error("Invalid retained transcript queue record");
        try { inserted += this.write(record.sessionId, record.messages); }
        catch (error) {
          if (!isSqliteContention(error)) { this.warn("write_failed",error); throw error; }
          this.warn("write_deferred",error);
          break;
        }
        try { unlinkSync(path); } catch(e: any) { if (e.code !== "ENOENT") throw e; }
        if (Date.now() >= deadline) break;
      }
      return inserted;
    } finally { this.draining = false; }
  }
}
