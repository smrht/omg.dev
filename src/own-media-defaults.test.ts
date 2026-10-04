/**
 * Real-path tests for the DEFAULT artifact factory: Sharp must decode images,
 * ffprobe must validate videos, and a magic-byte prefix is never enough. These
 * run in a child process with OMG_DATA_DIR pointed at a scratch dir so the
 * real artifacts store is never touched; the parent test spawns the child and
 * asserts its exit code, which keeps this file correct no matter which other
 * test files share the process (module-level PATHS would already be frozen).
 *
 * Tiny REAL fixtures: a valid 1x1 PNG, its truncated signature (magic bytes
 * without a decodable image), and an ffmpeg-generated valid MP4.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD_FLAG = "OMG_OWN_MEDIA_DEFAULTS_CHILD";
const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngBytes(): Uint8Array {
  const bin = atob(VALID_PNG_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** PNG signature only: passes the magic-byte sniff, cannot decode. */
function truncatedPngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/** MP4 box header only: passes the video sniff, not playable. */
function truncatedMp4Bytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x00, 0x00, 0x00, 0x20], 0);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  return bytes;
}

if (!process.env[CHILD_FLAG]) {
  describe("own-media default factory (child-isolated)", () => {
    test(
      "valid and invalid real media through the real factory: child suite passes",
      async () => {
        const scratch = mkdtempSync(join(tmpdir(), "own-media-defaults-"));
        const proc = Bun.spawn(["bun", "test", import.meta.path], {
          cwd: import.meta.dir,
          env: { ...process.env, [CHILD_FLAG]: "1", OMG_DATA_DIR: join(scratch, "data") },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        if (exitCode !== 0) console.error(stdout + stderr);
        expect(exitCode).toBe(0);
        // All four child scenarios ran and passed (names only print on failure).
        expect(stdout + stderr).toContain("4 pass");
        expect(stdout + stderr).toContain("0 fail");
      },
      30_000,
    );
  });
} else {
  // Child process: OMG_DATA_DIR was set before any module import, so the
  // artifacts store lands in the scratch dir.
  const dataDir = process.env.OMG_DATA_DIR!;
  const uploadsRoot = mkdtempSync(join(tmpdir(), "own-media-defaults-up-"));
  const scratch = mkdtempSync(join(tmpdir(), "own-media-defaults-cat-"));
  const catalogPath = join(scratch, "catalog.json");
  writeFileSync(
    catalogPath,
    JSON.stringify({ providers: { openai: { models: [{ id: "gpt-image-1", quote: { amount: 0.04, unit: "usd" }, maxCredits: 0.1 }] } } }),
  );

  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const mod = await import("./own-media.ts");

  const hasFfprobe = Bun.which("ffprobe") !== null && Bun.which("ffmpeg") !== null;

  let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  const opts = () =>
    ({
      env: { OPENAI_API_KEY: "sk-test-openai-abcdef1234567890" },
      dataDir,
      uploadsRoot,
      catalogPath,
      minPollIntervalMs: 0,
      threadExists: () => false,
      resolveHost: async () => ["93.184.216.34"],
      fetch: (url: string, init?: RequestInit) => fetchImpl(url, init),
      // NO artifactFactory injection: the default factory with Sharp + ffprobe
      // validation IS the subject under test.
      onJobCompleted: (job: unknown, media: unknown) => completed.push({ job, media }),
    }) as never;

  let completed: { job: unknown; media: unknown }[] = [];

  beforeEach(() => {
    completed = [];
  });

  function artifactFileFor(urlPath: string): string | null {
    const id = decodeURIComponent(urlPath.split("/").pop() ?? "");
    if (!id) return null;
    for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"]) {
      const p = join(dataDir, "artifacts", "files", `${id}${ext}`);
      if (existsSync(p)) return p;
    }
    return null;
  }

  test("valid png upload becomes a real artifact with dimensions", async () => {
    fetchImpl = async () => jsonResponse(500, {});
    const { job } = await mod.submitOwnMediaJob(
      { requestId: "defaults-upload-1", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      opts(),
    );
    const uploaded = join(uploadsRoot, "result.png");
    writeFileSync(uploaded, pngBytes());
    const done = await mod.completeOwnMediaJob(job.id, { path: uploaded, name: "result.png" }, opts());
    expect(done.status).toBe("succeeded");
    expect(done.result?.urlPath).toMatch(/^\/api\/artifacts\//);
    const file = artifactFileFor(done.result!.urlPath);
    expect(file).not.toBeNull();
    expect(readFileSync(file!).length).toBe(pngBytes().length);
    expect(completed).toHaveLength(1);
  });

  test("truncated png prefix is refused: no artifact, no callback", async () => {
    fetchImpl = async () => jsonResponse(500, {});
    const { job } = await mod.submitOwnMediaJob(
      { requestId: "defaults-upload-2", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      opts(),
    );
    const uploaded = join(uploadsRoot, "truncated.png");
    writeFileSync(uploaded, truncatedPngBytes());
    const err = await mod.completeOwnMediaJob(job.id, { path: uploaded }, opts()).catch((e) => e);
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe("invalid_result_path");
    expect(String(err.message)).toContain("niet gelezen");
    expect(completed).toEqual([]);
    // Complete PNG IHDR and chunk header, but no decodable image payload:
    // metadata-only validation used to accept this.
    const headerOnly = join(uploadsRoot, "header-only.png");
    writeFileSync(headerOnly, pngBytes().slice(0, 45));
    const headerErr = await mod.completeOwnMediaJob(job.id, { path: headerOnly }, opts()).catch((e) => e);
    expect(headerErr.httpStatus).toBe(400);
    expect(completed).toEqual([]);
  });

  test("provider result goes through the same validation: valid b64 succeeds, truncated fails", async () => {
    // Valid: real 1x1 PNG from the OpenAI b64 path.
    fetchImpl = async () => jsonResponse(200, { created: 1, data: [{ b64_json: VALID_PNG_BASE64 }] });
    const good = await mod.submitOwnMediaJob(
      { requestId: "defaults-openai-1", provider: "openai", model: "gpt-image-1", kind: "image", prompt: "poster", costAcknowledged: true },
      opts(),
    );
    expect(good.job.status).toBe("succeeded");
    expect(artifactFileFor(good.job.result!.urlPath)).not.toBeNull();

    // Truncated: magic prefix passes the sniff, Sharp decode fails in the
    // default factory, the job fails honestly with no artifact.
    const truncatedBase64 = Buffer.from(truncatedPngBytes()).toString("base64");
    fetchImpl = async () => jsonResponse(200, { created: 1, data: [{ b64_json: truncatedBase64 }] });
    const bad = await mod.submitOwnMediaJob(
      { requestId: "defaults-openai-2", provider: "openai", model: "gpt-image-1", kind: "image", prompt: "poster", costAcknowledged: true },
      opts(),
    ).catch((e) => e);
    expect(bad).toBeInstanceOf(mod.OwnMediaError);
    expect(bad.message).toContain("niet gelezen");
  });

  test.skipIf(!hasFfprobe)("valid ffmpeg-made mp4 uploads; truncated ftyp head is refused", async () => {
    // A real, playable 0.4s video.
    const valid = join(uploadsRoot, "real.mp4");
    const gen = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5", "-t", "0.4", "-pix_fmt", "yuv420p", "-y", valid]);
    expect(gen.exitCode).toBe(0);

    fetchImpl = async () => jsonResponse(500, {});
    const { job } = await mod.submitOwnMediaJob(
      { requestId: "defaults-video-1", provider: "google-flow", model: "hint", kind: "video", prompt: "clip" },
      opts(),
    );
    const done = await mod.completeOwnMediaJob(job.id, { path: valid, name: "real.mp4" }, opts());
    expect(done.status).toBe("succeeded");
    expect(artifactFileFor(done.result!.urlPath)).not.toBeNull();
    expect(completed).toHaveLength(1); // the valid video

    // Header-only mp4: sniff passes, ffprobe cannot read it, refused.
    const { job: bad } = await mod.submitOwnMediaJob(
      { requestId: "defaults-video-2", provider: "google-flow", model: "hint", kind: "video", prompt: "clip" },
      opts(),
    );
    const truncated = join(uploadsRoot, "head.mp4");
    writeFileSync(truncated, truncatedMp4Bytes());
    const err = await mod.completeOwnMediaJob(bad.id, { path: truncated }, opts()).catch((e) => e);
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe("invalid_result_path");
    expect(String(err.message)).toContain("ffprobe");
  });
}
