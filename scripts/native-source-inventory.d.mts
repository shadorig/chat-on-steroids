export interface NativeSource {
  id: string;
  url: string;
  version: string;
  type: string;
  sha256: string;
  targets: string[];
  file: string;
  bytes?: number;
  recipeUrl?: string;
  recipeArchiveSha256?: string;
  sourceNote?: string;
}

export interface CargoSourceRule {
  id: string;
  mode: 'download' | 'embedded';
  sourceId: string;
  lockPath: string;
  vendorPath?: string;
  insertAfter?: string;
  targets: string[];
  expectedPackages: number;
  expectedSha256: string;
}

export interface CargoClosure {
  id: string;
  mode: 'download' | 'embedded';
  sourceId: string;
  lockPath: string;
  vendorPath?: string;
  registry: string;
  targets: string[];
  packageDigest: string;
  packages: CargoRegistryPackage[];
}

export interface SourceRecipe {
  format: 2;
  packages: Record<string, string>;
  pinnedSources: NativeSource[];
  cargoSources: CargoSourceRule[];
  noticeSupplements: Array<{ id: string; url: string; sha256: string }>;
}

export interface CargoRegistryPackage {
  name: string;
  version: string;
  checksum: string;
}

export function cargoPackageDigest(packages: CargoRegistryPackage[]): string;
export function parseCargoLockRegistryPackages(text: string): CargoRegistryPackage[];
export function validateSourceRecipe(recipe: SourceRecipe): SourceRecipe;
export function deriveCargoSources(rule: CargoSourceRule, lockText: string): NativeSource[];
export function expandSourceRecipe(
  recipe: SourceRecipe,
  cargoLocks: Map<string, string>,
): { sources: NativeSource[]; cargoClosures: CargoClosure[] };
