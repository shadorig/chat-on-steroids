# Building and replacing the native image libraries

The repository's `source-recipe.json` pins each top-level archive, patch and exceptional notice.
Release assembly reads the pinned Cargo locks from their verified source archives, downloads
librsvg's crates.io source closure, and records the Rust standard-library closures already embedded
in their `rust-src` archives. It writes generated `sources.json` plus `SHA256SUMS.txt` into the
source archive. Verify the checksums before extracting. Keep embedded subprojects and notices.
Source retains its original licenses. The application consumes the published sharp 0.35.4/@img
binaries without modifying their machine code. Windows and Unix use different dependency versions
even though both report libvips 8.18.6.

## Source preparation

Extract component archives separately with one leading path component removed, as the
upstream recipes do with `tar --strip-components=1`. Archive filenames contain a URL hash
to avoid collisions; the inventory maps them to recipe downloads. The build repositories
retain platform settings, inline source edits, generated-file recipes, patches and scripts.

The libimagequant v2.4.1 tag resolves to commit
`cf061ab536ec861449fbc8ac815b492aaa4da5fe`. The supplied archive uses that immutable
commit instead of relying on the tag remaining fixed:

```sh
git archive --format=tar --prefix=libimagequant-2.4.1/ cf061ab536ec861449fbc8ac815b492aaa4da5fe | gzip -n -6 > libimagequant-2.4.1.tar.gz
```

The resulting recipe-archive SHA-256 is
`47d2a84b7b1052975c9d50a3d4e3cacbf57b43d84a4c3131210848ead9964dfb`.
The supplied immutable commit archive has different directory/compression bytes and the same
source. Unix Fontconfig comes from the official read-only mirror at the exact 2.18.3 tag
commit because the recipe endpoint rejects unattended archival downloads. Windows libxml2's
recipe directory typo is corrected to `2.15`; its original source-archive SHA-256 still matches.

## macOS and Linux

Use sharp-libvips commit `6e5971d333377743163edc3ad9e5d0b897abcbc9` (v1.3.3).
Its `build.sh`, `build/posix.sh`, `versions.properties` and `platforms/` directories
describe configuration and installation. The entry points are:

```sh
./build.sh linux-x64
./build.sh linux-arm64v8
./build.sh darwin-x64
./build.sh darwin-arm64v8
```

Linux uses the supplied Dockerfiles; macOS uses Xcode command-line tools and Homebrew's
pkg-config. Supply the retained source bodies to the corresponding CURL download steps
instead of resolving moving tags again. Four external patches are included; the UltraHDR
PR patch is pinned to its byte-identical commit patch. Preserve all inline `sed` edits,
generated `vips.map`, static inner libraries, SONAME changes and linker flags in `posix.sh`.

The actual release logs record Rust `1.100.0-nightly (787af2b8c 2026-08-25)`, cargo-c
`0.10.25+cargo-0.99.0` and Meson `1.12.0`. Use that dated Rust toolchain rather than today's
floating nightly. The reviewed librsvg 2.62.91 `Cargo.lock` is tracked under `cargo/` and the
same bytes are present in its source archive. After the recipe's feature edits, `cargo update --workspace` removed only
`color_quant 1.1.0`, `gif 0.14.2`, `image-webp 0.2.4` and `weezl 0.1.12`; it
added/upgraded nothing.
Retained crates include that lock's dependency sources, checked against Cargo.lock hashes.
Retain the lock for `cargo vendor` / `--locked`; do not run an unrestricted update.
GVDB and libnsgif sources are embedded in their parent archives.

Original release logs: https://github.com/lovell/sharp-libvips/actions/runs/32944387969

## Windows

Use build-win64-mxe commit `09cfccf20b91b441fbe97fa7a7ed8a597e55e830` (v8.18.6) and
MXE base `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3` (`llvm-mingw-20260605`), both included.
The `container/` Dockerfiles, `build/`, `build.sh` and MXE settings define the Linux
cross-compilation environment. Sharp's `build/win.sh` selects the `web` variant,
`vips-dev-{ARCH}-web-8.18.6-static.zip`, without `-ffi`. The main libvips and C++ wrapper
remain DLLs; “static” describes their dependencies.

The pinned MXE recipes identify Rust nightly 2026-06-05 (`e7815e522`), LLVM 22.1.7,
and MinGW-w64 commit `b536c4fdb038a9c59a7e5fb36e7d1293c4dc61d6`. Their runtime sources
and the Rust standard-library lock's crate sources are included. The pinned `rust-src`
archives already contain their `library/vendor` trees, so release assembly validates and records
those Cargo closures without duplicating the vendored crates as separate `.crate` downloads.
The full LLVM source archive is an
inclusive delivery choice; use its compiler-rt, libc++, libc++abi and libunwind recipes for the
relevant runtimes. This does not assert that the whole compiler is incorporated in the
application. The dated Unix Rust standard-library source is supplied separately, and readable
standard-library/runtime notices accompany both sets.

The targets are `x86_64-w64-mingw32.static` and `aarch64-w64-mingw32.static`. With
the build repository's `build/` mounted at `/data`, the source collection command is:

```sh
make download-vips-web MXE_TARGETS=x86_64-w64-mingw32.static \
  MXE_PLUGIN_DIRS="plugins/llvm-mingw /data /data/plugins/mozjpeg /data/plugins/zlib-ng /data/plugins/web-deps /data/plugins/proxy-libintl"
```

Populate MXE's `pkg` cache from the retained inventory. Most archives match recipe
checksums directly; explicit mirror/commit substitutions in `source-recipe.json` need the
corresponding filename/hash adjustment while preserving the recorded source commit.
Do not substitute another libimagequant fork. Preserve all build/MXE patches and settings.
GLib's GVDB and librsvg's workspace plus locked crates are included. Follow the retained
upstream build/packaging scripts after preparation; this archive is source, not a toolchain.

## Replacing the installed library

Close the app and work on a copy. Build for the same OS, CPU and Sharp/libvips ABI,
retaining exported interfaces and library names. Under application resources:

- Windows: `app.asar.unpacked/node_modules/@img/sharp-win32-{x64|arm64}/lib/`, with
  `libvips-42.dll` and `libvips-cpp-8.18.6.dll`.
- Linux: `app.asar.unpacked/node_modules/@img/sharp-libvips-linux-{x64|arm64}/lib/`.
- macOS: `app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-{x64|arm64}/lib/`
  under `Chat On Steroids.app/Contents/Resources`.

Replace the corresponding shared libraries and retain required SONAME links. Sharp is
also unpacked; its Apache-licensed binding source/build instructions are in the sharp
source distribution if an ABI change requires rebuilding it. No application hash check
or publisher-key requirement fences these files. On macOS seal the modified copy again:

```sh
codesign --force --deep --sign - "Chat On Steroids.app"
codesign --verify --deep --strict --verbose=2 "Chat On Steroids.app"
```

On Linux extract an AppImage or use an installed DEB copy to obtain ordinary writable
files. Normal OS access controls apply. Preserve source/license notices with modifications.
The application's MIT terms do not prohibit library modification or reverse engineering
for debugging those modifications.

The release pipeline tests the packaged Sharp runtime on each native OS/CPU. It does not
claim bit-identical compiler output or a full offline rebuild of all native dependencies;
those are separate reproducibility properties.
