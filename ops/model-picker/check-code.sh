#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
bun run typecheck
bun run --cwd web typecheck
bun test web/src/lib/model-favorites.test.ts web/src/lib/model-picker-display.test.ts web/src/lib/use-model-favorites.test.tsx web/src/components/compact-model-picker-sheet.test.tsx web/src/model-option-list.test.tsx web/src/components/session-usage-controls.test.tsx
printf '%s\n' MODEL_PICKER_CODE_OK
