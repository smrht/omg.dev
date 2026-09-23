# Model picker — issue 1023

Visual target: approved generated image exec-1082e53f-c33c-4027-bb09-26c272e8c655.png.
Scope: existing web picker and inline composer. Current assets/system font/Lucide reused. No new raster artwork. Native iOS source is out of scope.

Design read: compact flat agent header, max three favorite rows with readable model/provider, explicit actual reasoning levels, contextual usage, composer summary. 44px touch targets even when chrome is smaller. Light/dark reuse tokens. Existing source-of-truth for agent/model/thinking/start stays in composer. Favorites add browser-local per-agent state, not a fake provider catalog.
Motion read: preserve existing reduced-motion handling. Opening/closing and subpage direction clarify navigation; do not introduce ornamental motion. transitions-dev/polish skill paths are absent; use existing accessible primitives.

QA sequence: baseline exact390x844 in same-origin iframe (Firefox min outer-window500 bypassed without altering app CSS), then current picker light/dark; favorite add/remove/reload/agent isolation; all-model search and actual Flash selection/low-high-max; back/Escape/close; Claude profile/fast controls and real usage. Desktop1440 full page verify existing model picker and favorites. Restore browser preferences afterward; no chat submission/reset/connection authorization.

Review code, pure/render tests, root/web tsc, production build. Before deploy hash settings/routine definitions/configs, record session identities and process start times. New immutable layer with existing snapshot script; no process restart. Verify same UI live and preservation hashes. Keep rollback.
