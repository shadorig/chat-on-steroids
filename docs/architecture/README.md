# Architecture guide

This directory is the maintained, maintainer-facing architecture reference for Chat On Steroids. It preserves durable design knowledge that is too detailed for the root `AGENTS.md`, while leaving current wire shapes, constants and implementation mechanics with their narrower owners.

## Documentation ownership

Different sources answer different questions; they do not form one linear hierarchy of truth.

| Question | Primary authority |
| --- | --- |
| What outcome is requested now? | Current task plus applicable repository instructions. |
| What does this checkout do? | Executable source plus reproducible tests or observations. |
| What durable design is intended? | Maintained architecture documentation plus load-bearing implementation rationale. |
| What can users or models rely on? | Maintained public contract, security and setup references, checked against implementation. |
| What did a release ship? | The immutable release/tag, packaged artifact and relevant live evidence. |
| What was previously observed, investigated or proposed? | Dated provider notes, audits, plans, incidents and release history. |

A contradiction among these authorities is evidence of a bug, stale test/comment/document, incomplete migration or deliberate contract change. Investigate it explicitly. Current code does not turn a bug into intended architecture, and architecture prose does not prove that every code path implements it.

## System in one page

Chat On Steroids is an Electron application around a ChatGPT browser conversation. The model uses local MCP connectors; the companion extension observes and controls the ChatGPT page; the main process owns permissions, durable sessions, browser commands and external effects; the renderer is a constrained UI projection through a fixed preload API.

```text
ChatGPT model                         ChatGPT browser page
    | MCP                                   |
    v                                       v
Core / Desktop / Plugins            MAIN + isolated extension worlds
    |                                       |
    v                                       v
MCP ingress -> kernel                 extension service worker
    |                                       |
    +--------- main-process owners <--------+ loopback bridge
                     |
              sessions / input /
              projects / agents /
              Goal / continuation
                     |
                  preload
                     |
                  renderer
```

The recurring design rule is **one durable fact, one authoritative owner**. Other layers may observe, cache or present that fact, but they should not independently decide it. Most serious cross-feature bugs in this repository are an ownership or identity error before they are a UI bug.

## Guide map

| Document | Read it when changing |
| --- | --- |
| [Foundations](foundations.md) | identities, lifetimes, durability, startup/shutdown, ownership or evidence semantics |
| [MCP, projects and local authority](mcp-projects.md) | MCP dispatch, attribution, code mode, filesystem scope, Local Projects, workspaces or project instructions |
| [Sessions, input and browser transport](sessions-browser.md) | recording, history, input/outbox, attachments, extension transport, browser commands, recovery, models or finish boundaries |
| [Continuation, workers and Goal](orchestration.md) | Compact & Resume, worker families, Goal/Loop, planning or automatic continuation |
| [Application and integration boundaries](application-boundaries.md) | renderer/IPC, Desktop control, plugins, connections, tunnels or external integrations |
| [Build, update and release](shipping.md) | bundles, packages, native resources, updater, CI or publishing |

Use the narrower public references where they already own the detail:

- [`../tool-surface.md`](../tool-surface.md) is the public model-facing MCP contract.
- [`../chatgpt-turn-signals.md`](../chatgpt-turn-signals.md) records provider-page evidence used to classify ChatGPT turns. It is dated evidence; confirm current adapters when changing page logic.
- [`../plugins.md`](../plugins.md) is the maintained plugin behavior and setup reference.
- [`../setup.md`](../setup.md) is the user-facing setup and troubleshooting reference.
- [`../../SECURITY.md`](../../SECURITY.md) owns the public security model and permission boundaries.
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) owns contributor workflow and validation expectations.

## Maintaining these documents

Architecture prose should answer: **what owns the fact, what identity scopes it, what authority permits it to act, what lifetime it survives, what evidence proves its transition completed, and why does the constraint exist?** Then ask whether the fact is stable enough to belong here and whether a narrower owner should be linked instead of copied.

Use a refactor test: if an internal refactor could make a sentence false without changing behavior, ownership, authority, persistence semantics or a compatibility contract, that sentence is probably an implementation detail. Exact constants and representations belong here only when their exact form is itself load-bearing for persistence, compatibility, security or recovery.

Apply one durable concept, one canonical documentation owner. Secondary documents may carry the minimum context needed to understand a link, but must not independently maintain the same exact defaults, thresholds, operation sets, state labels, provider selectors or release matrix.

Temporary defects stay in issues, focused audits, tests or comments near the owner; they do not become permanent architecture. When behavior changes, update the narrowest maintained document that owns the affected contract.
