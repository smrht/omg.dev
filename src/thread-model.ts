/**
 * A thread's model choice: what is stored, what is pickable, and what a
 * message actually runs with.
 *
 * The stored choice lives on the conversation (`threadSelection`). This module
 * is the one place that turns it, plus the box's connected-agent catalog, into
 * the agent/model/thinkingLevel pair a reply and its task use. It keeps two
 * states apart that must not be conflated:
 *
 *   - NO selection: the box defaults apply, silently, as they always did.
 *   - An explicit selection that is no longer available: an honest error.
 *     Never a silent fallback to some other agent or model.
 */
import type { CodingAgentInfo } from "./coding-agents.ts";
import type { CodexModelCapabilities } from "./model-discovery.ts";
import {
  THREAD_CHAT_AGENT_KEYS,
  type ThreadSelection,
  type ThreadSelectionOption,
} from "../packages/protocol/src/threads.ts";

/** The pair every @omg action in one message uses: the short reply, and the task it may start. */
export type ThreadPair = {
  agent: string;
  model: string;
  thinkingLevel?: string | null;
  /** Explicit cyber access program, REPLIES ONLY (Codex family). Never reaches a task. */
  cyberAccessProgram?: string | null;
};

/** Per-model capability metadata a thread selection is validated against (Codex family). */
export type ThreadModelCapabilities = Record<string, CodexModelCapabilities>;

/** The structural slice of the model catalog this module needs (listModelCatalog items). */
export type ThreadCatalogItem = {
  key: string;
  label: string;
  defaultModel: string;
  models: string[];
  thinkingLevels: string[];
  thinkingLevelsByModel?: Record<string, string[]>;
};

export type ThreadPairResolution =
  | { kind: "pair"; pair: ThreadPair }
  | { kind: "error"; reason: string };

/** How one message runs: the pair its short reply uses, and the pair its task starts with. */
export type ThreadTurnPair = {
  completion: ThreadPair;
  task: { agent: string; model: string | null; thinkingLevel: string | null };
};

export type ThreadTurnResolution = { kind: "error"; reason: string } | ({ kind: "turn" } & ThreadTurnPair);

function levelsFor(item: ThreadCatalogItem, model: string): string[] {
  return item.thinkingLevelsByModel?.[model] ?? item.thinkingLevels ?? [];
}

/**
 * The agents a thread can pick: chat-adapter keys that this box shows, has
 * configured, and offers models for. An adapter key the catalog does not know
 * (say "claude" where only "aisdk" is listed) stays out — it cannot be picked
 * honestly, but remains valid when it appears in a stored choice or a mention.
 */
/** Codex-family keys whose per-model thinking levels come from live capability metadata. */
const CODEX_FAMILY_KEYS = new Set(["codex", "codex-aisdk"]);

export function threadSelectionOptions(
  catalog: readonly ThreadCatalogItem[],
  codingAgents: readonly CodingAgentInfo[],
  /** Codex-family capability metadata; programs and fresh levels come from it, never static guesses. */
  codexCapabilities?: ThreadModelCapabilities,
): ThreadSelectionOption[] {
  const connected = new Map<string, CodingAgentInfo>(codingAgents.map((agent) => [agent.key, agent]));
  const out: ThreadSelectionOption[] = [];
  for (const item of catalog) {
    if (!THREAD_CHAT_AGENT_KEYS.includes(item.key)) continue;
    const info = connected.get(item.key);
    if (!info || !info.visible || info.status.configured !== true) continue;
    if (!item.models.length) continue;
    // Live per-model reasoning efforts are the EXACT level list for that
    // model (a fresh level like "ultra" shows up the moment discovery does);
    // the catalog's static list applies only to models without metadata.
    const levelsByModel = CODEX_FAMILY_KEYS.has(item.key) && codexCapabilities
      ? Object.fromEntries(item.models.flatMap((model) => {
          const efforts = codexCapabilities[model]?.reasoningEfforts;
          return efforts?.length ? [[model, [...efforts]]] : [];
        }))
      : {};
    const mergedLevels: Record<string, string[]> = {
      ...(item.thinkingLevelsByModel ?? {}),
      ...levelsByModel,
    };
    const programs = codexCapabilities
      ? Object.fromEntries(
          item.models.flatMap((model) => {
            const offered = codexCapabilities[model]?.cyberAccessPrograms ?? [];
            return offered.length ? [[model, [...offered]]] : [];
          }),
        )
      : {};
    out.push({
      key: item.key,
      label: info.label || item.label,
      models: item.models,
      defaultModel: item.defaultModel || item.models[0],
      thinkingLevels: item.thinkingLevels ?? [],
      ...(Object.keys(mergedLevels).length ? { thinkingLevelsByModel: mergedLevels } : {}),
      ...(Object.keys(programs).length ? { cyberAccessProgramsByModel: programs } : {}),
    });
  }
  return out;
}

/** Programs live metadata offers for one option+model. Empty means none may be picked. */
function programsFor(option: ThreadSelectionOption | undefined, model: string): string[] {
  return option?.cyberAccessProgramsByModel?.[model] ?? [];
}

/** Coerce an untrusted stored/persisted value into a ThreadSelection, or null when it is not one. */
export function normalizeThreadSelection(value: unknown): ThreadSelection | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { agent?: unknown; model?: unknown; thinkingLevel?: unknown; cyberAccessProgram?: unknown };
  if (typeof row.agent !== "string" || !row.agent.trim()) return null;
  if (typeof row.model !== "string" || !row.model.trim()) return null;
  const thinkingLevel =
    typeof row.thinkingLevel === "string" && row.thinkingLevel.trim() ? row.thinkingLevel.trim() : null;
  const cyberAccessProgram =
    typeof row.cyberAccessProgram === "string" && row.cyberAccessProgram.trim() ? row.cyberAccessProgram.trim() : null;
  return {
    agent: row.agent.trim(),
    model: row.model.trim(),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(cyberAccessProgram ? { cyberAccessProgram } : {}),
  };
}

/**
 * Validate a selection a client wants to store. Returns a cleaned selection, or
 * a 400-shaped reason. A valid-but-currently-unavailable choice is REJECTED
 * here too: the picker only offers what answers, so a stored choice that
 * cannot run was stale or hand-written, and storing it would only postpone the
 * failure to the next message.
 */
export function checkThreadSelectionForStore(
  value: unknown,
  options: readonly ThreadSelectionOption[],
): { ok: true; selection: ThreadSelection | null } | { ok: false; reason: string } {
  const selection = normalizeThreadSelection(value);
  if (!selection) {
    // Null and undefined mean "no choice"; anything else that normalizes to
    // null (a number, an empty string, a mangled object) is a bad request.
    if (value === null || value === undefined) return { ok: true, selection: null };
    return { ok: false, reason: "selection must be { agent, model } or null" };
  }
  const option = options.find((row) => row.key === selection.agent);
  if (!option) {
    return {
      ok: false,
      reason: `agent "${selection.agent}" is not available for threads (expected one of ${
        options.length ? options.map((row) => row.key).join(", ") : "none"
      })`,
    };
  }
  if (!option.models.includes(selection.model)) {
    return {
      ok: false,
      reason: `unknown model "${selection.model}" for ${selection.agent} (expected one of ${option.models.join(", ")})`,
    };
  }
  if (selection.thinkingLevel) {
    const allowed = levelsFor(option, selection.model);
    if (!allowed.length) {
      return { ok: false, reason: `thinkingLevel is not supported for ${selection.agent} model ${selection.model}` };
    }
    if (!allowed.includes(selection.thinkingLevel)) {
      return {
        ok: false,
        reason: `unknown thinking level "${selection.thinkingLevel}" for ${selection.agent} ${selection.model} (expected one of ${allowed.join(", ")})`,
      };
    }
  }
  if (selection.cyberAccessProgram) {
    const offered = programsFor(option, selection.model);
    if (!offered.length || !offered.includes(selection.cyberAccessProgram)) {
      const list = offered.length ? offered.join(", ") : "none";
      return {
        ok: false,
        reason: `${selection.agent} model ${selection.model} does not offer program "${selection.cyberAccessProgram}" (offered: ${list})`,
      };
    }
  }
  return { ok: true, selection };
}

/**
 * What a message actually runs with, given the frozen stored choice and the
 * catalog as it is right now.
 *
 * `stored` null: the box defaults (`defaultAgent`/`defaultModel` when they name
 * something pickable, else the first pickable agent's own default).
 * `stored` set: it must still be fully available, or the caller gets an error
 * that names the choice — never a substitute.
 */
export function resolveThreadPair(input: {
  stored: ThreadSelection | null | undefined;
  options: readonly ThreadSelectionOption[];
  /** Settings' "Default agent and model", as the session launcher reads them. */
  defaultAgent?: string | null;
  defaultModel?: string | null;
}): ThreadPairResolution {
  if (input.stored) {
    const option = input.options.find((row) => row.key === input.stored!.agent);
    if (!option) {
      return {
        kind: "error",
        reason: `${input.stored.agent} is not connected for thread replies anymore; pick another agent for this thread`,
      };
    }
    if (!option.models.includes(input.stored.model)) {
      return {
        kind: "error",
        reason: `model ${input.stored.model} is not offered by ${input.stored.agent} anymore; pick another model for this thread`,
      };
    }
    if (input.stored.thinkingLevel) {
      const allowed = levelsFor(option, input.stored.model);
      if (!allowed.includes(input.stored.thinkingLevel)) {
        return {
          kind: "error",
          reason: `thinking level ${input.stored.thinkingLevel} is not supported by ${input.stored.agent} ${input.stored.model} anymore; pick another one for this thread`,
        };
      }
    }
    if (input.stored.cyberAccessProgram) {
      const offered = programsFor(option, input.stored.model);
      if (!offered.includes(input.stored.cyberAccessProgram)) {
        const list = offered.length ? offered.join(", ") : "none";
        return {
          kind: "error",
          reason: `program ${input.stored.cyberAccessProgram} is not offered by ${input.stored.agent} ${input.stored.model} anymore (offered: ${list}); pick another access choice for this thread`,
        };
      }
    }
    return { kind: "pair", pair: { ...input.stored } };
  }
  const byKey = input.options.find((row) => row.key === input.defaultAgent?.trim());
  const option = byKey ?? input.options[0];
  if (!option) {
    return { kind: "error", reason: "no connected agent is available for thread replies on this machine" };
  }
  const model = byKey && input.defaultModel?.trim() && byKey.models.includes(input.defaultModel.trim())
    ? input.defaultModel.trim()
    : option.defaultModel;
  return { kind: "pair", pair: { agent: option.key, model } };
}

/**
 * The @agent override, on top of the thread's stored choice.
 *
 * Naming the agent the thread already uses changes nothing: the thread's own
 * model, level and access program stay. Naming a different chat-capable agent
 * switches both the reply and the task to THAT agent's own known default
 * model with no level and no program (a program belongs to the chosen agent's
 * account, never to another agent's name). Naming an agent threads cannot
 * reply with keeps the thread's pair for omg's own brief, and starts the task
 * under that agent with its own default model, exactly as mentions always did.
 */
export function resolveThreadTurn(input: {
  stored: ThreadSelection | null | undefined;
  options: readonly ThreadSelectionOption[];
  defaultAgent?: string | null;
  defaultModel?: string | null;
  mentioned?: { key: string } | null;
}): ThreadTurnResolution {
  const base = resolveThreadPair(input);
  if (base.kind === "error") return base;
  const mentioned = input.mentioned?.key?.trim();
  if (!mentioned || mentioned === base.pair.agent) {
    return {
      kind: "turn",
      completion: base.pair,
      task: { agent: base.pair.agent, model: base.pair.model, thinkingLevel: base.pair.thinkingLevel ?? null },
    };
  }
  const option = input.options.find((row) => row.key === mentioned);
  if (!option) {
    return {
      kind: "turn",
      completion: base.pair,
      task: { agent: mentioned, model: null, thinkingLevel: null },
    };
  }
  const pair: ThreadPair = { agent: option.key, model: option.defaultModel };
  return { kind: "turn", completion: pair, task: { agent: option.key, model: option.defaultModel, thinkingLevel: null } };
}
