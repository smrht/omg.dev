# Gates: direct chat navigation

Scope: Remove the desktop workspace landing screen, retain the rail/stage, new-session shortcuts and other surfaces.

- [x] G1: Desktop entry and return navigation always use the chat rail/stage.
  EVIDENCE: Live Firefox: desktop entry, refresh, existing transcript and Schedules-to-Chat return show only rail/stage; workspace DOM absent and both back buttons absent. New session button and unmodified C shortcut open composer without sending.
- [x] G2: Typechecks, focused navigation tests and production build pass.
  EVIDENCE: 45 focused tests pass. Mac job 37a292d2-dd08-4676-816e-1b430ab4ba5a: root/web typechecks and Vite production build pass; returned manifest ok=true, all 1651 output hashes verified. Diff whitespace check passes.
- [x] G3: Live desktop/mobile browser QA passes; sessions and update preservation remain intact.
  EVIDENCE: Private layer 06176-chat-direct-20261005 active, 11766 entries hash-verified. No-Threads guard passes. Firefox desktop 1440px and mobile viewport checked, no mobile overflow. MainPID 3051295 and start time unchanged. All 24 baseline sessions retained: 22 still live, 2 concurrently archived after baseline with retained transcripts.
