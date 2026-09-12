# Documentation map

Use documentation according to the question it can authoritatively answer. Current source and reproducible tests show what the checkout does; maintained references below define intended or supported contracts; dated material preserves evidence without becoming current design.

## Maintained references

| Reference | Owns |
| --- | --- |
| [Project overview](../README.md) | public product introduction, supported-host summary and primary download/setup entry points |
| [Setup](setup.md) | user-facing setup, platform support and troubleshooting |
| [Model-facing tool surface](tool-surface.md) | current public MCP tools, discovery and caller-visible semantics |
| [Plugins](plugins.md) | plugin installation, configuration, readiness, OAuth and refresh behavior |
| [Architecture](architecture/README.md) | durable ownership, identity, authority, lifetime, recovery and rationale |
| [Security](../SECURITY.md) | public trust boundaries, permissions, credentials and disclosure policy |
| [Contributing](../CONTRIBUTING.md) | development, validation, packaging and pull-request workflow |

The root [`AGENTS.md`](../AGENTS.md) contains repository-wide working instructions for coding agents. It points to focused owners rather than duplicating their details.

## Evidence, history and proposals

- `chatgpt-turn-signals.md` is dated provider-page evidence. Verify the current extension adapters and, when feasible, the live signed-in page before relying on it for a browser-facing change.
- `codex-desktop-bridge.md` and `computer-use-overhaul-plan.md` are design/proposal records. `computer-use-overhaul-implementation.md` is a point-in-time implementation report.
- `bug-audit-*`, `bughunt-*`, `tool-error-rate-*`, `public-history-privacy-incident-*` and `plugin-notice-audit.md` are historical audits or incident evidence, not current architecture.
- `release-notes/` and `CHANGELOG.md` record shipped history. Validate a specific release against its immutable tag and artifacts.
- `plugin-licenses.md`, `licenses/` and generated notice/source inventories are distribution and compliance material; follow their owning scripts before changing generated outputs.

## Maintenance rule

Give each durable concept one canonical documentation owner. Secondary documents may include enough context to make a link understandable, but should not maintain parallel copies of exact defaults, thresholds, operation sets, state labels, provider selectors or release matrices.

Do not hard-wrap ordinary Markdown prose. Keep each paragraph on one physical source line and use newlines only where Markdown structure requires them. Formatting and documentation-structure checks run through the repository scripts.
