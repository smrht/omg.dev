// SSH-based runtime probe for the mac execution host.
//
// `ssh -T <target> probe` sends `{"type":"probe","schema":1}` on stdin and
// the supervisor answers the FROZEN MacRuntimeProbeReport shape
// (src/execution-host.ts: schema 1, machineIdentity, buildManifestSha256,
// os, cliVersion, toolManifestSha256, health, per-provider records). This is
// the probe transport for configs that pin the ssh route; the legacy
// local-adapter probe stays the default elsewhere. A reachable supervisor
// whose answer does not carry the pinned attestation facts fails CLOSED
// with the exact missing facts — reachability is preflight, never proof.
import {
  isProbeReport,
  MAC_PROBE_SCHEMA,
  type MacChatConfig,
  type MacRuntimeProbeOutcome,
} from "../execution-host.ts";
import { macSshOneShot, macSshSpawn, type MacStreamSpawnFn } from "./stream.ts";

/** Run one probe exchange over ssh and parse the frozen report. Never throws. */
export async function sshProbeRuntime(
  target: string,
  spawn: MacStreamSpawnFn,
  timeoutMs = 15_000,
): Promise<MacRuntimeProbeOutcome> {
  const answer = await macSshOneShot(spawn, target, { kind: "probe" }, {
    stdinJson: { type: "probe", schema: MAC_PROBE_SCHEMA },
    timeoutMs,
  });
  if (!answer.ok) return { ok: false, error: answer.error };
  const trimmed = answer.stdout.trim();
  if (!trimmed) return { ok: false, error: "probe antwoordde geen JSON" };
  const firstLine = trimmed.split("\n", 1)[0]!.trim();
  try {
    const parsed = JSON.parse(firstLine) as unknown;
    if (!isProbeReport(parsed)) {
      return {
        ok: false,
        error: "probe antwoordt niet het frozen MacRuntimeProbeReport (machine-identiteit/build-manifest/os/cli/tool-manifest/per-provider records); mac blijft unavailable tot de supervisor dit levert",
      };
    }
    return { ok: true, report: parsed };
  } catch {
    return { ok: false, error: "probe antwoordde geen geldig probe-report" };
  }
}

/** Preflight facts short of a full tested workflow (reported separately). */
export type MacSshPreflightDetail = {
  reachable: boolean;
  sanitizedReason?: string;
  /** Coordinator participation (item 16/20): shared-lock evidence from the
   * supervisor's own coordinator heartbeat, surfaced for admission/UI. */
  coordinator?: { ok: boolean; reason?: string };
  /** Shared coding capacity snapshot (names/numbers only). */
  capacity?: { active: number | null; limit: number | null };
};

/**
 * The probeRuntime override handed to registerMacLaunchAdapter when the
 * admin config pins the ssh route. Binds to config.ssh.target, parses the
 * FROZEN report (the supervisor's op_probe emits it), surfaces coordinator
 * readiness + capacity in the preflight channel, and fails closed on any
 * transport/parse problem. Pin evaluation stays with the contract owner.
 */
export function sshProbeRuntimeForConfig(
  spawn: MacStreamSpawnFn,
  onPreflight?: (report: MacSshPreflightDetail) => void,
): (config: MacChatConfig) => Promise<MacRuntimeProbeOutcome> {
  return async (config) => {
    const target = config.ssh?.target;
    if (!target) {
      return { ok: false, error: "config heeft geen ssh-target-pin; de ssh-probe is niet van toepassing" };
    }
    const outcome = await sshProbeRuntime(target, spawn);
    if (!outcome.ok) {
      onPreflight?.({ reachable: false, sanitizedReason: outcome.error });
      return outcome;
    }
    // The frozen report carries additive transport detail (op_probe): surface
    // coordinator/capacity evidence for admission/UI handling (items 16/20).
    const detail = (outcome.report as unknown as {
      transport?: { coordinator?: { ok?: boolean; reason?: string }; capacity?: { active?: number | null; limit?: number | null } };
    }).transport;
    onPreflight?.({
      reachable: true,
      ...(detail?.coordinator ? { coordinator: { ok: !!detail.coordinator.ok, ...(detail.coordinator.reason ? { reason: detail.coordinator.reason } : {}) } } : {}),
      ...(detail?.capacity ? { capacity: { active: detail.capacity.active ?? null, limit: detail.capacity.limit ?? null } } : {}),
    });
    return outcome;
  };
}

/**
 * The serve registration helper (item 30): the production spawn adapter is
 * `macSshSpawn` — real pipes both ways, so the probe's stdin JSON actually
 * reaches the supervisor and the answer drains before resolution. A bare
 * `Bun.spawn` (stdin default "ignore", incompatible shape) must NEVER be
 * cast in with `as never` to fake the contract; serve passes the adapter
 * EXPLICITLY (dependency injection, no PATH tricks), and tests inject a
 * fixture executable through the same production pipe adapter.
 */
export function serveSshProbeOverride(
  spawn: MacStreamSpawnFn,
  onPreflight?: (report: MacSshPreflightDetail) => void,
): (config: MacChatConfig) => Promise<MacRuntimeProbeOutcome> {
  return sshProbeRuntimeForConfig(spawn, onPreflight);
}
