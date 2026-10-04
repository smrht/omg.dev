// Public surface of the Mac main-chat bridge (see README.md in this
// directory for the mount example and the honest capability statement).
export {
  LeaseRegistry,
  LeaseValidationError,
  assertUpstreamUrl,
  hashToken,
  hashesMatch,
  newLeaseToken,
  sha256Hex,
  validateLease,
  type BridgeLease,
  type BridgeLeaseInput,
  type BridgeNamespaceTarget,
  type BridgeRoot,
} from "./lease.ts";
export {
  DEFAULT_BRIDGE_LIMITS,
  SUPPORTED_BRIDGE_ROLES,
  createMacChatBridge,
  type BridgeLimits,
  type MacChatBridge,
  type MacChatBridgeOptions,
} from "./bridge.ts";
export {
  DEFAULT_WORKSPACE_LIMITS,
  WORKSPACE_SERVER_NAME,
  WORKSPACE_SERVER_VERSION,
  workspaceReadiness,
  workspaceTools,
  type WorkspaceLimits,
} from "./workspace.ts";
export { forbiddenPathSegment } from "./guards.ts";
export { IdempotencyJournal, isUuid } from "./journal.ts";
export { StdioNamespaceAdapter, DEFAULT_STDIO_ADAPTER_LIMITS, type StdioServerSpec } from "./stdio-adapter.ts";
