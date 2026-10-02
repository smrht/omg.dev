#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/candidate"
for file in src/omg-capabilities.test.ts src/conversations.test.ts src/codex-daybreak.test.ts src/omg-isolation-computer.test.ts src/own-media.test.ts src/own-media-defaults.test.ts web/src/lib/session-mention.test.ts web/src/lib/app-search.test.ts web/src/components/own-media.test.tsx web/src/components/ai-elements/streamdown-session-ref.test.tsx web/src/components/desktop-workspace.test.tsx web/src/components/project-pill-rail.test.tsx; do
  bun test "$file"
done
printf 'THREAD_REMOVAL_REGRESSIONS_OK\n'
cd web
node node_modules/vite/bin/vite.js build
