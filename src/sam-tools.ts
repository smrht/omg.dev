// Sam's own MCP tools, kept in one file so upstream merges stay a one-liner in
// buildOmgMcpServer(). Nothing here is generic omg.dev surface — these wrap
// portfolio routes that every agent otherwise re-invents, usually unsafely.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, statSync } from "node:fs";
import * as z from "zod/v4";

const DEPLOY_HOSTS = ["netcup-vps8000-wp", "netcup-vps8000"] as const;

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

type PollerHost = {
  host: string;
  ok: boolean;
  apps: { app: string; repo: string; state: string }[];
  notInSync: { host: string; app: string; state: string }[];
  error?: string;
  raw?: string;
};

/** Parse `sites-beheer-deploy-poller --status` output. Header line is column 0. */
export function parsePollerOutput(out: string): { app: string; repo: string; state: string }[] {
  return out
    .split("\n")
    .map((line) => line.match(/^\s{2,}(\S+)\s+(\S+)\s+(.*\S)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ app: m[1], repo: m[2], state: m[3] }));
}

/**
 * Read-only deploy-poller status over ssh.
 *
 * The whole point is the invocation: `sudo -u samht`, never bare `sudo`. A root
 * run leaves root-owned files in the mirrors, releases and code dirs, which
 * wedges every later samht run and blocks that app's deploys entirely — it did
 * exactly that on 17 jul, 23 jul and 8 aug 2026. Baking the safe form into a
 * tool is cheaper than repeating the warning to every agent on every harness.
 */
async function readPollerStatus(host: string): Promise<PollerHost> {
  const proc = Bun.spawn(
    [
      "ssh",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      host,
      "sudo -u samht sites-beheer-deploy-poller --status",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  // ponytail: 60s wall clock, no retry. ssh either answers fast or the host is
  // the problem, which is itself the answer worth reporting.
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [out, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  if (code !== 0) {
    return { host, ok: false, apps: [], notInSync: [], error: (errText || out).trim().slice(0, 500) };
  }

  const apps = parsePollerOutput(out);

  // A zero exit with nothing parseable is NOT a clean host — it's a host we
  // learned nothing about, and reporting it as ok would render an empty
  // registry as an all-green one. Seen once here already: a cold ssh returned
  // exit 0 with empty stdout and the tool cheerfully said "attention: none".
  if (apps.length === 0) {
    return {
      host,
      ok: false,
      apps,
      notInSync: [],
      error: "poller gaf geen leesbare regels terug (exit 0)",
      raw: out.trim().slice(0, 2000),
    };
  }

  return {
    host,
    ok: true,
    apps,
    notInSync: apps
      .filter((a) => !a.state.includes("IN-SYNC"))
      .map((a) => ({ host, app: a.app, state: a.state })),
  };
}

const PLACEMENT_CSV = "/home/agent/sites-beheer/placement/placement.csv";

/** Minimale CSV-lezer voor placement.csv. Geen quoted velden met komma's daarin. */
export function leesPlacement(tekst: string): Record<string, string>[] {
  const [kop, ...regels] = tekst.trim().split("\n");
  const kolommen = kop.split(",");
  return regels.filter(Boolean).map((regel) => {
    // notes bevat zelf geen komma-in-quotes maar wel puntkomma's, dus splitsen
    // op de eerste N-1 komma's en de rest is de laatste kolom.
    const delen = regel.split(",");
    const staart = delen.slice(kolommen.length - 1).join(",");
    const waarden = [...delen.slice(0, kolommen.length - 1), staart];
    return Object.fromEntries(kolommen.map((k, i) => [k, (waarden[i] ?? "").trim()]));
  });
}

export function normaliseer(domein: string): string {
  return domein.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

// ---- Executor proxy (netcup-vps8000-95-88) ----
//
// Three thin central proxies to Sam's Executor MCP server. The Executor ties
// paused execution IDs to the MCP session (the StreamableHTTP Mcp-Session-Id):
// with a fresh Client per call, executor_execute ran in session A and an
// immediate executor_resume opened session B that had never heard of the
// executionId — measured live as "unknown" on every direct resume. So there is
// exactly ONE lazily connected shared Client/StreamableHTTPClientTransport per
// OMG MCP process, reused by executor_execute, executor_skills and
// executor_resume. On a connection or call failure the singleton is closed and
// cleared, so the next call reconnects fresh; when the server explicitly
// declares the session stale ("Session not found" na een Executor-herstart),
// the SAME original call is reissued exactly once over a fresh connection, so
// the first executor_execute after a restart succeeds instead of surfacing the
// stale-session error. The bearer comes from process.env.EXECUTOR_MCP_TOKEN or,
// because Codex deliberately sanitizes stdio-MCP child environments, from the
// mode-600 client env file. It is never put in a command line or printed; error
// text is defensively redacted so a thrown fetch/SDK error can't echo the
// Authorization header back into a transcript.

const EXECUTOR_MCP_URL = "https://netcup-vps8000-95-88.tailda028c.ts.net:8443/mcp";
const EXECUTOR_CLIENT_ENV = "/home/agent/.config/executor/client.env";

/**
 * Resolve the limited Executor client credential without putting it in argv.
 *
 * OMG's service and most harnesses inherit the environment variable. Codex
 * strips ambient variables from the stdio MCP process it starts, so that
 * process falls back to the same protected EnvironmentFile. Refuse group- or
 * world-readable files: a convenient fallback must not weaken the secret.
 */
export function executorToken(
  envToken: string | null | undefined = process.env.EXECUTOR_MCP_TOKEN,
  path: string = EXECUTOR_CLIENT_ENV,
): string {
  const ambient = (envToken ?? "").trim();
  if (ambient) return ambient;

  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return "";
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^export\s+/, "");
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^EXECUTOR_MCP_TOKEN\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[1].trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      return value.trim();
    }
  } catch {
    // executorAuth returns the single non-secret operator message below.
  }
  return "";
}

export function executorAuth(
  token: string | undefined,
): { ok: true; header: string } | { ok: false; error: string } {
  const t = (token ?? "").trim();
  if (!t) {
    return {
      ok: false,
      error:
        "EXECUTOR_MCP_TOKEN ontbreekt in de omg-omgeving. Zet EXECUTOR_MCP_TOKEN=<token> in " +
        "/home/agent/.config/executor/client.env (ingeladen door systemd drop-in 20-executor.conf) " +
        "en herstart omg.service. De token zelf staat nooit in logs of deze melding.",
    };
  }
  return { ok: true, header: `Bearer ${t}` };
}

export function executorFout(err: unknown, token: string): string {
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  // Nooit de bearer zelf doorlaten, ook niet via een uitgezonderde fetch-error.
  return token ? msg.split(token).join("<token-geredacteerd>") : msg;
}

export const EXECUTOR_RESUME_ACTIES = ["accept", "decline", "cancel"] as const;
export type ExecutorResumeActie = (typeof EXECUTOR_RESUME_ACTIES)[number];

/**
 * Bouwt de exacte argumenten voor Executor-tool `resume`. Pure, zodat de test
 * de doorgestuurde vorm kan bewijzen zonder een echte Executor-aanroep.
 */
export function executorResumeArgs(
  executionId: string,
  action: ExecutorResumeActie,
  content?: string,
): { executionId: string; action: ExecutorResumeActie; content: string } {
  return { executionId, action, content: content ?? "{}" };
}

/**
 * Herkent de expliciete stale-session-signatuur van de Executor: na een
 * containerrestart antwoordt de server op de oude Mcp-Session-Id met HTTP 404
 * en JSON-RPC -32001 "Session not found" (live gemeten 23-08-2026), wat de
 * SDK-client als StreamableHTTPError gooit. Alleen gegooide fouten met deze
 * expliciete serververklaring zijn retrybaar: een gewone tool-uitkomst
 * (ok:false/isError) kan dezelfde tekst legaal in gebruikersoutput bevatten en
 * wordt daarom nóóit als retrybaar gelezen — een retry op execute moet
 * bewijsbaar niet-uitgevoerd zijn, anders draait code dubbel.
 */
export function isStaleExecutorFout(err: unknown): boolean {
  const bericht = err instanceof Error ? err.message : String(err);
  return /session (not found|expired|terminated)/i.test(bericht);
}

/**
 * Precies één gedeelde verbinding per proces, lazy verbonden. `use` hergebruikt
 * de bestaande verbinding; valt de aanroep om, dan wordt de verbinding gesloten
 * én gewist zodat de volgende aanroep opnieuw verbindt. Parallelle eerste
 * aanroepen delen dezelfde lopende connect. Pure state zonder SDK-imports,
 * dus afzonderlijk testbaar.
 *
 * Met `isRetryable` wordt na zo'n reset — en alléén wanneer de fout volgens
 * dat predikaat expliciet stale-session is — dezelfde oorspronkelijke call
 * exact één keer opnieuw uitgevoerd over een verse verbinding. Zonder
 * predikaat blijft het gedrag ongewijzigd: reset zonder reissue.
 */
export function createSharedSession<T extends { close(): Promise<void> }>(
  connect: () => Promise<T>,
  isRetryable?: (err: unknown) => boolean,
) {
  let current: T | null = null;
  let connecting: Promise<T> | null = null;

  const discard = (failed: T) => {
    current = null;
    connecting = null;
    // Een close op een al kapotte verbinding mag zelf falen zonder te blijven plakken.
    return failed.close().catch(() => {});
  };

  const poging = async <R>(call: (connection: T) => Promise<R>): Promise<R> => {
    if (!current && !connecting) {
      connecting = connect().then(
        (connection) => {
          current = connection;
          connecting = null;
          return connection;
        },
        (err) => {
          connecting = null;
          throw err;
        },
      );
    }
    // connect-falen propageert hier direct: er is niets te sluiten of wissen.
    const connection = await (current ?? connecting!);
    try {
      return await call(connection);
    } catch (err) {
      await discard(connection);
      throw err;
    }
  };

  return {
    async use<R>(call: (connection: T) => Promise<R>): Promise<R> {
      try {
        return await poging(call);
      } catch (err) {
        if (!isRetryable || !isRetryable(err)) throw err;
        // Exact één reissue: een tweede falen valt door naar de aanroeper.
        // discard() heeft de stale verbinding al gesloten en gewist, dus dit
        // verbindt vers (of deelt een al lopende herverbinding).
        return await poging(call);
      }
    },
  };
}

/**
 * De enige Executor-verbinding van dit omg-proces. Lazy: pas bij de eerste
 * executor_*-aanroep wordt verbonden, met de bearer uit de omgeving van dat
 * moment. Client.close() sluit de StreamableHTTP-transport (en dus de
 * serversessie) mee.
 */
const executorSession = createSharedSession(async () => {
  const token = executorToken();
  const auth = executorAuth(token);
  if (!auth.ok) throw new Error(auth.error); // kan alleen als de token halverwege het proces verdwijnt
  const client = new Client({ name: "omg-sam-tools", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(EXECUTOR_MCP_URL), {
    requestInit: { headers: { Authorization: auth.header } },
  });
  await client.connect(transport);
  return client;
}, isStaleExecutorFout);

/** Verbindingseis van callExecutor: structuur, zodat tests een nep-sessie kunnen meegeven. */
type ExecutorSessie = {
  use<R>(
    call: (verbinding: {
      callTool(verzoek: { name: string; arguments?: Record<string, unknown> }): Promise<{
        content?: unknown;
        isError?: boolean;
      }>;
    }) => Promise<R>,
  ): Promise<R>;
};

/**
 * Eén Executor-aanroep over de gedeelde sessie; bij falen wordt die gesloten
 * en gewist, en bij een expliciete stale-session-fout wordt dezelfde aanroep
 * exact één keer herhaald (zie createSharedSession). Het derde argument is
 * uitsluitend een testnaad; productie gebruikt de module-singleton.
 */
export async function callExecutor(
  tool: string,
  args: Record<string, unknown>,
  sessie: ExecutorSessie = executorSession,
) {
  const token = executorToken();
  const auth = executorAuth(token);
  if (!auth.ok) return text({ ok: false, error: auth.error });

  try {
    const result = await sessie.use((client) =>
      client.callTool({ name: tool, arguments: args }) as Promise<{
        content?: unknown;
        isError?: boolean;
      }>,
    );
    // Content 1:1 doorspelen: de Executor bepaalt zelf wat een antwoord bevat.
    if (Array.isArray(result?.content) && result.content.length > 0) {
      return { content: result.content, ...(result.isError ? { isError: true } : {}) };
    }
    return text({ ok: false, error: `Executor-tool '${tool}' gaf geen content terug` });
  } catch (err) {
    return text({ ok: false, error: executorFout(err, token) });
  }
}

export function registerSamTools(server: McpServer): void {
  server.registerTool(
    "omg_site_placement",
    {
      title: "Waar draait deze site? (Sam's portfolio)",
      description:
        "Zoek op welke server een domein uit Sam's portfolio draait, uit placement.csv — de enige bron die hiervoor klopt. Gebruik dit in plaats van de `server`-kolom in eigen-sites.csv, money-local-context.csv of all-sites-local-context.csv: die zijn afgeleid of historisch en wijzen na elke migratie naar de verkeerde host. Geeft stack, type, docroot-pad en poort. Let op: dit is de administratie, niet een live meting; wijkt current_server af van desired_server dan loopt er een verhuizing en moet je verifiëren met `python3 scripts/placement_scan.py --diff`.",
      inputSchema: {
        domain: z.string().describe("Domeinnaam, met of zonder www/https."),
      },
    },
    async ({ domain }) => {
      const gezocht = normaliseer(domain);
      let rijen: Record<string, string>[];
      try {
        rijen = leesPlacement(await Bun.file(PLACEMENT_CSV).text());
      } catch (err) {
        return text({ ok: false, error: `placement.csv onleesbaar: ${String(err)}` });
      }

      const rij = rijen.find((r) => normaliseer(r.domain || "") === gezocht);
      if (!rij) {
        // Geen stille nul: een onbekend domein is geen "draait nergens".
        const buurt = rijen
          .map((r) => r.domain)
          .filter((d) => d && (d.includes(gezocht.split(".")[0]) || gezocht.includes(d.split(".")[0])))
          .slice(0, 5);
        return text({
          ok: false,
          domain: gezocht,
          error: "niet gevonden in placement.csv",
          lijkendOp: buurt,
          hint: "Staat een site er niet in, dan is de administratie achter, niet de site weg. Draai scripts/placement_scan.py --diff.",
        });
      }

      const verhuizing = !!rij.desired_server && rij.current_server !== rij.desired_server;
      return text({
        ok: true,
        domain: rij.domain,
        server: rij.current_server,
        stack: rij.stack,
        type: rij.type,
        pad: rij.notes,
        verhuizingLoopt: verhuizing,
        ...(verhuizing ? { desiredServer: rij.desired_server, waarschuwing: "current_server wijkt af van desired_server: verifieer met placement_scan.py --diff voordat je hier iets wijzigt" } : {}),
      });
    },
  );

  server.registerTool(
    "omg_deploy_poller_status",
    {
      title: "Deploy-poller status (Sam's portfolio)",
      description:
        "Read-only status of the server-side deploy-poller on Sam's Netcup VPS8000 hosts: which registered apps are IN-SYNC with their git remote and which are behind or failed. Use this instead of shelling out yourself — it runs the only safe invocation (`sudo -u samht`, never bare `sudo`, which corrupts poller state and blocks that app's deploys).",
      inputSchema: {
        host: z
          .enum([...DEPLOY_HOSTS, "both"])
          .optional()
          .describe("Which host to query. Defaults to both."),
      },
    },
    async ({ host }) => {
      const targets = !host || host === "both" ? [...DEPLOY_HOSTS] : [host];
      const hosts = await Promise.all(targets.map(readPollerStatus));
      return text({
        hosts,
        // The one number worth reading first: anything not IN-SYNC is either
        // mid-deploy or stuck, and both deserve a look.
        attention: hosts.flatMap((h) => h.notInSync),
      });
    },
  );

  server.registerTool(
    "executor_execute",
    {
      title: "Voer code uit op de Executor (netcup-vps8000-95-88)",
      description:
        "Voer code uit op Sam's Executor-MCP-server (netcup-vps8000-95-88) en geef het resultaat " +
        "1:1 door. Gebruik dit in plaats van een eigen HTTP-call naar de Executor: deze route regelt " +
        "de bearer (EXECUTOR_MCP_TOKEN), één gedeelde client per omg-proces en nette foutmeldingen zonder " +
        "token-lekkage. pauzeert de execution, dan werkt een directe executor_resume: execute en resume " +
        "delen dezelfde MCP-sessie en paused executionId's zijn sessie-gebonden. " +
        "Ontbreekt de token, dan krijg je een duidelijke niet-geheime foutmelding.",
      inputSchema: {
        code: z.string().describe("De code die de Executor moet uitvoeren."),
      },
    },
    async ({ code }) => callExecutor("execute", { code }),
  );

  server.registerTool(
    "executor_skills",
    {
      title: "Executor-skills (netcup-vps8000-95-88)",
      description:
        "Lijst de skills van Sam's Executor-MCP-server, of de details van één skill. Zelfde route " +
        "als executor_execute: bearer uit EXECUTOR_MCP_TOKEN, gedeelde client per omg-proces, resultaat 1:1.",
      inputSchema: {
        name: z.string().optional().describe("Optioneel: alleen deze skill tonen."),
      },
    },
    async ({ name }) => callExecutor("skills", name ? { name } : {}),
  );

  server.registerTool(
    "executor_resume",
    {
      title: "Hervat een Executor-execution (netcup-vps8000-95-88)",
      description:
        "Hervat een eerdere Executor-run op basis van zijn executionId, met een actie (accept, decline of cancel) " +
        "en optioneel content (JSON-string, standaard '{}'). Zelfde route als executor_execute: bearer uit " +
        "EXECUTOR_MCP_TOKEN en dezelfde gedeelde MCP-sessie — executionId's zijn sessie-gebonden, dus resume " +
        "moet over dezelfde verbinding als execute — resultaat 1:1.",
      inputSchema: {
        executionId: z.string().describe("Het executionId van de te hervatten run."),
        action: z
          .enum(EXECUTOR_RESUME_ACTIES)
          .describe("Wat de Executor met de wachtende run doet: accept, decline of cancel."),
        content: z.string().default("{}").describe("Content als JSON-string; standaard '{}'."),
      },
    },
    async ({ executionId, action, content }) => callExecutor("resume", executorResumeArgs(executionId, action, content)),
  );
}
