# Continuation, workers and Goal

[Architecture index](README.md)

Compact & Resume, reusable workers and Goal/Loop all extend work across more than one immediate model turn. They share session/history infrastructure but have different authorities and must not silently drive one another.

## Compact & Resume

Compact & Resume changes the provider frontend while preserving the local session:

```text
local session S: conversation A  --->  conversation B
                  same history / project / queue / terminal principal
```

`src/main/session/continuation.ts` owns the transaction. The handoff text is context for the model; it is not the durable session identity and does not decide whether the move happened.

### Transaction phases

The durable transaction progresses from source-handoff acquisition through one destination claim to an irreversible durable session rebind, followed by idempotent projection repair. Failure can abort while the transaction is still safely pre-commit; it cannot roll back a completed rebind. The exact persisted state vocabulary and compatibility handling live in `src/main/session/continuation.ts`.

The important boundaries are:

1. **Reserve source A.** Create one continuation token tied to local session S and exact source conversation A.
2. **Ask for a marked handoff.** The source send checkpoint records whether submission has not started, may have been dispatched ambiguously, or is known sent. A missing receipt after a possible dispatch cannot authorize another blind Send.
3. **Capture exact provenance.** Accept the handoff that belongs to the marked request/turn, not the latest convenient assistant text.
4. **Claim destination once.** One durable browser command/claim owns creation of B. Duplicate tabs cannot independently become the replacement.
5. **Commit S → B.** Durable session metadata rebind is the semantic point of no return. Before it, failure can leave A current; after it, recovery repairs B's projections idempotently and never rolls the session back to A.
6. **Publish projections.** Recorder lookup, workspace, Goal objective/switch and prime binding are derived from the committed session decision.

The transaction's destination-send checkpoint distinguishes a safe pre-send retry from ambiguous post-dispatch state. That checkpoint is what makes a page reload/takeover safe before Send and forbidden after a possible send.

### Restart recovery

Restore reads the durable continuation together with authoritative session metadata. An interrupted commit is resolved by the session's current conversation:

- if session metadata already says B, finish/publish the committed projection;
- if it still says A and the send is safely retryable, keep the existing transaction claimable;
- if ownership contradicts both expected sides, fail closed instead of inventing a third rebind.

Continuation restore runs after worker-family restore because a committed prime move can need to repair that family's provider binding.

Late calls from source A may remain valid historical evidence for session S, but once B is current they must not reactivate A's browser-recovery or automation authority.

## Worker families

`src/main/agents.ts` is the worker broker. Several prime-owned families can coexist. The topology inside one family is a star: a prime delegates to workers; workers do not create descendants.

The key identity is **family/run incarnation + worker conversation**, not a friendly slot label. `worker-1` can be reused across runs or exist in another family, so routing by name alone is a cross-task bug.

### Admission and durable mutation

Spawning validates capacity, requested work, model settings, workspace and role before handing out browser work. Mutations that cross a meaningful external boundary follow:

```text
stage exact family mutation
  -> make critical swarm snapshot durable
  -> publish/open/report
```

Async rollback is scoped to the same run revision; it must not restore another family's newer state.

Slot counts are admission policy, not eviction authority. A working/invited/detached/waking worker can still occupy execution capacity; a sleeping worker frees a working slot while retaining its conversation and history for reuse.

### Sleeping, detached and terminal

- **Sleeping** means the worker finished its assignment and can be messaged again. Reuse a suitable sleeper for follow-up work before spawning a replacement.
- **Detached** means browser attachment is missing. The worker can still be server-side active; an exact later call can prove it alive and a page can reattach under the same identity.
- **Terminal** means the worker is no longer reusable. This is different from merely sleeping or losing its tab.

Worker reports/inboxes are at-least-once transports with stable message identities. Publication of an offer does not itself prove the exact recipient processed it; acknowledgement belongs to the recipient/run and its defined evidence boundary.

A worker's conversation is intentionally persistent. Compact & Resume moves a prime's provider frontend while retaining the family; workers themselves keep their own conversation identity.

## Goal and Loop

Goal and Loop are one automation driver with two policies:

- **Goal** may decide the requested finish line has been reached and send no continuation.
- **Loop** continues useful checking/improvement within the existing user brief until switched off.

They must preserve the original user objective and accepted steering. A continuation decision is not permission to invent unrelated work merely to keep a loop alive.

`src/main/goal.ts` intentionally separates several facts that are easy to collapse incorrectly:

| Fact | Meaning |
| --- | --- |
| saved objective | the finish line for one chat; survives restart and can move during continuation |
| per-chat switch | whether this chat may be driven and in Goal or Loop mode |
| reply obligation | one stable final assistant reply that still needs a terminal decision |
| provider draft | replaceable in-flight attempt to generate that decision |
| browser input/send | separate outbox/transport that may eventually deliver a continuation |

An objective existing does not mean a provider request should start on restore. A provider request succeeding does not mean its reply was sent. A failed provider attempt must not silently mark an otherwise still-owed reply as handled.

### Durable Goal state

Objectives, per-chat switches and reply obligations use separate named durable ledgers because they have different lifetimes.

- Objectives are chat/session state, not global config. Compact & Resume moves them A → B.
- Per-chat switches are durable user decisions. An explicit chat override can remain Off even if an app-wide default later changes. Decision-helper chats are marked as helper identity and are never themselves normal Goal sources.
- Reply obligations are bounded stable-final identities with handled tombstones. Their durable row lets reload/restart recover an owed decision without scanning rendered transcript history.

User-visible save/switch acknowledgements use an immediate durable barrier. If that write fails, the live value is restored rather than reporting a state that can disappear on restart.

### Decision eligibility

The browser/page owns whether a native turn has legitimately reached the relevant completion boundary. Main owns the durable context, credentials, provider request and resulting draft. This keeps provider-page liveness evidence separate from model-decision generation.

A draft freezes the mode, prompts, objective, model/reasoning and owning browser client that started it. Mid-request settings changes retire the old attempt; they do not reinterpret its response under new policy.

Stop, block, newer turn/input, mode changes, settings changes, continuation and explicit revocation can invalidate an attempt. Revalidate current authority before publication/delivery after awaits.

### Backends and helper roles

Goal/Loop can generate decisions through the configured backend. A ChatGPT decision helper is a role-specific conversation that reasons over reference context and returns a decision; it is not an executor of that reference task. API/custom backends receive explicitly assembled bounded context and keep credentials in main-process secure storage.

Provider progress is presentation, not sendable continuation text. Final output must pass the structured decision contract before it can enter the outbox.

## Astra finish behavior

Astra finish handling uses `src/main/session/finish.ts` rather than opening an automatic new browser turn from a final answer. The exact active session/conversation/turn must own the finish call.

At that boundary, queued user instructions take priority. Automatic Goal work is generated only from a new recorded work/input revision and, when accepted, enters the same durable input owner as other messages. Repeated finish calls do not create independent continuation authorities.

“HELD” is a model instruction to keep the current work turn open while work remains. “RELEASED” means the hold no longer applies; neither string is a provider-native terminal receipt.

## Generated workflows

The task planner is a helper role, not a staged executor. A generated workflow must give the executor the complete original objective, requirements, constraints and implementation approach in its first payload. Later stages are verification/improvement checkpoints rather than withheld pieces of the task specification.

For a new chat, the editable plan belongs to that draft until Send creates the concrete session. For an existing session, admitted checkpoints belong to the durable outbox and are no longer tied to whether the composer text remains visible. See `src/main/goal.ts`, `src/main/task-request.ts` and `src/main/session/input.ts` for current admission details.

The model-maintained `update_plan` card is separate; it is progress presentation and has no power to execute or delete generated workflow stages.
