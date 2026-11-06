import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { workerCommand } from "./omg-isolation-runtime.ts";

async function checked(command: string[], cwd: string) {
  const p = Bun.spawn(workerCommand(command, `omg-update-preflight-${crypto.randomUUID()}`, cwd),
    { env: process.env, stdout: "ignore", stderr: "ignore" });
  if (await p.exited !== 0) throw new Error("Isolation command failed. Check the candidate with omg_isolation_source.py.");
}

export async function verifyIsolationTree(root: string) {
  const privateLayer = join(homedir(), ".local/lib/omg-private/current/preserve.py");
  if (existsSync(privateLayer)) await checked(["/usr/bin/python3", privateLayer, root, "--apply"], root);
  await checked(["/usr/bin/python3", join(homedir(), ".local/lib/agentbox-isolation/current/sqlite_resilience_apply.py"), join(root, "src")], root);
  await checked(["/usr/bin/python3", join(homedir(), ".local/lib/agentbox-isolation/current/ship_shared_apply.py"), join(root, "src")], root);
  await checked(["/usr/bin/python3", join(homedir(), ".local/lib/agentbox-isolation/current/omg_isolation_source.py"), join(root, "src")], root);
}

// Verify an extracted candidate before the upstream updater removes live modules.
// Use disk-backed cache, not /tmp (tmpfs on this host).
export async function preflightIsolationArchive(archive: string) {
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  const candidate = mkdtempSync(join(cache, "omg-isolation-stage-"));
  try {
    await checked(["tar", "-xzf", archive, "--strip-components=1", "-C", candidate], candidate);
    await verifyIsolationTree(candidate);
    await checked([process.execPath, "build", join(candidate, "src/tmux.ts"),
      join(candidate, "src/computer/desktop.ts"), join(candidate, "src/auto/runner.ts"),
      join(candidate, "src/self-update.ts"), "--target=bun", "--external=*", "--outdir=" + join(candidate, ".isolation-build")], candidate);
  } catch {
    throw new Error("Update refused: isolation preflight failed; live installation has not been replaced.");
  } finally { rmSync(candidate, { recursive: true, force: true }); }
}
