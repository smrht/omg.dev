#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
bun run typecheck
bun run --cwd web typecheck
bun test web/src/lib/session-overview.test.ts web/src/lib/session-groups.test.ts web/src/lib/rail-group-fold.test.ts web/src/lib/bot-stage-session.test.ts web/src/components/session-overview.test.tsx web/src/lib/model-favorites.test.ts web/src/lib/model-picker-display.test.ts web/src/lib/use-model-favorites.test.tsx web/src/components/compact-model-picker-sheet.test.tsx web/src/model-option-list.test.tsx web/src/components/session-usage-controls.test.tsx web/src/components/desktop-workspace.test.tsx
bun test web/src/dual-surface-shortcuts.test.ts
printf '%s\n' DESKTOP_WORKSPACE_CODE_OK
