/**
 * Narrow composition boundary between MCP result decoration and browser recovery.
 *
 * The kernel must not import the browser bridge: doing so makes every tool path depend on the
 * HTTP composition root and closes a runtime import cycle. The bridge owns the actual recovery
 * schedule and installs this read-only projection when it initializes.
 */
type RepairEtaProvider = (now?: number) => number | null;

let provider: RepairEtaProvider = () => null;

export function installUnattributedRepairEta(next: RepairEtaProvider): void { provider = next; }
export function unattributedRepairEta(now = Date.now()): number | null { return provider(now); }
