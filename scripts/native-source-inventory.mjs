import { createHash } from 'node:crypto';

const CRATES_IO_REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';
const SOURCE_TYPES = new Set(['archive', 'build-repo', 'patch', 'runtime-source']);
const TARGETS = new Set(['darwin', 'linux', 'win32']);
const CARGO_MODES = new Set(['download', 'embedded']);

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function cargoPackageKey(pkg) {
  return `${pkg.name}\0${pkg.version}\0${pkg.checksum}`;
}

export function cargoPackageDigest(packages) {
  const canonical = packages.map(cargoPackageKey).sort().join('\n');
  return sha256Text(`${canonical}\n`);
}

function parseTomlString(line, key) {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`).exec(line);
  return match?.[1];
}

export function parseCargoLockRegistryPackages(text) {
  if (typeof text !== 'string' || !text.includes('[[package]]')) {
    throw new Error('Cargo.lock contains no package records');
  }

  const packages = [];
  let current = null;
  const finish = () => {
    if (!current?.source) return;
    if (current.source !== CRATES_IO_REGISTRY) {
      throw new Error(`Unsupported Cargo source for ${current.name ?? '<unknown>'}: ${current.source}`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(current.name ?? '') || !/^[A-Za-z0-9+._-]+$/.test(current.version ?? '') ||
        !/^[a-f0-9]{64}$/.test(current.checksum ?? '')) {
      throw new Error(`Incomplete crates.io Cargo package: ${current.name ?? '<unknown>'}@${current.version ?? '<unknown>'}`);
    }
    packages.push({
      name: current.name,
      version: current.version,
      checksum: current.checksum,
    });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '[[package]]') {
      finish();
      current = {};
      continue;
    }
    if (!current) continue;
    for (const key of ['name', 'version', 'source', 'checksum']) {
      const value = parseTomlString(line, key);
      if (value !== undefined) current[key] = value;
    }
  }
  finish();

  const keys = new Set();
  for (const pkg of packages) {
    const key = cargoPackageKey(pkg);
    if (keys.has(key)) throw new Error(`Duplicate Cargo package record: ${pkg.name}@${pkg.version}`);
    keys.add(key);
  }
  return packages;
}

function validateTargets(targets, owner) {
  if (!Array.isArray(targets) || targets.length === 0 || new Set(targets).size !== targets.length ||
      targets.some((target) => !TARGETS.has(target))) {
    throw new Error(`Invalid native source targets for ${owner}`);
  }
}

function validatePinnedSource(source) {
  if (!source || typeof source !== 'object' || !/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(source.id ?? '') ||
      typeof source.url !== 'string' || !source.url.startsWith('https://') || source.url.length > 2048 ||
      typeof source.version !== 'string' || !source.version || !SOURCE_TYPES.has(source.type) ||
      !/^[a-f0-9]{64}$/.test(source.sha256 ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(source.file ?? '') ||
      !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 256 * 1024 * 1024) {
    throw new Error(`Invalid pinned native source: ${source?.id ?? '<missing>'}`);
  }
  if ((source.recipeUrl !== undefined &&
       (typeof source.recipeUrl !== 'string' || !source.recipeUrl.startsWith('https://') || source.recipeUrl.length > 2048)) ||
      (source.recipeArchiveSha256 !== undefined && !/^[a-f0-9]{64}$/.test(source.recipeArchiveSha256)) ||
      (source.sourceNote !== undefined &&
       (typeof source.sourceNote !== 'string' || !source.sourceNote || source.sourceNote.length > 2048))) {
    throw new Error(`Invalid optional native source metadata: ${source.id}`);
  }
  validateTargets(source.targets, source.id);
}

function validateCargoSource(source, pinnedSources) {
  const lockSegments = typeof source?.lockPath === 'string' ? source.lockPath.split('/') : [];
  const vendorSegments = typeof source?.vendorPath === 'string' ? source.vendorPath.split('/') : [];
  if (!source || typeof source !== 'object' || !/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(source.id ?? '') ||
      !CARGO_MODES.has(source.mode) ||
      !/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(source.sourceId ?? '') ||
      typeof source.lockPath !== 'string' || !source.lockPath.endsWith('/Cargo.lock') || source.lockPath.startsWith('/') ||
      lockSegments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9+._-]+$/.test(segment)) ||
      !Number.isSafeInteger(source.expectedPackages) || source.expectedPackages < 1 ||
      !/^[a-f0-9]{64}$/.test(source.expectedSha256 ?? '')) {
    throw new Error(`Invalid Cargo-derived native source: ${source?.id ?? '<missing>'}`);
  }
  validateTargets(source.targets, source.id);
  const owners = pinnedSources.filter((pinned) => pinned.id === source.sourceId);
  if (owners.length !== 1) throw new Error(`Cargo source ${source.id} must name one pinned source archive`);
  if (source.targets.some((target) => !owners[0].targets.includes(target))) {
    throw new Error(`Cargo source ${source.id} targets must be covered by ${source.sourceId}`);
  }
  if (source.mode === 'download') {
    if (!/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(source.insertAfter ?? '')) {
      throw new Error(`Cargo source ${source.id} must name one insertion point`);
    }
    const insertions = pinnedSources.filter((pinned) => pinned.id === source.insertAfter);
    if (insertions.length !== 1) throw new Error(`Cargo source ${source.id} must name one insertion point`);
  } else {
    if (source.insertAfter !== undefined) {
      throw new Error(`Embedded Cargo source ${source.id} must not declare an insertion point`);
    }
    if (typeof source.vendorPath !== 'string' || source.vendorPath.startsWith('/') ||
        vendorSegments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9+._-]+$/.test(segment))) {
      throw new Error(`Embedded Cargo source ${source.id} must name a safe vendor path`);
    }
  }
}

export function validateSourceRecipe(recipe) {
  if (!recipe || recipe.format !== 2 || !recipe.packages || typeof recipe.packages !== 'object' || Array.isArray(recipe.packages) ||
      !Array.isArray(recipe.pinnedSources) || !Array.isArray(recipe.cargoSources) ||
      !Array.isArray(recipe.noticeSupplements)) {
    throw new Error('Invalid native source recipe');
  }

  const packageEntries = Object.entries(recipe.packages);
  if (packageEntries.length === 0 || packageEntries.some(([name, version]) =>
    !name || name.length > 214 || /\s/.test(name) || typeof version !== 'string' || !version || version.length > 128)) {
    throw new Error('Invalid native source package pins');
  }

  const filenames = new Set();
  const targetsById = new Map();
  for (const source of recipe.pinnedSources) {
    validatePinnedSource(source);
    if (filenames.has(source.file)) throw new Error(`Duplicate native source filename: ${source.file}`);
    filenames.add(source.file);
    const usedTargets = targetsById.get(source.id) ?? new Set();
    if (source.targets.some((target) => usedTargets.has(target))) {
      throw new Error(`Overlapping native source targets for ${source.id}`);
    }
    source.targets.forEach((target) => usedTargets.add(target));
    targetsById.set(source.id, usedTargets);
  }
  for (const source of recipe.cargoSources) validateCargoSource(source, recipe.pinnedSources);

  const cargoIds = new Set();
  for (const source of recipe.cargoSources) {
    if (cargoIds.has(source.id)) throw new Error(`Duplicate Cargo source id: ${source.id}`);
    cargoIds.add(source.id);
  }

  const supplementIds = new Set();
  for (const supplement of recipe.noticeSupplements) {
    if (typeof supplement.id !== 'string' || !supplement.id || supplement.id.length > 256 || supplementIds.has(supplement.id) ||
        typeof supplement.url !== 'string' || !supplement.url.startsWith('https://') || supplement.url.length > 2048 ||
        !/^[a-f0-9]{64}$/.test(supplement.sha256 ?? '')) {
      throw new Error(`Invalid or duplicate native notice supplement: ${supplement.id ?? '<missing>'}`);
    }
    supplementIds.add(supplement.id);
  }
  return recipe;
}

function validateCargoPackages(cargoSource, lockText) {
  const packages = parseCargoLockRegistryPackages(lockText);
  if (packages.length !== cargoSource.expectedPackages) {
    throw new Error(`${cargoSource.id} Cargo package count changed: expected ${cargoSource.expectedPackages}, got ${packages.length}`);
  }
  const digest = cargoPackageDigest(packages);
  if (digest !== cargoSource.expectedSha256) {
    throw new Error(`${cargoSource.id} Cargo package digest changed: expected ${cargoSource.expectedSha256}, got ${digest}`);
  }
  return packages;
}

function cargoPackagesToSources(cargoSource, packages) {
  return packages.map((pkg) => {
    const url = `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`;
    return {
      id: `crate-${pkg.name}-${pkg.version}`,
      url,
      version: pkg.version,
      type: 'rust-crate',
      sha256: pkg.checksum,
      targets: [...cargoSource.targets],
      file: `crate-${pkg.name}-${pkg.version}-${sha256Text(url).slice(0, 8)}.crate`,
    };
  });
}

export function deriveCargoSources(cargoSource, lockText) {
  if (cargoSource.mode !== 'download') {
    throw new Error(`Cargo source ${cargoSource.id} is embedded and must not be downloaded separately`);
  }
  return cargoPackagesToSources(cargoSource, validateCargoPackages(cargoSource, lockText));
}

export function expandSourceRecipe(recipe, cargoLocks) {
  validateSourceRecipe(recipe);
  const derivedByInsertion = new Map();
  const allFiles = new Set(recipe.pinnedSources.map((source) => source.file));
  const cargoClosures = [];

  for (const cargoSource of recipe.cargoSources) {
    const lockText = cargoLocks.get(cargoSource.id);
    if (typeof lockText !== 'string') throw new Error(`Missing Cargo.lock input for ${cargoSource.id}`);
    const packages = validateCargoPackages(cargoSource, lockText);
    cargoClosures.push({
      id: cargoSource.id,
      mode: cargoSource.mode,
      sourceId: cargoSource.sourceId,
      lockPath: cargoSource.lockPath,
      ...(cargoSource.vendorPath ? { vendorPath: cargoSource.vendorPath } : {}),
      registry: CRATES_IO_REGISTRY,
      targets: [...cargoSource.targets],
      packageDigest: cargoPackageDigest(packages),
      packages,
    });
    if (cargoSource.mode === 'embedded') continue;
    const derived = cargoPackagesToSources(cargoSource, packages);
    for (const source of derived) {
      if (allFiles.has(source.file)) throw new Error(`Duplicate generated native source filename: ${source.file}`);
      allFiles.add(source.file);
    }
    const group = derivedByInsertion.get(cargoSource.insertAfter) ?? [];
    group.push(...derived);
    derivedByInsertion.set(cargoSource.insertAfter, group);
  }

  const sources = [];
  for (const source of recipe.pinnedSources) {
    sources.push(source);
    sources.push(...(derivedByInsertion.get(source.id) ?? []));
  }
  return { sources, cargoClosures };
}
