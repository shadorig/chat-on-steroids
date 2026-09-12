import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativePrebuildDir, parseTarget, sharpPackagesFor } from './packaging-targets.mjs';
import { readInstalledPackage } from './installed-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = path.join(root, 'resources', 'packaging', 'native');

const say = (message) => process.stdout.write(`${message}\n`);

function requirePrebuild(directory, relative) {
  const target = path.join(directory, ...relative.split('/'));
  if (!existsSync(target)) throw new Error(`Required native prebuild is missing: ${relative}`);
}

async function stageTargetPayload(platform, arch, sharpPackages, nativePackages) {
  const payloadRoot = path.join(stagingRoot, platform, arch, 'node_modules');
  await rm(path.join(stagingRoot, platform, arch), { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true });

  for (const installed of sharpPackages) {
    const relative = installed.name.split('/');
    await cp(installed.directory, path.join(payloadRoot, ...relative), { recursive: true });
  }

  const prebuildDir = nativePrebuildDir(platform, arch);
  for (const installed of nativePackages) {
    const source = path.join(installed.directory, 'prebuilds', prebuildDir);
    const destination = path.join(payloadRoot, installed.name, 'prebuilds', prebuildDir);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  // node-pty launches this helper as a process on macOS. Preserve the published package's executable
  // contract explicitly instead of depending on host/filesystem copy-mode behaviour.
  if (platform === 'darwin') {
    await chmod(path.join(payloadRoot, 'node-pty', 'prebuilds', prebuildDir, 'spawn-helper'), 0o755);
  }
  say(`${platform}-${arch} native packaging payload staged.`);
}

async function main() {
  const { platform, arch } = parseTarget();
  const sharp = await readInstalledPackage(root, 'sharp');
  const sharpPackages = [];
  for (const packageName of sharpPackagesFor(platform, arch)) {
    const installed = await readInstalledPackage(root, packageName, { fromPackage: 'sharp' });
    if (sharp.manifest.optionalDependencies?.[packageName] !== installed.version ||
        !installed.manifest.cpu?.includes(arch) || !installed.manifest.os?.includes(platform)) {
      throw new Error(`Unexpected installed metadata for ${packageName}@${installed.version}`);
    }
    sharpPackages.push(installed);
    say(`${packageName} ${installed.version} verified from the installed Sharp dependency graph.`);
  }

  const nativePackages = await Promise.all(['node-pty', 'tree-sitter', 'tree-sitter-bash']
    .map((name) => readInstalledPackage(root, name)));
  const prebuildDir = nativePrebuildDir(platform, arch);
  const nodePty = nativePackages.find((pkg) => pkg.name === 'node-pty');
  const treeSitter = nativePackages.find((pkg) => pkg.name === 'tree-sitter');
  const treeSitterBash = nativePackages.find((pkg) => pkg.name === 'tree-sitter-bash');
  if (platform === 'win32') {
    requirePrebuild(nodePty.directory, `prebuilds/win32-${arch}/conpty.node`);
    requirePrebuild(nodePty.directory, `prebuilds/win32-${arch}/conpty_console_list.node`);
    requirePrebuild(nodePty.directory, `prebuilds/win32-${arch}/conpty/OpenConsole.exe`);
  } else {
    requirePrebuild(nodePty.directory, `prebuilds/${prebuildDir}/pty.node`);
    if (platform === 'darwin') requirePrebuild(nodePty.directory, `prebuilds/${prebuildDir}/spawn-helper`);
  }
  requirePrebuild(treeSitter.directory, `prebuilds/${prebuildDir}/tree-sitter.node`);
  requirePrebuild(treeSitterBash.directory, `prebuilds/${prebuildDir}/tree-sitter-bash.node`);
  await stageTargetPayload(platform, arch, sharpPackages, nativePackages);
  say(`${platform}-${arch} native dependency prebuilds are ready.`);
}

main().catch((error) => {
  process.stderr.write(`\nCould not prepare native packaging dependencies: ${error.message}\n`);
  process.exit(1);
});
