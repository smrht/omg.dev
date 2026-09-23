# Compact chat overview — Agentbox private layer

Issue: https://github.com/smrht/sites-beheer/issues/1022
Base: codex/preserve-06117, 2a8c07fde4a5478cb71ad1d301f146d259927433.

The approved design puts real open questions and blocked sessions first, then pins, ongoing work and recent conversations. Search matches title, preview, project, agent and model; all terms must match, case/accent insensitive. All chats and Projects provide alternate views. The unread filter uses the existing per-viewer unread store. Families retain ancestry. Row/keyboard ordering and folded groups use the same result. Compact (60px) and comfortable (76px) persist per browser. Existing provider and avatar preferences, film blur, quick menu, usage, gestures and session actions are retained.

Project chips appear under Projects. A visible clear-filter action restores all projects and now stays there across polls. Search covers roster metadata, not the entire historical transcript. Idle is deliberately not called completed. A blocked row opens the existing conversation recovery surface; there is no blind automatic retry. Preferences are browser-local, not cross-device synchronized.

## Delivery

The Mac source tree matches live App.tsx/index.css at baseline. A Node Vite build produces platform-independent web assets. New files go to a staging directory; make_snapshot.py derives a new immutable layer from current. Compressed collisions from another build platform retain original bytes only after decompression proves equality. activate.py validates both manifests and all live before-hashes, publishes assets before HTML, and switches the private pointer. No backend or data files change and no service restart occurs.

Current layer: `/home/agent/.local/lib/omg-private/releases/06117-1022-overview-20260923`.
Rollback and baseline: `/home/agent/.local/state/omg-update-backups/overview-1022/`.
Previous layer: `06117-1021-menu-20260923`. Run the saved rollback.py only when rollback is intended. It preserves data and new assets needed by existing tabs.

## Verification

57 focused pure tests (state/search/group/project/pin/unread/folding); 4 overview rendering tests; 4 existing usage-control tests. Root and web typechecks and web production build pass. Design QA in design-qa.md. Firefox UI: 1440px desktop and 500px mobile responsive layout; search/no results/clear, all views, density persistence, keyboard tab in toolbar. Both themes inspected. Flash selectable, new/Continue usage rings and real Claude quota readback; no submitted chat or reset. Dark/film quick menu tested. All test preferences restored.

Live preservation baseline: 26 application settings, 69 routine definitions (6 quiet), 20 session identities, three Computer process PID/starttick pairs; service PID/starttime unchanged. Hash manifest6230files. Snapshot is version-pinned so unknown updates cannot silently replace it.

No physical iPhone or full native client verification. No claim all unrelated upstream tests pass. Browser evidence and run logs retained locally, not committed because they contain conversation text.
