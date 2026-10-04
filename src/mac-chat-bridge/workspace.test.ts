// Focused tests for the /mcp/workspace tool surface: guarded list/read,
// CAS writes with the idempotency journal (concurrency, crash-after-claim,
// replay, conflict), path/secret/symlink denial, root flags, and full
// get_context freshness. Fixtures live under the build tmp dir; no network,
// no $HOME access, no upstream.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { LeaseRegistry } from "./lease.ts";
import { createMacChatBridge } from "./bridge.ts";
import { payloadHashOf } from "./journal.ts";
import { writeRawBytesForTests } from "./workspace.ts";

const BASE = "/Users/samht/.cache/mac-headchat-build-20261003/tmp";
const TOKEN = "workspace-test-token-0123456789";

let runDir: string;
let proj: string;
let readonlyDir: string;
let writeonlyDir: string;
let instructionsFile: string;
let skillRoot: string;
let memoryRoot: string;
let outside: string;

beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
  runDir = mkdtempSync(join(BASE, "workspace-"));
  proj = join(runDir, "proj");
  readonlyDir = join(runDir, "readonly");
  writeonlyDir = join(runDir, "writeonly");
  outside = join(runDir, "outside");
  instructionsFile = join(runDir, "AGENTS.md");
  skillRoot = join(runDir, "skills");
  memoryRoot = join(runDir, "memory");
  for (const dir of [proj, readonlyDir, writeonlyDir, outside, join(skillRoot, "deploy-skill"), join(skillRoot, "not-a-skill"), memoryRoot]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(instructionsFile, "instr-v1", "utf8");
  writeFileSync(join(skillRoot, "deploy-skill", "SKILL.md"), "# deploy", "utf8");
  writeFileSync(join(skillRoot, "not-a-skill", "README.md"), "no skill file", "utf8");
  writeFileSync(join(memoryRoot, "MEMORY.md"), "memory-v1", "utf8");
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function makeBridge(workspaceLimits?: Record<string, number>) {
  const registry = new LeaseRegistry();
  registry.register({
    id: "sess-w",
    token: TOKEN,
    expiresAt: Date.now() + 60_000,
    cwd: proj,
    roots: [
      { path: proj, read: true, write: true },
      { path: readonlyDir, read: true, write: false },
      { path: writeonlyDir, read: false, write: true },
    ],
    instructions: [instructionsFile],
    skillRoots: [skillRoot],
    memoryRoots: [memoryRoot],
    role: "mac-chat",
    namespaces: {},
  });
  const bridge = createMacChatBridge({ registry, journalDir: join(runDir, "journal"), workspaceLimits });
  return { bridge, registry };
}

function wsUrl(query = ""): string {
  return `http://127.0.0.1:8767/mcp/workspace?session=sess-w${query}`;
}

const authHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

type ToolOutcome = { isError: boolean; text: string; payload: Record<string, unknown> | null };

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const { bridge } = makeBridge();
  const res = await bridge.handle(new Request(wsUrl(), {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
  const text = body.result.content[0].text;
  // Error results carry a human-readable message; success results carry JSON.
  return { isError: body.result.isError, text, payload: body.result.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
}

/** Success-only helper: asserts the call succeeded and returns its JSON payload. */
async function callToolOk(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await callTool(name, args);
  expect(outcome.isError).toBe(false);
  return outcome.payload as Record<string, unknown>;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("read_file and list_files", () => {
  test("read returns content plus the sha of the exact bytes", async () => {
    writeFileSync(join(proj, "notes.md"), "hello bridge", "utf8");
    const payload = await callToolOk("read_file", { path: "notes.md" });
    expect(payload.content).toBe("hello bridge");
    expect(payload.sha256).toBe(sha("hello bridge"));
    expect(payload.bytes).toBe(12);
  });

  test("read from a write-only root is denied", async () => {
    writeFileSync(join(writeonlyDir, "w.txt"), "x", "utf8");
    const { isError, text } = await callTool("read_file", { path: join(writeonlyDir, "w.txt") });
    expect(isError).toBe(true);
    expect(text).toContain("denied");
  });

  test("reading non-UTF-8 bytes is refused, not corrupted", async () => {
    const bin = join(proj, "blob.bin");
    writeRawBytesForTests(bin, new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
    const { isError, text } = await callTool("read_file", { path: "blob.bin" });
    expect(isError).toBe(true);
    expect(text).toContain("UTF-8");
  });

  test("list skips .git, .env and symlinks and stays inside the root", async () => {
    mkdirSync(join(proj, ".git"), { recursive: true });
    writeFileSync(join(proj, ".git", "HEAD"), "ref", "utf8");
    writeFileSync(join(proj, ".env"), "SECRET=1", "utf8");
    writeFileSync(join(proj, "ok.txt"), "ok", "utf8");
    mkdirSync(join(proj, "sub"), { recursive: true });
    writeFileSync(join(proj, "sub", "deep.txt"), "deep", "utf8");
    symlinkSync(outside, join(proj, "link-out"));
    const payload = await callToolOk("list_files", {});
    const entries = payload.entries as { path: string; type: string }[];
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("ok.txt");
    expect(paths).toContain("sub/deep.txt");
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("link-out");
    expect(paths.some((p) => p.includes("outside"))).toBe(false);
  });

  test("list from a write-only root is denied (read flag governs list)", async () => {
    const { isError } = await callTool("list_files", { path: writeonlyDir });
    expect(isError).toBe(true);
  });
});

describe("write_file compare-and-swap", () => {
  test("new file: expected null creates it and returns the fresh revision", async () => {
    const payload = await callToolOk("write_file", {
      path: "new.txt", content: "first", expectedSha256: null, callId: randomUUID(),
    });
    expect(payload.sha256).toBe(sha("first"));
    expect(readFileSync(join(proj, "new.txt"), "utf8")).toBe("first");
  });

  test("expected null on an existing file is a conflict, disk untouched", async () => {
    writeFileSync(join(proj, "exists.txt"), "original", "utf8");
    const { isError, text } = await callTool("write_file", {
      path: "exists.txt", content: "clobber", expectedSha256: null, callId: randomUUID(),
    });
    expect(isError).toBe(true);
    expect(text).toContain("revision conflict");
    expect(readFileSync(join(proj, "exists.txt"), "utf8")).toBe("original");
  });

  test("stale expected sha is a conflict, disk untouched", async () => {
    writeFileSync(join(proj, "cas.txt"), "v1", "utf8");
    const { isError, text } = await callTool("write_file", {
      path: "cas.txt", content: "v2", expectedSha256: sha("wrong"), callId: randomUUID(),
    });
    expect(isError).toBe(true);
    expect(text).toContain("revision conflict");
    expect(readFileSync(join(proj, "cas.txt"), "utf8")).toBe("v1");
  });

  test("correct expected sha overwrites and moves the revision", async () => {
    writeFileSync(join(proj, "ovw.txt"), "v1", "utf8");
    const payload = await callToolOk("write_file", {
      path: "ovw.txt", content: "v2", expectedSha256: sha("v1"), callId: randomUUID(),
    });
    expect(payload.sha256).toBe(sha("v2"));
    expect(readFileSync(join(proj, "ovw.txt"), "utf8")).toBe("v2");
  });

  test("write into a read-only root is denied", async () => {
    const { isError, text } = await callTool("write_file", {
      path: join(readonlyDir, "x.txt"), content: "x", expectedSha256: null, callId: randomUUID(),
    });
    expect(isError).toBe(true);
    expect(text).toContain("denied");
    expect(existsSync(join(readonlyDir, "x.txt"))).toBe(false);
  });

  test("missing or malformed callId / expectedSha is rejected before any claim", async () => {
    const noId = await callTool("write_file", { path: "a.txt", content: "x", expectedSha256: null });
    expect(noId.isError).toBe(true);
    expect(noId.text).toContain("callId");
    const badSha = await callTool("write_file", { path: "a.txt", content: "x", expectedSha256: "zz", callId: randomUUID() });
    expect(badSha.isError).toBe(true);
    expect(badSha.text).toContain("expectedSha256");
    expect(existsSync(join(proj, "a.txt"))).toBe(false);
  });

  test("content over the write cap is refused", async () => {
    const { bridge } = makeBridge({ maxWriteBytes: 128 });
    const res = await bridge.handle(new Request(wsUrl(), {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: { path: "big.txt", content: "y".repeat(3000), expectedSha256: null, callId: randomUUID() } } }),
    }));
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("write cap");
    expect(existsSync(join(proj, "big.txt"))).toBe(false);
  });
});

describe("idempotency journal", () => {
  test("same callId + same payload replays the recorded result without writing again", async () => {
    const callId = randomUUID();
    const args = { path: "idem.txt", content: "one", expectedSha256: null, callId };
    const first = await callTool("write_file", args);
    expect(first.isError).toBe(false);
    const before = readFileSync(join(proj, "idem.txt"), "utf8");
    const second = await callToolOk("write_file", args);
    expect(second.replay).toBe(true);
    expect((second.recordedOutcome as { kind: string }).kind).toBe("written");
    expect(readFileSync(join(proj, "idem.txt"), "utf8")).toBe(before);
  });

  test("same callId + different payload is a conflict", async () => {
    const callId = randomUUID();
    await callTool("write_file", { path: "conf.txt", content: "a", expectedSha256: null, callId });
    const second = await callTool("write_file", { path: "conf.txt", content: "b", expectedSha256: null, callId });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("callId conflict");
    expect(readFileSync(join(proj, "conf.txt"), "utf8")).toBe("a");
  });

  test("crash after claim: in-flight journal entry yields outcome_unknown and no replay", async () => {
    const { bridge, registry } = makeBridge();
    // Forge exactly what a crash between claim and mutation leaves behind.
    const { IdempotencyJournal } = await import("./journal.ts");
    const journal = new IdempotencyJournal(join(runDir, "journal"));
    const callId = randomUUID();
    const path = join(proj, "crash.txt");
    const payloadHash = payloadHashOf({ path: "crash.txt", content: "boom", expectedSha256: null });
    journal.forgeInFlight("sess-w", callId, payloadHash, path);
    const res = await bridge.handle(new Request(wsUrl(), {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: { path: "crash.txt", content: "boom", expectedSha256: null, callId } } }),
    }));
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("outcome_unknown");
    expect(existsSync(path)).toBe(false); // never replayed the mutation
    expect(registry.size()).toBe(1);
  });

  test("concurrent conflicting writes: exactly one wins, the loser sees a conflict", async () => {
    const { bridge } = makeBridge();
    const send = async (content: string, callId: string) => {
      const res = await bridge.handle(new Request(wsUrl(), {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "write_file", arguments: { path: "race.txt", content, expectedSha256: null, callId } },
        }),
      }));
      const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
      return { isError: body.result.isError, text: body.result.content[0].text };
    };
    const [ra, rb] = await Promise.all([send("left", randomUUID()), send("right", randomUUID())]);
    const outcomes = [ra, rb].sort((a, b) => Number(a.isError) - Number(b.isError));
    expect(outcomes[0].isError).toBe(false);
    expect(outcomes[1].isError).toBe(true);
    expect(outcomes[1].text).toContain("revision conflict");
    const onDisk = readFileSync(join(proj, "race.txt"), "utf8");
    expect(["left", "right"]).toContain(onDisk);
    // The winner's recorded revision matches the disk exactly.
    const winner = JSON.parse(outcomes[0].text) as { sha256: string };
    expect(winner.sha256).toBe(sha(onDisk));
  });

  test("concurrent identical callIds: one result is definitive, the duplicate never re-executes", async () => {
    const { bridge } = makeBridge();
    const callId = randomUUID();
    const send = () => bridge.handle(new Request(wsUrl(), {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "write_file", arguments: { path: "same-id.txt", content: "same", expectedSha256: null, callId } },
      }),
    }));
    const [ra, rb] = await Promise.all([send(), send()]);
    const textOf = async (res: Response): Promise<string> =>
      ((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text;
    const [ta, tb] = await Promise.all([textOf(ra), textOf(rb)]);
    // Exactly one write happened; the file is intact.
    expect(readFileSync(join(proj, "same-id.txt"), "utf8")).toBe("same");
    // The duplicate either saw the in-flight claim (outcome_unknown) or the
    // finished record (replay). Re-execution would show a second written
    // result with a fresh write — impossible by construction, asserted below.
    const writes = [ta, tb].filter((t) => !t.includes("outcome_unknown") && !t.includes("replay"));
    expect(writes.length).toBe(1);
    expect(JSON.parse(writes[0]).sha256).toBe(sha("same"));
  });
});

describe("path, secret and symlink guards", () => {
  test("relative and absolute escapes are denied and nothing lands outside", async () => {
    for (const bad of ["../escape.txt", "sub/../../escape.txt", join(outside, "escape.txt"), "/etc/passwd"]) {
      const { isError, text } = await callTool("write_file", {
        path: bad, content: "x", expectedSha256: null, callId: randomUUID(),
      });
      expect(isError).toBe(true);
      expect(text).toContain("denied");
    }
    expect(existsSync(join(runDir, "escape.txt"))).toBe(false);
    expect(existsSync(join(outside, "escape.txt"))).toBe(false);
  });

  test("forbidden names are rejected for read and write, even inside the broad root", async () => {
    mkdirSync(join(proj, ".git"), { recursive: true });
    writeFileSync(join(proj, ".env"), "X=1", "utf8");
    writeFileSync(join(proj, ".git", "HEAD"), "ref", "utf8");
    const bad = [".env", "prod.env", ".git/HEAD", "creds/credentials.json", "share/secrets.md", "keys/server.key", "id_rsa", "cert.pem", "vault.kdbx"];
    for (const path of bad) {
      const w = await callTool("write_file", { path, content: "x", expectedSha256: null, callId: randomUUID() });
      expect(w.isError).toBe(true);
      const r = await callTool("read_file", { path });
      expect(r.isError).toBe(true);
    }
    // The pre-existing .env inside the root is unreadable too.
    const r = await callTool("read_file", { path: ".env" });
    expect(r.isError).toBe(true);
  });

  test("symlinked file, dangling symlink and symlinked directory component are all denied", async () => {
    const outsideFile = join(outside, "real.txt");
    writeFileSync(outsideFile, "real", "utf8");
    symlinkSync(outsideFile, join(proj, "inroot-link"));
    symlinkSync(join(outside, "never.txt"), join(proj, "dangling-link"));
    const outsideDir = join(outside, "dir");
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(join(proj, "via"), { recursive: true });
    symlinkSync(outsideDir, join(proj, "via", "linkdir"));

    for (const readPath of ["inroot-link", "dangling-link", "via/linkdir/file.txt"]) {
      const r = await callTool("read_file", { path: readPath });
      expect(r.isError).toBe(true);
    }
    for (const writePath of ["inroot-link", "dangling-link", "via/linkdir/new.txt"]) {
      const w = await callTool("write_file", { path: writePath, content: "x", expectedSha256: null, callId: randomUUID() });
      expect(w.isError).toBe(true);
    }
    expect(readFileSync(outsideFile, "utf8")).toBe("real");
    expect(existsSync(join(outsideDir, "file.txt"))).toBe(false);
    expect(existsSync(join(outsideDir, "new.txt"))).toBe(false);
    expect(existsSync(join(outside, "never.txt"))).toBe(false);
  });

  test("hostile cwd query/header cannot widen the workspace", async () => {
    const { bridge } = makeBridge();
    const res = await bridge.handle(new Request(wsUrl("&cwd=/"), {
      method: "POST",
      headers: { ...authHeaders, "x-omg-cwd": "/" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: { path: "Users/samht/.ssh/authorized_keys", content: "x", expectedSha256: null, callId: randomUUID() } } }),
    }));
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("denied");
  });
});

describe("get_context freshness and manifests", () => {
  test("returns full instruction content and reflects changes on the next call", async () => {
    const first = await callToolOk("get_context", {});
    const instr1 = (first.instructions as { path: string; content: string; sha256: string }[])[0];
    expect(instr1.content).toBe("instr-v1");
    expect(instr1.sha256).toBe(sha("instr-v1"));
    const revision1 = first.revision as string;

    writeFileSync(instructionsFile, "instr-v2-changed", "utf8");
    const second = await callToolOk("get_context", {});
    const instr2 = (second.instructions as { path: string; content: string; sha256: string }[])[0];
    expect(instr2.content).toBe("instr-v2-changed");
    expect(instr2.sha256).toBe(sha("instr-v2-changed"));
    expect(second.revision).not.toBe(revision1);

    // Memory manifest is hashed too, so central state changes are visible.
    const mem = (second.memory as { root: string; files: { path: string; sha256: string }[] }[])[0];
    expect(mem.files[0].sha256).toBe(sha("memory-v1"));
  });

  test("skill manifest discovers only dirs with SKILL.md; missing instruction is explicit", async () => {
    writeFileSync(instructionsFile, "x", "utf8");
    const payload = await callToolOk("get_context", {});
    const skills = (payload.skills as { root: string; skills: { name: string }[] }[])[0];
    expect(skills.skills.map((s) => s.name)).toEqual(["deploy-skill"]);
    const registry2 = new LeaseRegistry();
    const missingInstr = join(runDir, "MISSING.md");
    registry2.register({
      id: "sess-missing", token: TOKEN, expiresAt: Date.now() + 60_000, cwd: proj,
      roots: [{ path: proj, read: true, write: true }], instructions: [missingInstr],
      skillRoots: [], memoryRoots: [], role: "mac-chat", namespaces: {},
    });
    const bridge2 = createMacChatBridge({ registry: registry2, journalDir: join(runDir, "journal2") });
    const res = await bridge2.handle(new Request("http://127.0.0.1:8767/mcp/workspace?session=sess-missing", {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_context", arguments: {} } }),
    }));
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const out = JSON.parse(body.result.content[0].text) as { instructions: { missing?: boolean }[] };
    expect(out.instructions[0].missing).toBe(true);
  });
});
