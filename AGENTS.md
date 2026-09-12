# Chat On Steroids — repository instructions

This root guide contains instructions and cross-cutting constraints for almost every change. Read focused documentation and current code for the subsystem you are changing.

The current task defines the requested outcome. Current executable source plus reproducible tests or observations establish what this checkout does. Maintained architecture documents describe intended durable design; public references describe supported externally meaningful behavior; release artifacts establish what shipped; dated plans and audits are point-in-time evidence. A disagreement among those authorities is something to investigate, not permission to let one category silently overwrite another.

## Repository model

Chat On Steroids is a cross-platform Electron workspace that connects ChatGPT to local tools and durable project/session state. A companion Chromium extension observes and drives the ChatGPT page. The Electron main process owns local authority; the renderer projects it through validated preload/IPC APIs.

Keep these identities distinct:

| Identity | Meaning |
| --- | --- |
| Local session | Durable identity for history, project binding, queued work, ownership and continuation. |
| ChatGPT conversation | Replaceable provider-side frontend associated with a local session. |
| Local Project | Explicit folder association and narrower project scope inside approved roots. |
| Approved root | Filesystem permission granted by the user; not itself a project binding. |
| Request / document / turn / epoch | Short-lived evidence attributing one operation to the correct owner and browser generation. |
| Worker family / incarnation | Exact multi-agent ownership; a friendly worker label is not globally unique. |

Core, Desktop and Plugins are separate MCP surfaces. The extension bridge is a separate loopback boundary. Shared infrastructure does not merge their identities or authority.

## Working rules

- Start with `git status --short`. Before changing an already modified file, inspect its working-tree diff and, if it has staged changes, its staged diff.
- The worktree may be shared and dirty. Preserve unrelated edits. Do not reset, checkout, clean, stash, stage, unstage, broadly reformat or overwrite work you did not create unless the task explicitly requires that Git or formatting operation.
- Use `rg` and `rg --files` to discover current code, callers, tests and paths. Do not rely on remembered locations or historical documentation.
- Before changing behavior, read the owning implementation, its relevant producers/consumers and the nearest deterministic tests. For documentation-only work, inspect implementation only as far as needed to verify changed claims.
- Fix identity, ownership, routing, persistence and recovery bugs at the earliest incorrect boundary. Do not patch only a final presentation symptom or turn that principle into an unrelated rewrite.
- Give each meaningful fact one authoritative owner. Other modules may derive, cache or present it; they should not independently decide it.
- Unknown identity must fail closed when guessing could mutate, attribute, send, acknowledge, authorize or route work. Presentation may degrade visibly; execution must not guess.
- Revalidate ownership after awaits when stale work could overwrite newer state or act on the wrong target. A stable-looking id is insufficient when its document, generation or epoch can change.
- Commit durable intent before acknowledging it or allowing a dependent external side effect. Restore from the same durable authority.
- Never automatically replay an external mutation when the action may have happened and only its receipt is uncertain. Distinguish proven pre-action failure from post-action uncertainty.
- Bound untrusted or growing data at its owning layer, including request bodies, images, text, results, queues, journals, browser observations and process output. Prefer existing centralized limits.
- Prefer repairing the authoritative transition over adding fallbacks, timers, watchers, retries or mirrored state. When such machinery is required, define its owner, lifetime, trigger, stale-result behavior, uncertainty/idempotency semantics and cleanup path.
- Prefer existing dependencies. Change an owning source/generator instead of hand-editing generated or vendored output.

## Find the owner

Start with [`docs/README.md`](docs/README.md) to distinguish maintained contracts from historical material. For durable ownership and cross-process reasoning, use the focused architecture guide:

| Change area | Read first |
| --- | --- |
| identities, lifetimes, durability, startup/shutdown, evidence | [`docs/architecture/foundations.md`](docs/architecture/foundations.md) |
| MCP dispatch, attribution, filesystem scope, Local Projects, workspaces, project instructions | [`docs/architecture/mcp-projects.md`](docs/architecture/mcp-projects.md) |
| sessions, history, input, attachments, extension transport, browser commands and recovery | [`docs/architecture/sessions-browser.md`](docs/architecture/sessions-browser.md) |
| Compact & Resume, workers, Goal/Loop, planning and automatic continuation | [`docs/architecture/orchestration.md`](docs/architecture/orchestration.md) |
| renderer/IPC, Desktop control, plugins, connections and tunnels | [`docs/architecture/application-boundaries.md`](docs/architecture/application-boundaries.md) |
| bundles, native resources, updater, CI and releases | [`docs/architecture/shipping.md`](docs/architecture/shipping.md) |

Use the narrower maintained reference when it owns the current external contract:

- [`SECURITY.md`](SECURITY.md) for permission boundaries, credentials, approved paths, shell/Desktop authority and private-data handling.
- [`docs/tool-surface.md`](docs/tool-surface.md) for model-visible tools, schemas, discovery, publication, platform differences and permission gates.
- [`docs/chatgpt-turn-signals.md`](docs/chatgpt-turn-signals.md) for dated provider-page observations; confirm current adapters or live behavior when page logic matters.
- [`docs/plugins.md`](docs/plugins.md) for plugin installation, execution, discovery and refresh behavior.
- [`docs/setup.md`](docs/setup.md) for user-facing setup and troubleshooting.
- [`CONTRIBUTING.md`](CONTRIBUTING.md), `.github/workflows/` and the owning scripts for contribution, CI, packaging and release procedure.

## Preserve boundary contracts

Changes at a boundary normally require checking every participant and any persistence/compatibility path that carries the same contract:

- MCP: declaration/schema → discovery/publication → live permission guard → handler → recorder/result projection.
- Extension bridge: main-process command → `extension/background.js` custody → exact document/navigation epoch → acknowledgement/result.
- Page integration: `extension/content.js` isolated world → MAIN-world integration → shared provider DOM primitives in `extension/chatgpt-dom.js`.
- Renderer: main-process owner → validated IPC → fixed preload API → renderer selection/load generation.
- Persistence: mutation → durable publication → restart restore → stale-callback rejection.
- Projects/filesystem: proven session/project binding → approved-root policy → canonical path at use.
- Terminal/Desktop: exact caller/session custody → live process/frame/window/control ownership.

If a wire shape, durable schema, public tool, configuration default, browser command or persisted identity changes, search for all producers, consumers, migration/restore paths, compatibility handling and regression coverage. Fresh-install defaults, legacy migration, malformed-state recovery and current runtime policy are separate cases unless the implementation proves otherwise.

## Browser and extension work

ChatGPT DOM and React internals are provider behavior, so stale mocks alone are insufficient evidence for a browser-facing fix. Keep reusable provider selectors and DOM-shape assumptions centralized in `extension/chatgpt-dom.js`.

When behavior materially depends on the current provider page and live browser tools are available, inspect the signed-in page before finalizing the change and repeat the smallest relevant flow afterward. If live verification is unavailable, report that limitation and keep conclusions at the source/test/build evidence level.

Extension runtime source ships directly. Validate the exact files that will ship rather than assuming another bundling layer replaces them.

## Validation

Use the narrowest deterministic check that can falsify the change, then widen according to the affected contract and the claim you intend to make:

```sh
corepack pnpm exec vitest run test/<target>.test.ts
corepack pnpm run typecheck
corepack pnpm run verify
corepack pnpm run build
```

- Behavior changes should add or update meaningful deterministic regression coverage when practical, including the neighboring negative or stale-owner case.
- TypeScript behavior changes should normally pass the nearest focused suites and typecheck.
- Run the repository verification gate for broad or cross-cutting production changes and when required by `CONTRIBUTING.md`.
- Run a build when bundling, preload/main/renderer boundaries, generated output or build-time behavior can differ from source execution.
- Package only when package/runtime layout is relevant. Validate platform-specific behavior on an appropriate native OS before making a platform-wide claim.
- Documentation-only changes need formatting, link/path verification, rendered-structure review and `git diff --check`; they do not require the production suite unless documentation participates in generation or verification.
- For races, control ordering: pause the older operation before publication, complete the newer one, resume the older one and prove it cannot overwrite or resurrect newer state. Sleeps are a last resort.

## Safety and completion

- Never put real credentials, connector URLs, tunnel tokens, personal conversations, account/workspace identifiers, usernames or private local paths into fixtures, public documentation, logs, screenshots or examples.
- Do not edit Electron user data, session ledgers, extension storage or other runtime state as a repair shortcut. Fix the owner and make restore/recovery converge.
- Do not commit, push, tag, publish, install, stage/unstage user work or create distributable packages unless the task requests that outcome or the artifact is necessary validation.
- Do not bypass privacy or security checks. Do not claim tests as build proof, builds as package proof, packages as installation proof or one-host observations as cross-platform proof.

Before finishing, inspect every changed-file diff and run `git status --short` again. Check for unrelated edits, accidental generated files, private data, debugging output and unintended dependency/lockfile changes. Report what changed, the exact validation run and any evidence that remains unavailable.

## Documentation contract

Root `AGENTS.md` owns repository-wide working instructions. `docs/architecture/` owns stable design invariants. Maintained public references own current user/model-facing behavior. Source/types/tests own volatile mechanics. Historical documents remain point-in-time evidence. Link to a canonical owner instead of maintaining parallel descriptions.

Architecture prose should explain ownership, identity, authority, lifetime, durability, irreversible transitions and rationale. If a legitimate internal refactor could make a sentence false without changing those properties or a compatibility contract, move/generalize the detail. Source paths are implementation entry points, not the invariant itself.

Do not hard-wrap Markdown prose. Keep each ordinary paragraph on one physical source line; use newlines only for Markdown structure. Do not reflow unrelated prose solely for formatting.

Keep this file small enough that reading it whole is cheap. Do not add version numbers, source-alignment dates, exact feature counts, current defaults, transient workarounds, bug inventories, implementation walkthroughs or historical rationale. Put subsystem knowledge in its narrowest maintained owner and enforce mechanical rules with tooling where practical.
