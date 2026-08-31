import { expect, test } from "bun:test";
import { parsePollerOutput } from "./sam-tools.ts";

const REAL_OUTPUT = `Deploy-poller status op netcup-vps8000-wp:
  pdfsamenvoegen     smrht/pdfsamenvoegen@main          remote=f251f6091b25 marker=f251f6091b25 IN-SYNC
  muziekmakenmetai   smrht/muziekmakenmetai.nl@feature/mvp-saas remote=2a615581cf92 marker=2a615581cf92 IN-SYNC
  kleurplaat         smrht/kleurplaat-generator@main    remote=3eb16ea067c0 marker=deadbeefcafe BEHIND
`;

test("parses app rows and skips the column-0 header", () => {
  const apps = parsePollerOutput(REAL_OUTPUT);
  expect(apps.map((a) => a.app)).toEqual(["pdfsamenvoegen", "muziekmakenmetai", "kleurplaat"]);
  expect(apps[1].repo).toBe("smrht/muziekmakenmetai.nl@feature/mvp-saas");
});

test("a non-IN-SYNC row is distinguishable — that is the whole alert", () => {
  const behind = parsePollerOutput(REAL_OUTPUT).filter((a) => !a.state.includes("IN-SYNC"));
  expect(behind.map((a) => a.app)).toEqual(["kleurplaat"]);
});

test("empty or header-only output yields no rows, so callers must treat it as unknown", () => {
  expect(parsePollerOutput("")).toEqual([]);
  expect(parsePollerOutput("Deploy-poller status op host:\n")).toEqual([]);
});

import { leesPlacement, normaliseer } from "./sam-tools.ts";

const CSV = `domain,stack,type,current_server,desired_server,notes
luchtfotodrone.nl,luchtfotodrone_nl,wp-compose,netcup-vps8000-wp,netcup-vps8000-wp,/srv/wordpress/stacks/luchtfotodrone_nl; port:8213
verhuizer.nl,verhuizer,wp-compose,netcup-vps8000,netcup-vps8000-wp,/srv/server95/verhuizer; port:9001
`;

test("notes met puntkomma blijft heel, ook al staan er scheidingstekens in", () => {
  const rijen = leesPlacement(CSV);
  expect(rijen).toHaveLength(2);
  expect(rijen[0].notes).toBe("/srv/wordpress/stacks/luchtfotodrone_nl; port:8213");
  expect(rijen[0].current_server).toBe("netcup-vps8000-wp");
});

test("een lopende verhuizing is te zien aan twee verschillende servers", () => {
  const rij = leesPlacement(CSV).find((r) => r.domain === "verhuizer.nl")!;
  expect(rij.current_server).not.toBe(rij.desired_server);
});

test("www, https en een pad leiden naar hetzelfde domein", () => {
  for (const invoer of ["luchtfotodrone.nl", "www.luchtfotodrone.nl", "https://luchtfotodrone.nl/blog/x/"]) {
    expect(normaliseer(invoer)).toBe("luchtfotodrone.nl");
  }
});

import { executorAuth, executorFout, executorToken } from "./sam-tools.ts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("zonder EXECUTOR_MCP_TOKEN een duidelijke, niet-geheime fout — nooit stil doorverbinden", () => {
  for (const leeg of [undefined, "", "   "]) {
    const auth = executorAuth(leeg);
    expect(auth.ok).toBe(false);
    if (!auth.ok) {
      expect(auth.error).toContain("EXECUTOR_MCP_TOKEN");
      expect(auth.error).toContain("/home/agent/.config/executor/client.env");
      expect(auth.error).not.toContain("Bearer"); // geen header-fragment, geen token-plaats
    }
  }
});

test("met token wordt de bearer-header exact één keer opgebouwd", () => {
  const auth = executorAuth("test-token-waarde");
  expect(auth.ok).toBe(true);
  if (auth.ok) expect(auth.header).toBe("Bearer test-token-waarde");
});

test("een foutmelding die de token bevat wordt geredacteerd, nooit doorgespeeld", () => {
  const fout = executorFout(new Error("fetch failed: Authorization: Bearer geheim-xyz"), "geheim-xyz");
  expect(fout).not.toContain("geheim-xyz");
  expect(fout).toContain("<token-geredacteerd>");
});

test("executorToken verkiest de procesomgeving en hoeft dan geen bestand", () => {
  expect(executorToken("  env-token  ", "/bestaat-bewust-niet")).toBe("env-token");
});

test("executorToken leest Codex' mode-600 clientbestand zonder shell-evaluatie", () => {
  const map = mkdtempSync(join(tmpdir(), "executor-token-test-"));
  const bestand = join(map, "client.env");
  try {
    writeFileSync(bestand, "# clientcredential\nexport EXECUTOR_MCP_TOKEN='bestand-token'\n", { mode: 0o600 });
    expect(executorToken(null, bestand)).toBe("bestand-token");
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
});

test("executorToken weigert een group- of world-readable secretbestand", () => {
  const map = mkdtempSync(join(tmpdir(), "executor-token-mode-test-"));
  const bestand = join(map, "client.env");
  try {
    writeFileSync(bestand, "EXECUTOR_MCP_TOKEN=mag-niet-lekken\n", { mode: 0o600 });
    chmodSync(bestand, 0o640);
    expect(executorToken(null, bestand)).toBe("");
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
});

test("executorToken retourneert leeg bij een ontbrekend of tokenloos bestand", () => {
  const map = mkdtempSync(join(tmpdir(), "executor-token-empty-test-"));
  const bestand = join(map, "client.env");
  try {
    expect(executorToken(null, join(map, "ontbreekt.env"))).toBe("");
    writeFileSync(bestand, "ANDERE_VARIABELE=waarde\n", { mode: 0o600 });
    expect(executorToken(null, bestand)).toBe("");
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
});

import { executorResumeArgs, createSharedSession } from "./sam-tools.ts";

test("executor_resume geeft executionId, action en content exact door aan resume — content default '{}'", () => {
  expect(executorResumeArgs("exec-42", "accept")).toEqual({
    executionId: "exec-42",
    action: "accept",
    content: "{}",
  });
  expect(executorResumeArgs("exec-42", "decline", '{"answer":"nee"}')).toEqual({
    executionId: "exec-42",
    action: "decline",
    content: '{"answer":"nee"}',
  });
  expect(executorResumeArgs("exec-42", "cancel", "")).toEqual({
    executionId: "exec-42",
    action: "cancel",
    content: "",
  });
});

// createSharedSession is de pure state-machine achter de gedeelde
// Executor-sessie: paused executionId's zijn MCP-sessie-gebonden, dus
// hergebruik over aanroepen heen en reset bij falen moeten bewezen zijn.

function nepClient() {
  const aanroepen: string[] = [];
  let gesloten = 0;
  return {
    aanroepen,
    isGesloten: () => gesloten,
    callTool: async (naam: string) => {
      aanroepen.push(naam);
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => {
      gesloten += 1;
    },
  };
}

test("gedeelde sessie verbindt één keer en hergebruikt dezelfde client over aanroepen heen", async () => {
  let verbindingen = 0;
  const client = nepClient();
  const sessie = createSharedSession(async () => {
    verbindingen += 1;
    return client;
  });
  await sessie.use((c) => c.callTool("execute"));
  await sessie.use((c) => c.callTool("resume"));
  expect(verbindingen).toBe(1);
  expect(client.aanroepen).toEqual(["execute", "resume"]);
  expect(client.isGesloten()).toBe(0);
});

test("parallelle eerste aanroepen delen dezelfde lopende connect — geen tweede sessie ernaast", async () => {
  let verbindingen = 0;
  const client = nepClient();
  const sessie = createSharedSession(async () => {
    verbindingen += 1;
    await new Promise((r) => setTimeout(r, 5));
    return client;
  });
  await Promise.all([
    sessie.use((c) => c.callTool("execute")),
    sessie.use((c) => c.callTool("resume")),
  ]);
  expect(verbindingen).toBe(1);
});

test("mislukte aanroep sluit en wist de client; de volgende aanroep verbindt opnieuw", async () => {
  let verbindingen = 0;
  const eerste = nepClient();
  const sessie = createSharedSession(async () => {
    verbindingen += 1;
    return verbindingen === 1 ? eerste : nepClient();
  });
  await expect(sessie.use(() => Promise.reject(new Error("stream gereset")))).rejects.toThrow(
    "stream gereset",
  );
  expect(eerste.isGesloten()).toBe(1);
  const tweede = await sessie.use((c) => Promise.resolve(c));
  expect(verbindingen).toBe(2);
  expect(tweede).not.toBe(eerste);
});

test("een falende close op een kapotte verbinding blokkeert de volgende aanroep niet", async () => {
  let verbindingen = 0;
  const sessie = createSharedSession(async () => {
    verbindingen += 1;
    return verbindingen === 1
      ? {
          callTool: async (_naam: string) => {
            throw new Error("sessie weg");
          },
          close: async () => {
            throw new Error("close geweigerd");
          },
        }
      : nepClient();
  });
  await expect(sessie.use((c) => c.callTool("execute"))).rejects.toThrow("sessie weg");
  await expect(sessie.use((c) => c.callTool("resume"))).resolves.toBeTruthy();
  expect(verbindingen).toBe(2);
});

test("mislukte verbinding propageert en laat geen vastgelopen connecting-staat achter", async () => {
  let pogingen = 0;
  const sessie = createSharedSession(async () => {
    pogingen += 1;
    throw new Error("connect geweigerd");
  });
  await expect(sessie.use((c) => c.callTool("execute"))).rejects.toThrow("connect geweigerd");
  await expect(sessie.use((c) => c.callTool("execute"))).rejects.toThrow("connect geweigerd");
  expect(pogingen).toBe(2);
});

// ---- Executor-containerherstart: reset én exact één reissue ----
//
// Live gemeten 23-08-2026 tegen de Executor: een call over een sessie die de
// server niet meer kent (na containerrestart) krijgt HTTP 404 met
// {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"}}
// terug, wat de SDK-client als StreamableHTTPError gooit. De gedeelde
// sessie reset daardoor wel (close+clear), maar de oude code voerde de
// mislukte call zelf niet opnieuw uit: de EERSTE executor_execute na een
// Executor-herstart retourneerde {ok:false,error:"... Session not found"}
// en pas een latere call herstelde. De eis hieronder: bij zo'n expliciete
// stale-session-fout wordt na de reset dezelfde oorspronkelijke call exact
// één keer opnieuw uitgevoerd — binnen dezelfde toolaanroep.

/** Expliciete stale-session-signatuur zoals de Executor die live teruggeeft. */
function isStaleSessionFout(err: unknown): boolean {
  return /session not found/i.test(err instanceof Error ? err.message : String(err));
}

const STALE_SESSION_FOUT = new Error(
  'Streamable HTTP error: Error POSTing to endpoint: ' +
    '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}',
);

test("na een stale-session wordt dezelfde oorspronkelijke call exact één keer na clientreset opnieuw uitgevoerd", async () => {
  let verbindingen = 0;
  let sloten = 0;
  const uitgevoerd: { tool: string; args: unknown }[] = [];
  const bijhouden = (verzoek: { name: string; arguments?: unknown }) =>
    uitgevoerd.push({ tool: verzoek.name, args: verzoek.arguments });

  const sessie = createSharedSession(
    async () => {
      verbindingen += 1;
      const stale = verbindingen === 1;
      return {
        callTool: async (verzoek: { name: string; arguments?: unknown }) => {
          bijhouden(verzoek);
          if (stale) throw STALE_SESSION_FOUT;
          return { content: [{ type: "text" as const, text: '{"ok":true,"data":"na herstart"}' }] };
        },
        close: async () => {
          sloten += 1;
        },
      };
    },
    isStaleSessionFout,
  );

  const antwoord = await sessie.use((client) =>
    client.callTool({ name: "execute", arguments: { code: "1+1" } }),
  );

  expect(verbindingen).toBe(2); // na de reset precies één nieuwe verbinding
  expect(sloten).toBe(1); // de stale client exact één keer gesloten
  expect(uitgevoerd).toHaveLength(2); // de retry is de énige extra poging
  expect(uitgevoerd[0]).toEqual(uitgevoerd[1]); // exact dezelfde oorspronkelijke call
  expect(antwoord).toEqual({
    content: [{ type: "text", text: '{"ok":true,"data":"na herstart"}' }],
  }); // de tooluitkomst is het retry-resultaat, niet ok:false "Session not found"
});

import { callExecutor, isStaleExecutorFout } from "./sam-tools.ts";

test("isStaleExecutorFout herkent alleen de expliciete stale-session-signatuur", () => {
  // De live gemeten vorm (StreamableHTTPError met de 404-body) en kale
  // servermeldingen (JSON-RPC-foutpad) zijn retrybaar:
  expect(isStaleExecutorFout(STALE_SESSION_FOUT)).toBe(true);
  expect(isStaleExecutorFout(new Error("Session not found"))).toBe(true);
  expect(isStaleExecutorFout(new Error("Session terminated"))).toBe(true);
  // Gewone transport- en tool-fouten zijn dat niet:
  expect(isStaleExecutorFout(new Error("fetch failed"))).toBe(false);
  expect(
    isStaleExecutorFout(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: ' +
          '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error"}}',
      ),
    ),
  ).toBe(false);
  expect(isStaleExecutorFout(new Error("Execution failed: exit 1"))).toBe(false);
});

/** Nep-sessie met exact de productie-wiring: createSharedSession + isStaleExecutorFout. */
function nepExecutorSessie(
  gedragPerVerbinding: (
    verbinding: number,
  ) => (verzoek: { name: string; arguments?: unknown }) => Promise<unknown>,
) {
  const uitgevoerd: { tool: string; args: unknown }[] = [];
  let verbindingen = 0;
  const sessie = createSharedSession(
    async () => {
      verbindingen += 1;
      const gedrag = gedragPerVerbinding(verbindingen);
      return {
        callTool: async (verzoek: { name: string; arguments?: unknown }) => {
          uitgevoerd.push({ tool: verzoek.name, args: verzoek.arguments });
          return gedrag(verzoek);
        },
        close: async () => {},
      };
    },
    isStaleExecutorFout,
  );
  return { sessie, uitgevoerd, telVerbindingen: () => verbindingen };
}

async function metTestToken<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env.EXECUTOR_MCP_TOKEN;
  process.env.EXECUTOR_MCP_TOKEN = "test-token";
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env.EXECUTOR_MCP_TOKEN;
    else process.env.EXECUTOR_MCP_TOKEN = was;
  }
}

test("executor_execute herstelt binnen dezelfde aanroep na Executor-herstart — de tooluitkomst is het retry-resultaat", async () => {
  await metTestToken(async () => {
    const { sessie, uitgevoerd, telVerbindingen } = nepExecutorSessie((verbinding) =>
      verbinding === 1
        ? () => {
            throw STALE_SESSION_FOUT;
          }
        : () =>
            Promise.resolve({
              content: [{ type: "text" as const, text: '{"ok":true,"data":"na herstart"}' }],
            }),
    );
    const antwoord = await callExecutor("execute", { code: "1+1" }, sessie);
    expect(uitgevoerd).toEqual([
      { tool: "execute", args: { code: "1+1" } },
      { tool: "execute", args: { code: "1+1" } },
    ]);
    expect(telVerbindingen()).toBe(2);
    expect(antwoord).toEqual({
      content: [{ type: "text", text: '{"ok":true,"data":"na herstart"}' }],
    });
  });
});

test("een gewone aanroepfout wordt exact één keer uitgevoerd en geretourneerd — nooit gedupliceerd", async () => {
  await metTestToken(async () => {
    const { sessie, uitgevoerd, telVerbindingen } = nepExecutorSessie(
      () => () => Promise.reject(new Error("Execution failed: exit 1")),
    );
    const antwoord = await callExecutor("execute", { code: "1+1" }, sessie);
    expect(uitgevoerd).toEqual([{ tool: "execute", args: { code: "1+1" } }]);
    expect(telVerbindingen()).toBe(1);
    const laad = JSON.parse((antwoord.content as { text: string }[])[0].text);
    expect(laad.ok).toBe(false);
    expect(laad.error).toBe("Execution failed: exit 1");
  });
});

test("blijft de sessie ook na de herpoging stale, dan géén derde poging en precies één ok:false", async () => {
  await metTestToken(async () => {
    const { sessie, uitgevoerd, telVerbindingen } = nepExecutorSessie(
      () => () => {
        throw STALE_SESSION_FOUT;
      },
    );
    const antwoord = await callExecutor("execute", { code: "1+1" }, sessie);
    expect(uitgevoerd).toHaveLength(2); // maximaal één herpoging
    expect(telVerbindingen()).toBe(2);
    const laad = JSON.parse((antwoord.content as { text: string }[])[0].text);
    expect(laad.ok).toBe(false);
    expect(laad.error).toContain("Session not found");
  });
});

test("een normale MCP-tooluitkomst met ok:false wordt 1:1 doorgespeeld en nooit herhaald", async () => {
  await metTestToken(async () => {
    const { sessie, uitgevoerd, telVerbindingen } = nepExecutorSessie(
      () => () =>
        Promise.resolve({
          content: [
            { type: "text" as const, text: JSON.stringify({ ok: false, error: "skill niet gevonden" }) },
          ],
        }),
    );
    const antwoord = await callExecutor("skills", { name: "bestaat-niet" }, sessie);
    expect(uitgevoerd).toEqual([{ tool: "skills", args: { name: "bestaat-niet" } }]);
    expect(telVerbindingen()).toBe(1);
    expect(JSON.parse((antwoord.content as { text: string }[])[0].text)).toEqual({
      ok: false,
      error: "skill niet gevonden",
    });
  });
});
