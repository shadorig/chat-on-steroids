# Build, update and release

[Architecture index](README.md) · [Contributing](../../CONTRIBUTING.md)

Shipping has several evidence layers. Keep them separate so a successful source check is not reported as proof of a package or released artifact.

## Evidence ladder

```text
source
  -> tests/typecheck
  -> Electron bundle
  -> platform package
  -> packaged-runtime smoke
  -> installed payload
  -> published release artifacts/checksums
  -> live behavior on that installed version
```

Crossing one rung does not imply the next. Native dependencies and unpacked resources are a common reason a source/dev run can pass while a package fails.

## Development and bundle

`package.json` is the command authority. `electron.vite.config.ts` bundles main/preload/renderer. The companion `extension/` ships as source files rather than through that bundle, so an extension change must be validated as packaged/copied extension content rather than assuming Vite transformed it.

`corepack pnpm run dev` runs `predev` first. That stages the pinned checksum-verified host tunnel payload and regenerates third-party notices before Electron starts. A clean checkout can therefore require this preparation before a saved auto-connect has its expected ignored runtime material.

Generated/staged native resources should be regenerated through their owning scripts. Do not edit a downloaded binary or generated notice as if it were source.

## Package construction

`scripts/package.mjs` orchestrates packaging. Platform/architecture vocabulary and pinned resource versions/checksums live in the packaging scripts rather than this document.

The package must carry more than the Vite bundle:

- companion extension files;
- pinned tunnel/ripgrep payloads where applicable;
- target native `node-pty`, Sharp/image and other native dependencies;
- platform Desktop helper/addon payloads;
- notices and corresponding native source material required by distribution obligations.

`electron-builder.yml` is the package-layout authority. Native executable/shared-library resources that cannot run from asar are explicitly unpacked or copied outside it.

Build/package on appropriate native runners for platform-specific claims. Electron Builder's ability to emit some cross-platform format from another host is not equivalent to exercising the target runtime, OS permission identity or native dependency stack.

## Platform targets

Release automation currently builds supported Windows, macOS and Linux architecture combinations on native CI runners. Consult `.github/workflows/release.yml` and packaging scripts for the current matrix and output names instead of duplicating that volatile list here.

The public security/setup docs describe signing/notarization status and platform limitations. Keep those user-facing statements synchronized with actual release policy.

## Packaged-runtime smoke

Packaging tests should verify what can differ from source execution: resource paths, executable permissions, native module architecture, extension placement, helper loading and startup.

The repository contains focused smoke scripts for the packaged runtime and platform-specific bundles. Use the one matching the layer changed. Passing `pnpm run build` alone is insufficient for a change whose risk is package layout.

## Updater

`src/main/update.ts` owns update checks, download verification, staging and supported apply paths. Update checks are non-fatal background work and must not delay an already usable workspace.

The updater accepts only a complete candidate whose published checksum matches. The candidate is revalidated before handoff at quit. A failed check/download must not replace an already verified candidate with unverified bytes.

Platform application paths differ: some package formats can self-apply, while others present a manual supported flow. Consult the current updater implementation for the exact matrix.

The companion extension is a separate payload/lifecycle. Updating the Electron app does not mean a running unpacked extension instance automatically refreshed itself.

## Release workflow

`.github/workflows/release.yml` builds and smoke-tests release candidates and assembles the complete artifact set. `.github/workflows/publish.yml` is the publication gate.

The durable principles are:

- build candidates from the exact reviewed ref/tag, not by mixing artifacts from another run;
- verify source/package/extension version alignment before publication;
- require the matching release notes/changelog inputs;
- run privacy, notices/native-source and dependency/resource checks before publishing;
- refuse to overwrite an existing release;
- verify assembled artifact checksums again before creating the public release;
- inspect public artifacts/checksums after publication when making a shipped-version claim.

A tag by itself is not evidence that release automation completed. Likewise, a dirty local tree with the same package version is not the immutable source of a published release.

## Third-party notices and corresponding source

`scripts/generate-third-party-notices.mjs`, native-source inventory/packaging scripts and the `docs/licenses/` material are distribution inputs, not decorative docs. A dependency/native-binary change can require regenerating and re-reviewing license/source outputs.

Notice completeness and source/replacement obligations are distinct checks. The focused license docs and CI scripts are the current authority for what each distributed component requires.

## Validation choices

Use validation proportional to the changed layer:

| Changed layer | Minimum meaningful evidence |
| --- | --- |
| docs only | `git diff --check`, link/path verification, rendered structure review |
| TypeScript behavior | focused tests + typecheck |
| broad production behavior | `corepack pnpm run verify` |
| bundle/preload/renderer integration | build plus focused runtime tests |
| package resources/native layout | target package + packaged-runtime smoke |
| release mechanics | workflow/script tests plus candidate assembly checks |
| installed/provider behavior | install that exact artifact and exercise the relevant live flow |

Do not package, install or publish merely because source-level work was requested. Those actions are validation or delivery steps only when the task actually requires them.
