import { createHash } from "node:crypto";

type Session = { sessionId?: string | null; nativeSessionId?: string | null };

/** Only an explicit parent or the runtime's own identity may establish lineage.
 * A global active-session file can belong to a different concurrent task. */
export function resolveSubsessionParent(input: unknown, rows: Session[]): string {
  if (typeof input !== "string" || !input.trim())
    throw new Error("Subagent vereist een hoofdchat. Geef --parent SESSION_ID mee of start vanuit een beheerde OMG-sessie.");
  const id = input.trim();
  if (!/^[0-9a-f-]{8,36}$/i.test(id)) throw new Error("Ongeldig hoofdchat-ID");
  const matches = rows.filter(r => [r.sessionId, r.nativeSessionId].some(v => v === id || v?.startsWith(id)));
  if (matches.length !== 1 || !matches[0]?.sessionId)
    throw new Error(matches.length > 1 ? "Hoofdchat-ID is niet uniek" : "Hoofdchat bestaat niet of is niet actief");
  return matches[0].sessionId!;
}

/** A parse/transport failure may be retried without launching another worker.
 * taskKey explicitly names a logical job; otherwise exact inputs name it. */
export function subsessionCreationKey(parent: string, body: Record<string, unknown>, taskKey?: string): string {
  const identity = taskKey?.trim()
    ? [parent, "task", taskKey.trim()]
    : [parent, body.agent, body.model, body.thinkingLevel ?? null, body.cwd ?? null, body.prompt];
  return "subsession-v1:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
