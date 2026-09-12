# MCP, projects and local authority

[Architecture index](README.md) · [Public tool surface](../tool-surface.md) · [Security model](../../SECURITY.md)

This document describes the authority path behind model-visible tools. The public tool names and schemas live in `docs/tool-surface.md`; this file focuses on attribution, permission and workspace ownership.

## Separate connector surfaces

Core, Desktop and Plugins are independent MCP surfaces. They can share local infrastructure, but a surface's discovery and token do not authorize another surface's tools.

Tool exposure can remain monotonic for one endpoint lifetime because clients may cache discovered schemas. That is a discovery property, not a permission decision: every invocation passes through current effective capability checks. A tool that was visible before revocation may remain listed while its handler returns `TOOL_DISABLED`.

`src/main/mcp/kernel.ts` is the common dispatch machinery. Surface declarations decide which operations are published; the kernel revalidates current policy and caller identity at execution.

## One MCP call: evidence path

An MCP payload does not contain a trustworthy ChatGPT conversation id. Exact attribution is built from evidence outside the tool arguments:

```text
HTTP request
  -> bounded ingress + normalized x-request-id
  -> request-local call context
  -> exact request correlation
  -> durable session / project / worker ownership
  -> blocked/superseded/lifecycle guards
  -> live capability checks
  -> handler
  -> result/input/inbox delivery
  -> recording
  -> local HTTP response
```

`src/main/mcp/inbound.ts` normalizes the inbound request id and carries it through `AsyncLocalStorage`. `src/main/session/correlation.ts` joins that id with the provider page's exact `message.metadata.request_id` evidence. Tool name, arrival time, active tab, “only generating chat” and visual proximity are not substitutes.

The first exact proof for a request workflow owns that request. A later conflicting conversation claim does not overwrite it. The local session captured with that proof is retained so a historical request cannot silently jump to whichever session currently happens to own the same provider chat.

Calls whose request id has not yet been proven may wait through the recorder's bounded evidence window. A request with no exact proof ultimately records as **Unattributed**. `allowUnattributedCalls` can relax selected self-contained operations, but identity-sensitive routing, project scope, terminal custody, plans and worker control still require their own proof.

## Execution lifetime is not recording lifetime

Several lifetimes intentionally overlap:

- a handler can still be running and capable of mutation;
- attribution/recording may still be settling after the handler stops mutating;
- the wider HTTP request can still be open for delivery/response bookkeeping.

Do not treat recorder evidence grace as if the machine mutation itself is still running, and do not treat an HTTP 200 as proof of model comprehension.

Command/program nonzero exit is also distinct from connector failure: the transport can work correctly while the program the user asked to run fails.

The call context preserves that distinction in its outcome vocabulary:

| Outcome | Meaning |
| --- | --- |
| `ok` | the requested operation completed normally |
| `process_exit_nonzero` | command transport worked, but the launched program exited unsuccessfully |
| `tool_rejected` | validation, permission, identity or lifecycle policy deliberately refused the operation |
| `tool_internal_error` | the tool/runtime itself failed its contract |

Recorded evidence and the model-visible result should agree about that outcome. Do not translate a failing build into an MCP transport error merely because both are “red” in a UI.

## Code-mode composition

Core/Desktop/Plugins can expose a bounded JavaScript `exec` composition surface when eligible. The code-mode runtime is disposable and has no ambient Node, filesystem, network, imports or timers; current runtime mechanics live under `src/main/mcp/code-mode-*`.

Nested calls use the same registered tools, schemas, permission checks, exact caller context and recording path as direct calls. Code mode does not create a second tool authority. Only explicitly emitted text/images enter the outer result, and recursive composition is refused.

Because child calls can mutate external state, a later script failure cannot imply that already successful children are safe to replay. Tool-call counts and normal evidence remain visible so a caller can reason about partial execution.

## Filesystem authority

`src/main/sandbox.ts` owns filesystem authorization. It resolves virtual/native spellings, canonicalizes existing paths, checks the deepest existing ancestor for missing targets, and rejects traversal or symlink/junction/reparse escapes according to the current root policy.

Every public filesystem operation must reach this authority directly or through an already validated wrapper, and targets that can change during an await must be revalidated at actual use.

An approved root is a permission boundary, not a promise about repository structure. If an approved root contains `projects/app`, a caller must preserve that real path; code must not guess a missing intermediate folder to make a request work.

Shell execution is intentionally broader after admission. `exec_command` validates its starting workspace but the launched shell runs with the logged-in user's normal OS privileges. This is why read-only mode disables command execution rather than pretending the filesystem path sandbox contains arbitrary child processes. See `SECURITY.md` for the public security statement.

Patch rollback has one extra concurrency rule: restore a path only while it still matches what this patch produced. If another actor edited the file after a partial multi-file patch, rollback must not erase that newer edit merely to recover the older operation.

## Local Project authority

A Local Project is a narrower project binding inside approved roots. It is security state, not just sidebar metadata.

`src/main/local-projects/` owns an independently durable authority ledger with:

- an authority era and monotonic mutation epoch;
- canonical project directory records;
- exact session and conversation bindings;
- explicit ungroup/revoke state;
- unresolved fresh-send fences for a new provider conversation whose id does not exist yet.

Project mutations serialize, write the new authority before publishing it, and can latch authority unavailable when restoration is malformed or inconsistent. The safe failure mode is to refuse project-scoped filesystem admission rather than fall back to another approved root or a learned working directory.

Removing a project from sidebar grouping does not widen old chats. Existing sessions retain their narrow project association; re-adding the folder can restore grouping. Explicit security reset or revocation is a different operation.

For a fresh browser send, the input may know the project before ChatGPT has produced a conversation id. The unresolved send fence preserves that narrowing through the gap. Once the exact browser receipt proves the destination conversation, the authority ledger binds it and retires the fence as one semantic transition.

## Workspace is convenience, not permission

`src/main/workspace.ts` tracks a useful cwd keyed to proven session/agent identity. Workers inherit their exact prime/family workspace. A workspace can make relative paths convenient, but it never grants access and never overrides explicit Local Project authority.

If caller ownership is unresolved, a relative path must not silently fall back to the first approved root. Likewise, `worker-1` by itself is not enough to find a workspace because that label can exist in more than one family/incarnation.

## Browser executor prompt bootstrap

A successful MCP initialize does not prove the host surfaced the full connector instructions to the executor, so `src/main/session/prompt.ts` owns an explicit browser-message bootstrap. It is intentionally eligible only for the opening normal executor message and a newly spawned worker's opening message; follow-ups, Goal/Loop continuations, generated checkpoints, worker revival, decision/planner helpers and Compact & Resume bootstraps do not repeatedly prepend it.

Project guidance comes only from the explicitly selected Local Project folder's root `AGENTS.md`. The app does not recursively discover instruction files, infer them from cwd or scan parent repositories on behalf of the chat. This application bootstrap is distinct from a coding agent's own nested `AGENTS.md` discovery.

Preparation revalidates the same project identity, canonical directory and read authority after the asynchronous file read. Authored user work and the complete current Core instruction frame are mandatory; project guidance uses only the remaining transport budget and receives an explicit cut notice when shortened. Exact bounds live beside `prompt.ts`.

## Terminal custody

The process manager owns live `exec_command` sessions. Custody is keyed to the durable local-session principal established by exact caller correlation, not merely the current provider conversation. That choice lets Compact & Resume change conversation A → B without adopting or moving a live terminal: the local session did not change.

Another session or worker must not poll or write a process it does not own. Anonymous custody is not adoptable. Completed unread output remains owned data and must not be silently evicted just to free capacity; explicit reads or exact-owner delivery settle it under the process manager's bounds.

Completed background output can also be offered automatically in a later **outer** exact-owner tool response. An offer does not drain the bytes. A subsequent exact-owner invocation that started after successful publication acknowledges the offered page; an older concurrent call cannot. Explicit `write_stdin` remains the way to drain the remaining suffix. Nested code-mode calls do not consume this outer delivery channel.

## Changing a boundary

When changing a model-visible tool or authority rule, check both ends:

- declaration/schema and discovery exposure;
- live capability enforcement;
- caller/session/project resolution;
- handler result classification;
- recording/redaction;
- compatibility with cached schemas;
- relevant restore or restart behavior.

The nearest public contract tests are under `test/mcp*.test.ts`; filesystem/project/terminal behavior has focused suites under `test/sandbox*`, `test/projects*`, `test/workspace*`, `test/codex-*` and `test/exec*`.
