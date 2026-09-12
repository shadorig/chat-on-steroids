import { describe, expect, it } from 'vitest';
import {
  cargoPackageDigest,
  deriveCargoSources,
  expandSourceRecipe,
  parseCargoLockRegistryPackages,
  type SourceRecipe,
  validateSourceRecipe,
} from '../scripts/native-source-inventory.mjs';

const LOCK = `version = 4

[[package]]
name = "alpha"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'1'.repeat(64)}"

[[package]]
name = "local-workspace"
version = "0.1.0"

[[package]]
name = "beta-sys"
version = "2.0.0+abi.4"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'2'.repeat(64)}"
`;

function cargoRule() {
  const packages = parseCargoLockRegistryPackages(LOCK);
  return {
    id: 'fixture-crates',
    mode: 'download' as const,
    sourceId: 'fixture',
    lockPath: 'fixture-1.0.0/Cargo.lock',
    insertAfter: 'fixture',
    targets: ['darwin', 'linux', 'win32'],
    expectedPackages: packages.length,
    expectedSha256: cargoPackageDigest(packages),
  };
}

describe('native source inventory', () => {
  it('derives crates.io archive identities from Cargo.lock without storing crate rows', () => {
    const rule = cargoRule();
    const sources = deriveCargoSources(rule, LOCK);

    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      id: 'crate-alpha-1.2.3',
      url: 'https://static.crates.io/crates/alpha/alpha-1.2.3.crate',
      version: '1.2.3',
      type: 'rust-crate',
      sha256: '1'.repeat(64),
      targets: ['darwin', 'linux', 'win32'],
      file: 'crate-alpha-1.2.3-627a3a47.crate',
    });
    expect(sources[1]!.id).toBe('crate-beta-sys-2.0.0+abi.4');
    expect(sources[1]!.file).toMatch(/^crate-beta-sys-2\.0\.0\+abi\.4-[a-f0-9]{8}\.crate$/);
  });

  it('inserts derived Cargo sources at the recipe-owned point', () => {
    const rule = cargoRule();
    const recipe: SourceRecipe = {
      format: 2,
      packages: { sharp: '1.0.0' },
      pinnedSources: [
        {
          id: 'fixture', url: 'https://example.com/fixture.tar.xz', version: '1.0.0', type: 'archive',
          sha256: '3'.repeat(64), targets: ['darwin', 'linux', 'win32'], file: 'fixture.tar.xz', bytes: 123,
        },
        {
          id: 'after', url: 'https://example.com/after.tar.xz', version: '1.0.0', type: 'archive',
          sha256: '4'.repeat(64), targets: ['linux'], file: 'after.tar.xz', bytes: 456,
        },
      ],
      cargoSources: [rule],
      noticeSupplements: [],
    };

    validateSourceRecipe(recipe);
    const expanded = expandSourceRecipe(recipe, new Map([[rule.id, LOCK]]));
    expect(expanded.sources.map((source) => source.id)).toEqual([
      'fixture', 'crate-alpha-1.2.3', 'crate-beta-sys-2.0.0+abi.4', 'after',
    ]);
    expect(expanded.cargoClosures).toEqual([
      expect.objectContaining({ id: rule.id, mode: 'download', packages: expect.any(Array) }),
    ]);
  });

  it('records embedded Cargo closures without emitting duplicate crate downloads', () => {
    const baseRule = cargoRule();
    const rule = {
      ...baseRule,
      id: 'embedded-crates',
      mode: 'embedded' as const,
      insertAfter: undefined,
      vendorPath: 'fixture-1.0.0/vendor',
    };
    const recipe: SourceRecipe = {
      format: 2,
      packages: { sharp: '1.0.0' },
      pinnedSources: [{
        id: 'fixture', url: 'https://example.com/fixture.tar.xz', version: '1.0.0', type: 'archive',
        sha256: '3'.repeat(64), targets: ['darwin', 'linux', 'win32'], file: 'fixture.tar.xz', bytes: 123,
      }],
      cargoSources: [rule],
      noticeSupplements: [],
    };

    const expanded = expandSourceRecipe(recipe, new Map([[rule.id, LOCK]]));
    expect(expanded.sources.map((source) => source.id)).toEqual(['fixture']);
    expect(expanded.cargoClosures[0]).toMatchObject({
      id: rule.id,
      mode: 'embedded',
      sourceId: 'fixture',
      vendorPath: 'fixture-1.0.0/vendor',
      packages: expect.arrayContaining([expect.objectContaining({ name: 'alpha', version: '1.2.3' })]),
    });
    expect(() => deriveCargoSources(rule, LOCK)).toThrow('must not be downloaded separately');
  });

  it('fails when the pinned Cargo closure changes', () => {
    const rule = { ...cargoRule(), expectedPackages: 3 };
    expect(() => deriveCargoSources(rule, LOCK)).toThrow('Cargo package count changed');
  });

  it('rejects another Cargo registry instead of inventing a download URL', () => {
    const lock = LOCK.replace(
      'registry+https://github.com/rust-lang/crates.io-index',
      'registry+https://example.com/private-index',
    );
    expect(() => parseCargoLockRegistryPackages(lock)).toThrow('Unsupported Cargo source');
  });

  it('rejects Git Cargo dependencies instead of silently omitting their source', () => {
    const lock = LOCK.replace(
      'registry+https://github.com/rust-lang/crates.io-index',
      'git+https://github.com/example/alpha?rev=deadbeef#deadbeef',
    );
    expect(() => parseCargoLockRegistryPackages(lock)).toThrow('Unsupported Cargo source');
  });

  it('rejects malformed package pins, overlapping source targets, and unsafe lock paths', () => {
    const rule = cargoRule();
    const recipe: SourceRecipe = {
      format: 2,
      packages: { sharp: '1.0.0' },
      pinnedSources: [
        {
          id: 'fixture', url: 'https://example.com/a.tar.xz', version: '1.0.0', type: 'archive',
          sha256: '3'.repeat(64), targets: ['darwin'], file: 'a.tar.xz', bytes: 123,
        },
        {
          id: 'fixture', url: 'https://example.com/b.tar.xz', version: '1.0.0', type: 'archive',
          sha256: '4'.repeat(64), targets: ['darwin'], file: 'b.tar.xz', bytes: 456,
        },
      ],
      cargoSources: [],
      noticeSupplements: [],
    };
    expect(() => validateSourceRecipe(recipe)).toThrow('Overlapping native source targets');
    expect(() => validateSourceRecipe({ ...recipe, pinnedSources: recipe.pinnedSources.slice(0, 1), packages: { 'bad pin': '' } }))
      .toThrow('Invalid native source package pins');
    expect(() => validateSourceRecipe({ ...recipe, pinnedSources: recipe.pinnedSources.slice(0, 1), packages: ['1.0.0'] as unknown as Record<string, string> }))
      .toThrow('Invalid native source recipe');

    const safeRecipe = { ...recipe, pinnedSources: recipe.pinnedSources.slice(0, 1), cargoSources: [{ ...rule, lockPath: '../Cargo.lock' }] };
    expect(() => validateSourceRecipe(safeRecipe)).toThrow('Invalid Cargo-derived native source');
  });
});
