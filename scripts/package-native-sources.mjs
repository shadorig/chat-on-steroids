import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expandSourceRecipe, validateSourceRecipe } from './native-source-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
const recipe = validateSourceRecipe(JSON.parse(await fs.readFile(path.join(noticeDirectory, 'source-recipe.json'), 'utf8')));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const [name, version] of Object.entries(recipe.packages)) {
  if (lock.packages[`node_modules/${name}`]?.version !== version) {
    throw new Error(`Native source review does not cover locked ${name}; expected ${version}`);
  }
}

if (process.argv.includes('--check')) {
  console.log(`Validated native source recipe with ${recipe.pinnedSources.length} pinned source files and ${recipe.cargoSources.length} Cargo closure rules.`);
  process.exit(0);
}

const output = path.join(root, 'release', 'native-sources');
const archives = path.join(output, 'archives');
await fs.mkdir(archives, { recursive: true });

const DERIVED_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
const tarExecutable = process.platform === 'win32' ? 'tar.exe' : 'tar';

async function ensureSource(source) {
  const destination = path.join(archives, source.file);
  const limit = source.bytes ?? DERIVED_SOURCE_MAX_BYTES;
  let bytes;
  try {
    const info = await fs.stat(destination);
    if (info.size <= limit) bytes = await fs.readFile(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Native source download failed: ${source.file}: HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error(`Native source exceeds reviewed size bound: ${source.file}`);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if ((source.bytes !== undefined && bytes.length !== source.bytes) ||
      createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
    throw new Error(`Native source checksum or size mismatch: ${source.file}`);
  }
  await fs.writeFile(destination, bytes);
  return { ...source, bytes: bytes.length };
}

const cargoLocks = new Map();
const cargoArchives = new Map();
for (const cargoSource of recipe.cargoSources) {
  const owner = recipe.pinnedSources.find((source) => source.id === cargoSource.sourceId);
  const verifiedOwner = await ensureSource(owner);
  const archivePath = path.join(archives, verifiedOwner.file);
  const result = spawnSync(tarExecutable, ['-xOf', archivePath, cargoSource.lockPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not read ${cargoSource.lockPath} from ${verifiedOwner.file}`);
  cargoLocks.set(cargoSource.id, result.stdout);
  cargoArchives.set(cargoSource.id, archivePath);
}

const { sources, cargoClosures } = expandSourceRecipe(recipe, cargoLocks);

async function verifyEmbeddedCargoClosure(closure) {
  if (closure.mode !== 'embedded') return;
  const archivePath = cargoArchives.get(closure.id);
  if (!archivePath || !closure.vendorPath) throw new Error(`Missing embedded Cargo archive metadata for ${closure.id}`);
  const checksumMembers = closure.packages.map((pkg) =>
    `${closure.vendorPath}/${pkg.name}-${pkg.version}/.cargo-checksum.json`);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-native-cargo-'));
  try {
    const extraction = spawnSync(tarExecutable, ['-xf', archivePath, '-C', tempDirectory, ...checksumMembers], {
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) {
      throw new Error(`Could not extract vendored Cargo checksums for ${closure.id}: ${extraction.stderr.trim()}`);
    }
    for (let index = 0; index < closure.packages.length; index++) {
      const pkg = closure.packages[index];
      const checksumPath = path.join(tempDirectory, ...checksumMembers[index].split('/'));
      const checksum = JSON.parse(await fs.readFile(checksumPath, 'utf8'));
      if (checksum.package !== pkg.checksum) {
        throw new Error(`Vendored Cargo checksum mismatch for ${pkg.name}@${pkg.version} in ${closure.id}`);
      }
    }
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

await Promise.all(cargoClosures.map(verifyEmbeddedCargoClosure));
console.log(`Validated Cargo closures: ${cargoClosures.map((closure) =>
  `${closure.id}=${closure.packages.length} ${closure.mode}`).join(', ')}.`);

let index = 0;
let completed = 0;
const verifiedSources = new Array(sources.length);
await Promise.all(Array.from({ length: 8 }, async () => {
  while (index < sources.length) {
    const sourceIndex = index++;
    verifiedSources[sourceIndex] = await ensureSource(sources[sourceIndex]);
    if (++completed % 50 === 0) console.log(`Verified ${completed}/${sources.length} source files.`);
  }
}));

const inventory = {
  format: 2,
  packages: recipe.packages,
  sources: verifiedSources,
  cargoClosures,
  noticeSupplements: recipe.noticeSupplements,
};
await fs.writeFile(path.join(output, 'sources.json'), `${JSON.stringify(inventory, null, 2)}\n`);
for (const name of ['source-recipe.json', 'README.md', 'SOURCE-BUILD.md', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt']) {
  await fs.copyFile(path.join(noticeDirectory, name), path.join(output, name));
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), verifiedSources.map(source => `${source.sha256}  archives/${source.file}`).join('\n') + '\n');
const destination = path.join(root, 'release', 'Chat-On-Steroids-Native-Sources.tar.gz');
// List the reviewed files explicitly: stale files from an older local build cannot enter the release.
const files = ['source-recipe.json', 'sources.json', 'README.md', 'SOURCE-BUILD.md', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt', 'SHA256SUMS.txt',
  ...verifiedSources.map(source => `archives/${source.file}`)];
const list = path.join(root, 'release', 'native-source-files.txt');
await fs.writeFile(list, files.join('\n') + '\n');
const result = spawnSync(tarExecutable, ['-czf', destination, '-C', output, '-T', list], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Native source archive failed: ${result.status}`);
console.log(`Built ${path.basename(destination)} with ${verifiedSources.length} verified source files.`);
