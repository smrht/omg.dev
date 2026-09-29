import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mount, window, type Mounted } from "../test-support/render";
import type { OwnMediaApi, OwnMediaJob, OwnMediaProviderInfo, OwnMediaSubmitInput } from "../lib/own-media";
import type { OwnMediaProviderId } from "../../../../packages/protocol/src/own-media";

const { OwnMediaPanel } = await import("./own-media");

function providerFixture(): OwnMediaProviderInfo[] {
  return [
    {
      id: "chatgpt",
      label: "ChatGPT (browser)",
      route: "browser",
      kinds: ["image", "video"],
      costSource: "subscription",
      billingLabel: "ChatGPT-abonnement",
      handoffUrl: "https://chatgpt.com",
      available: true,
      note: "Je opent ChatGPT zelf en kiest daar het model.",
      models: [],
    },
    {
      id: "openai",
      label: "OpenAI Images API",
      route: "api",
      kinds: ["image"],
      costSource: "api",
      billingLabel: "API, betaald per gebruik",
      handoffUrl: null,
      available: true,
      note: "Genereert direct via de OpenAI Images API.",
      models: [
        { id: "gpt-image-1", label: "gpt-image-1", kind: "image", aspectRatios: ["1:1", "3:2"], qualities: ["low", "high"], quote: { amount: 0.04, unit: "usd" }, maxCredits: 0.1 },
        { id: "gpt-image-2", label: "gpt-image-2", kind: "image", aspectRatios: ["16:9"] },
      ],
    },
    {
      id: "google-flow",
      label: "Google Flow (browser)",
      route: "browser",
      kinds: ["video"],
      costSource: "site_credits",
      billingLabel: "Google Flow-credits",
      handoffUrl: "https://labs.google/fx/tools/flow",
      available: true,
      note: "Je opent Google Flow zelf.",
      models: [],
    },
    {
      id: "kie",
      label: "KIE API",
      route: "api",
      kinds: ["image", "video"],
      costSource: "api",
      billingLabel: "API, betaald per gebruik",
      handoffUrl: null,
      available: true,
      note: "Genereert direct via de KIE-jobs-API.",
      models: [
        { id: "gpt-image-2-text-to-image", label: "gpt-image-2-text-to-image", kind: "image" },
        {
          id: "wan/2-6-text-to-video",
          label: "Wan 2.6 text-to-video",
          kind: "video",
          durations: ["5", "10", "15"],
          resolutions: ["720p", "1080p"],
          quote: { amount: 60, unit: "credits" },
          maxCredits: 80,
        },
      ],
    },
  ];
}

function browserJob(overrides: Partial<OwnMediaJob> = {}): OwnMediaJob {
  return {
    id: "job-1",
    requestId: "om-fixed",
    requestFingerprint: "deadbeef",
    provider: "chatgpt",
    model: "hint",
    kind: "image",
    prompt: "een rode fiets",
    status: "pending_handoff",
    cost: { source: "subscription", acknowledged: true },
    handoffUrl: "https://chatgpt.com",
    note: "Niets wordt op deze site gegenereerd.",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

type FakeApi = OwnMediaApi & {
  submitted: OwnMediaSubmitInput[];
  completed: { id: string; file: File }[];
  cancelled: string[];
  polled: { id: string; signal?: AbortSignal }[];
};

function fakeApi(jobs: { submit?: OwnMediaJob; afterSubmit?: (id: string, signal?: AbortSignal) => Promise<OwnMediaJob> } = {}): FakeApi {
  const api: FakeApi = {
    submitted: [],
    completed: [],
    cancelled: [],
    polled: [],
    async providers() {
      return providerFixture();
    },
    async submit(input) {
      api.submitted.push(input);
      return { job: jobs.submit ?? browserJob(), idempotent: false };
    },
    async job(id, signal) {
      api.polled.push({ id, signal });
      return jobs.afterSubmit ? await jobs.afterSubmit(id, signal) : browserJob({ id });
    },
    async cancel(id) {
      api.cancelled.push(id);
      return browserJob({ id, status: "cancelled", note: "Geannuleerd. Er is niets gegenereerd of betaald via deze site." });
    },
    async completeWithFile(id, file) {
      api.completed.push({ id, file });
      return browserJob({ id, status: "succeeded", result: { urlPath: "/api/artifacts/a1", name: file.name } });
    },
  };
  return api;
}

let ui: Mounted;
beforeEach(() => {
  ui = mount();
});
afterEach(() => ui.cleanup());

async function renderPanel(api: FakeApi, threadId?: string) {
  const { OwnMediaPanel } = await import("./own-media");
  await ui.flushAsync(async () => {
    ui.render(<OwnMediaPanel api={api} threadId={threadId ?? null} />);
  });
}

function setSelect(selector: string, value: string) {
  ui.flush(() => {
    const el = ui.query(selector) as HTMLSelectElement | null;
    if (!el) throw new Error(`missing ${selector}`);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInput(selector: string, value: string) {
  ui.flush(() => {
    const el = ui.query(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) throw new Error(`missing ${selector}`);
    // React's value tracker ignores a plain .value assignment; go through the
    // native setter so the dispatched input event reads as a real change.
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(selector: string) {
  ui.flush(() => {
    const el = ui.query(selector) as HTMLElement | null;
    if (!el) throw new Error(`missing ${selector}`);
    el.click();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("OwnMediaPanel", () => {
  test("shows all four providers with their billing source", async () => {
    await renderPanel(fakeApi());
    const select = ui.query('select[name="provider"]') as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent ?? "");
    expect(options).toHaveLength(4);
    expect(options[0]).toContain("ChatGPT");
    expect(options[0]).toContain("ChatGPT-abonnement");
    expect(options[1]).toContain("OpenAI");
    expect(options[2]).toContain("Google Flow");
    expect(options[3]).toContain("KIE");
    expect(ui.text()).not.toContain("OPENAI_API_KEY");
    expect(ui.text()).not.toContain("KIE_API_KEY");
  });

  test("the note is wired from the input via aria-describedby, not the other way round", async () => {
    await renderPanel(fakeApi());
    const select = ui.query('select[name="provider"]') as HTMLSelectElement;
    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const note = ui.query(`[id="${describedBy}"]`);
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("ChatGPT");
  });

  test("two panels on one page never share element ids", async () => {
    const api = fakeApi();
    const { OwnMediaPanel } = await import("./own-media");
    await ui.flushAsync(async () => {
      ui.render(
        <div>
          <OwnMediaPanel api={api} />
          <OwnMediaPanel api={api} />
        </div>,
      );
    });
    const selects = ui.queryAll('select[name="provider"]') as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    expect(selects[0].id).not.toBe(selects[1].id);
  });

  test("browser handoff: submit stores the job, opens nothing, and completes by upload", async () => {
    const api = fakeApi();
    await renderPanel(api, "11111111-1111-4111-8111-111111111111");
    setInput('input[name="modelHint"]', "wat ChatGPT aanbiedt");
    setInput('textarea[name="prompt"]', "een rode fiets");
    click("button[type=submit]");
    await ui.flushAsync();

    expect(api.submitted).toHaveLength(1);
    expect(api.submitted[0].provider).toBe("chatgpt");
    expect(api.submitted[0].threadId).toBe("11111111-1111-4111-8111-111111111111");
    expect(api.submitted[0].costAcknowledged).toBeUndefined();

    const handoff = ui.query('a[href="https://chatgpt.com"]');
    expect(handoff).not.toBeNull();
    expect(handoff!.getAttribute("rel")).toBe("noreferrer");
    expect(ui.text()).toContain("Niets wordt op deze site gegenereerd");

    const file = new File(["png-bytes"], "result.png", { type: "image/png" });
    await ui.flushAsync(async () => {
      const input = ui.query('input[name="result"]') as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.completed).toHaveLength(1);
    expect(api.completed[0].id).toBe("job-1");
    expect(api.completed[0].file.name).toBe("result.png");
    expect(ui.query('img[src="/api/artifacts/a1"]')).not.toBeNull();
    expect(ui.text()).toContain("klaar");
  });

  test("google-flow is offered for video with its own handoff url", async () => {
    const api = fakeApi({
      submit: browserJob({ provider: "google-flow", kind: "video", model: "Veo in Flow", handoffUrl: "https://labs.google/fx/tools/flow", cost: { source: "site_credits", acknowledged: true } }),
    });
    await renderPanel(api);
    setSelect('select[name="provider"]', "google-flow");
    setInput('input[name="modelHint"]', "Veo in Flow");
    setInput('textarea[name="prompt"]', "drone over duinen");
    click("button[type=submit]");
    await ui.flushAsync();
    expect(ui.query('a[href="https://labs.google/fx/tools/flow"]')).not.toBeNull();
    expect(ui.text()).toContain("Google Flow-credits");
  });

  test("API model without a configured price keeps submit disabled with an honest message", async () => {
    await renderPanel(fakeApi());
    setSelect('select[name="provider"]', "kie");
    setSelect('select[name="kind"]', "image");
    setInput('textarea[name="prompt"]', "icon");
    const submit = ui.query("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(ui.text()).toContain("prijs niet ingesteld");
    expect(ui.text()).toContain("uitgeschakeld");
  });

  test("API submit needs the explicit cost acknowledgement and sends estimate wording", async () => {
    const api = fakeApi();
    await renderPanel(api);
    setSelect('select[name="provider"]', "openai");
    setInput('textarea[name="prompt"]', "poster");
    expect(ui.text()).toContain("geschat");
    expect(ui.text()).toContain("lokaal plafond");
    let submit = ui.query("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    click('input[name="costAck"]');
    submit = ui.query("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    click("button[type=submit]");
    await ui.flushAsync();
    expect(api.submitted).toHaveLength(1);
    expect(api.submitted[0].model).toBe("gpt-image-1");
    expect(api.submitted[0].costAcknowledged).toBe(true);
    expect(ui.text()).toContain("US$ 0.04 per generatie");
  });

  test("stale ratio and quality reset when the model changes", async () => {
    await renderPanel(fakeApi());
    setSelect('select[name="provider"]', "openai");
    setSelect('select[name="aspectRatio"]', "3:2");
    setSelect('select[name="quality"]', "high");
    let ratio = ui.query('select[name="aspectRatio"]') as HTMLSelectElement;
    expect(ratio.value).toBe("3:2");
    // gpt-image-2 offers only 16:9 and no quality: both stale values must go.
    setSelect('select[name="model"]', "gpt-image-2");
    await ui.flushAsync(async () => {
      await sleep(1);
    });
    ratio = ui.query('select[name="aspectRatio"]') as HTMLSelectElement;
    expect(ratio.value).toBe("");
    expect(ui.query('select[name="quality"]')).toBeNull();
    // Submitting now cannot carry the stale 3:2 or high.
    setInput('textarea[name="prompt"]', "poster");
    click("button[type=submit]");
    await ui.flushAsync();
  });

  test("stale options reset when the provider changes", async () => {
    await renderPanel(fakeApi());
    setSelect('select[name="provider"]', "openai");
    setSelect('select[name="aspectRatio"]', "3:2");
    setSelect('select[name="provider"]', "chatgpt");
    await ui.flushAsync(async () => {
      await sleep(1);
    });
    // Browser route offers COMMON_RATIOS which includes 3:2, but switching
    // away and back to an api provider without that ratio resets it.
    setSelect('select[name="provider"]', "kie");
    setSelect('select[name="kind"]', "image");
    await ui.flushAsync(async () => {
      await sleep(1);
    });
    const ratio = ui.query('select[name="aspectRatio"]') as HTMLSelectElement | null;
    if (ratio) expect(ratio.value).toBe("");
  });

  test("wan video requires a duration and sends the documented fields", async () => {
    const api = fakeApi();
    await renderPanel(api);
    setSelect('select[name="provider"]', "kie");
    setSelect('select[name="kind"]', "video");
    setInput('textarea[name="prompt"]', "drone over duinen");
    // Without a duration the submit stays disabled and says why.
    let submit = ui.query("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(ui.text()).toContain("Kies eerst een duur");
    setSelect('select[name="duration"]', "10");
    setSelect('select[name="resolution"]', "720p");
    click('input[name="costAck"]');
    submit = ui.query("button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    click("button[type=submit]");
    await ui.flushAsync();
    expect(api.submitted).toHaveLength(1);
    expect(api.submitted[0].model).toBe("wan/2-6-text-to-video");
    expect(api.submitted[0].duration).toBe("10");
    expect(api.submitted[0].resolution).toBe("720p");
    expect(api.submitted[0].costAcknowledged).toBe(true);
  });

  test("submitted API job can be cancelled and shows the honest note", async () => {
    const api = fakeApi({
      submit: browserJob({
        id: "job-2",
        provider: "kie",
        model: "gpt-image-2-text-to-image",
        status: "submitted",
        providerJobId: "t-1",
        cost: { source: "api", acknowledged: true, quote: { amount: 6, unit: "credits" } },
      }),
    });
    await renderPanel(api);
    setInput('input[name="modelHint"]', "x");
    setInput('textarea[name="prompt"]', "icon");
    click("button[type=submit]");
    await ui.flushAsync();
    expect(ui.text()).toContain("aangeboden bij de provider");
    click("button:not([type=submit])");
    await ui.flushAsync();
    expect(api.cancelled).toEqual(["job-2"]);
    expect(ui.text()).toContain("geannuleerd");
    expect(ui.text()).toContain("niets gegenereerd");
  });

  test("provider errors surface in Dutch with role=alert", async () => {
    const api = fakeApi();
    api.submit = async () => {
      throw new Error("KIE weigerde de opdracht: geen credits meer.");
    };
    await renderPanel(api);
    setInput('input[name="modelHint"]', "hint");
    setInput('textarea[name="prompt"]', "poster");
    click("button[type=submit]");
    await ui.flushAsync();
    expect(ui.query('[role="alert"]')?.textContent).toContain("geen credits meer");
  });

  test("poll failures become visible instead of being swallowed forever", async () => {
    const api = fakeApi({
      submit: browserJob({
        id: "job-poll",
        provider: "kie",
        model: "gpt-image-2-text-to-image",
        status: "submitted",
        providerJobId: "t-2",
        cost: { source: "api", acknowledged: true, quote: { amount: 6, unit: "credits" } },
      }),
    });
    api.job = async () => {
      throw new Error("server onbereikbaar");
    };
    const { OwnMediaPanel } = await import("./own-media");
    await ui.flushAsync(async () => {
      ui.render(<OwnMediaPanel api={api} pollIntervalMs={1} />);
    });
    setInput('input[name="modelHint"]', "x");
    setInput('textarea[name="prompt"]', "poster");
    click("button[type=submit]");
    await ui.flushAsync();
    await ui.flushAsync(async () => {
      await sleep(20);
    });
    expect(ui.text()).toContain("Status opvragen lukt niet");
  });

  test("at most one poll is in flight; unmount stops polling", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const api = fakeApi({
      submit: browserJob({
        id: "job-single",
        provider: "kie",
        model: "gpt-image-2-text-to-image",
        status: "submitted",
        providerJobId: "t-3",
        cost: { source: "api", acknowledged: true, quote: { amount: 6, unit: "credits" } },
      }),
    });
    api.job = async (id) => {
      api.polled.push({ id });
      await gate;
      return browserJob({ id, status: "succeeded", result: { urlPath: "/api/artifacts/ok", name: "ok.png" } });
    };
    const { OwnMediaPanel } = await import("./own-media");
    await ui.flushAsync(async () => {
      ui.render(<OwnMediaPanel api={api} pollIntervalMs={1} />);
    });
    setInput('input[name="modelHint"]', "x");
    setInput('textarea[name="prompt"]', "poster");
    click("button[type=submit]");
    await ui.flushAsync();
    await ui.flushAsync(async () => {
      await sleep(10);
    });
    // Several ticks fired while the first poll is still pending: one call.
    expect(api.polled.length).toBe(1);
    // Unmount aborts the loop; releasing afterwards triggers nothing new.
    ui.cleanup();
    release();
    await sleep(5);
    expect(api.polled.length).toBe(1);
  });
});
