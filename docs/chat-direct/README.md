# Direct chat entry — 5 October 2026

Sam uses the session rail and transcript stage. Remove the separate desktop workspace landing view and its two return buttons. New session, keyboard handlers, project filters, bots and mobile keep their existing behavior. An empty desktop stage still has the existing in-pane composer; selecting a conversation opens its transcript.

Source: App.tsx; base 1e19b2f7, matching live App.tsx SHA256 fdfd07107673c1f018073dfbcc0b2b283a73a1d3435a20270fe240968002df39.

Verification: 45 focused tests (dual-surface shortcuts, project filter, session overview, expand-on-focus), Mac Node build with frozen Bun install and root/web typechecks. Check DIST-MANIFEST.json ok, not only worker exit code; the adapter packages build failures as diagnostic artifacts with exit 0.

Delivery uses an immutable web-only snapshot derived from the active private layer, retaining all old hashed assets. Apply with activate.py under the update lock. No server restart or session migration. Before activation, verify the old manifest and unchanged active pointer. Rollback replaces changed frontend files from the previous snapshot and returns the pointer; never roll back user data.

Live layer: `06176-chat-direct-20261005`; previous: `06176-agentbox-20261005-r4-weekretro`. 240 files activated; 328 pre-existing gzip assets retained after exact decompressed-content equality. Three gates verified. Firefox QA restored its original No project filter and closed its own browser.
