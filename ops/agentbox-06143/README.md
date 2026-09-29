# Pinned 0.6.143 staging

Prepared locally. NOT DEPLOYED. Tailscale SSH user verification is pending.

Before staging, re-read the live private pointer and verify its manifest.
`deploy.py` currently expects the last verified 06138-agentbox-20260928;
any newer live customization must be brought into the source before proceeding.
Copy the current live safety wrapper/pilot checker, preserving all changes and
adding only version 0.6.143 to the supported list.

The three Linux-only boot recovery checks in session-relaunch-containment.test.ts
must run on the candidate on Linux. Source-level startup overlays must be tested
against the candidate and remain no-ops before activation.

Use the prior 06138 runbook: release SHA validation, source delta upload,
protocol/client/web build, stage, negative controls and replay, state capture,
safe preflight, safe apply under a transient unit, adoption/state checks and
public desktop/mobile QA. Do not run run-safe.sh before these prerequisites.

Separate feature scope: thread subscription/model choice and own media routes
are still at design stage. This update does not claim to implement those.
