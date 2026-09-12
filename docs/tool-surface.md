# Model-facing tool surface

This is the maintained public reference for the tools Chat On Steroids can publish to ChatGPT. Current declarations and focused contract tests define what the checked tree publishes; a disagreement among this document, declarations, implementation and tests is a maintenance defect to investigate explicitly. Start with `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`, `src/main/mcp/tools-desktop-windows.ts`, `src/main/mcp/tools-desktop-macos.ts`, `src/main/mcp/tools-plugins.ts` and `test/mcp.test.ts`.

For the ownership and security model behind these tools, see [`architecture/mcp-projects.md`](architecture/mcp-projects.md). For filesystem/shell/Desktop security boundaries, see [`../SECURITY.md`](../SECURITY.md).

## Connectors

Core, Desktop and Plugins are separate MCP discovery and permission boundaries. They share local infrastructure but use separate connector identities and secret paths; one surface never forwards a foreign tool name to another.

| Connector | Purpose | Possible public tools |
| --- | --- | --- |
| **Chat On Steroids Core** | approved files, patches, terminal, generated-file saving, local session history, task plans, workers and finish control | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `download_artifact`, `session`, `update_plan`, `agents`, `session_finish`, `exec` |
| **Chat On Steroids Desktop — Windows** | native apps/windows, background window screenshots, accessibility, mouse/keyboard and clipboard | Window2 observation/control operations, `read_clipboard`, `write_clipboard`, `exec` |
| **Chat On Steroids Desktop — macOS** | screenshots/windows/accessibility, mouse/keyboard and clipboard | `observe`, `computer`, `exec` |
| **Chat On Steroids Plugins** | enabled external MCP integrations | enabled upstream tool names, plus `exec` when the upstream set does not already define that name |

Core is the required coding connector. Desktop is optional and is available only where the native backend is supported. Plugins is optional and dynamic.

### Fresh install versus migration defaults

A true first launch enables every Core capability supported by the platform, starts read-only mode off, and enables session recording and multi-agent mode. `download_artifact` is therefore permitted by fresh-install capability policy; its actual publication/use still depends on the normal approved path and provider file-reference requirements.

Windows also enables its Desktop capabilities on first launch. macOS supports Desktop but starts the app-level Desktop capabilities off; the user must enable them and grant the required OS Screen Recording/Accessibility permissions. Linux has no native Desktop surface and masks those capabilities at runtime.

This first-launch policy is deliberately different from the conservative `DEFAULT_CAPABILITIES` used to fill missing fields in older configuration shapes. Existing installs retain explicit saved choices, and a malformed existing config recovers conservatively rather than treating damage as new consent.

### Discovery snapshots and live permissions

ChatGPT can cache a connector's complete `tools/list` response. During one endpoint lifetime, Core and Desktop keep already exposed tools available so a stale cached schema can receive a clear `TOOL_DISABLED` result instead of turning a permission change into an unknown-tool transport error. Every call still rechecks current effective permissions.

`find` and the terminal pair are a special snapshot choice: `find` is the search fallback when search is available but command execution was unavailable when that Core surface was first exposed. A deliberate feature disable/reconnect can establish a clean new surface shape.

## Core tools

### `read`

Reads approved paths. One call can read multiple paths, list a directory one level deep, expand bounded globs, select line ranges, return text with numbered lines, and return supported image content. The ordinary per-text-file budget is 256 KiB and the aggregate call budget is bounded; use batching for related reads rather than paying a connector round trip per file. The current aggregate payload ceiling is 512 KiB.

Path resolution goes through the current approved-root and Local Project authority. A Local Project narrows the filesystem scope further than the approved root that contains it.

### `view_image`

The dedicated Codex-compatible image tool. It is gated by file-read permission and validates both the encoded image and decoded-pixel/memory bounds before returning one native MCP image block.

### `find`

Search fallback for a Core discovery snapshot where search is enabled and command execution is not. It covers bounded filename/glob and text search without granting a shell. When `exec_command` is in the surface snapshot, repository searches normally use the real shell/ripgrep path instead.

### `apply_patch`

Applies the V4A text patch envelope. Create, edit, move and delete-file permissions are checked per hunk, with approved-root/Local Project resolution before mutation. A multi-file patch is preflighted and has bounded rollback behavior; directory deletion and arbitrary binary writes are not hidden patch operations.

### `exec_command`

Runs a command in the host's real shell. The starting working directory must satisfy the current filesystem/project admission rules, but the child process itself runs with the logged-in user's OS privileges and is **not** confined to approved roots.

It accepts either one `cmd` or a sequential `cmds` batch of up to 20 commands. A batch runs in one shell process, so cwd and environment changes carry forward; each section reports its own exit and the aggregate exit is the first nonzero result. A program's nonzero exit means the program failed, not that MCP transport failed.

Long-running/interactive commands can return a process `session_id` for `write_stdin`.

### `write_stdin`

Continues a live `exec_command` process by `session_id`. It can write input or poll buffered output. Process custody belongs to the exact durable local-session principal; another session or worker cannot adopt the process merely by knowing its numeric id.

An empty `chars` value is a poll. An empty poll can return when new output arrives instead of holding its entire yield window; later bytes remain buffered for the next poll. A non-empty write uses the command runtime's bounded collection window so an interactive reply can be returned whole.

### `download_artifact`

Saves a native ChatGPT file reference into an approved destination. The tool requests native file injection through `_meta.openai/fileParams`, validates allowed HTTPS file sources/redirects, streams under the configured file-size bound, refuses to overwrite an existing destination, and rechecks the target before publication. The default per-file limit is 20 MiB.

Current native ChatGPT file downloads accept exact allowlisted provider file hosts (`files.oaiusercontent.com` and `oaidalleapiprodscus.blob.core.windows.net`) and validate every redirect against the same source policy. Shared-hosting wildcards are not trusted.

Signed file credentials are not copied into recorded tool arguments. A file reference is not re-created through shell text or base64 as a substitute for the provider-owned download.

### `session`

Available while local session recording is enabled. It has exactly two actions:

- `search` lists the 30 newest recordings when no query is supplied, or searches durable session content. Its ordinary response budget is roughly 3,000 estimated tokens and continues by cursor.
- `read` requires an explicit local `session_id` and returns exact authored user/assistant text, compact tool headlines and selected durable activity under bounded cursor-based pagination. Read pages and expanded tool details use roughly a 5,000 estimated-token result budget.

`read` returns an `update_cursor` suitable for following a running session without replaying the whole history. Exact tool details can be expanded with the short references returned by the tool. The session tool never guesses which recording the caller meant, and its own audit calls are omitted from this read/search projection so repeated history reads do not recursively copy themselves.

Compact & Resume is app/browser orchestration; there is no model-visible `save_handoff` or `resume_session` tool.

### `update_plan`

Available with session recording. Replaces the calling session's displayed task plan with one complete bounded plan. It is presentation state only: it does not execute steps, send messages or consume generated-workflow checkpoints.

The call requires exact chat/session identity and rejects an older/stale update that would overwrite a plan from a newer invocation or replacement conversation.

### `agents`

Available while multi-agent mode is enabled. It has four actions:

- `spawn` makes the calling exact conversation the prime of its own run and creates requested worker chats atomically after broker state crosses its durable acceptance barrier. Use it for new parallel work; check/reuse a suitable sleeping worker before creating a replacement.
- `message` sends one message or an all-or-nothing batch within the caller's family. Messaging a sleeping worker reserves a slot and wakes that exact existing conversation.
- `status` reports the caller's own family/history, including sleeping/revivable and terminal workers plus available capacity.
- `finish` is a worker's factual handoff to its prime. It normally puts the worker to sleep so the same conversation can be reused; a worker that has exhausted its reusable context becomes terminal instead.

The current worker reuse ceiling is 400,000 locally estimated context tokens. Crossing it does not interrupt useful work already in flight; it makes the worker's next stop terminal rather than reusable.

Worker `model` and `reasoning_effort` overrides are optional. Omit them unless the user explicitly requested an override: app settings supply the normal defaults. When the app has an observed account model catalog, invalid/ambiguous requested model or reasoning choices are rejected before workers open; the native browser selection is still the final Send-time confirmation. There is no silent downgrade of an invalid explicit choice.

Prime/worker identity comes from the proven ChatGPT conversation and run incarnation. There is no model-supplied `agent_key`, join token or takeover field. A worker cannot create worker descendants.

### `session_finish`

Conditionally exposed when Session finish is enabled. This is an Astra-only near-completion boundary when the user/executor prompt explicitly requests it. It receives queued work or holds/releases the current exact turn; it is not a generic progress, polling or queue-collection tool.

Workers report with `agents action=finish`, and decision helpers answer their own role normally.

### `exec` (code mode)

When the surface has composable tools and no conflicting direct tool named `exec`, CoS adds bounded JavaScript composition. Core code mode receives `tools.<name>(args)`, `Promise.all`, `text(...)` and `image(...)` in a fresh isolated runtime with no ambient Node, filesystem, network, imports, console, timers or persistent globals.

Nested calls use the same live registrations, schemas, permissions, approved paths, caller identity and recording as direct calls. Only explicit text/image emissions enter the outer result. A script failure does not undo child actions already dispatched, so successful mutations must not be blindly replayed after a later JavaScript error.

Exact companion request/conversation/session proof is required. Lifecycle signals such as `session_finish` and `agents action=finish` must be direct calls.

## Desktop tools

Desktop is an optional connector. Windows and macOS intentionally expose different public vocabularies because their native backends have different stable primitives. Linux exposes none.

### Windows: Window2 operations

With screen permission, Windows can publish these read/observation operations:

| Tool | Purpose |
| --- | --- |
| `list_windows` | list open native app/window identities |
| `get_window` | resolve an exact returned window identity |
| `list_apps` | list installed/running apps with their exact owned windows |
| `get_window_state` | observe one window, optional accessibility text and native screenshot blocks without activating it |

With control permission, Windows can publish these input/launch operations:

| Tool | Purpose |
| --- | --- |
| `launch_app` | launch an observed app id or explicit executable path/name without arbitrary command arguments |
| `click` | click screenshot coordinates or a current accessibility element index |
| `press_key` | send a bounded keysym-style key/chord to the exact target window |
| `type_text` | type literal text; multiline input additionally requires clipboard-write permission |
| `scroll` | send wheel deltas at screenshot coordinates |
| `set_value` | replace an indexed editable control's value |
| `drag` | drag between screenshot coordinates |
| `perform_secondary_action` | invoke an advertised accessibility action on an indexed element |
| `activate_window` | explicitly activate an exact returned window |

`read_clipboard` and `write_clipboard` are exposed independently under their own permissions.

Observation indexes/coordinates are scoped to the exact caller/session and native frame/helper generation. Input revalidates the target and current geometry instead of lending another chat's latest observation. Screenshot pixels are returned once as native MCP image blocks; structured metadata does not duplicate their data URLs.

Windows Desktop code mode exposes these same operations through its `sky` adapter and keeps all live permission/target checks.

### macOS: `observe`

`observe` reads desktop state without performing input. It can inspect the active window, list or wait for windows, capture a specific window, and return snapshot-scoped accessibility controls. Screen permission is independent from control/clipboard permissions.

### macOS: `computer`

`computer` executes a bounded batch of native actions. Its action vocabulary includes semantic control actions, coordinate click/double-click/move/drag/scroll, typing/key presses, focus/wait and clipboard read/write. Each action rechecks the particular screen/control/clipboard permission it needs; registering `computer` because clipboard access is enabled does not grant mouse/keyboard control.

Semantic refs and screenshot frames are snapshot-scoped. Native helpers revalidate window/frame ownership before physical input, report partial-batch failure, and can perform bounded verification of expected foreground/window/control changes.

## Plugins tools

The Plugins connector publishes the current bounded set of tools from installed **enabled** external MCP integrations under their upstream names and schemas. Tool collisions are excluded rather than silently renamed. See [`plugins.md`](plugins.md) for installation, OAuth and readiness behavior.

Every direct or nested call is still dispatched through CoS recording/attribution and current plugin-manager policy. Read-only mode refuses external plugin calls because the upstream server's OS or service permissions are outside CoS's approved-folder sandbox.

If the upstream tool set does not already own the name `exec`, the Plugins connector can add the same isolated code-mode composition surface over those enabled tools. Plugin result redaction still applies.

## Permission and identity invariants

- A tool call checks **current** permissions even when its schema was exposed earlier.
- Core, Desktop and Plugins do not forward or alias one another's tools.
- A connector secret for one surface does not authorize another surface.
- Read-only mode removes effective file-write, command and Desktop-control/clipboard-write authority and refuses external plugin execution, without pretending the saved capability choices themselves changed.
- Approved filesystem roots do not sandbox arbitrary shell processes, native Desktop control or an external plugin server.
- Local Project bindings can narrow filesystem-capable Core calls beyond the approved root.
- Identity-sensitive tools fail closed when the request cannot be tied to the exact current conversation/session owner.
- Tool arguments, text, structured results and binary/image transport remain explicitly bounded.

## Compatibility notes

Older ChatGPT conversations can retain a cached MCP schema after an upgrade or settings change. Refresh the relevant CoS app/connector in ChatGPT when its published declaration changes; reloading the companion browser extension is a separate operation.

The extension bridge pairs separately from the MCP connectors and does not grant filesystem/tool authority.

## Tests that protect the surface

`test/mcp.test.ts` checks Core/Desktop surface membership, cross-surface rejection, discovery budgets, live permission gating, cached exposure and schema shape. Windows Desktop publication is covered by `test/tools-desktop-windows.test.ts`; code-mode behavior by `test/code-mode-*.test.ts`; image parity by `test/codex-view-image-parity.test.ts`; plugin exposure by `test/plugins-*.test.ts`.

When changing the public tool surface, update the declarations, implementation, permission mapping, tests and this document together. Prefer composing workflows from existing primitives over adding a permanently exposed special-case tool.
