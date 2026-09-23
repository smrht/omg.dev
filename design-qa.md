# Compact model picker — design QA

final result: passed

## Visual evidence

Source: `/Users/samht/.codex/generated_images/01a0ba92-6736-7131-936e-a73fd56f3e95/exec-1082e53f-c33c-4027-bb09-26c272e8c655.png` (853 × 1844).
Implementation: `ops/model-picker/evidence/local-picker-light.png` and `local-picker-dark.png` (780 × 1688, actual Firefox iframe viewport 390 × 844 CSS px, density 2).
Combined input inspected: `ops/model-picker/evidence/design-comparison.png`, both normalized to 390 × 844; focused comparison `picker-detail-comparison.png`, picker regions normalized to equal width without changing their individual aspect ratios.
State: OpenCode, Flash selected, three favorites, Max thinking, picker open. The source contains fictional session counts/avatar; the implementation uses current API data. The background overview is retained and outside this picker redesign. No comparison claim about matching conversation content or identity.

## Findings and required surfaces

No remaining P0/P1/P2 findings in the delivered picker scope.

- Typography: retained application system font, readable 15px agent heading, 14px model and 12px provider/metadata. No overlapping or clipped labels. Slightly lighter weight than the generated concept is P3, consistent with existing app typography.
- Spacing/layout: 358px-wide card at 16px inset on a 390px viewport; height 346px. The concept is roughly 296px tall at that width. The additional height is intentional: every picker control has at least 44px touch height rather than the concept's smaller thinking and search targets. Composer and card remain visible together, with scrollable detail pages. Existing bottom safe-area behavior stays in place.
- Color/tokens: existing white/light gray and dark charcoal tokens, blue selected model/thinking, muted provider labels. Dark mode inspected separately; no new arbitrary palette or gradients.
- Images/icons: actual existing OpenCode and other agent assets, library icons; sharp at density 2. No generated brand substitutes, placeholders, or custom drawn artwork. The source's unrelated fictional avatars were not implemented.
- Copy/content: explicit agent, model, provider, favorites, all models, thinking, usage and summary. Actual model IDs remain values. Unsupported quota is honestly labeled `Limiet niet beschikbaar`.
- Interaction/accessibility: sibling star and model buttons avoid nested controls; explicit selected state, 44px targets, keyboard radio navigation, Escape/focus return and nonmodal outside dismissal verified. Primary mobile and desktop selection paths work.

## Comparison history

Pre-comparison implementation review found a clipped absolute-positioned picker inside the composer's backdrop container, missing synchronized favorites across mounted composers, and thinking radios without arrow-key handling. These were corrected before the final design comparison: body portal with anchor measurements, useSyncExternalStore, and roving radio focus. Browser screenshots above are after those fixes. They are implementation-review fixes, not claimed as multiple visual comparison iterations.

First normalized source/render comparison: no actionable P0/P1/P2 findings. Accepted constraints are the touch-target height, existing safe-area gap and current background data. P3 differences: checkmark and star order, missing decorative pointer, slightly different type weight/radii. No further polish loop.

## Verification and limits

Root/web typechecks, 34 focused tests (119 assertions), production build passed. Browser checked 390px mobile in light/dark, favorite add/remove/reload/per-agent isolation, all-model search, actual Flash selection, low/high/max keyboard selection, usage and all-agent usage, composer draft preservation, attachment/mic/start availability; no chat submitted. Desktop1440 existing picker/search/star/Flash selection passed. Additional360×640 mobile verification passed:328px card width,133px top,346px height, no overflow; see evidence/narrow-check.log. Profile selection rendered in component tests; multiple live profiles were unavailable. Native iPhone/Safari and unrelated full upstream suite are not claimed tested.

Implementation checklist: source comparison complete; interactive controls verified; existing assets used; production build passed; deployment preservation and live readback recorded separately in ops/model-picker/README.md.
