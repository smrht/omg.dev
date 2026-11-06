// HARNESS-LEVEL integration test: the REAL codex-aisdk-session harness runs
// with `--execution-host mac` and drives two turns through the REAL remote
// transport (createRemoteCodexTransport) over a PATH-shim `ssh` that speaks
// the frozen supervisor protocol (test fixture subprocess). Proves:
//
//   - the two-token `--execution-host mac` argv actually selects the remote
//     route (defect 11: the local codex binary is ABSENT from PATH — any
//     local-spawn attempt would crash the harness instead of silently
//     going local);
//   - per-turn central context freshness: nonce 1 reaches turn 1, a changed
//     AGENTS.md nonce reaches turn 2;
//   - native resume: turn 2 rides thread/resume with the SAME thread id;
//   - every stream requestId is journaled (reconciliation across turns);
//   - the central transcript receives both turns (registry + SQLite index).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS = join(import.meta.dir, "codex-aisdk-session.ts");
const FIXTURE = join(import.meta.dir, "../../../test/mac-chat/fixtures/fake-ssh.ts");

let base: string;
let project: string;
let dataDir: string;
let outDir: string;
let shimDir: string;
let key: string;
const threadId = `thread-fx-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "mac-chat-harness-"));
  project = join(base, "project");
  dataDir = join(base, "data");
  outDir = join(base, "fixture-out");
  shimDir = join(base, "bin");
  mkdirSync(project, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "PROJECT NONCE ONE");
  key = crypto.randomUUID();
  // The TEST process must read the SAME data dir as the harness when it
  // verifies the central transcript at the end.
  process.env.OMG_DATA_DIR = dataDir;
  // PATH shim: a real executable named `ssh` that execs the fixture with the
  // SAME argv. PATH contains ONLY the shim + system essentials — no codex.
  const bunPath = process.execPath;
  writeFileSync(join(shimDir, "ssh"), `#!/bin/sh\nexec "${bunPath}" "${FIXTURE}" "$@"\n`);
  chmodSync(join(shimDir, "ssh"), 0o755);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function harnessEnv(): Record<string, string> {
  return {
    ...process.env,
    OMG_DATA_DIR: dataDir,
    LFG_MAC_SSH_TARGET: "mac-fixture",
    LFG_MAC_BRIDGE_URL: "http://127.0.0.1:18866",
    LFG_MAC_BRIDGE_TOKEN: "t".repeat(40),
    LFG_MAC_NAMESPACES: "omg,workspace",
    LFG_MAC_REQUEST_ID: crypto.randomUUID(),
    FIXTURE_OUT: outDir,
    FIXTURE_PROVIDER_THREAD: threadId,
    PATH: `${shimDir}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? "",
  };
}

function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 150);
    };
    tick();
  });
}

describe("real codex harness on the mac route (fixture ssh)", () => {
  test("two turns: fresh nonce per turn, native thread resume, journaled ids, central transcript, no local codex", async () => {
    const child = Bun.spawn([
      process.execPath, HARNESS,
      "--key", key,
      "--model", "gpt-5.5-codex",
      "--cwd", project,
      "--managed-name", "lfg-fx",
      "--execution-host", "mac",
      "--", "EERSTE BEURT",
    ], {
      cwd: project,
      env: harnessEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderrChunks: string[] = [];
    void (async () => {
      const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) stderrChunks.push(new TextDecoder().decode(value));
      }
    })().catch(() => {});

    // Turn 1 completes: fixture wrote the turn input AND a turn/completed
    // roundtrip happened (the harness indexes the assistant message).
    const registryEntry = join(dataDir, "aisdk", `${key}.json`);
    const cmdFile = join(dataDir, "aisdk", `${key}.cmd`);
    try {
      await waitUntil(() => existsSync(registryEntry), 15_000, "registry entry");
    } catch (error) {}
    await waitUntil(() => {
      if (!existsSync(registryEntry)) return false;
      try {
        const entry = JSON.parse(readFileSync(registryEntry, "utf8")) as { busy?: boolean; threadId?: string; remoteInit?: { state?: string } };
        return entry.busy === false && !!entry.threadId && entry.remoteInit?.state === "ready";
      } catch {
        return false;
      }
    }, 30_000, "turn 1 completion (busy=false, threadId, remoteInit ready)").catch((error) => {
      console.error("HARNESS STDERR:\n" + stderrChunks.join(""));
      try {
        console.error("REGISTRY:", readFileSync(registryEntry, "utf8"));
      } catch {}
      try {
        console.error("OUT:", require("node:fs").readdirSync(outDir).join(", "));
        console.error("METADATA:", readFileSync(join(outDir, "metadata.jsonl"), "utf8"));
        console.error("PROVIDER:", readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8").slice(0, 2000));
      } catch {}
      throw error;
    });

    const afterTurn1 = JSON.parse(readFileSync(registryEntry, "utf8")) as {
      executionHost?: string; threadId?: string | null; remoteInit?: { state?: string };
    };
    expect(afterTurn1.executionHost).toBe("mac");
    expect(afterTurn1.threadId).toBe(threadId);
    expect(afterTurn1.remoteInit?.state).toBe("ready");

    // Central context nonce ONE reached the provider (metadata + turn input).
    const metadataLines1 = readFileSync(join(outDir, "metadata.jsonl"), "utf8").trim().split("\n");
    expect(metadataLines1.length).toBe(1);
    expect(metadataLines1[0]).toContain("NONCE ONE");
    const providerStdin1 = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
    expect(providerStdin1).toContain("EERSTE BEURT");
    expect(providerStdin1).toContain("NONCE ONE");
    expect(providerStdin1).toContain("central-context");

    // Central source CHANGES between turns → nonce TWO must reach turn 2.
    writeFileSync(join(project, "AGENTS.md"), "PROJECT NONCE TWO");

    appendFileSync(cmdFile, `${JSON.stringify({ type: "send", text: "TWEEDE BEURT" })}\n`);
    await waitUntil(() => {
      const metadataLines = readFileSync(join(outDir, "metadata.jsonl"), "utf8").trim().split("\n");
      return metadataLines.length >= 2;
    }, 30_000, "turn 2 stream launch");

    await waitUntil(() => {
      const providerStdin = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
      return providerStdin.includes("TWEEDE BEURT") && providerStdin.includes("NONCE TWO");
    }, 30_000, "turn 2 input with fresh nonce");

    const metadataLines2 = readFileSync(join(outDir, "metadata.jsonl"), "utf8").trim().split("\n");
    const meta1 = JSON.parse(metadataLines2[0]!) as { requestId: string };
    const meta2 = JSON.parse(metadataLines2[1]!) as { requestId: string; context: unknown };
    expect(meta2.requestId).not.toBe(meta1.requestId); // fresh id per stream
    expect(JSON.stringify(meta2.context)).toContain("NONCE TWO"); // fresh context per turn

    // Native resume: turn 2 used thread/resume with the SAME thread id.
    const providerStdin = readFileSync(join(outDir, "provider-stdin.jsonl"), "utf8");
    const resumeLines = providerStdin.trim().split("\n").filter((l) => l.includes("thread/resume"));
    expect(resumeLines.length).toBeGreaterThanOrEqual(1);
    expect(resumeLines[0]).toContain(threadId);

    // Every stream id journaled: the pending record points at the LAST id.
    const journal = JSON.parse(readFileSync(join(dataDir, "aisdk", `${key}.macstart.json`), "utf8")) as { requestId: string; state: string };
    expect(journal.requestId).toBe(meta2.requestId);
    expect(journal.state).toBe("ready");

    process.on("exit", () => {
      if (stderrChunks.length) console.error("HARNESS STDERR:\n" + stderrChunks.join(""));
    });
    // Close the session cleanly.
    appendFileSync(cmdFile, `${JSON.stringify({ type: "close" })}\n`);
    await child.exited.catch(() => 0);

    // Central transcript: both turns indexed under the session key.
    // (Checked in a SUBPROCESS with OMG_DATA_DIR set before module load —
    // other test files mutate this process's env/PATHS caches.)
    const probe = Bun.spawnSync([
      process.execPath, "-e",
      `const { sessionHasIndexedMessages } = await import(${JSON.stringify(join(import.meta.dir.replace("/src/agents/backends", "/src"), "transcript-index.ts"))}); process.exit(sessionHasIndexedMessages(${JSON.stringify(key)}) ? 0 : 3);`,
    ], { env: { ...process.env, OMG_DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe" });
    expect(probe.exitCode).toBe(0);
    const { readEntry } = await import("../../aisdk-registry.ts");
    expect(readEntry(key)?.threadId ?? null).toBe(null); // harness removed its entry on close

    // No local codex was ever spawned: PATH had none, and the harness never
    // exited with the "installed Codex CLI not found" failure.
    expect(stderrChunks.join("")).not.toContain("installed Codex CLI not found");
  }, 90_000);
});
