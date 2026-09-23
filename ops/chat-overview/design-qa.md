# Chat overview design QA
Target: approved third generated concept (attention groups, flat dark/light list) combined with first concept density. Source images opened together with implementation captures. Existing OMG navigation, composer, usage and provider assets remain real; no generated UI art or mock rows shipped.

Evidence: evidence/mobile-dark.png, mobile-light.png, desktop-dark.png, desktop-light.png, captured in Firefox. Mobile viewport measured 500 CSS px; desktop 1440. Retina screenshots are 2x. Concept is 390x844 logical pixels; compared content proportions/row scale rather than device chrome. No physical iPhone claim.

Typography: 15px titles, 13px preview; compact rows measured 60px, comfortable76px. Group hierarchy and search/tabs use existing theme tokens. Icons28px within32px mark; existing pin/unread/state markers retained. No extra cards or imagery. Same theme and provider assets as installed product.

Corrections: removed duplicate always-visible project rail in attention/all modes (available under Projects); combined unread filter and density control into title row; retained all-projects scope across polls; toolbar keyboard events do not trigger app project shortcuts. Reduced-motion keeps existing gestures without added animation. Local Vite WebSocket proxy tested open after switching preview runtime from Bun to Node; production transport unchanged.

Intentional differences: real pinned chats are retained and placed below attention, above ongoing/recent; empty attention group is omitted. 'Recent afgerond' becomes 'Recente gesprekken' because idle does not prove completion. No one-click blind retry: blocked row opens the existing recovery controls in that conversation. Existing machine/menu and composer remain, protecting project/model/usage controls. Mobile and desktop share grouping and keyboard order.

Browser results: search/no-result/clear, three views, 60/76px density with reload, both themes passed. Model/usage/Continue and quick-menu theme/film QA passed at both widths without submitting a chat or consuming credits. Focused grouping/render tests verify attention on wrapper/native question IDs, blocked vs busy precedence, child ancestry, pins, unread authority.

final result: passed
