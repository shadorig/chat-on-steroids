import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { generateThirdPartyNotices } from '../scripts/generate-third-party-notices.mjs';

let root: string;
let packages: Array<{ name: string; version: string; directory: string }>;
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function generate(check = false) {
  return generateThirdPartyNotices({ root, packages, check });
}
beforeEach(async () => {
  root = await makeTempDir('notices-');
  await write('node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }));
  await write('node_modules/fixture/LICENSE', 'Fixture copyright and permission\n');
  await write('node_modules/fixture/NOTICE', 'Fixture attribution\n');
  packages = [{ name: 'fixture', version: '1.0.0', directory: path.join(root, 'node_modules', 'fixture') }];
  await write('docs/licenses/plugins/inventory.json', '[]');
  await write('docs/licenses/codex/LICENSE', 'Codex license fixture\n');
  await write('docs/licenses/codex/NOTICE', 'Codex notice fixture\n');
  for (const name of ['README.md', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt']) await write(`docs/licenses/native/${name}`, `Fixture ${name}\n`);
});
afterEach(async () => { await removeTempDir(root); });

it('preserves license and NOTICE text; check mode leaves the shipped inventory untouched', async () => {
  await generate();
  const output = path.join(root, 'resources/packaging/licenses/THIRD-PARTY-NOTICES.txt');
  const notice = await fs.readFile(output, 'utf8');
  expect(notice).toContain('Fixture copyright and permission\n');
  expect(notice).toContain('Fixture attribution\n');
  expect(notice).toContain('Codex license fixture\n');
  expect(notice).toContain('Codex notice fixture\n');
  await write('resources/packaging/licenses/THIRD-PARTY-NOTICES.txt', 'other platform inventory');
  await generate(true);
  expect(await fs.readFile(output, 'utf8')).toBe('other platform inventory');
});

it('rejects a manifest license label with no license or NOTICE material', async () => {
  await fs.unlink(path.join(root, 'node_modules/fixture/LICENSE'));
  await fs.unlink(path.join(root, 'node_modules/fixture/NOTICE'));
  await expect(generate(true)).rejects.toThrow('Missing license texts for production packages: fixture@1.0.0');
});

it('rejects an installed package that differs from the pnpm inventory', async () => {
  await write('node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '2.0.0' }));
  await expect(generate(true)).rejects.toThrow('identity differs from pnpm inventory');
});

it('rejects a production package inventory row whose manifest is invalid', async () => {
  await write('node_modules/fixture/package.json', '{broken');
  await expect(generate(true)).rejects.toThrow('Missing or invalid production dependency: fixture@1.0.0');
});

it('rejects changed catalog notice bytes before publishing an inventory', async () => {
  await write('docs/licenses/plugins/inventory.json', JSON.stringify([{ package: 'fixture', version: '1.0.0', notices: [{ file: 'LICENSE', sha256: '0'.repeat(64) }] }]));
  await write('docs/licenses/plugins/LICENSE', 'changed');
  await expect(generate()).rejects.toThrow('Catalog license hash mismatch');
  await expect(fs.stat(path.join(root, 'resources/packaging/licenses/THIRD-PARTY-NOTICES.txt'))).rejects.toThrow();
});
