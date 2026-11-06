import { describe, expect, test } from "bun:test";
import {
  EXECUTION_HOSTS_UNAVAILABLE,
  executionHostInfo,
  executionHostLabel,
  executionHostOptions,
  isExecutionHostId,
  loadExecutionHosts,
  parseExecutionHostsPayload,
  resolveExecutionHostLaunch,
  useExecutionHosts,
} from "./execution-hosts";

describe("parseExecutionHostsPayload", () => {
  test("accepts the contract shape and normalizes labels to the fixed UI labels", () => {
    const payload = parseExecutionHostsPayload({
      hosts: [
        { id: "agentbox", label: "Agentbox", available: true },
        { id: "mac", label: "MacBook Pro", available: false, reason: "op batterij" },
      ],
      defaultHost: "agentbox",
    });
    expect(payload).not.toBeNull();
    expect(payload!.hosts.map((host) => host.id)).toEqual(["agentbox", "mac"]);
    // One machine, one name: whatever the box calls it, the UI says MacBook M1.
    expect(payload!.hosts[1]!.label).toBe("MacBook M1");
    expect(payload!.hosts[1]!.reason).toBe("op batterij");
    expect(payload!.defaultHost).toBe("agentbox");
  });

  test("rejects shapes without a launchable list", () => {
    expect(parseExecutionHostsPayload(null)).toBeNull();
    expect(parseExecutionHostsPayload({})).toBeNull();
    expect(parseExecutionHostsPayload({ hosts: "nope" })).toBeNull();
    expect(parseExecutionHostsPayload({ hosts: [{ id: "mac", available: true }] })).toBeNull();
    expect(parseExecutionHostsPayload({ hosts: [{ id: "auto", available: true }] })).toBeNull();
  });

  test("drops unknown host ids — there is no third host and no Auto", () => {
    const payload = parseExecutionHostsPayload({
      hosts: [
        { id: "agentbox", available: true },
        { id: "cloud", available: true },
        { id: "auto", available: true },
      ],
      defaultHost: "auto",
    });
    expect(payload!.hosts.map((host) => host.id)).toEqual(["agentbox", "mac"]);
    // Mac was not reported: synthesized as concretely unavailable, not absent.
    expect(payload!.hosts[1]!.available).toBe(false);
    expect(payload!.hosts[1]!.reason).toBeTruthy();
    // An unknown defaultHost cannot become the composer's answer.
    expect(payload!.defaultHost).toBe("agentbox");
  });

  test("falls back to the fixed label when the server sends none", () => {
    const payload = parseExecutionHostsPayload({
      hosts: [{ id: "agentbox", available: true }],
    });
    expect(payload!.hosts[0]!.label).toBe("Agentbox");
    expect(payload!.hosts[1]!.label).toBe("MacBook M1");
  });

  test("a server-side Mac default is parsed but never becomes a UI default", () => {
    const payload = parseExecutionHostsPayload({
      hosts: [
        { id: "agentbox", available: true },
        { id: "mac", available: true },
      ],
      defaultHost: "mac",
    });
    // The field survives parsing (contract honesty); the composer is what
    // ignores it — a new root conversation always starts on Agentbox.
    expect(payload!.defaultHost).toBe("mac");
  });
});

describe("loadExecutionHosts", () => {
  test("asks the endpoint for the agent kind and returns the parsed list", async () => {
    const calls: string[] = [];
    const payload = await loadExecutionHosts("codex-aisdk", async (path) => {
      calls.push(path);
      return {
        hosts: [
          { id: "agentbox", label: "Agentbox", available: true },
          { id: "mac", label: "Mac", available: true },
        ],
        defaultHost: "agentbox",
      };
    });
    expect(calls).toEqual(["/api/execution-hosts?agent=codex-aisdk"]);
    expect(payload.hosts.some((host) => host.id === "mac" && host.available)).toBe(true);
  });

  test("an endpoint error leaves exactly one launchable host: Agentbox", async () => {
    const payload = await loadExecutionHosts("claude", async () => {
      throw new Error("endpoint down");
    });
    expect(payload).toEqual(EXECUTION_HOSTS_UNAVAILABLE);
    const agentbox = executionHostInfo(payload.hosts, "agentbox");
    const mac = executionHostInfo(payload.hosts, "mac");
    expect(agentbox.available).toBe(true);
    expect(mac.available).toBe(false);
    // A concrete status, not a blank "unavailable".
    expect(mac.reason).toBeTruthy();
  });

  test("an unusable payload is treated as an endpoint fault, not as Mac available", async () => {
    const payload = await loadExecutionHosts("claude", async () => ({ hosts: 7 }));
    expect(payload).toEqual(EXECUTION_HOSTS_UNAVAILABLE);
  });
});

describe("resolveExecutionHostLaunch — explicit choice, no silent fallback", () => {
  const hosts = [
    { id: "agentbox" as const, label: "Agentbox", available: true },
    { id: "mac" as const, label: "Mac", available: false, reason: "op batterij" },
  ];

  test("a selected but unavailable Mac stays Mac and reports blocked", () => {
    const launch = resolveExecutionHostLaunch("mac", hosts);
    expect(launch.host).toBe("mac");
    expect(launch.blocked).toBe(true);
    expect(launch.reason).toBe("op batterij");
  });

  test("a Mac that comes back unblocks without the choice ever moving", () => {
    const back = [
      { id: "agentbox" as const, label: "Agentbox", available: true },
      { id: "mac" as const, label: "Mac", available: true },
    ];
    expect(resolveExecutionHostLaunch("mac", back)).toEqual({ host: "mac", blocked: false, reason: undefined });
  });

  test("an unknown host list never makes a host silently launchable", () => {
    const launch = resolveExecutionHostLaunch("mac", []);
    expect(launch.host).toBe("mac");
    expect(launch.blocked).toBe(true);
    expect(launch.reason).toBeTruthy();
  });
});

describe("executionHostOptions", () => {
  test("fixed order, unavailable hosts disabled with their note", () => {
    const options = executionHostOptions(EXECUTION_HOSTS_UNAVAILABLE.hosts, "mac");
    expect(options.map((option) => option.id)).toEqual(["agentbox", "mac"]);
    expect(options[0]).toMatchObject({ selected: false, disabled: false });
    expect(options[1]).toMatchObject({ selected: true, disabled: true, note: expect.any(String) });
  });
});

describe("labels and ids", () => {
  test("executionHostLabel names the Mac consistently and defaults absent metadata to Agentbox", () => {
    expect(executionHostLabel("mac")).toBe("MacBook M1");
    expect(executionHostLabel("agentbox")).toBe("Agentbox");
    expect(executionHostLabel(undefined)).toBe("Agentbox");
    expect(executionHostLabel(null)).toBe("Agentbox");
  });

  test("isExecutionHostId admits exactly the two contract hosts", () => {
    expect(isExecutionHostId("agentbox")).toBe(true);
    expect(isExecutionHostId("mac")).toBe(true);
    expect(isExecutionHostId("auto")).toBe(false);
    expect(isExecutionHostId("cloud")).toBe(false);
  });
});

describe("useExecutionHosts", () => {
  test("fetches on visibility and agent change only — no poll loop", async () => {
    const { mount } = await import("../test-support/render");
    const { useState } = await import("react");
    const calls: string[] = [];
    const request = async (path: string) => {
      calls.push(path);
      return {
        hosts: [
          { id: "agentbox", label: "Agentbox", available: true },
          { id: "mac", label: "Mac", available: true },
        ],
        defaultHost: "agentbox",
      };
    };

    let setAgent: ((agent: string) => void) | null = null;
    function Probe() {
      const [agent, setAgentState] = useState("claude");
      const hosts = useExecutionHosts(agent, true, request);
      setAgent = setAgentState;
      return (
        <div>
          <span data-testid="mac-available">
            {String(hosts.hosts.find((host) => host.id === "mac")?.available ?? false)}
          </span>
        </div>
      );
    }

    const ui = mount();
    ui.render(<Probe />);
    await ui.flushAsync();
    expect(calls).toEqual(["/api/execution-hosts?agent=claude"]);
    expect(ui.query('[data-testid="mac-available"]')?.textContent).toBe("true");

    // Plain re-render: no refetch.
    ui.render(<Probe />);
    ui.render(<Probe />);
    await ui.flushAsync();
    expect(calls).toEqual(["/api/execution-hosts?agent=claude"]);

    // Agent switch: exactly one new request.
    ui.flush(() => setAgent?.("codex-aisdk"));
    await ui.flushAsync();
    expect(calls).toEqual([
      "/api/execution-hosts?agent=claude",
      "/api/execution-hosts?agent=codex-aisdk",
    ]);
    ui.cleanup();
  });

  test("does not fetch while the composer is not visible", async () => {
    const { mount } = await import("../test-support/render");
    const calls: string[] = [];
    const request = async (path: string) => {
      calls.push(path);
      return EXECUTION_HOSTS_UNAVAILABLE;
    };
    function Probe() {
      const hosts = useExecutionHosts("claude", false, request);
      return <span data-testid="count">{hosts.hosts.length}</span>;
    }
    const ui = mount();
    ui.render(<Probe />);
    await ui.flushAsync();
    expect(calls).toEqual([]);
    ui.cleanup();
  });

  test("an agent switch blocks Mac until the new agent's answer lands — no stale availability", async () => {
    const { mount } = await import("../test-support/render");
    const { useState } = await import("react");
    const pending = new Map<string, (value: unknown) => void>();
    const request = (path: string) =>
      new Promise<unknown>((resolve) => {
        const agent = decodeURIComponent(path.split("agent=")[1] ?? "");
        if (agent === "claude") {
          resolve({
            hosts: [
              { id: "agentbox", available: true },
              { id: "mac", available: true },
            ],
            defaultHost: "agentbox",
          });
        } else {
          pending.set(agent, resolve);
        }
      });

    let setAgent: ((agent: string) => void) | null = null;
    function Probe() {
      const [agent, setAgentState] = useState("claude");
      const hosts = useExecutionHosts(agent, true, request as never);
      setAgent = setAgentState;
      const mac = hosts.hosts.find((host) => host.id === "mac")!;
      return <span data-testid="mac">{mac.available ? "ja" : `nee|${mac.reason ?? ""}`}</span>;
    }

    const ui = mount();
    ui.render(<Probe />);
    await ui.flushAsync();
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("ja");

    // Switch to a provider whose answer is deliberately still in flight:
    // Claude's "Mac available" must not carry over.
    ui.flush(() => setAgent?.("codex-aisdk"));
    await ui.flushAsync();
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("nee|Uitvoerstatus wordt geladen");

    await ui.flushAsync(() =>
      pending.get("codex-aisdk")!({
        hosts: [
          { id: "agentbox", available: true },
          { id: "mac", available: false, reason: "op batterij" },
        ],
        defaultHost: "agentbox",
      }),
    );
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("nee|op batterij");
    ui.cleanup();
  });

  test("a late answer for a previous agent never overwrites the current one", async () => {
    const { mount } = await import("../test-support/render");
    const { useState } = await import("react");
    const queue: { agent: string; resolve: (value: unknown) => void }[] = [];
    const request = (path: string) =>
      new Promise<unknown>((resolve) => {
        queue.push({ agent: decodeURIComponent(path.split("agent=")[1] ?? ""), resolve });
      });
    const macAvailable = () => ({
      hosts: [
        { id: "agentbox", available: true },
        { id: "mac", available: true },
      ],
      defaultHost: "agentbox",
    });
    const macBlocked = () => ({
      hosts: [
        { id: "agentbox", available: true },
        { id: "mac", available: false, reason: "op batterij" },
      ],
      defaultHost: "agentbox",
    });

    let setAgent: ((agent: string) => void) | null = null;
    function Probe() {
      const [agent, setAgentState] = useState("claude");
      const hosts = useExecutionHosts(agent, true, request as never);
      setAgent = setAgentState;
      const mac = hosts.hosts.find((host) => host.id === "mac")!;
      return <span data-testid="mac">{mac.available ? "ja" : `nee|${mac.reason ?? ""}`}</span>;
    }

    const ui = mount();
    ui.render(<Probe />);
    await ui.flushAsync();
    // claude answers.
    await ui.flushAsync(() => queue.shift()!.resolve(macAvailable()));
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("ja");

    // claude -> codex -> claude, fast: both new fetches are pending.
    ui.flush(() => setAgent?.("codex-aisdk"));
    ui.flush(() => setAgent?.("claude"));
    // The newest fetch (claude, again) answers first.
    const codexFetch = queue.shift()!;
    await ui.flushAsync(() => queue.shift()!.resolve(macAvailable()));
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("ja");

    // The older codex answer lands last and says Mac is blocked: it belongs
    // to a fetch for an agent nobody has selected anymore — it must drop.
    await ui.flushAsync(() => codexFetch.resolve(macBlocked()));
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("ja");
    ui.cleanup();
  });

  test("refresh re-reads the current agent on demand — and nothing polls on its own", async () => {
    const { mount } = await import("../test-support/render");
    const calls: string[] = [];
    let macAvailable = false;
    const request = async (path: string) => {
      calls.push(path);
      return {
        hosts: [
          { id: "agentbox", available: true },
          { id: "mac", available: macAvailable },
        ],
        defaultHost: "agentbox",
      };
    };
    function Probe() {
      const hosts = useExecutionHosts("claude", true, request);
      const mac = hosts.hosts.find((host) => host.id === "mac")!;
      return (
        <div>
          <span data-testid="mac">{mac.available ? "ja" : "nee"}</span>
          <button type="button" data-testid="refresh" onClick={hosts.refresh} />
        </div>
      );
    }

    const ui = mount();
    ui.render(<Probe />);
    await ui.flushAsync();
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("nee");
    expect(calls).toEqual(["/api/execution-hosts?agent=claude"]);

    // The Mac comes back on the box, but idle renders never refetch.
    macAvailable = true;
    ui.render(<Probe />);
    await ui.flushAsync();
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("nee");
    expect(calls).toHaveLength(1);

    // The explicit refresh is what makes it selectable without a reload.
    ui.flush(() => {
      (ui.query('[data-testid="refresh"]') as HTMLButtonElement).click();
    });
    await ui.flushAsync();
    expect(ui.query('[data-testid="mac"]')?.textContent).toBe("ja");
    expect(calls).toEqual([
      "/api/execution-hosts?agent=claude",
      "/api/execution-hosts?agent=claude",
    ]);
    ui.cleanup();
  });
});
