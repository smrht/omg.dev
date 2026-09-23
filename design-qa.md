# Desktop workspace design QA

Reference: approved combination of options 1 and 2, exec-7ddc00a6-3a69-4ece-8aeb-e5b3c4a9cabc.png (1619×971). Prior mobile picker report: ops/model-picker/design-qa.md.

Same-size comparison: ops/desktop-workspace/evidence/comparison.png combines the reference and rendered implementation, normalizing DPR2 capture to CSS pixels. Reviewed full view and composer/list/detail regions. Private screenshots contain real session metadata and are excluded from Git.

| Fidelity surface | Finding |
| --- | --- |
| Layout | Narrow global rail, broad compact composer, wide conversation list and selected summary follow the approved hierarchy. |
| Spacing | Integrated controls and compact rows use the desktop width; 1024/1280/1619 layouts have no horizontal overflow. |
| Typography | Existing system font and theme tokens retained; clear heading, title and secondary text levels. |
| Assets and color | Existing real agent marks retained; blue selection and primary action, dark/light themes, no new decorative imagery. |
| Content and behavior | Actual title, project, model, latest text and state; fabricated reference artifact and quota deliberately omitted. Open gesprek opens the existing session. |

P1 resolved: first render had intrinsic-width overflow. min-w-0 flex wrappers and scoped responsive controls fixed it; repeated browser geometry checks pass.
P2 resolved: hidden workspace scroll could overwrite its stored offset. Active-only writes and restoration preserve 416px across open/return; component test covers it.
Accepted differences: account avatar remains with its existing user menu in the header; real provider controls and data determine labels. Start remains disabled until valid input. No invented artifact card.

Desktop functional evidence: local-check.log, model-check.log, code-check.log, build.log. Actual open/return, filters/query/scroll, draft, keyboard o, two panels, Flash/favorites and both themes passed. 89 focused tests / 235 assertions; both TypeScript checks and production build passed. No chat was submitted.

Public desktop: live-check.log confirms the real session round-trip, keyboard/multipane and Settings/Computer navigation; comparison-live.png visually reviewed. Deployed entry asset index-7woW23vy.js verified after using the normal Reload action. Mobile public 390px rerun passed; the first run was intercepted by the standard persistent update toast, not a failed picker action. Local 390/360 both passed. Public 360px verification passed as well (mobile-live-narrow.log).

final result: passed
No unresolved P0–P2 design or connected-route regressions in the tested viewports.
