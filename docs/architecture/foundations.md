# Architecture foundations

[Architecture index](README.md)

This document describes the identities, lifetimes, durability rules and process ownership that the rest of the application builds on.

## Runtime planes

There are four cooperating planes with different authority:

| Plane | Main responsibility | It does not prove |
| --- | --- | --- |
| MCP connectors | expose bounded Core/Desktop/Plugins operations to the model | which ChatGPT page originated a request without correlation evidence |
| Electron main process | permissions, durable state, tool execution, browser orchestration and native effects | that a provider page accepted or understood a remote action merely because a local call returned |
| Companion extension | observe provider state, perform authorized browser actions, retain browser-document evidence | filesystem/tool authority; the extension cannot turn browser evidence into local permission |
| Renderer/preload | present sessions/settings and request named main-process actions | direct filesystem, shell, secrets or arbitrary IPC authority |

The extension bridge is a separate loopback protocol from MCP. A paired extension is not an MCP credential, and an MCP request is not browser identity by itself.

## Identities that must remain distinct

Many features share labels that look interchangeable but are not.

| Identity | What it means |
| --- | --- |
| **Local session** | durable identity for recorded work, project binding, queued input and current provider binding |
| **ChatGPT conversation** | replaceable provider-side conversation currently attached to a local session |
| **Turn** | one authored user-message generation and the exact work/reply associated with it |
| **Approved root** | filesystem permission the user granted; it may contain several projects |
| **Local Project** | explicit narrower folder association and sidebar grouping; it does not grant a new root |
| **Native ChatGPT Project** | provider-side `/g/...` context; unrelated to the Local Project security authority |
| **MCP request id** | transport workflow id used to join a model request to page evidence |
| **Browser document + navigation epoch** | one concrete page lifetime; a conversation id alone is insufficient after reload/navigation |
| **Input id** | durable outbox identity for one user-authored delivery obligation |
| **Prime run / worker incarnation** | exact worker-family ownership; a friendly name such as `worker-1` is not globally unique |
| **Terminal session id** | process handle whose custody belongs to a proven durable local-session principal |
| **Renderer selection generation** | UI lifetime fence preventing an older async response from repainting a newer selection |

When several features fail together, trace one concrete identity through its owners and find the first transition where it becomes ambiguous or wrong.

## Lifetime model

Persistence answers “what survived?” rather than “what is true now?”.

| Lifetime | Typical storage | What survives | What it cannot establish by itself |
| --- | --- | --- | --- |
| app restart | session files and named `state/` JSON | committed history, project authority, input, commands, Goal/worker/continuation intent | that an old browser page or process is still alive |
| browser restart | selected extension `storage.local` state | pairing/disconnect intent and narrowly chosen restart markers | a live tab/document or current account entitlement |
| MV3 service-worker suspension | extension `storage.session` | observation journal, tab/document registry, command/receipt custody | an entire browser restart |
| document lifetime | content/Fiber memory | exact DOM/Fiber observations and navigation epoch | anything after reload unless independently restored/re-observed |
| Electron process lifetime | process manager and in-memory recovery episodes | live child processes, timers and current runtime coordination | process survival after the app exits |
| renderer/window lifetime | UI state/local preferences | drafts, expanded rows and presentation choices | durable send receipts or security authority |

Restoration should rebuild only facts backed by durable or independently re-observed evidence. A restored id is not permission to assume the object it once named still exists.

## One fact, one owner

The table names primary implementation entry points, not permanent module paths or a storage-schema specification.

| Fact | Primary owner |
| --- | --- |
| settings and effective permissions | `src/main/config.ts` plus capability projection |
| encrypted credentials | `src/main/secrets.ts` and plugin credential storage |
| approved path resolution | `src/main/sandbox.ts` |
| Local Project security binding | `src/main/local-projects/` authority ledger |
| local session/history | `src/main/session/store.ts` and `recorder.ts` |
| exact MCP request ownership | `src/main/session/correlation.ts` |
| user input and delivery custody | `src/main/session/input.ts` |
| browser commands and receipts | `src/main/browser-bridge/command-ledger.ts` plus extension command custody |
| Compact & Resume transaction | `src/main/session/continuation.ts` |
| worker families/inboxes | `src/main/agents.ts` |
| Goal objective/switch/reply obligation | `src/main/goal.ts` |
| native Desktop target/frame custody | `src/main/computer/` |
| renderer-accessible actions | fixed API in `src/preload/index.ts`, validated in `src/main/ipc.ts` |
| plugin installation/exposure | `src/main/plugins/` |
| connector lifecycle/status | `src/main/connection.ts` |
| update candidate/application | `src/main/update.ts` |

If two modules can independently declare the same semantic transition complete, the design needs a clearer owner or a derived projection.

## Durability semantics

`src/main/durable.ts` is a small durable-JSON mechanism, not a transactional database. It gives named files serialized writes and temp-file-to-rename publication. `writeDurableSoon()` is useful for ordinary state projection; `writeDurableNow()` is the barrier for a transition that must be on disk before the caller acknowledges it or lets an external side effect depend on it.

Important consequences:

- Per-file serialization does **not** create a transaction across files. A caller that needs semantic ordering between two ledgers must await those writes in the required order.
- A failed durable security transaction must not linger as a background retry that can appear later after the caller was told it failed.
- Tolerant reads are appropriate for recoverable operational state. Security-sensitive authority can choose stricter restoration and fail closed instead of treating malformed state as empty.
- `flushDurable()` settles independent writers even if one fails; one bad state file must not skip every sibling during shutdown.

The same rule appears across subsystems: **publish durable intent before acknowledging the event that consumes that intent**. Browser commands persist leases before handing text to a page; user settings that are reported saved cross their durable barrier first; worker command retirement waits for the worker snapshot that explains it.

## Compatibility lifetimes

Compatibility code has the lifetime of the evidence it must still read, not the lifetime of the implementation that replaced it. Historical records may need permanent display/read compatibility; persisted operational snapshots need migration only across the supported stored-state horizon; mixed-running-version protocol shims exist only while an older already-loaded participant can legitimately coexist with the current process. Keep those cases explicit rather than treating every legacy branch as permanent fallback behavior.

A compatibility reader may translate old representation into the current model, but it must not grant authority that malformed current-format state lacks. Current schemas fail closed on missing or invalid ownership fields; only a version that is explicitly known to predate that field may enter the migration path. When the supported horizon makes a compatibility branch unreachable, delete the reader, its fixture and its migration-only vocabulary together.

## Unknown identity and stale async work

Unknown identity is allowed to degrade presentation but must fail closed where a wrong guess could mutate, attribute, send, acknowledge or route work to the wrong owner.

Likewise, an async operation owns the identity and generation at its start. After any await that can race navigation, cancellation, settings changes or another mutation, re-check that the original owner still applies before publication or external action. Comparing only a stable-looking id is often insufficient: A → B → A can return to the same id under a different epoch.

Tests for these races should control ordering rather than sleep: pause the older operation before publication, commit the newer one, then resume the older one and prove it cannot overwrite or resurrect newer state.

## Startup dependency constraints

Startup ordering is part of correctness because restored owners can race browser or MCP traffic. The durable constraints are:

- Single-instance ownership must be established before a process touches shared user data; a losing process must not perform normal bootstrap against the primary's stores.
- Validated storage/configuration and security-narrowing state must be restored before accepting work that could otherwise use broader defaults.
- Goal obligations, request correlation and blocked-chat state must exist before browser/tool traffic can act on them.
- Worker-family state must be restored before continuation recovery that may repair prime ownership.
- Renderer security policy and the fixed IPC boundary must exist before normal window activation.
- Maintenance, optional connector startup and update checks keep independent lifetimes and should not make a usable UI wait on unrelated network/background work.

Feature toggles must not erase durable history merely because a capability is disabled at startup. Consult `src/main/index.ts` for the exact current sequence.

## Shutdown dependency constraints

Shutdown runs bounded phases sequentially. Work inside one phase may settle together, but later phases must not race owners that can still mutate their state:

- Stop admission and drain accepted bridge/MCP work before stopping resources used by those handlers.
- Stop child processes, native helpers and plugins before final persistence flushes.
- Flush recorder work before the session/durable writers that recorder work can enqueue.
- Hand off an already verified staged update only after application-owned state has reached its shutdown barrier.
- Exit after the bounded sequence even when a phase times out, so an invisible process cannot retain the single-instance lock forever.

Timeouts bound teardown; they do not redefine ownership order or abort abandoned work. Consult `src/main/index.ts` and `src/main/shutdown.ts` for the exact current phases and budgets.

## Evidence levels

Keep claims scoped to the evidence actually collected:

```text
source -> focused tests -> full verification -> build -> package -> installed payload -> live browser/device/provider behavior
```

A passing test does not prove packaged resources are correct. A build does not prove a platform installer. A local HTTP success does not prove the remote model received or understood a result. For shipped-version questions, inspect the immutable release/tag and artifact rather than assuming a dirty tree with the same version label is equivalent.
