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

Browser-reported completion is also evidence, not infallible truth. If an exact same-request local call starts after a reported completed end, the recorder can reopen that turn in-process because the call proves the page's completion observation was premature. Display chronology must preserve that later correction instead of folding it away as old UI noise.

The provider-page signals themselves are documented in `docs/chatgpt-turn-signals.md`.

## History consumers and renderer bounds

The model-facing `session` tool and the desktop timeline are different consumers of the same durable history.

The model tool uses explicit local session ids and bounded cursors so cross-chat and worker reads do not depend on guessing the caller's current page. The desktop renderer pages sessions and timeline rows, keeps a bounded paint window and fences async loads to the selected session generation. Rendering limits must not become retention limits.

Context-pressure and cost/usage displays are local estimates unless a provider-specific usage observation explicitly says otherwise. UI labels and decisions must not turn an estimate into an invoice, entitlement or provider-private context meter.

### Context pressure versus usage estimates

Session `contextTokens` is a local estimate of pressure in the **current provider frontend** and is reset when Compact & Resume durably rebinds the session. Lifetime work accounting is separate and continues across that rebind.

The daily work/cost view in `src/main/session/usage.ts` is also derived locally from recorded tool work and frontend-context measurements. It deduplicates stable tool-call identities, segments work across compaction/model changes, applies the configured divisor/multiplier/rates, and caches derived session totals against durable revisions rather than rereading unchanged history on every paint. Historical rows without exact model proof remain explicitly assumed/estimated.

Provider account-usage observations from `extension/usage.js` are a different data source. They are bounded snapshots used for the pools the provider actually reports; missing/expired values mean “not reported,” not zero or exhausted. Never merge these two measurement systems into one implied provider invoice.

## One durable input owner

`src/main/session/input.ts` is the outbox for user-authored messages and generated checkpoints. An input has a stable id and moves through explicit custody states such as queued, browser/tool-owned, sent, failed or cancelled.

The critical rule is:

> A browser send that may have crossed the provider boundary is never automatically sent again merely because its acknowledgement was lost.

Pre-send failure and post-action uncertainty are different states. Browser and tool delivery are mutually exclusive for the same claim: a message claimed by a browser path cannot simultaneously be injected into an MCP result.

Tool delivery uses a different receipt model. The offer can repeat under the same stable message identity until a **later exact-owner tool invocation**, which started after publication, proves the model had an opportunity to receive it. Offering data is not the same as acknowledging it.

## Input policy and delivery modes

Delivery policy derives from exact session/turn/model/tool evidence at the time of claim. The renderer may present options such as immediate delivery, after-turn delivery or finish checkpoint, but the durable outbox owns whether an entry is still claimable.

Important semantics:

- Active-turn correction authority belongs to the exact turn and can be revoked by a newer turn, navigation, occupied draft or tool activity before Send.
- “After turn” entries spend verified completion boundaries in FIFO order; a replayed old completion must not drain the next entry.
- Native file attachments always use browser upload/send. A file-bearing input cannot silently become an MCP file reference.
- A claim has no arbitrary age-based transport fallback after it may have acted. Lost receipts do not license switching to another delivery route.
- For fresh Local Project sends, project narrowing must survive the no-conversation-id gap before request ownership can be published broadly.

## Attachment staging

`src/main/session/input-attachments.ts` owns immutable originals selected by the user. The renderer and browser use opaque attachment ids and bounded previews rather than source paths.

Staging admission, quota, browser chunking and provider upload are separate boundaries. A locally staged file is not proof ChatGPT received it; a completed native upload is not yet proof the final message was submitted. Retention must preserve bytes still owned by the outbox.

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

`src/main/bridge.ts` owns app-side commands such as opening a worker/revival/resume destination or stopping an exact turn. A command progresses through durable intent, one page lease, browser action, durable receipt and retirement.

The lease is persisted **before** command text is handed to a page. That prevents an app restart or second tab from redeeming the same bootstrap as a fresh operation. The page's per-document client id is part of the lease; a second document is refused unless the specific operation is still at a safe pre-send takeover point.

A command id is a correlation marker behind bridge authentication, not a credential. A stale marker whose command was cancelled, superseded or completed yields no text and no action.

Receipts are durable answers to lost/ambiguous ACKs. A prior receipt is replayable only to the same document/conversation identity that completed the command. For cross-file transitions, the owning state is made durable before the command receipt is allowed to retire the transport; worker bootstrap retirement, for example, waits for the critical worker snapshot that explains the result.

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

Goal and compaction have their own bounded pickup schedules because they represent still-owed durable obligations. Those schedules are implementation policy; consult current `bridge.ts` rather than copying their numeric cadence into another authority.

## Model observation and browser opening

Account model availability is observed from the signed-in provider page and confirmed through the native model/effort UI when sending. A remembered label, picker option or cached catalog is useful presentation state but not fresh entitlement proof.

Browser opening authority belongs to the concrete operation that needs a page. Reuse/election, process absence, window layout and provider hydration are different decisions. Missing receipts, temporarily unreachable elected pages and user-closed tabs do not automatically grant a second opening attempt for an operation that already spent one.

## Stop, end-turn and block

These controls mean different things:

- **Stop** requests native generation cancellation for one exact turn and revokes related automation/recovery intent; native confirmation is still required.
- **End turn** releases an Astra finish hold. It does not claim ChatGPT has stopped.
- **Block** persists refusal of local tools for one exact provider conversation. It does not stop ChatGPT remotely or erase history.

Never infer one from another in UI or recovery logic.
