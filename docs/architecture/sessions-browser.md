# Sessions, input and browser transport

[Architecture index](README.md) · [ChatGPT turn evidence](../chatgpt-turn-signals.md)

This document covers durable conversation history, user-input custody, the extension/bridge transport and browser recovery. These systems meet at the same user flow but keep separate owners.

## Durable local session model

A local session is the stable work identity. Its ChatGPT conversation can change, most notably during Compact & Resume, while the session retains history, project binding, queued input and terminal custody.

The session store uses different write forms for different data. The following is the current persisted layout, not a public file-format contract:

```text
userData/sessions/<local-session>/
  events.jsonl        append-oriented structured activity
  messages/*.json     atomically replaceable canonical native messages
  meta.json           durable/recoverable session projection
  recovery.json       bounded derived checkpoint for current-turn recovery authority
  assets/             bounded binary or overflow material
  handoffs/           captured continuation briefs and provenance
  plan.json           current model-maintained progress plan
```

`src/main/session/store.ts` does not infer message identity from similar text, timing or turn position. Producers supply stable logical identities. Streaming/final revisions replace the same canonical message while preserving its original chronological anchor.

Large inline text budgets are rendering/transport decisions, not permission to lose authored history. Overflow data is retained through bounded assets where the owning path supports it.

## Two evidence producers

`src/main/session/recorder.ts` combines evidence that no one producer can supply alone:

- MCP/app evidence provides exact tool arguments/results, request ids, local outcomes and assets.
- Browser observations provide native user/assistant messages, turn state, page identity and provider-side progress/errors.

The recorder does not use “looks like the same chat” heuristics to attribute tools. Exact request correlation decides ownership; unresolved calls remain first-class Unattributed history.

Browser-reported completion is also evidence, not infallible truth. A durable `turn_end` is an **immutable observation in the append-only journal**, not a row that later evidence edits or deletes. If stronger exact evidence proves the same logical turn continued, the recorder appends `turn_start` for that same turn id with `source: 'app'`; a later terminal observation then appends the next `turn_end`. This A/start → A/end → A/app-reopen → A/end shape is used even when the first fresh evidence is already an exact native final. Shared chronology treats each same-id reopen as a new bounded segment so consumers never reorder the correction ahead of the terminal observation it supersedes.

A page-authored `turn_start` also carries the exact native user-message id whose Send opened that logical turn. Protocol 18 treats the pair as one self-contained lifecycle boundary: current browser traffic without either opaque id is not admitted as lifecycle authority, and an overlong/invalid id is never truncated into a different identity. Instead of returning a second partial-ack channel to the browser, the bridge canonicalizes a permanently invalid lifecycle/message observation **in place** as a durable `recording_gap` event and accepts the batch normally. Its neighboring observations keep their original order, the browser can retire the successful HTTP batch atomically, and every later history reader can see that evidence is missing at that exact point. Confirmed browser-side quota discard, an oversized single observation and a permanently bridge-rejected observation use the same `recording_gap` domain with a typed reason plus structured `lostKinds` and, when still unambiguous, `affectedTurnId`. A failed `storage.session` write while the observations still exist in the live service worker is only a durability risk (`durable: false`), not fabricated proof that history was lost. These are recorder-integrity facts, not ChatGPT `chat_error`s. Historical pre-18 lifecycle rows remain readable.

Turn opening identity is monotonic evidence owned by the logical turn. `turn_start` means a lifecycle segment actually opened; a later identity strengthening or contradiction is a separate durable `turn_identity` fact and therefore cannot accidentally reopen an ended turn during replay. A previously unknown opening can become exact; two different exact openings for the same turn become `conflict` and never collapse back to either value. Lineage integrity is monotonic too: once confirmed recorder loss damages a logical turn, no later same-id segment can make that lineage intact again. App-authored same-id corrective reopens inherit both the logical turn's opening evidence and any known damage instead of inferring a new question from current DOM position. Exact same-request or fresh-work evidence may reopen a legacy turn whose opening remains unknown, but that state stays tracked-and-nonadoptable until an exact opening is proven; damaged or conflicting durable lineage cannot authorize adoption/Stop. `SessionSummary.activeTurnId` remains the durable projection of which logical turn is open even after its opening row ages out of bounded caches. The v3 recovery checkpoint carries the newest lifecycle boundary together with opening identity, logical/segment starts, independent lineage integrity and bounded scoped-damage tombstones; older checkpoint versions are derived caches and are rebuilt from the authoritative journal rather than trusted for execution authority. Ordinary current-turn authority reads this bounded projection, with full JSONL lineage reconstruction reserved for legacy/unknown checkpoints. Process-local lifecycle state keeps one `turnsById` record per logical id, with active/terminal/reopen state pointing at that record rather than copying its identity into competing mutable objects.

Browser liveness and replacement-document adoption authority are separate facts on one tracked-turn wire shape. `/activity.turn` is either absent or `{ id, live, adoption }`: `id` says which recorder turn the app still owns, `live` says whether current process evidence considers that turn actively working, and `adoption` is either `null` or the exact opening user-message identity that authorizes a replacement document to adopt it. Therefore “turn T still exists but is no longer live/adoptable” is representable without pretending that no turn exists, and a pending Stop command cannot recreate adoption identity after durable evidence has become unknown or conflicting. After awaited response projections, the bridge revalidates the current session/conversation attachment before publishing any activity from that session; a source conversation that moved away receives no session-wide rows, cursor advance or capability metadata from its replacement conversation. The content script uses the exact opening message plus the next user boundary to constrain assistant ownership. If the opening message has not hydrated—or appears at more than one distinct transcript position—the document abstains instead of borrowing the newest rendered question or answer.

The provider-page signals themselves are documented in `docs/chatgpt-turn-signals.md`.

## History consumers and renderer bounds

The model-facing `session` tool and the desktop timeline are different consumers of the same durable history.

The model tool uses explicit local session ids and bounded cursors so cross-chat and worker reads do not depend on guessing the caller's current page. The desktop renderer pages sessions and timeline rows, keeps a bounded paint window and fences async loads to the selected session generation. Rendering limits must not become retention limits.

Context-pressure and cost/usage displays are local estimates unless a provider-specific usage observation explicitly says otherwise. UI labels and decisions must not turn an estimate into an invoice, entitlement or provider-private context meter.

### Context pressure versus usage estimates

Session `contextTokens` is a local estimate of pressure in the **current provider frontend** and is reset when Compact & Resume durably rebinds the session. Lifetime work accounting is separate and continues across that rebind.

The daily work/cost view in `src/main/session/usage.ts` is also derived locally from recorded tool work and frontend-context measurements. It deduplicates stable tool-call identities, segments work across compaction/model changes and caches **facts** (context segments plus call attribution) against durable revisions rather than caching today's pricing projection. The activity chart uses the raw local estimate. Cost comparison separately caps each frontend against the currently observed comparison ceiling and then applies the configured divisor/multiplier/rates. A model-catalog change can therefore change the comparison without rewriting historical activity. Historical rows without exact model proof remain explicitly assumed/estimated.

Provider account-usage observations from `extension/usage.js` are a different data source. They are bounded snapshots used for the pools the provider actually reports; missing/expired values mean “not reported,” not zero or exhausted. Never merge these two measurement systems into one implied provider invoice.

## One durable input owner

`src/main/session/input.ts` is the outbox for user-authored messages and generated checkpoints. An input has a stable id and moves through explicit custody states such as queued, browser/tool-owned, sent, failed or cancelled.

One authored input owns one conversational delivery and one receipt. The outbox does not silently append a deferred instruction to another input: model/reasoning selection, automation, objective, attachments and source-boundary semantics remain attached to the input that authored them. A later eligible boundary may deliver a later queued entry, but transport convenience never turns two authored intents into one receipt.

The critical rule is:

> A browser send that may have crossed the provider boundary is never automatically sent again merely because its acknowledgement was lost.

Pre-send failure and post-action uncertainty are different states. Browser and tool delivery are mutually exclusive for the same claim: a message claimed by a browser path cannot simultaneously be injected into an MCP result.

Tool delivery uses a different receipt model. The offer can repeat under the same stable message identity until a **later exact-owner tool invocation**, which started after publication, proves the model had an opportunity to receive it. Offering data is not the same as acknowledging it.

## Input policy and delivery modes

Delivery policy derives from exact session/turn/model/tool evidence at the time of claim. The renderer may present options such as immediate delivery, after-turn delivery or finish checkpoint, but the durable outbox owns whether an entry is still claimable.

Important semantics:

- Active-turn correction authority belongs to the exact turn and can be revoked by a newer turn, navigation, occupied draft or tool activity before Send.
- “After turn” entries spend verified completion boundaries in FIFO order; a replayed old completion must not drain the next entry.
- Native file attachments use browser upload/send. An explicitly eligible image-only draft may instead create a bounded normalized image projection for delivery with the next tool response; the staged original remains the authored attachment identity and never silently becomes an MCP file reference. The outbox stores only immutable projection references (id, size and hash), while the bytes live once in the existing attachment store and are materialized only at delivery/history boundaries.
- A claim has no arbitrary age-based transport fallback after it may have acted. Lost receipts do not license switching to another delivery route.
- For fresh Local Project sends, project narrowing must survive the no-conversation-id gap before request ownership can be published broadly.

## Attachment staging

`src/main/session/input-attachments.ts` owns immutable originals selected by the user. The renderer and browser use opaque attachment ids and bounded previews rather than source paths.

Staging admission, quota, optional image normalization, browser chunking and provider upload are separate boundaries. A locally staged file is not proof ChatGPT received it, a normalized tool-delivery projection is not proof the model consumed it, and a completed native upload is not yet proof the final message was submitted. Retention must preserve bytes still owned by the outbox, while tool injection freezes its normalized projection before the original can change or be pruned.

## Plans and finish checkpoints

There are two different concepts named “plan”:

- A **generated workflow** is user-task input. The executor receives the complete objective and workflow up front; later stages become verification/improvement checkpoints in the durable outbox.
- `update_plan` is the coding agent's progress presentation stored with the session. It does not execute work or consume queued checkpoints.

`src/main/task-request.ts` deduplicates one explicit planner/helper invocation by request id and fingerprint and retries only classified pre-delivery failures. Cancellation belongs to that exact invocation; a late result cannot be redirected to another draft/session.

`src/main/session/finish.ts` owns Astra's finish boundary. A finish call is a model-issued hold/notice tied to the exact active session, conversation and turn. It is not proof that the provider stopped or completed. New user input takes priority, and releasing the hold records that the model may finish; it does not fabricate a native terminal event.

Automatic Goal work at this boundary is deduplicated from actual recorded context/input revision, not from a repeated timestamp or repeated finish call.

## Extension responsibilities

The extension is split deliberately:

| Component | Responsibility |
| --- | --- |
| `extension/chatgpt-dom.js` | provider selectors and shared DOM primitives |
| `extension/fiber.js` | bounded MAIN-world React/message/request/model evidence |
| `extension/usage.js` | bounded provider usage and live request-origin observations |
| `extension/content.js` | isolated-world observation and exact document browser actions |
| `extension/background.js` | MV3 journal, tab/document registry, command election and bridge transport |

Content ↔ MAIN evidence is untrusted data. It must be nonce/document/epoch scoped and never grants filesystem or tool permission.

Provider DOM assumptions belong in `chatgpt-dom.js`; feature modules should consume those shared primitives instead of developing independent selector folklore.

### Native-page presentation

The companion should preserve ChatGPT's native answer DOM, Markdown/code/citations and action controls. Extension-owned progress/recovery presentation is additive. Hide or replace a native row only when exact evidence proves the app-owned representation covers that same logical activity; missing attribution should leave the provider UI usable rather than guessing a match.

Recovery presentation is one mutable chronological status for the same incident, not a parallel toast/history system that multiplies retries into apparent new work. Reused React DOM nodes require strong message identity—request id, visible text or screen position alone can span revisions and must not be used as a durable logical key.

## Service-worker custody and browser lifetimes

The service worker is the only extension component that talks to the local bridge. Pairing secret material remains there; page scripts do not receive local-tool authority.

The observation journal and live tab/document registry use extension session storage so MV3 worker suspension does not lose accepted observations. Selected inert restart markers can use local storage, but browser restart does not imply a tab/document survived. Any action authority restored after restart must be reconciled against the app's current durable state before a page can act.

Tab identity includes the Chrome tab/document plus navigation epoch. Navigation retires the old epoch before a late callback can publish for it.

## Durable browser commands

`src/main/browser-bridge/command-ledger.ts` owns durable app-side command and receipt custody. `src/main/browser-bridge/command-coordinator.ts` coordinates that ledger with process-local execution state such as deadlines and placement offers, including the narrow continuation/broker fences that span those concerns. `src/main/bridge.ts` adapts authenticated browser routes onto those owners. A command progresses through durable intent, one page lease, browser action, durable receipt and retirement.

The lease is persisted **before** command text is handed to a page. That prevents an app restart or second tab from redeeming the same bootstrap as a fresh operation. The page's per-document client id is part of the lease; a second document is refused unless the specific operation is still at a safe pre-send takeover point.

A command id is a correlation marker behind bridge authentication, not a credential. A stale marker whose command was cancelled, superseded or completed yields no text and no action.

Receipts are durable answers to lost/ambiguous ACKs. A prior receipt is replayable only to the same document/conversation identity that completed the command. For cross-file transitions, the owning state is made durable before the command receipt is allowed to retire the transport; worker bootstrap retirement, for example, waits for the critical worker snapshot that explains the result.

A Stop command is authorized by the exact local logical turn it names and its exact opening native user-message identity. Provider `data-turn-id` is only corroborating page evidence: provider-id equality can never substitute for current local-turn equality before command redemption or immediately before the click.

Continuation Send checkpoints are protocol actions, not independent booleans. Since bridge protocol 17, each checkpoint uses exactly one source or destination action: `source-claim`, `source-arm`, `source-release`, `destination-claim`, `destination-arm` or `destination-release`. Destination actions are additionally paired with the exact command id and document/client owner. Missing ownership identity is rejected rather than coerced to an empty credential. An already-loaded older page that still emits checkpoint booleans is an explicit mixed-version case and is told that its document is outdated/reload-required instead of waiting for a generic command timeout.

## Browser Send acceptance

Insertion into the native editor is preparation, not a send receipt. Browser delivery must recheck the elected editor/document/route around asynchronous model selection, upload and authorization steps, then cross the provider Send boundary once.

Stable native user-message/conversation evidence establishes acceptance. Button disappearance, text insertion or a local `sent` boolean is insufficient. Once an authorized click can have acted, uncertainty is carried as uncertainty rather than converted into another click.

## Recovery is evidence-driven

Browser recovery exists for work the app can still prove it owes. It is not permission to reopen arbitrary historical chats.

Recovery reasons have separate evidence and budgets—missing owned tabs, live-turn silence, assistant error, attribution failure, Goal pickup and continuation pickup are not one generic “reload if old” policy. The exact timings live in `bridge.ts`; the stable rules are:

- block/stop/supersession/current-session checks are revalidated when repair is handed out;
- one repair episode should not mint repeated tabs or reloads from the same stale observation;
- the browser's actual tab registry decides open-vs-reload at action time;
- an attributed call is strong proof that the request-id join works, but it does not prove an assistant-error repair succeeded or that a page answer stream recovered;
- a repair handout is not success until the browser confirms it; unconfirmed custody stays in the repair protocol instead of being silently counted as done;
- old durable history alone does not grant a new recovery episode after process restart.

For an exact provider failed-view observation, main-process recovery is represented by one discriminated `TurnActivityLease`: active work, failed view awaiting refresh, or failed view listening after a confirmed refresh. The browser reports evidence and performs the requested browser action; it does not own a second five-minute recovery state machine. A confirmed refresh is the transition that starts the listening lease. Fresh exact work replaces that failed-view lease with ordinary active work. Each semantic lease has an explicit process-local generation identity; scheduling timestamps may defer that same generation but never create new authority, and stale asynchronous work must match the current generation before publishing.

Goal and compaction have their own bounded pickup schedules because they represent still-owed durable obligations. Those schedules are implementation policy; consult current `bridge.ts` rather than copying their numeric cadence into another authority.

### Continuation authority

Recovery can create a right to continue only from one exact durable source turn. `src/main/session/recovery-proof.ts` captures an immutable `RecoveryProof` from one serialized recorder snapshot: the source conversation/turn, durable work head, exact qualifying MCP call and the model class derived from that same call. `thinking_failed` is valid only while its failed `turn_end` remains the durable work head. Any later assistant revision, lifecycle event, page/tool work, user message or newer exact MCP activity invalidates that proof.

Timing is not evidence. A `RecoveryGrant` may add `notBefore` to postpone use of an existing proof—for example while the provider is natively busy—but elapsed time can never mint the proof. Native busy therefore defers a continuation; it never creates one.

Recovered continuation arbitration has one precedence rule:

1. an explicit queued user instruction receives the checkpoint first;
2. only when the outbox has no such instruction or active transport custody may synthesized Goal/Loop work receive it.

The outbox and Goal ledger still own their own persistence. `recovery-arbitration.ts` owns only **who gets the checkpoint**. Explicit input commits first; retiring a duplicate synthetic Goal projection is convergence cleanup, not the authority boundary. A final Goal-spend fence re-runs precedence, so even a failed cleanup write cannot turn two projections into two spendable continuations. This keeps the following precedence stable across reloads and retries:

- a native final supersedes a provisional provider failure;
- fresh work revokes any unspent recovered continuation;
- an authorized browser Send retains custody until its exact receipt or classified pre-send failure because the provider boundary may already have been crossed;
- a lost receipt never authorizes switching transport or clicking Send again;
- image projection is delivery material; the staged original remains the authored attachment identity;
- recovery authority always comes from exact durable source-turn evidence, never from silence duration alone.

Cleanup and authority are deliberately separate. Stop/new-work paths withdraw stale recovery rows best-effort so state converges quickly, but final claim/Send authorization always revalidates the proof and fails closed. A transient cleanup write failure must not turn an already-durable Stop or provider observation into a false primary-operation failure.

Provider `Thinking failed` is a machine-coded native failed-view observation (`reason: 'thinking_failed'`). The content script closes that page-local generation immediately once the native failure is settled and keeps only a bounded post-terminal Fiber/request-id observation window. Recovery grace belongs to the main-process lease described above. The explicit native failure signal outranks ChatGPT's transient interruption marker; an exact later native final is stronger evidence and reopens the same durable turn before completing it. Error discovery on the hot path is scoped to the active assistant turn plus global provider notices rather than rescanning historical turn DOM. The generic ten-minute watchdog is separately coded as `no_visible_progress`; renderer behavior never depends on matching English provider prose for current events.

The long silence window for Pro-class work is intentionally conservative. Local timing audits showed that tool/progress gaps are not themselves terminal evidence, including gaps inside one request/turn; the implementation therefore treats the window as a recovery scheduling bound only. The proof rules above, not the measured duration, grant continuation authority.

## Model observation and browser opening

Account model availability is observed from the signed-in provider page and confirmed through the native model/effort UI when sending. A remembered label, picker option or cached catalog is useful presentation state but not fresh entitlement proof.

Browser opening authority belongs to the concrete operation that needs a page. Reuse/election, process absence, window layout and provider hydration are different decisions. Missing receipts, temporarily unreachable elected pages and user-closed tabs do not automatically grant a second opening attempt for an operation that already spent one.

## Stop, end-turn and block

These controls mean different things:

- **Stop** requests native generation cancellation for one exact turn and revokes related automation/recovery intent; native confirmation is still required.
- **End turn** releases an Astra finish hold. It does not claim ChatGPT has stopped.
- **Block** persists refusal of local tools for one exact provider conversation. It does not stop ChatGPT remotely or erase history.

Never infer one from another in UI or recovery logic.
