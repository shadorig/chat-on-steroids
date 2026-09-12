# Application and integration boundaries

[Architecture index](README.md) · [Plugin guide](../plugins.md) · [Security model](../../SECURITY.md)

This document covers the Electron renderer boundary, connector lifecycle, native Desktop control and external plugins. These features all reach outside one module, but they do not share authority.

## Renderer and preload

The renderer is an unprivileged presentation layer. The BrowserWindow keeps context isolation, sandboxing and web security enabled; Node integration/webviews are disabled, permission requests are denied, and arbitrary navigation/window creation is refused.

`src/preload/index.ts` exposes the complete renderer API through `contextBridge`. Every method maps to a fixed IPC channel; the renderer never receives `ipcRenderer` or a generic “invoke channel” escape hatch.

`src/main/ipc.ts` validates payloads and routes actions to main-process owners. The renderer can request named operations, but it does not become the owner of filesystem paths, secrets, browser commands, worker state or durable session transitions.

Dropped-file path discovery is another explicit boundary: Electron's preload can resolve a user-supplied `File`, then main validates/stages it. The renderer should not gain a general local-path API merely because drag/drop needs this one route.

## Async renderer state

Session lists, detail pages, controls, plans and model discovery are asynchronous. `src/renderer/chat.ts` uses selection/load generations so a response started for session A cannot repaint session B after the user navigates, including A → B → A races.

Durable mutation acknowledgement comes from main. Renderer optimism or a button click is not a receipt. Presentation-only dismissal must not cancel or acknowledge the durable work it hides.

History can be much larger than one renderer paint. Row/text/HTML budgets belong to rendering and pagination; they must not truncate the durable store to make the UI convenient.

## Authored content, titles and localization

Provider-captured HTML crosses a strict rendering allowlist; authored user text remains text. File names, paths and unresolved citations must not become invented clickable local links. Provider citation offsets and Unicode slicing are normalized at the rendering boundary rather than trusting browser indices to match JavaScript UTF-16 automatically.

Session title metadata records where a title came from. A provider title may replace an authored fallback, while an explicit manual title remains a deliberate user choice. Sidebar preview text is derived from authored conversation content; injected executor instructions/project frames are not user-authored preview material.

Application-owned UI text is localized through the renderer's locale system. Changing locale can repaint those labels without translating authored messages, provider text, code, shell output or file paths. Authored prose can use natural text direction; code/path/shell surfaces stay structurally stable. The current locale inventory belongs to the renderer catalogs and their focused tests.

## Connection lifecycle

`src/main/connection.ts` owns the local MCP server and optional public tunnel lifecycle. Connection transitions serialize and use a generation fence so a late health/open/close callback from an older endpoint cannot replace current status.

Core, Desktop and Plugins can share a local server process but keep separate connector surfaces and proof. A successful Core request does not establish that Desktop or Plugins is configured in ChatGPT. Likewise, extension pairing, local listener health, public-tunnel reachability and provider connector enrollment are different facts and should be presented separately.

Tunnel implementation/discovery lives under `src/main/tunnel/`; diagnostics test the chain in layers. A transient health failure is evidence to report, not automatic permission to churn a replacement endpoint while accepted work may still be using the current one.

## External plugins

The complete maintained behavior reference is `docs/plugins.md`. Architecturally:

- `src/main/plugins/manager.ts` owns installed records, enabled policy, connections and routing;
- `installer.ts` owns package materialization/archive bounds;
- `exposure.ts` owns which upstream tools are currently publishable;
- `oauth.ts` owns remote authorization flow and encrypted credentials.

External servers retain their own OS/service authority. CoS approved filesystem roots do not sandbox a third-party subprocess. Read-only mode therefore refuses plugin tool calls rather than trusting upstream annotations to prove non-mutation.

Installation/configuration mutations serialize per installation. Enabled plugins can reconnect in the background, but startup should not block the workspace on external server discovery. Disable or uninstall revokes local exposure before slower shutdown/cleanup work.

Transport failure does not license blind replay of a mutating external tool call; the external server may already have acted.

## Connector refresh

Local plugin/tool discovery and ChatGPT's cached connector schema are separate. A local tool change can require provider-side connector refresh before existing ChatGPT conversations see the new declaration.

Refresh automation, when enabled, targets the exact account-observed installed app identity and verifies the resulting provider declarations. Local “Ready” status alone must never be presented as proof that ChatGPT refreshed its cache.

The renderer's plugin-refresh reminder is presentation of that distinction, not a refresh receipt. Dismissing the reminder records only that the user dismissed the notice for the current running app version; it does not mark provider declarations synchronized or start a browser action by itself.

## Native Desktop control

Desktop capabilities are separate from filesystem roots. Windows and macOS use platform-native helpers behind platform-specific public schemas; unsupported platforms mask the capability rather than pretending another route provides equivalent authority.

`src/main/computer/` owns native observation/action state. The stable safety model is:

1. Observe a concrete target and receive a bounded frame/accessibility snapshot.
2. Tie subsequent semantic refs or coordinates to that exact target/frame/helper generation.
3. Revalidate window ownership, geometry and helper generation after asynchronous work and before physical input.
4. Report actual partial-batch outcomes and postcondition failures rather than inventing success.

Coordinates are screenshot pixels owned by a returned frame; callers should not apply an extra DPI conversion. Accessibility refs are snapshot-scoped and must fail stale rather than silently resolve a different control after the UI changes.

Native input is a real side effect. Window activation, clipboard replacement, keyboard/mouse action and the resulting postcondition are separate stages. An API accepting an action is not proof that the intended app state changed.

Windows browser-target policy also protects the ChatGPT workspace from generic tab/window-management chords. Browser testing should use an independently selected target window rather than letting a desktop action accidentally close or switch the model's own conversation.

See current declarations under `src/main/mcp/tools-desktop*.ts` and focused `test/computer*` / `test/tools-desktop*` suites for the exact supported action vocabulary.

## Secrets and external navigation

Credentials stay in main-process secure storage and are write-only from normal renderer forms. Diagnostic/result redaction happens at the owning boundary; raw credentials should not be copied through renderer state, logs, session fixtures or shell commands.

External links cross a validated main-process allowlist. The renderer itself cannot navigate the application window to arbitrary content or create new BrowserWindows.

## Integration changes to validate

When touching these boundaries, check the complete route rather than only one module:

- renderer action -> preload method -> validated IPC -> main owner;
- MCP surface -> connection publication -> tunnel/provider status;
- plugin policy -> manager -> upstream client -> redacted result -> connector exposure;
- Desktop observe -> returned target/frame -> action revalidation -> postcondition;
- config disable -> synchronous authority revocation -> slower resource cleanup.
