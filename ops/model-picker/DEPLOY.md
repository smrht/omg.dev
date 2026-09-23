# Resume publication after SSH identity verification

Implementation commit: ff39599d in smrht/omg.dev, branch codex/chat-overview.
Published and live-verified on2026-09-23. The steps below document the completed deployment and its safety requirements. Fresh publication baseline: model-picker-1023-publish; the earlier model-picker-1023 baseline is retained.

1. Reverify agentbox2, the active private pointer and source hash. Expected prior layer is `06117-1022-overview-20260923`. Existing baseline is under `~/.local/state/omg-update-backups/model-picker-1023/`; retain it. Read/re-run the state comparison before writing; if legitimate concurrent settings changed, record a fresh baseline without erasing the earlier one.
2. Re-run source gates and Node/Vite production build when source changed. Exact source files for a new immutable layer:
   - changed: `web/src/App.tsx`
   - new: `web/src/components/compact-model-picker-sheet.tsx`, `web/src/lib/model-favorites.ts`, `web/src/lib/model-picker-display.ts`, `web/src/lib/use-model-favorites.ts`
   - dist: `web/dist`, excluding source maps. Keep all old hashed assets.
   The replaced `agent-setup-sheet.tsx` was absent from packaged runtime source; it is deleted only in the source repository.
3. Stage only those files and built dist under `~/.cache/agent-tmp/omg-model-picker`. Transfer the reviewed `normalize-compressed.py`, `activate.py` and `rollback.py` to the baseline folder. Run compressed-content normalization against the current immutable manifest.
4. Use the reviewed snapshot builder `/Users/samht/sites-beheer/omg-fork/0698/make_snapshot.py`: current snapshot as --from, staging as --build, --name `06117-1023-picker-20260923`, the changed/new lists above, --dist-from web/dist. This refuses mismatched source/hashed-asset bytes. Never overwrite an existing release.
5. Activate with `activate.py <new-release-path> --expected 06117-1022-overview-20260923`. No service restart is necessary. Keep prior immutable layer and rollback helper.
6. Verify baseline with `python3 ~/.local/state/omg-update-backups/model-picker-1023-publish/verify-publication.py --baseline ~/.local/state/omg-update-backups/model-picker-1023-publish`. This checks archived sessions against a new archive timestamp and retained transcript, as active lists legitimately change. Compare OMG MainPID/start time against service-before.txt. Live browser must verify picker/favorites/search/Flash/thinking/usage/composer at mobile and desktop widths, preserving test preferences and submitting no chat. A running process or HTTP200 is insufficient.
7. Update README/admin runbook, close issue1023 only after live proof, stop own preview/tunnel and remove only this task's staging. Keep private screenshots and preservation backups.

Rollback script intentionally restores software only, retains current data and old/new assets for open tabs, and refuses an unexpected current layer.
