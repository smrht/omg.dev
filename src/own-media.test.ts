/**
 * Offline tests for the own-media modules. Everything is injected: no real
 * provider call, no real spend, no real DNS. The provider transports are
 * fakes that record every call so "no duplicate paid call" and "exact
 * documented parameters" are counts and captured bodies, not hopes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelOwnMediaJob,
  completeOwnMediaJob,
  getOwnMediaJob,
  handleOwnMediaRequest,
  kieTaskInput,
  listOwnMediaProviders,
  OwnMediaError,
  ownMediaRequestFingerprint,
  resolveOwnMediaCatalog,
  sniffMediaKind,
  submitOwnMediaJob,
  sweepOwnMediaJobs,
  type OwnMediaArtifactMedia,
  type OwnMediaJob,
  type OwnMediaOptions,
} from "./own-media.ts";

const OPENAI_KEY = "sk-test-openai-abcdef1234567890";
const KIE_KEY = "kie-test-key-abcdef1234567890";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngBody(): Uint8Array {
  const bin = atob(PNG_1X1_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Minimal MP4 head: size box + "ftyp" — enough for the sniffer. */
function mp4Body(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x00, 0x00, 0x00, 0x20], 0);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  return bytes;
}

function htmlBody(): Uint8Array {
  return new TextEncoder().encode("<!DOCTYPE html><html><body>error page</body></html>");
}

let dataDir: string;
let uploadsRoot: string;
let scratch: string;
let fetchLog: { url: string; init?: RequestInit }[];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
let artifactCalls: { kind: string; sessionId: string; path: string }[];
let artifactMedia: OwnMediaArtifactMedia;
let completed: { job: OwnMediaJob; media: OwnMediaArtifactMedia }[];
let clock: number;

function baseOpts(extra: Partial<OwnMediaOptions> = {}): OwnMediaOptions {
  return {
    env: { OPENAI_API_KEY: OPENAI_KEY, KIE_API_KEY: KIE_KEY },
    dataDir,
    uploadsRoot,
    catalogPath: null,
    fetch: (url, init) => fetchImpl(url, init),
    now: () => clock,
    threadExists: (id) => id === THREAD_ID,
    artifactFactory: async (input) => {
      artifactCalls.push(input);
      return artifactMedia;
    },
    resolveHost: async (host) => {
      if (host === "private.kie.ai" || host === "intranet") return ["192.168.1.5"];
      return ["93.184.216.34"];
    },
    onJobCompleted: (job, media) => completed.push({ job, media }),
    minPollIntervalMs: 0,
    ...extra,
  };
}

/** A catalog file with a quote+cap: openai gpt-image-1, kie legacy + video adapter. */
function writeCatalog(models: unknown): string {
  const path = join(scratch, "catalog.json");
  writeFileSync(path, JSON.stringify(models));
  return path;
}

const QUOTED_CATALOG = {
  providers: {
    openai: {
      models: [{ id: "gpt-image-1", quote: { amount: 0.04, unit: "usd" }, maxCredits: 0.1 }],
    },
    kie: {
      models: [
        { id: "gpt-image-2-text-to-image", quote: { amount: 6, unit: "credits" }, maxCredits: 10 },
        { id: "gpt-image-2-5-flare-text-to-image", quote: { amount: 8, unit: "credits" }, maxCredits: 12 },
        { id: "wan/2-6-text-to-video", quote: { amount: 60, unit: "credits" }, maxCredits: 80 },
      ],
    },
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "own-media-test-"));
  dataDir = join(scratch, "data");
  uploadsRoot = join(scratch, "uploads");
  mkdirSync(uploadsRoot, { recursive: true });
  fetchLog = [];
  fetchImpl = async () => jsonResponse(500, {});
  artifactCalls = [];
  artifactMedia = { urlPath: "/api/artifacts/test-artifact", name: "test.png", width: 1, height: 1 };
  completed = [];
  clock = 1_000_000;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("provider catalog", () => {
  test("lists the four routes honestly: current documented models, no quotes, no secrets", () => {
    const result = listOwnMediaProviders(baseOpts());
    const ids = result.providers.map((p) => p.id);
    expect(ids).toEqual(["chatgpt", "openai", "google-flow", "kie"]);

    const chatgpt = result.providers[0];
    expect(chatgpt.route).toBe("browser");
    expect(chatgpt.handoffUrl).toBe("https://chatgpt.com");
    expect(chatgpt.costSource).toBe("subscription");
    expect(chatgpt.models).toEqual([]);

    const flow = result.providers[2];
    expect(flow.route).toBe("browser");
    expect(flow.handoffUrl).toBe("https://labs.google/fx/tools/flow");
    expect(flow.costSource).toBe("site_credits");

    const openai = result.providers[1];
    expect(openai.models.map((m) => m.id).slice(0, 3)).toEqual(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"]);
    expect(openai.models.map((m) => m.id)).toContain("gpt-image-1");
    for (const m of openai.models) expect(m.quote).toBeUndefined();

    const kie = result.providers[3];
    expect(kie.models.map((m) => m.id)).toContain("gpt-image-2-5-flare-text-to-image");
    expect(kie.models.map((m) => m.id)).toContain("gpt-image-2-5-sunburst-text-to-image");
    expect(kie.models.map((m) => m.id)).toContain("wan/2-6-text-to-video");
    for (const m of kie.models) expect(m.quote).toBeUndefined();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(OPENAI_KEY);
    expect(serialized).not.toContain(KIE_KEY);
  });

  test("KIE video support is exactly the one documented WAN adapter", () => {
    const catalog = resolveOwnMediaCatalog(baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) }));
    const video = catalog.kie.filter((m) => m.kind === "video");
    expect(video.map((m) => m.id)).toEqual(["wan/2-6-text-to-video"]);
    expect(video[0].durations).toEqual(["5", "10", "15"]);
    expect(video[0].resolutions).toEqual(["720p", "1080p"]);
  });

  test("OpenAI 2.5 exposes its documented extra quality settings only on those models", () => {
    const c = resolveOwnMediaCatalog(baseOpts());
    expect(c.openai.find(m => m.id === "gpt-image-2.5-sunburst")?.qualities).toContain("max");
    expect(c.openai.find(m => m.id === "gpt-image-2.5-flare")?.qualities).toContain("xhigh");
    expect(c.openai.find(m => m.id === "gpt-image-1")?.qualities).not.toContain("max");
  });

  test("rejects catalog entries with a quote but no cap", () => {
    const bad = { providers: { kie: { models: [{ id: "x", kind: "image", quote: { amount: 5, unit: "credits" } }] } } };
    expect(() => resolveOwnMediaCatalog(baseOpts({ catalogPath: writeCatalog(bad) }))).toThrow(OwnMediaError);
  });

  test("a KIE video entry without the WAN schema is a config error, not a silent generic payload", () => {
    const bad = { providers: { kie: { models: [{ id: "some-video", kind: "video" }] } } };
    const catalog = resolveOwnMediaCatalog(baseOpts({ catalogPath: writeCatalog(bad) }));
    expect(() => {
      // settings() runs this assertion; calling it directly keeps the unit tight.
      const { assertKieCatalogHonest } = require("./own-media.ts") as typeof import("./own-media.ts");
      assertKieCatalogHonest(catalog);
    }).toThrow(/gedocumenteerde video-adapter/);
    // And the payload builder refuses the same shape as a second gate.
    expect(() => kieTaskInput({ id: "some-video", label: "v", kind: "video" }, { prompt: "p" })).toThrow(OwnMediaError);
    expect(() => kieTaskInput({ id: "some-video", label: "v", kind: "video", durations: ["5"], resolutions: ["1080p"] }, { prompt: "p" })).toThrow(OwnMediaError);
    // Video entries WITH the schema are fine.
    expect(() =>
      kieTaskInput({ id: "wan/2-6-text-to-video", label: "wan", kind: "video", durations: ["5"], resolutions: ["1080p"] }, { prompt: "p", duration: "5", resolution: "1080p" }),
    ).not.toThrow();
  });
});

describe("kie task input builder (documented bodies only)", () => {
  test("WAN 2.6 video body matches the docs and never sends nsfw_checker", () => {
    const input = kieTaskInput(
      { id: "wan/2-6-text-to-video", label: "wan", kind: "video", durations: ["5", "10", "15"], resolutions: ["720p", "1080p"] },
      { prompt: "drone over duinen", duration: "10", resolution: "720p" },
    );
    expect(input).toEqual({ prompt: "drone over duinen", duration: "10", resolution: "720p", multi_shots: false });
    expect("nsfw_checker" in input).toBe(false);
  });

  test("GPT-Image 2.5 body uses aspect_ratio/resolution/background", () => {
    const input = kieTaskInput(
      { id: "gpt-image-2-5-flare-text-to-image", label: "flare", kind: "image", aspectRatios: ["3:2"], resolutions: ["1K", "2K", "4K"], backgrounds: ["transparent", "opaque", "auto"] },
      { prompt: "poster", aspectRatio: "3:2", resolution: "1K", background: "transparent" },
    );
    expect(input).toEqual({ prompt: "poster", aspect_ratio: "3:2", resolution: "1K", background: "transparent" });
  });

  test("legacy image body stays prompt/aspect_ratio/quality", () => {
    const input = kieTaskInput(
      { id: "gpt-image-2-text-to-image", label: "g2", kind: "image", aspectRatios: ["3:2"], qualities: ["low", "medium", "high"] },
      { prompt: "icon", aspectRatio: "3:2", quality: "medium" },
    );
    expect(input).toEqual({ prompt: "icon", aspect_ratio: "3:2", quality: "medium" });
  });
});

describe("content sniffing", () => {
  test("recognizes real image and video magic bytes, rejects other content", () => {
    expect(sniffMediaKind(pngBody())).toBe("image");
    expect(sniffMediaKind(mp4Body())).toBe("video");
    expect(sniffMediaKind(htmlBody())).toBeNull();
    expect(sniffMediaKind(new Uint8Array(0))).toBeNull();
  });
});

describe("browser handoff routes (honest manual flow)", () => {
  const chatgptInput = {
    requestId: "chatgpt-run-1",
    provider: "chatgpt" as const,
    model: "wat ChatGPT aanbiedt",
    kind: "video" as const,
    prompt: "draaiende aarde, cinematisch",
    threadId: THREAD_ID,
  };

  test("persists prompt and waits for the user; no provider call; repeat is idempotent", async () => {
    const { job, idempotent } = await submitOwnMediaJob(chatgptInput, baseOpts());
    expect(idempotent).toBe(false);
    expect(job.status).toBe("pending_handoff");
    expect(job.handoffUrl).toBe("https://chatgpt.com");
    expect(job.prompt).toBe("draaiende aarde, cinematisch");
    expect(job.threadId).toBe(THREAD_ID);
    expect(job.cost.source).toBe("subscription");
    expect(fetchLog).toEqual([]);

    // Identical repeat: same job, still no call.
    const again = await submitOwnMediaJob(chatgptInput, baseOpts());
    expect(again.idempotent).toBe(true);
    expect(again.job.id).toBe(job.id);
    expect(fetchLog).toEqual([]);

    // Same requestId, different input: a conflict, never a silent second job.
    const conflict = await submitOwnMediaJob({ ...chatgptInput, prompt: "iets anders" }, baseOpts()).catch((e) => e);
    expect(conflict).toBeInstanceOf(OwnMediaError);
    expect(conflict.code).toBe("conflict");
    expect(conflict.httpStatus).toBe(409);
  });

  test("google-flow is video-only and stores only a hint", async () => {
    const { job } = await submitOwnMediaJob(
      { requestId: "flow-run-1", provider: "google-flow", model: "Veo (in Flow gekozen)", kind: "video", prompt: "drone over duinen" },
      baseOpts(),
    );
    expect(job.status).toBe("pending_handoff");
    expect(job.handoffUrl).toBe("https://labs.google/fx/tools/flow");
    expect(job.cost.source).toBe("site_credits");
    await expect(
      submitOwnMediaJob({ requestId: "flow-run-2", provider: "google-flow", model: "x", kind: "image", prompt: "p" }, baseOpts()),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("manual result: upload under the uploads dir becomes an artifact on the thread", async () => {
    const { job } = await submitOwnMediaJob(
      { requestId: "chatgpt-run-2", provider: "chatgpt", model: "DALL-E in ChatGPT", kind: "image", prompt: "poster", threadId: THREAD_ID },
      baseOpts(),
    );
    const uploaded = join(uploadsRoot, "chatgpt-result.png");
    writeFileSync(uploaded, pngBody());

    const done = await completeOwnMediaJob(job.id, { path: uploaded, name: "poster.png" }, baseOpts());
    expect(done.status).toBe("succeeded");
    expect(done.result?.urlPath).toBe("/api/artifacts/test-artifact");
    expect(artifactCalls).toHaveLength(1);
    expect(artifactCalls[0].sessionId).toBe(THREAD_ID);
    expect(artifactCalls[0].path).toBe(realpathSync(uploaded));
    expect(completed).toHaveLength(1);
  });

  test("manual video result accepts real mp4 content", async () => {
    const { job } = await submitOwnMediaJob(
      { requestId: "flow-run-3", provider: "google-flow", model: "Veo", kind: "video", prompt: "clip" },
      baseOpts(),
    );
    const uploaded = join(uploadsRoot, "flow-result.mp4");
    writeFileSync(uploaded, mp4Body());
    const done = await completeOwnMediaJob(job.id, { path: uploaded }, baseOpts());
    expect(done.status).toBe("succeeded");
    expect(artifactCalls[0].sessionId).toBe(job.id);
  });

  test("rejects result paths outside the uploads dir, symlinks, wrong types and fake content", async () => {
    const { job } = await submitOwnMediaJob(
      { requestId: "chatgpt-run-4", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      baseOpts(),
    );
    const outside = join(scratch, "outside.png");
    writeFileSync(outside, pngBody());
    await expect(completeOwnMediaJob(job.id, { path: outside }, baseOpts())).rejects.toMatchObject({ code: "invalid_result_path" });

    const link = join(uploadsRoot, "link.png");
    symlinkSync(outside, link);
    await expect(completeOwnMediaJob(job.id, { path: link }, baseOpts())).rejects.toMatchObject({ code: "invalid_result_path" });

    const wrongType = join(uploadsRoot, "notes.txt");
    writeFileSync(wrongType, "geen afbeelding");
    await expect(completeOwnMediaJob(job.id, { path: wrongType }, baseOpts())).rejects.toMatchObject({ code: "invalid_result_path" });

    // .png extension, HTML content: the extension is a claim, the bytes decide.
    const fake = join(uploadsRoot, "fake.png");
    writeFileSync(fake, htmlBody());
    await expect(completeOwnMediaJob(job.id, { path: fake }, baseOpts())).rejects.toMatchObject({ code: "invalid_result_path" });

    expect(artifactCalls).toEqual([]);
  });

  test("a finished or cancelled handoff job cannot be completed again", async () => {
    const { job } = await submitOwnMediaJob(
      { requestId: "chatgpt-run-5", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      baseOpts(),
    );
    const uploaded = join(uploadsRoot, "one.png");
    writeFileSync(uploaded, pngBody());
    await completeOwnMediaJob(job.id, { path: uploaded }, baseOpts());
    await expect(completeOwnMediaJob(job.id, { path: uploaded }, baseOpts())).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("openai direct route", () => {
  const input = {
    requestId: "openai-run-1",
    provider: "openai" as const,
    model: "gpt-image-1",
    kind: "image" as const,
    prompt: "een fiets in een gracht",
    aspectRatio: "3:2",
    quality: "high",
    costAcknowledged: true,
  };

  test("sends the official payload (n pinned to 1, size, quality, timeout signal) and registers the b64 result", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { created: 1, data: [{ b64_json: PNG_1X1_BASE64 }] });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const { job } = await submitOwnMediaJob({ ...input, threadId: THREAD_ID }, opts);

    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0].url).toBe("https://api.openai.com/v1/images/generations");
    const body = JSON.parse(String(fetchLog[0].init!.body));
    expect(body).toEqual({ model: "gpt-image-1", prompt: "een fiets in een gracht", n: 1, size: "1536x1024", quality: "high" });
    expect((fetchLog[0].init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(fetchLog[0].init!.signal).toBeInstanceOf(AbortSignal);

    expect(job.status).toBe("succeeded");
    expect(job.cost).toEqual({ source: "api", acknowledged: true, quote: { amount: 0.04, unit: "usd" } });
    expect(artifactCalls[0].sessionId).toBe(THREAD_ID);
    expect(completed).toHaveLength(1);
  });

  test("current documented models are accepted and sized per the guide", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { created: 1, data: [{ b64_json: PNG_1X1_BASE64 }] });
    };
    const opts = baseOpts({
      catalogPath: writeCatalog({ providers: { openai: { models: [{ id: "gpt-image-2.5-sunburst", quote: { amount: 0.05, unit: "usd" }, maxCredits: 0.2 }] } } }),
    });
    const { job } = await submitOwnMediaJob({ ...input, model: "gpt-image-2.5-sunburst", aspectRatio: "1:1", quality: undefined }, opts);
    expect(job.status).toBe("succeeded");
    expect(JSON.parse(String(fetchLog[0].init!.body)).model).toBe("gpt-image-2.5-sunburst");
    expect(JSON.parse(String(fetchLog[0].init!.body)).size).toBe("1024x1024");
  });

  test("refuses to spend without an explicit cost acknowledgement", async () => {
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    await expect(submitOwnMediaJob({ ...input, costAcknowledged: undefined }, opts)).rejects.toMatchObject({ code: "cost_ack_required" });
    await expect(submitOwnMediaJob({ ...input, costAcknowledged: false }, opts)).rejects.toMatchObject({ code: "cost_ack_required" });
    expect(fetchLog).toEqual([]);
  });

  test("refuses when no admin quote is configured, and creates nothing", async () => {
    const opts = baseOpts(); // no catalog: no quote, no cap
    const err = await submitOwnMediaJob(input, opts).catch((e) => e);
    expect(err).toBeInstanceOf(OwnMediaError);
    expect(err.code).toBe("quote_unavailable");
    expect(fetchLog).toEqual([]);
    expect(() => readdirSync(join(dataDir, "own-media", "jobs"))).toThrow();
  });

  test("rejects unknown and cross-provider models", async () => {
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    await expect(submitOwnMediaJob({ ...input, model: "gpt-image-99" }, opts)).rejects.toMatchObject({ code: "unknown_model" });
    await expect(submitOwnMediaJob({ ...input, model: "gpt-image-2-text-to-image" }, opts)).rejects.toMatchObject({ code: "unknown_model" });
    await expect(
      submitOwnMediaJob({ ...input, provider: "kie", model: "gpt-image-1" }, opts),
    ).rejects.toMatchObject({ code: "unknown_model" });
    expect(fetchLog).toEqual([]);
  });

  test("sanitizes auth failures and never echoes the key; failed job blocks a repeat", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(500, { error: { message: `upstream barfed on ${OPENAI_KEY}` } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const err = await submitOwnMediaJob(input, opts).catch((e) => e);
    expect(err).toBeInstanceOf(OwnMediaError);
    expect(err.message).not.toContain(OPENAI_KEY);
    expect(err.message).toContain("[sleutel verwijderd]");
    const again = await submitOwnMediaJob(input, opts);
    expect(again.idempotent).toBe(true);
    expect(again.job.status).toBe("failed");
    expect(fetchLog).toHaveLength(1);
  });
});

describe("kie direct route", () => {
  const input = {
    requestId: "kie-run-1",
    provider: "kie" as const,
    model: "gpt-image-2-text-to-image",
    kind: "image" as const,
    prompt: "icon van een fiets",
    aspectRatio: "3:2",
    quality: "medium",
    costAcknowledged: true,
  };

  test("createTask uses the verified legacy payload and a timeout signal", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { code: 200, data: { taskId: "task-17" } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const { job } = await submitOwnMediaJob(input, opts);

    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0].url).toBe("https://api.kie.ai/api/v1/jobs/createTask");
    expect(fetchLog[0].init!.method).toBe("POST");
    expect((fetchLog[0].init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KIE_KEY}`);
    expect(fetchLog[0].init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(fetchLog[0].init!.body))).toEqual({
      model: "gpt-image-2-text-to-image",
      input: { prompt: "icon van een fiets", aspect_ratio: "3:2", quality: "medium" },
    });
    expect(job.status).toBe("submitted");
    expect(job.providerJobId).toBe("task-17");
    expect(job.cost.quote).toEqual({ amount: 6, unit: "credits" });
  });

  test("gpt-image-2-5-flare createTask sends the documented 2.5 parameters", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { code: 200, data: { taskId: "task-f" } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    await submitOwnMediaJob(
      {
        requestId: "kie-flare-1",
        provider: "kie",
        model: "gpt-image-2-5-flare-text-to-image",
        kind: "image",
        prompt: "poster",
        aspectRatio: "3:2",
        resolution: "2K",
        background: "transparent",
        costAcknowledged: true,
      },
      opts,
    );
    expect(JSON.parse(String(fetchLog[0].init!.body))).toEqual({
      model: "gpt-image-2-5-flare-text-to-image",
      input: { prompt: "poster", aspect_ratio: "3:2", resolution: "2K", background: "transparent" },
    });
    // Off-schema parameters for this model are refused before any call.
    fetchLog = [];
    await expect(
      submitOwnMediaJob(
        { requestId: "kie-flare-2", provider: "kie", model: "gpt-image-2-5-flare-text-to-image", kind: "image", prompt: "poster", quality: "high", costAcknowledged: true },
        opts,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchLog).toEqual([]);
  });

  test("wan 2-6 text-to-video createTask sends exactly the documented body", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { code: 200, data: { taskId: "task-w" } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    await submitOwnMediaJob(
      {
        requestId: "kie-wan-1",
        provider: "kie",
        model: "wan/2-6-text-to-video",
        kind: "video",
        prompt: "drone over duinen",
        duration: "10",
        resolution: "720p",
        costAcknowledged: true,
      },
      opts,
    );
    const body = JSON.parse(String(fetchLog[0].init!.body));
    expect(body).toEqual({
      model: "wan/2-6-text-to-video",
      input: { prompt: "drone over duinen", duration: "10", resolution: "720p", multi_shots: false },
    });
    // The provider safety default is never switched off.
    expect("nsfw_checker" in body.input).toBe(false);
    // Missing duration is refused (the schema demands the choice).
    fetchLog = [];
    await expect(
      submitOwnMediaJob(
        { requestId: "kie-wan-2", provider: "kie", model: "wan/2-6-text-to-video", kind: "video", prompt: "clip", costAcknowledged: true },
        opts,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchLog).toEqual([]);
  });

  test("poll downloads the guarded result without auth and finishes the job", async () => {
    fetchImpl = (async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      if (url.includes("createTask")) return jsonResponse(200, { code: 200, data: { taskId: "task-17" } });
      if (url.includes("recordInfo")) {
        return jsonResponse(200, { code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://s2.kie.ai/r/abc.png"] }) } });
      }
      const headers = JSON.stringify(init?.headers ?? {});
      expect(headers).not.toContain("Authorization");
      expect(headers).not.toContain(KIE_KEY);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(pngBody(), { headers: { "Content-Type": "image/png" } });
    }) as typeof fetchImpl;
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const { job } = await submitOwnMediaJob(input, opts);
    clock += 5000;
    const done = await getOwnMediaJob(job.id, opts);
    expect(done.status).toBe("succeeded");
    expect(done.result?.urlPath).toBe("/api/artifacts/test-artifact");
    expect(fetchLog.find((c) => c.url === "https://s2.kie.ai/r/abc.png")).toBeDefined();
    expect(completed).toHaveLength(1);
    // A second get is a read of the settled job: no new download, no new post.
    const reread = await getOwnMediaJob(job.id, opts);
    expect(reread.status).toBe("succeeded");
    expect(completed).toHaveLength(1);
    expect(artifactCalls).toHaveLength(1);
  });

  test("provider failure marks the job failed with a sanitized message", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      if (url.includes("createTask")) return jsonResponse(200, { code: 200, data: { taskId: "task-18" } });
      return jsonResponse(200, { code: 200, data: { state: "fail", failMsg: `model error for ${KIE_KEY}`, resultJson: null } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const submitted = await submitOwnMediaJob(input, opts);
    clock += 5000;
    const done = await getOwnMediaJob(submitted.job.id, opts);
    expect(done.status).toBe("failed");
    expect(done.error).not.toContain(KIE_KEY);
  });

  test("malicious result URLs are refused: http, userinfo, foreign host, private IP, redirect, fake content", async () => {
    const cases: Array<{ urls: string[]; redirect?: boolean; htmlContent?: boolean }> = [
      { urls: ["http://s2.kie.ai/plain.png"] },
      { urls: ["https://user:secret@s2.kie.ai/creds.png"] },
      { urls: ["https://evil.example.com/steal.png"] },
      { urls: ["https://private.kie.ai/inside.png"] },
      { urls: ["https://s2.kie.ai/fine.png"], redirect: true },
      { urls: ["https://s2.kie.ai/fake.png"], htmlContent: true },
    ];
    for (const c of cases) {
      fetchLog = [];
      const taskId = `t-${Math.random().toString(36).slice(2, 8)}`;
      fetchImpl = async (url) => {
        fetchLog.push({ url });
        if (url.includes("createTask")) return jsonResponse(200, { code: 200, data: { taskId } });
        if (url.includes("recordInfo")) {
          return jsonResponse(200, { code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: c.urls }) } });
        }
        if (c.redirect) return new Response(null, { status: 302, headers: { Location: "https://evil.example.com/x" } });
        const bytes = c.htmlContent ? htmlBody() : pngBody();
        return new Response(bytes, { headers: { "Content-Type": "image/png" } });
      };
      const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
      const { job } = await submitOwnMediaJob({ ...input, requestId: `kie-evil-${taskId}` }, opts);
      clock += 5000;
      const done = await getOwnMediaJob(job.id, opts);
      expect(done.status).toBe("failed");
      expect(fetchLog.some((call) => call.url.includes("evil.example.com"))).toBe(false);
      expect(fetchLog.some((call) => call.url.startsWith("http://"))).toBe(false);
      expect(artifactCalls).toEqual([]);
      expect(completed).toEqual([]);
    }
  });

  test("idempotency: the same requestId never makes a second paid call", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { code: 200, data: { taskId: "task-17" } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const first = await submitOwnMediaJob(input, opts);
    const second = await submitOwnMediaJob(input, opts);
    expect(second.idempotent).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(fetchLog.filter((c) => c.url.includes("createTask"))).toHaveLength(1);
  });

  test("cancelled API job says plainly that nothing is refunded", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { code: 200, data: { taskId: "task-17" } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const { job } = await submitOwnMediaJob(input, opts);
    const cancelled = await cancelOwnMediaJob(job.id, opts);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.note).toContain("niet automatisch");
    expect(cancelled.note).toContain("terugbetaald");
    await expect(cancelOwnMediaJob(job.id, opts)).rejects.toMatchObject({ code: "conflict" });
  });

  test("cancelled browser job states nothing was generated or paid", async () => {
    const opts = baseOpts();
    const { job } = await submitOwnMediaJob(
      { requestId: "chatgpt-cancel-1", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      opts,
    );
    const cancelled = await cancelOwnMediaJob(job.id, opts);
    expect(cancelled.note).toContain("niets gegenereerd");
  });

  test("timeout sweep fails stale jobs honestly and nothing retries them", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { code: 200, data: { taskId: "task-17" } });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG), inProgressTimeoutMs: 1000 });
    const { job } = await submitOwnMediaJob(input, opts);
    clock += 2000;
    const sweep = sweepOwnMediaJobs(opts);
    expect(sweep.timedOut).toBe(1);
    const after = await getOwnMediaJob(job.id, opts);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("niet automatisch opnieuw");
    expect(fetchLog.filter((c) => c.url.includes("createTask"))).toHaveLength(1);
  });

  test("expiry sweep deletes exactly this job's cached downloads, keeps audit record and neighbours", async () => {
    // Terminal job (manual completion) with a cached download file.
    fetchImpl = async () => jsonResponse(200, {});
    const opts = baseOpts({ maxAgeMs: 1000 });
    const { job } = await submitOwnMediaJob(
      { requestId: "sweep-exp-1", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      opts,
    );
    const uploaded = join(uploadsRoot, "sweep.png");
    writeFileSync(uploaded, pngBody());
    await completeOwnMediaJob(job.id, { path: uploaded }, opts);

    const downloads = join(dataDir, "own-media", "downloads");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(join(downloads, `${job.id}.png`), pngBody());
    writeFileSync(join(downloads, "unrelated.png"), pngBody());

    clock += 2000;
    const sweep = sweepOwnMediaJobs(opts);
    expect(sweep.expired).toBe(1);
    expect(await Bun.file(join(downloads, `${job.id}.png`)).exists()).toBe(false);
    expect(await Bun.file(join(downloads, "unrelated.png")).exists()).toBe(true);
    // The job audit record stays, marked expired, still private on disk.
    const record = JSON.parse(await Bun.file(join(dataDir, "own-media", "jobs", `${job.id}.json`)).text()) as OwnMediaJob;
    expect(record.status).toBe("expired");
  });

  test("a stalled download stream is cut off by the timeout, not awaited forever", async () => {
    fetchImpl = (async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      if (url.includes("createTask")) return jsonResponse(200, { code: 200, data: { taskId: "task-stall" } });
      if (url.includes("recordInfo")) {
        return jsonResponse(200, { code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://s2.kie.ai/stall.png"] }) } });
      }
      // A stream that never yields a chunk and never ends.
      return new Response(
        new ReadableStream({
          start() {
            /* deliberately stalled */
          },
        }),
        { headers: { "Content-Type": "image/png" } },
      );
    }) as typeof fetchImpl;
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG), downloadTimeoutMs: 40 });
    const { job } = await submitOwnMediaJob(input, opts);
    clock += 5000;
    const started = Date.now();
    const done = await getOwnMediaJob(job.id, opts);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(done.status).toBe("failed");
    expect(artifactCalls).toEqual([]);
  });

  test("a createTask that never answers is cut off; the failed job blocks a paid repeat", async () => {
    fetchImpl = (url, init) => {
      fetchLog.push({ url, init });
      return new Promise<Response>(() => {
        /* never resolves, ignores the signal on purpose */
      });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG), apiTimeoutMs: 30 });
    const started = Date.now();
    const err = await submitOwnMediaJob(input, opts).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(err).toBeInstanceOf(OwnMediaError);
    expect(err.code).toBe("provider_error");
    // The failure is recorded and indexed: the same requestId returns the
    // failed job instead of a second paid attempt.
    const again = await submitOwnMediaJob(input, opts);
    expect(again.idempotent).toBe(true);
    expect(again.job.status).toBe("failed");
    expect(fetchLog.filter((c) => c.url.includes("createTask"))).toHaveLength(1);
  });

  test("an instantly successful openai job cannot be cancelled afterwards", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      return jsonResponse(200, { created: 1, data: [{ b64_json: PNG_1X1_BASE64 }] });
    };
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const openaiInput = { ...input, provider: "openai" as const, model: "gpt-image-1" };
    const { job } = await submitOwnMediaJob(openaiInput, opts);
    expect(job.status).toBe("succeeded");
    await expect(cancelOwnMediaJob(job.id, opts)).rejects.toMatchObject({ code: "conflict" });
    expect(completed).toHaveLength(1);
  });
});

describe("concurrency regression", () => {
  const input = {
    requestId: "kie-conc-1",
    provider: "kie" as const,
    model: "gpt-image-2-text-to-image",
    kind: "image" as const,
    prompt: "icon",
    costAcknowledged: true,
  };
  function concCatalog(): string {
    return writeCatalog(QUOTED_CATALOG);
  }

  test("parallel submits with the same requestId produce one paid call", async () => {
    fetchImpl = async (url, init) => {
      fetchLog.push({ url, init });
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse(200, { code: 200, data: { taskId: "task-race" } });
    };
    const opts = baseOpts({ catalogPath: concCatalog() });
    const [a, b] = await Promise.all([submitOwnMediaJob(input, opts), submitOwnMediaJob(input, opts)]);
    expect(a.idempotent || b.idempotent).toBe(true);
    expect(a.job.id).toBe(b.job.id);
    expect(fetchLog.filter((c) => c.url.includes("createTask"))).toHaveLength(1);
  });

  test("parallel gets share one download and register one artifact, post once", async () => {
    fetchImpl = (async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      if (url.includes("createTask")) return jsonResponse(200, { code: 200, data: { taskId: "task-p" } });
      if (url.includes("recordInfo")) {
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse(200, { code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://s2.kie.ai/r/p.png"] }) } });
      }
      await new Promise((r) => setTimeout(r, 5));
      return new Response(pngBody(), { headers: { "Content-Type": "image/png" } });
    }) as typeof fetchImpl;
    const opts = baseOpts({ catalogPath: concCatalog() });
    const { job } = await submitOwnMediaJob(input, opts);
    clock += 5000;
    const [x, y] = await Promise.all([getOwnMediaJob(job.id, opts), getOwnMediaJob(job.id, opts)]);
    expect(x.status).toBe("succeeded");
    expect(y.status).toBe("succeeded");
    expect(fetchLog.filter((c) => c.url === "https://s2.kie.ai/r/p.png")).toHaveLength(1);
    expect(artifactCalls).toHaveLength(1);
    expect(completed).toHaveLength(1);
  });

  test("cancellation during an in-flight manual completion is never undone", async () => {
    const opts0 = baseOpts();
    const { job } = await submitOwnMediaJob(
      { requestId: "chatgpt-race-1", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      opts0,
    );
    const uploaded = join(uploadsRoot, "race.png");
    writeFileSync(uploaded, pngBody());

    let releaseFactory: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFactory = r));
    const slowOpts = baseOpts({
      artifactFactory: async (i) => {
        artifactCalls.push(i);
        await gate;
        return artifactMedia;
      },
    });
    const completing = completeOwnMediaJob(job.id, { path: uploaded }, slowOpts);
    // Let the completion reach the factory await, then cancel.
    await new Promise((r) => setTimeout(r, 5));
    const cancelled = await cancelOwnMediaJob(job.id, slowOpts);
    expect(cancelled.status).toBe("cancelled");
    releaseFactory();
    const err = await completing.catch((e) => e);
    expect(err).toBeInstanceOf(OwnMediaError);
    expect(err.code).toBe("conflict");
    const final = await getOwnMediaJob(job.id, baseOpts());
    expect(final.status).toBe("cancelled");
    expect(completed).toEqual([]);
  });

  test("cancellation during an in-flight download drops the result without a post", async () => {
    let releaseDownload: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseDownload = r));
    fetchImpl = (async (url: string, init?: RequestInit) => {
      fetchLog.push({ url, init });
      if (url.includes("createTask")) return jsonResponse(200, { code: 200, data: { taskId: "task-d" } });
      if (url.includes("recordInfo")) {
        return jsonResponse(200, { code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://s2.kie.ai/r/d.png"] }) } });
      }
      await gate;
      return new Response(pngBody(), { headers: { "Content-Type": "image/png" } });
    }) as typeof fetchImpl;
    const opts = baseOpts({ catalogPath: concCatalog() });
    const { job } = await submitOwnMediaJob(input, opts);
    clock += 5000;
    const getting = getOwnMediaJob(job.id, opts);
    await new Promise((r) => setTimeout(r, 5));
    const cancelled = await cancelOwnMediaJob(job.id, opts);
    expect(cancelled.status).toBe("cancelled");
    releaseDownload();
    const after = await getting;
    expect(after.status).toBe("cancelled");
    expect(artifactCalls).toEqual([]);
    expect(completed).toEqual([]);
    const stored = await getOwnMediaJob(job.id, baseOpts());
    expect(stored.status).toBe("cancelled");
  });
});

describe("request validation", () => {
  test("an unknown thread is refused and no job is created", async () => {
    const opts = baseOpts();
    await expect(
      submitOwnMediaJob(
        { requestId: "bad-thread-1", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster", threadId: "22222222-2222-4222-8222-222222222222" },
        opts,
      ),
    ).rejects.toMatchObject({ code: "thread_not_found" });
    await expect(
      submitOwnMediaJob({ requestId: "bad-thread-2", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster", threadId: "../../etc" }, opts),
    ).rejects.toMatchObject({ code: "thread_not_found" });
  });

  test("malformed fields are 400s, never .trim runtime errors", async () => {
    const opts = baseOpts();
    const bad: unknown[] = [
      { requestId: 12345678, provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" },
      { requestId: "valid-req-1", provider: 5, model: "hint", kind: "image", prompt: "poster" },
      { requestId: "valid-req-2", provider: "chatgpt", model: "hint", kind: "image", prompt: 42 },
      { requestId: "valid-req-3", provider: "chatgpt", model: null, kind: "image", prompt: "poster" },
      { requestId: "valid-req-4", provider: "chatgpt", model: "hint", kind: ["image"], prompt: "poster" },
      { requestId: "valid-req-5", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster", costAcknowledged: "ja" },
      { requestId: "valid-req-6", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster", threadId: { id: 1 } },
    ];
    for (const body of bad) {
      const err = await submitOwnMediaJob(body as never, opts).catch((e) => e);
      expect(err).toBeInstanceOf(OwnMediaError);
      expect(err.httpStatus).toBe(400);
      expect(err.code).toBe("invalid_request");
    }
  });

  test("requestId shape and prompt limits are enforced", async () => {
    const opts = baseOpts();
    await expect(
      submitOwnMediaJob({ requestId: "short", provider: "chatgpt", model: "hint", kind: "image", prompt: "poster" }, opts),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      submitOwnMediaJob({ requestId: "valid-request-1", provider: "chatgpt", model: "hint", kind: "image", prompt: "" }, opts),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      submitOwnMediaJob({ requestId: "valid-request-2", provider: "nope", model: "hint", kind: "image", prompt: "poster" } as never, opts),
    ).rejects.toMatchObject({ code: "unknown_provider" });
  });

  test("fingerprints separate identical requestIds with different content", () => {
    const base = { requestId: "r-1", provider: "chatgpt" as const, model: "hint", kind: "image" as const, prompt: "a" };
    expect(ownMediaRequestFingerprint(base)).not.toBe(ownMediaRequestFingerprint({ ...base, prompt: "b" }));
    expect(ownMediaRequestFingerprint(base)).toBe(ownMediaRequestFingerprint({ ...base }));
  });
});

describe("http handler", () => {
  function request(method: string, path: string, body?: unknown): Request {
    return new Request(`http://127.0.0.1:8766${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
  }

  test("routes providers, submit, poll, result and cancel", async () => {
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const url = (p: string) => new URL(`http://127.0.0.1:8766${p}`);

    expect(await handleOwnMediaRequest(new Request("http://127.0.0.1:8766/api/other"), url("/api/other"), opts)).toBeNull();

    const providers = await handleOwnMediaRequest(request("GET", "/api/own-media/providers"), url("/api/own-media/providers"), opts);
    expect(providers!.status).toBe(200);
    expect(((await providers!.json()) as { providers: unknown[] }).providers).toHaveLength(4);

    fetchImpl = async () => jsonResponse(200, { code: 200, data: { taskId: "task-42" } });
    const submitBody = {
      requestId: "http-kie-1",
      provider: "kie",
      model: "gpt-image-2-text-to-image",
      kind: "image",
      prompt: "via http",
      costAcknowledged: true,
    };
    const submit = await handleOwnMediaRequest(request("POST", "/api/own-media/jobs", submitBody), url("/api/own-media/jobs"), opts);
    expect(submit!.status).toBe(201);
    const job = ((await submit!.json()) as { job: OwnMediaJob }).job;
    expect(job.status).toBe("submitted");

    const again = await handleOwnMediaRequest(request("POST", "/api/own-media/jobs", submitBody), url("/api/own-media/jobs"), opts);
    expect(again!.status).toBe(200);
    expect(((await again!.json()) as { idempotent: boolean }).idempotent).toBe(true);

    // Same requestId, different input: 409 through the handler.
    const conflict = await handleOwnMediaRequest(
      request("POST", "/api/own-media/jobs", { ...submitBody, prompt: "andere prompt" }),
      url("/api/own-media/jobs"),
      opts,
    );
    expect(conflict!.status).toBe(409);

    const missing = await handleOwnMediaRequest(request("GET", "/api/own-media/jobs/00000000-0000-4000-8000-000000000000"), url("/api/own-media/jobs/00000000-0000-4000-8000-000000000000"), opts);
    expect(missing!.status).toBe(404);
    // Path traversal in the id is a 404, never a file read.
    const traverse = await handleOwnMediaRequest(request("GET", "/api/own-media/jobs/..%2F..%2Fetc"), url("/api/own-media/jobs/..%2F..%2Fetc"), opts);
    expect(traverse!.status).toBe(404);

    const cancel = await handleOwnMediaRequest(request("POST", `/api/own-media/jobs/${job.id}/cancel`), url(`/api/own-media/jobs/${job.id}/cancel`), opts);
    expect(cancel!.status).toBe(200);
    expect(((await cancel!.json()) as { job: OwnMediaJob }).job.status).toBe("cancelled");

    const method = await handleOwnMediaRequest(request("DELETE", "/api/own-media/jobs"), url("/api/own-media/jobs"), opts);
    expect(method!.status).toBe(405);

    // Manual result through the handler validates the path too.
    const handoff = await handleOwnMediaRequest(
      request("POST", "/api/own-media/jobs", {
        requestId: "http-chatgpt-1",
        provider: "chatgpt",
        model: "hint",
        kind: "image",
        prompt: "via http",
      }),
      url("/api/own-media/jobs"),
      baseOpts(),
    );
    const handoffJob = ((await handoff!.json()) as { job: OwnMediaJob }).job;
    const outside = join(scratch, "escape.png");
    writeFileSync(outside, pngBody());
    const bad = await handleOwnMediaRequest(request("POST", `/api/own-media/jobs/${handoffJob.id}/result`, { path: outside }), url(`/api/own-media/jobs/${handoffJob.id}/result`), baseOpts());
    expect(bad!.status).toBe(400);
    expect(((await bad!.json()) as { code: string }).code).toBe("invalid_result_path");
  });

  test("malformed JSON bodies answer 400, not 500", async () => {
    const opts = baseOpts();
    const res = await handleOwnMediaRequest(
      new Request("http://127.0.0.1:8766/api/own-media/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: 12345678, provider: "chatgpt", model: "x", kind: "image", prompt: 9 }),
      }),
      new URL("http://127.0.0.1:8766/api/own-media/jobs"),
      opts,
    );
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as { code: string }).code).toBe("invalid_request");
  });

  test("no response ever contains a key", async () => {
    fetchImpl = async () => jsonResponse(401, { error: { message: `bad key ${OPENAI_KEY}` } });
    const opts = baseOpts({ catalogPath: writeCatalog(QUOTED_CATALOG) });
    const res = await handleOwnMediaRequest(
      request("POST", "/api/own-media/jobs", {
        requestId: "http-openai-1",
        provider: "openai",
        model: "gpt-image-1",
        kind: "image",
        prompt: "via http",
        costAcknowledged: true,
      }),
      new URL("http://127.0.0.1:8766/api/own-media/jobs"),
      opts,
    );
    const text = await res!.text();
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(KIE_KEY);
  });
});
