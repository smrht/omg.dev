import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistIsolationDesktop } from "./omg-isolation-computer";

test("an exited optional WM cannot discard a healthy desktop registration", () => {
  if (process.platform !== "linux") return;
  const dir = mkdtempSync(join(tmpdir(), "desktop-persist-test-"));
  try {
    const state = join(dir,"desktop.json"), backup = join(dir,"backup.json");
    const record = {pids:{xvfb:process.pid,vnc:process.pid,chrome:process.pid,wm:2147483647}};
    persistIsolationDesktop(record,state,backup);
    const actual=JSON.parse(readFileSync(state,"utf8"));
    expect(actual.pids.chrome).toBe(process.pid);
    expect(actual.pids.wm).toBeUndefined();
    expect(JSON.parse(readFileSync(backup,"utf8")).record).toEqual(actual);
    expect(record.pids.wm).toBe(2147483647);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
