import { defaultModelForAgent, modelsForAgent } from "./agent-catalog.ts";
import type { ResumableBackend } from "./resume-cache.ts";

export function resolveResumeModel(
  backend: ResumableBackend,
  storedModel?: string | null,
  requestedModel?: string | null,
): string {
  // Cursor stores the exact launched variant (for example `kimi-k3-high`),
  // while its picker deliberately collapses that family to `kimi-k3`. The
  // durable row is already pinned to the Cursor backend, so preserve a valid
  // stored slug instead of comparing it with the shorter picker catalog and
  // silently resuming on `auto`.
  if (backend === "cursor" && storedModel && /^[A-Za-z0-9_.:/-]{1,120}$/.test(storedModel)) {
    return storedModel;
  }
  // OpenCode resolves arbitrary provider/model pairs at runtime: custom
  // slugs like `zai-coding-plan/glm-5.3-flash` never appear in the static
  // catalog, so a cold resume silently fell back to the catalog default.
  // Preserve a syntactically valid stored slug, same contract as the
  // cursor rule above; malformed stored input falls through unchanged.
  if (
    backend === "opencode" &&
    storedModel && storedModel.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)*$/.test(storedModel)
  ) {
    return storedModel;
  }
  const allowed = modelsForAgent(backend);
  if (storedModel && allowed.includes(storedModel)) return storedModel;
  if (requestedModel && allowed.includes(requestedModel)) return requestedModel;
  return defaultModelForAgent(backend);
}
