/** Durable write-ahead queue for the derived transcript index.
 * Immutable, private records survive worker exit. Concurrent drainers are safe:
 * replay uses stable message IDs and SQLite INSERT OR IGNORE. Never replay tools.
 */
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readdirSync, readFileSync, unlinkSync, constants, fstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dlopen, read } from "bun:ffi";

// The permanent inode must never be unlinked: flock is released by the kernel
// on close/crash, so a slow live drainer cannot have its lease stolen.
let nativeLock: { flock: (fd: number, operation: number) => number; errno: () => number } | undefined;
function lockApi() {
  if (nativeLock) return nativeLock;
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") throw new Error("Unsupported transcript queue lock platform");
  const errnoName = linux ? "__errno_location" : "__error";
  const library = dlopen(linux ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    [errnoName]: { args: [], returns: "ptr" },
  });
  nativeLock = {
    flock: library.symbols.flock as any,
    errno: () => read.i32((library.symbols[errnoName] as any)()),
  };
  return nativeLock;
}
function acquireDrainLock(directory: string): number | undefined {
  const fd = openSync(join(directory, ".drain.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o600 || st.size !== 0 || st.nlink !== 1)
      throw new Error("Unsafe transcript queue drain lock metadata");
    const api = lockApi();
    if (api.flock(fd, 6) === 0) return fd; // LOCK_EX | LOCK_NB
    const errno = api.errno();
    if (errno !== (process.platform === "darwin" ? 35 : 11))
      throw Object.assign(new Error("Transcript queue drain lock failed"), {errno});
    closeSync(fd);
    return undefined;
  } catch (error) { closeSync(fd); throw error; }
}

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
  private retryAt = 0;
  private busyStreak = 0;
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
    if (this.draining || Date.now() < this.retryAt) return 0;
    this.draining = true;
    let inserted = 0;
    let lockFd: number | undefined;
    try {
      let names: string[];
      try { names = readdirSync(this.directory).filter(n => /^\d{16}-\d+-[\da-f-]+\.json$/.test(n)).sort(); }
      catch (e: any) { if (e.code === "ENOENT") return 0; throw e; }
      if (!names.length) return 0;
      lockFd = acquireDrainLock(this.directory);
      if (lockFd === undefined) {
        this.retryAt = Date.now() + 100 + Math.floor(Math.random() * 150);
        return 0;
      }
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
          this.busyStreak = Math.min(this.busyStreak + 1, 5);
          const delay = Math.min(5000, 250 * 2 ** (this.busyStreak - 1));
          this.retryAt = Date.now() + delay + Math.floor(Math.random() * Math.min(250, 5000 - delay));
          this.warn("write_deferred",error);
          break;
        }
        this.busyStreak = 0;
        this.retryAt = 0;
        try { unlinkSync(path); } catch(e: any) { if (e.code !== "ENOENT") throw e; }
        if (Date.now() >= deadline) break;
      }
      return inserted;
    } finally {
      try { if (lockFd !== undefined) closeSync(lockFd); }
      finally { this.draining = false; }
    }
  }
}
