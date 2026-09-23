Implement the user-approved combination of desktop workspace concepts 1 and 2 in the existing OMG.dev frontend.

Scope: narrow global navigation, compact integrated existing composer, wide searchable grouped conversation list, real selected-session preview, explicit Open gesprek and return preserving search/filter/scroll. Keep existing session actions, model favorites/usage, settings and mobile functionality.

Non-goals: backend changes, new quota sources, new sessions on opening a conversation, unrelated cleanup, service restart.

Reference: /Users/samht/.codex/generated_images/01a0ba92-6736-7131-936e-a73fd56f3e95/exec-7ddc00a6-3a69-4ece-8aeb-e5b3c4a9cabc.png

Required: product-design image-to-code and design QA, modern-web-guidance, Unlazy gates; existing immutable private release deployment route.

Acceptance: root/web typechecks, focused behavior tests, production build, browser desktop light/dark and mobile QA, open-return state preservation, public live UI verification and baseline preservation with no runtime restart. Code oracle: ops/desktop-workspace/check-code.sh exits 0 with DESKTOP_WORKSPACE_CODE_OK after all checks. Visual and live preservation gates remain separate.

Attempt cap: investigate after two failures of the same route, do not blindly retry. Report implementation versus live proof and any blockers explicitly.
