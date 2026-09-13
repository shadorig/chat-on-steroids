import { currentCall, type CallContext } from './call-context.js';
import { getConfig } from '../config.js';
import { guard, fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { codeModeSchema, runCodeMode, CODE_MODE_LIMITS, type CodeModeTool, type CodeModeOptions } from './code-mode-runtime.js';
import { toolDeclaration } from './tool-declarations.js';
import { canAddCodeMode } from './code-mode-contract.js';

/** Contract checked against OpenAI Codex 634ebc1865c6ac840ed3ba118f040d527bf4b55d,
 * code-mode-protocol/src/description.rs and core/src/tools/code_mode/execute_spec.rs.
 * MCP requires an object argument; it cannot advertise Codex's freeform grammar/namespace. */
export const codeModeDeclaration = (options: CodeModeOptions = {}) => toolDeclaration('exec', () => ({
  title: 'Run JavaScript',
  description: options.windowsDesktop
    ? 'Run Windows Computer Use JavaScript with sky: list_apps, list_windows, get_window, launch_app, get_window_state, click, press_key, type_text, scroll, set_value, drag, perform_secondary_action, activate_window. sky uses direct-tool arguments, returns native values and throws tool errors; get_window_state emits screenshots. Use nodeRepl.write(value) or text(value). sky is prebound for Windows. Fresh runtime per call; variables do not persist. tools.<name> returns MCP results; ALL_TOOLS lists methods. No Node/filesystem/network, timers or setTimeout. 64k source, 32 MiB JS memory, 2s CPU, 60s total, 32 calls, 8 concurrent, 4 images and 12 MiB output. Live permissions apply. Without exact companion identity, reads require Allow unattributed calls; desktop input also requires Allow unattributed computer control. Observe before acting, then refresh. Script failure does not undo dispatched inputs; observe before retrying.'
    : 'Run JavaScript to compose this connector’s tools. MCP arguments: {code: "raw JavaScript"}; the host chooses the outer namespace (Codex calls this functions.exec). Inside code, use await tools.<tool_name>(args), await Promise.all([...]), text(value), and image(dataUrlOrMcpImageContent). tools return their normal MCP result objects, including content and isError. Only explicit text/image output reaches the model; intermediate results stay in the runtime and local tool recording. ALL_TOOLS lists {name,description}; use the individual tools’ schemas for arguments. Fresh isolated JavaScript runtime, top-level await, no Node, filesystem, network, console or imports. Requires exact companion chat/session identity or Allow unattributed calls enabled. Limits: 64k source characters, 32 MiB JS memory, 2s active JS time, 60s total, 32 calls, 8 concurrent calls, 40k text bytes, 4 images, 12 MiB emitted payload. Await every call. Termination stops JavaScript/new calls, not actions already dispatched. Individual tools remain available. session_finish and agents action=finish must be direct calls. No recursive exec, pragma, wait/yield or persistent globals. See the connector instructions for examples.',
  inputSchema: codeModeSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}), options.windowsDesktop ? 'windows-desktop' : 'standard');

export function codeModeHandler(
  getTools: () => CodeModeTool[], invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeOptions = {}
): (args: { code: string }) => Promise<ToolResult> {
  return ({ code }) => guard('exec', async () => {
    const parent = currentCall();
    if (!parent || ((!parent.caller.requestId || !parent.caller.conversationId || !parent.caller.sessionId) &&
      !getConfig().multiAgent.allowUnattributedCalls)) {
      return fail('CALLER_IDENTITY_REQUIRED: code mode needs exact companion chat/session proof or Allow unattributed calls enabled in app settings. No JavaScript or nested tool ran.');
    }
    return runCodeMode(code, getTools().filter(tool => tool.name !== 'exec'), (name, args) => invoke(name, args, parent), CODE_MODE_LIMITS, options);
  });
}

export function registerCodeMode(
  reg: SurfaceRegistrar, invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeOptions = {}
): void {
  if (!canAddCodeMode(reg.descriptions())) return;
  reg.register('exec', codeModeDeclaration(options), codeModeHandler(() => reg.descriptions(), invoke, options));
}
