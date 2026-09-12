import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

function packagePath(nodeModules, name) {
  return path.join(nodeModules, ...name.split('/'));
}

async function nodeModulesContaining(root, fromPackage) {
  if (!fromPackage) return path.join(root, 'node_modules');
  let directory = await fs.realpath(packagePath(path.join(root, 'node_modules'), fromPackage));
  for (let index = 0; index < fromPackage.split('/').length; index++) directory = path.dirname(directory);
  return directory;
}

export async function readInstalledPackage(root, name, { fromPackage } = {}) {
  const nodeModules = await nodeModulesContaining(root, fromPackage);
  const directory = await fs.realpath(packagePath(nodeModules, name));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== name) throw new Error(`Installed package identity mismatch: expected ${name}, found ${manifest.name ?? 'unnamed package'}`);
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error(`Installed package has no version: ${name}`);
  return { name, version: manifest.version, directory, manifest };
}

function pnpmInvocation() {
  if (process.platform === 'win32') {
    const corepack = path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js');
    if (!existsSync(corepack)) throw new Error(`Corepack is unavailable beside ${process.execPath}`);
    return { command: process.execPath, prefix: [corepack, 'pnpm'] };
  }
  return { command: 'corepack', prefix: ['pnpm'] };
}

export async function productionPackagesFromPnpm(root) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const expected = /^pnpm@([^\s]+)$/.exec(pkg.packageManager ?? '')?.[1];
  if (!expected) throw new Error('package.json must pin pnpm with an exact packageManager field');

  const invocation = pnpmInvocation();
  const versionResult = spawnSync(invocation.command, [...invocation.prefix, '--version'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (versionResult.error) throw versionResult.error;
  if (versionResult.status !== 0) throw new Error(`Could not run pnpm: ${versionResult.stderr.trim()}`);
  const actual = versionResult.stdout.trim();
  if (actual !== expected) throw new Error(`pnpm version mismatch: expected ${expected}, found ${actual}`);

  const result = spawnSync(invocation.command, [
    ...invocation.prefix, 'licenses', 'list', '--prod', '--json', '--workspace-root'
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inventory production packages with pnpm: ${result.stderr.trim()}`);

  const byLicense = JSON.parse(result.stdout);
  const packages = [];
  for (const entries of Object.values(byLicense)) {
    if (!Array.isArray(entries)) throw new Error('Unexpected pnpm license inventory shape');
    for (const entry of entries) {
      if (!Array.isArray(entry.versions) || !Array.isArray(entry.paths) || entry.versions.length !== entry.paths.length) {
        throw new Error(`Unexpected pnpm package inventory row for ${entry.name ?? 'unknown package'}`);
      }
      for (let index = 0; index < entry.paths.length; index++) {
        packages.push({ name: entry.name, version: entry.versions[index], directory: entry.paths[index] });
      }
    }
  }

  // pnpm's license report intentionally omits optional dependencies. Sharp's platform
  // packages are optional by design, but they are release payloads and carry their own
  // license/attribution material. Join the optionals that pnpm actually linked beside Sharp;
  // unsupported and ignored targets have no link and therefore cannot enter the inventory.
  const sharp = await readInstalledPackage(root, 'sharp');
  for (const [name, expectedVersion] of Object.entries(sharp.manifest.optionalDependencies ?? {})) {
    if (!name.startsWith('@img/')) continue;
    try {
      const installed = await readInstalledPackage(root, name, { fromPackage: 'sharp' });
      if (installed.version !== expectedVersion) {
        throw new Error(`Sharp optional dependency mismatch: expected ${name}@${expectedVersion}, found ${installed.version}`);
      }
      packages.push({ name, version: installed.version, directory: installed.directory });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const unique = new Map();
  for (const pkg of packages) unique.set(await fs.realpath(pkg.directory), pkg);
  return [...unique.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.directory.localeCompare(b.directory));
}
