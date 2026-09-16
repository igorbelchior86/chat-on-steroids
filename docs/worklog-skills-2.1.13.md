# Skills and model picker integration, 2.1.13

## Behavior

The managed application-data library remains compatible with UTF-8 Markdown/text imports at `skills/<id>/SKILL.md`, while the same catalogue now discovers Codex-style packages from project `.agents/skills`, the scoped project `.codex/skills`, `~/.agents/skills`, legacy `$CODEX_HOME/skills`, bundled `.system`, and the platform admin location. External packages require Codex frontmatter and can carry `agents/openai.yaml`, `scripts/`, `references/`, `assets/` and other resources. Complete package import preserves resources while rejecting escaping links.

Canonical `SKILL.md` paths own identity. The composer resolves exact slash commands, keeps `/prompt <command>` compatibility, displays source/scope, and qualifies collisions deterministically. Only managed skills expose Remove. Catalogue calls are scoped to the selected or durable project so project-local skills do not bleed into unrelated drafts or sessions.

Applicable Codex `config.toml` layers support `skills.include_instructions`, `skills.max_context_tokens`, `skills.bundled.enabled`, and `[[skills.config]]` enable/disable rules by exact name or path. Disabled skills cannot be listed or explicitly resolved. Explicit skill bodies stay mandatory in delivery even when the implicit catalogue is disabled.

The existing first-message owner inserts Core instructions and the bounded implicit skill index when enabled, complete selected skill bodies, optional project AGENTS.md and the complete authored request, in that order. The 96,000-character and UTF-8 transport budgets remain authoritative. AGENTS.md spends the remaining space; selected skill or user-text overflow fails explicitly. Prepared bytes stay in the existing input ledger through retry and restart. Explicit follow-up skills do not repeat Core setup.

The existing Core filesystem surface exposes the managed `/skills` root plus canonical global skill aliases. Structured Core file mutations refuse the global aliases, while command execution retains its existing shell semantics. Repo discovery begins inside the approved project but allowed external directory links are catalogued by canonical identity without widening the project's ordinary filesystem root. Skill reads never replace the learned project workspace or become the implicit workspace for a rootless relative path. No new MCP tool, permission expansion or automatic script execution is introduced.

## Model picker and retained fixes

The 2.1.12 picker patch is integrated. The signed-in browser's native menu was inspected with Desktop tools: its version list contains a retirement caption beneath the leading version label, and its retained React state supplies the exact model slugs, effort values, availability and version entries. This supports the patch's primary-label matching and metadata-based confirmation. Both ordinary input and worker bootstrap call the same `selectModelSettings` implementation. Goal, Loop and Plan forward the saved helper model and reasoning through `requestBrowserDecision` and the same input-delivery owner. The picker code remains identical to 2.1.12; the separate logical-turn grouping change is retained.

Existing local repairs for request attribution, canonical-question recovery, Goal/Loop obligations, worker revival, continuation admission and terminal/plugin diagnostics are included. A bounded source review and test cross-reference found no concrete regression in these repairs. Existing tests already cover restored compaction pickup and expiry; no duplicate test was added.

Contributor attribution for the incorporated work from PRs #220, #224 and #227 is retained in CONTRIBUTORS.md and the integration commit.

## Verification

Focused checks cover storage and link handling, metadata refresh, selected prompt order, Unicode/character budgets, duplicate selections, unavailable skills, project workspace preservation, real input-ledger retries and renderer draft/keyboard behavior. The 43 model-picker regression cases pass against the integrated patch.

`node scripts/verify-skills-layout.cjs` uses the production renderer controller, HTML and CSS in an isolated Electron/Chromium process. Eight empty/populated layout cases cover 920- and 420-pixel viewports in both themes, with twelve screenshots inspected for fitting and readable controls. Import-to-Use and actual Chromium Enter/Tab events preserve authored text. This is a renderer fixture with API replies; it does not claim a live provider message was submitted.

The imported text and the managed filesystem path are covered by separate backend and delivery integration tests. No live chat messages or user skill installations were created for these checks.

Before the setup amendment, the complete local `npm run verify` passed: 4,455 tests passed with 42 declared skips, followed by both isolated MCP shutdown tests. TypeScript, public-history privacy, dependency notices and pinned native-source validation passed. `npm run build` completed for main, preload and renderer. The only build messages were the existing mixed static/dynamic import chunk notices. `npm run verify:tunnel-current` confirmed the pinned tunnel client matches the current upstream release.

## Setup amendment and release download reliability

The setup page ends with guidance about ChatGPT tool approvals. The first explicit model-discovery opening requests a durable reminder; passive discovery and failed browser opening do not request it. Understood, close and Escape acknowledge the CoS reminder only after a successful disk commit. This does not approve a provider tool call. The renderer retains the newest revision, waits behind another open dialog and preserves the user's draft and focus.

An original SVG example shows a neutral Core read request with Deny, Allow once and Always allow. It is labelled as an illustration and reused in Setup and the popup. No user-provided private screenshot was incorporated. The isolated Chromium layout check covers both surfaces at 420 pixels in dark and light themes; the four resulting screenshots were inspected. The focused renderer, durable-state, IPC and source-download tests pass together (94 cases).

The first release run was cancelled for this amendment. Independently, GNOME GitLab briefly returned HTTP 406 for one pinned GVDB source archive. The same URL subsequently returned the exact reviewed byte count and SHA-256 digest. Downloads now retry network failures and transient HTTP responses up to three times with 1/2-second backoff. The 180-second attempt deadline, eight-download concurrency, pinned URLs, reviewed byte counts and SHA-256 requirements remain unchanged. Integrity failures are not retried, and a fresh live GVDB fetch through the helper verified the existing pin.

## Final reliability amendments

A reported single `read` refusal matched the Plugins manager's stale-tool fallback, not the Core reader. Empty-owner calls now explain the stale or wrong connector and point built-in names to their proper surface. No tool is forwarded across connectors. Separate regressions preserve the disabled status of a real external plugin named `read`.

Image injections retain their exact image blocks through MCP delivery even if optional preview storage fails. Canonical input history is written before preview assets, but after the carrier tool record. Concurrent queue reads respect that ordering, so long histories without a retained turn-start event still place the instruction after its carrier. Saved previews and later receipts update the same transcript anchor. The real MCP test covers both quota success and failure while deliberately holding the carrier recorder open.

Project openings now name the bound virtual working folder in mandatory main context, even without AGENTS.md. This does not widen permissions or forbid task-relevant work elsewhere. Setup explains separate tunnel identities and a nonempty Core Actions list. Health checks distinguish external tools/list responses from generic HTTP traffic and avoid claiming that transport proves provider acceptance or approval.

With the full Skills changes integrated, the complete `npm run verify` passed **4,423 main-suite tests** across 175 passing test files, with 129 declared skips, followed by both isolated MCP shutdown tests: **4,425 passing tests** in the verification run. TypeScript, public-history privacy, 92 production-package notices, seven plugin license entries and all 730 native-source pins passed. The production main, preload and renderer build completed successfully after the final documentation update; its only messages were the existing mixed static/dynamic import chunk notices.
