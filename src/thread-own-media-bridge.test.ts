/**
 * The own-media thread bridge, offline: a browser-route request through the
 * real HTTP handler, with every provider replaced by injections, and the
 * finished result landing in the thread exactly once — the contract the serve
 * wiring (handleOwnMediaRequest + onJobCompleted -> appendThreadMessage) runs
 * on. No network, no generation, no credits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { handleOwnMediaRequest, type OwnMediaArtifactMedia, type OwnMediaJob } from "./own-media.ts";
import { appendThreadMessage, readThreadMessages, startThread, threadAuthor } from "./threads.ts";
import type { ThreadMedia } from "../packages/protocol/src/threads.ts";

const originalData = PATHS.data;
let root: string;
let uploads: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omg-thread-media-"));
  PATHS.data = join(root, "data");
  uploads = join(root, "uploads");
  mkdirSync(uploads, { recursive: true });
});

afterEach(() => {
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function ownMediaOpts(onJobCompleted: (job: OwnMediaJob, media: OwnMediaArtifactMedia) => void) {
  return {
    dataDir: join(root, "own-media"),
    uploadsRoot: uploads,
    env: {},
    fetch: (async () => {
      throw new Error("network attempted in offline test");
    }) as unknown as typeof fetch,
    threadExists: (threadId: string) => threadId === existingThread.id,
    artifactFactory: async (input: { kind: string; path: string; caption: string; alt: string }): Promise<OwnMediaArtifactMedia> => ({
      urlPath: `/api/artifacts/fake-${input.kind}`,
      name: "result.png",
      width: 1,
      height: 1,
    }),
    onJobCompleted,
  };
}

let existingThread: ReturnType<typeof startThread>;

describe("own media results reach the thread through the serve bridge", () => {
  test("offline: request -> pending_handoff -> uploaded result -> artifact -> one thread message", async () => {
    existingThread = startThread({ identity: "benny@example.com" });
    const author = threadAuthor(existingThread.id, "benny@example.com", "Benny");
    const completed: Array<{ job: OwnMediaJob; media: OwnMediaArtifactMedia }> = [];
    const opts = ownMediaOpts((job, media) => completed.push({ job, media }));

    // 1. Submit: a browser-route (ChatGPT) job tied to the thread. No network,
    //    no credits: it lands as pending_handoff with a handoff URL.
    const submit = await handleOwnMediaRequest(
      new Request("http://x/api/own-media/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "threadmedia-0001",
          provider: "chatgpt",
          model: "gpt-image",
          kind: "image",
          prompt: "Een ronde logo-schets",
          threadId: existingThread.id,
        }),
      }),
      new URL("http://x/api/own-media/jobs"),
      opts,
    );
    expect(submit?.status).toBe(201);
    const job = (await submit!.json()) as { job: OwnMediaJob };
    expect(job.job.status).toBe("pending_handoff");
    expect(job.job.threadId).toBe(existingThread.id);

    // A repeat submit with the same requestId is idempotent: same job, no new one.
    const again = await handleOwnMediaRequest(
      new Request("http://x/api/own-media/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "threadmedia-0001",
          provider: "chatgpt",
          model: "gpt-image",
          kind: "image",
          prompt: "Een ronde logo-schets",
          threadId: existingThread.id,
        }),
      }),
      new URL("http://x/api/own-media/jobs"),
      opts,
    );
    expect(again?.status).toBe(200);

    // 2. Complete with a real uploaded PNG inside the uploads root.
    const uploaded = join(uploads, "result.png");
    writeFileSync(uploaded, PNG);
    const before = readThreadMessages(existingThread.id).length;
    const finish = await handleOwnMediaRequest(
      new Request(`http://x/api/own-media/jobs/${job.job.id}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: uploaded, name: "logo.png" }),
      }),
      new URL(`http://x/api/own-media/jobs/${job.job.id}/result`),
      opts,
    );
    expect(finish?.status).toBe(200);

    // 3. Exactly one completion, carrying the artifact the factory registered.
    expect(completed).toHaveLength(1);
    expect(completed[0]!.job.status).toBe("succeeded");
    expect(completed[0]!.media).toMatchObject({ urlPath: "/api/artifacts/fake-image", name: "result.png" });

    // 4. The serve bridge shape: that media becomes a ThreadMedia message in
    //    the thread, posted once, never by @omg inference. (The serve wiring
    //    calls appendThreadMessage with exactly these fields.)
    const message = appendThreadMessage(existingThread.id, {
      author: { kind: "omg" },
      text: `Media klaar via ${completed[0]!.job.provider}.`,
      media: [
        {
          kind: completed[0]!.job.kind,
          path: completed[0]!.media.urlPath,
          name: completed[0]!.media.name,
          ...(completed[0]!.media.width != null ? { width: completed[0]!.media.width } : {}),
          ...(completed[0]!.media.height != null ? { height: completed[0]!.media.height } : {}),
        },
      ],
    });
    const rows = readThreadMessages(existingThread.id);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ id: message.id, author: { kind: "omg" }, text: "Media klaar via chatgpt." });
    expect((rows.at(-1)!.media as ThreadMedia[])[0]).toMatchObject({
      kind: "image",
      path: "/api/artifacts/fake-image",
      name: "result.png",
      width: 1,
      height: 1,
    });

    // 5. Completing again is refused: no second artifact, no second post.
    const duplicate = await handleOwnMediaRequest(
      new Request(`http://x/api/own-media/jobs/${job.job.id}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: uploaded, name: "logo.png" }),
      }),
      new URL(`http://x/api/own-media/jobs/${job.job.id}/result`),
      opts,
    );
    expect(duplicate?.status).toBe(409);
    expect(completed).toHaveLength(1);
  });

  test("a result file from outside the uploads root is refused, visibly", async () => {
    existingThread = startThread({ identity: "benny@example.com" });
    const opts = ownMediaOpts(() => {});
    const submit = await handleOwnMediaRequest(
      new Request("http://x/api/own-media/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "threadmedia-0002",
          provider: "chatgpt",
          model: "gpt-image",
          kind: "image",
          prompt: "Nog een schets",
          threadId: existingThread.id,
        }),
      }),
      new URL("http://x/api/own-media/jobs"),
      opts,
    );
    const { job } = (await submit!.json()) as { job: OwnMediaJob };
    const outside = join(root, "outside.png");
    writeFileSync(outside, PNG);
    const refused = await handleOwnMediaRequest(
      new Request(`http://x/api/own-media/jobs/${job.id}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: outside }),
      }),
      new URL(`http://x/api/own-media/jobs/${job.id}/result`),
      opts,
    );
    expect(refused?.status).toBe(400);
    const body = (await refused!.json()) as { error?: string };
    expect(body.error).toContain("uploadmap");
  });

  test("a job for a thread that does not exist is refused up front", async () => {
    existingThread = startThread({ identity: "benny@example.com" });
    const opts = ownMediaOpts(() => {});
    const ghost = crypto.randomUUID();
    const submit = await handleOwnMediaRequest(
      new Request("http://x/api/own-media/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "threadmedia-0003",
          provider: "chatgpt",
          model: "gpt-image",
          kind: "image",
          prompt: "Geheim",
          threadId: ghost,
        }),
      }),
      new URL("http://x/api/own-media/jobs"),
      opts,
    );
    expect(submit?.status).toBe(404);
    const body = (await submit!.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });
});
