import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const architectureDir = path.join(root, 'docs', 'architecture');
const errors = [];
const architectureFiles = fs.existsSync(architectureDir)
  ? fs
      .readdirSync(architectureDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(architectureDir, entry.name))
  : [];
if (!fs.existsSync(architectureDir))
  errors.push(
    'maintained documentation directory is missing: docs/architecture'
  );

const maintainedFiles = [
  'AGENTS.md',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'docs/README.md',
  'docs/setup.md',
  'docs/tool-surface.md',
  'docs/plugins.md',
  'docs/architecture/README.md'
].map((file) => path.join(root, file));

const checkedFiles = [...new Set([...maintainedFiles, ...architectureFiles])];
const anchorCache = new Map();

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function markdownWithoutFences(text) {
  let fenced = false;
  let marker = '';
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(```+|~~~+)/);
      if (match && (!fenced || match[1][0] === marker)) {
        fenced = !fenced;
        marker = fenced ? match[1][0] : '';
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

function parseLinkTarget(raw) {
  const value = raw.trim();
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    return end === -1 ? value : value.slice(1, end);
  }
  return value.split(/\s+(?=["'])/, 1)[0];
}

function insideRoot(file) {
  const fromRoot = path.relative(root, file);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${path.sep}`) &&
      fromRoot !== '..' &&
      !path.isAbsolute(fromRoot))
  );
}

/** Windows existence checks are case-insensitive; walk exact names so CI agrees across hosts. */
function existsWithExactCase(file) {
  if (!insideRoot(file)) return false;
  const parts = path.relative(root, file).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory())
      return false;
    if (!fs.readdirSync(current).includes(part)) return false;
    current = path.join(current, part);
  }
  return fs.existsSync(current);
}

function resolveLink(file, target) {
  const hash = target.indexOf('#');
  const beforeFragment = hash === -1 ? target : target.slice(0, hash);
  const query = beforeFragment.indexOf('?');
  const rawPath =
    query === -1 ? beforeFragment : beforeFragment.slice(0, query);
  const rawFragment = hash === -1 ? '' : target.slice(hash + 1);
  let decodedPath;
  let fragment;
  try {
    decodedPath = decodeURIComponent(rawPath);
    fragment = decodeURIComponent(rawFragment);
  } catch {
    errors.push(`${relative(file)} has an invalid encoded link: ${target}`);
    return null;
  }
  const resolved = !decodedPath
    ? file
    : decodedPath.startsWith('/')
      ? path.join(root, decodedPath.slice(1))
      : path.resolve(path.dirname(file), decodedPath);
  return { resolved, fragment };
}

function headingAnchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const anchors = new Set();
  const duplicates = new Map();
  const text = markdownWithoutFences(fs.readFileSync(file, 'utf8'));
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1]
      .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '');
    const base = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const duplicate = duplicates.get(base) ?? 0;
    duplicates.set(base, duplicate + 1);
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

for (const file of checkedFiles) {
  if (!existsWithExactCase(file)) {
    errors.push(`maintained documentation is missing: ${relative(file)}`);
    continue;
  }

  const text = markdownWithoutFences(fs.readFileSync(file, 'utf8'));
  const targets = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) =>
      parseLinkTarget(match[1])
    ),
    ...[...text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map(
      (match) => match[1]
    )
  ];
  for (const target of new Set(targets)) {
    if (/^[a-z][a-z+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const link = resolveLink(file, target);
    if (!link) continue;
    if (!insideRoot(link.resolved)) {
      errors.push(`${relative(file)} links outside the repository: ${target}`);
      continue;
    }
    if (!existsWithExactCase(link.resolved)) {
      errors.push(
        `${relative(file)} links to missing or case-mismatched path: ${target}`
      );
      continue;
    }
    if (
      link.fragment &&
      path.extname(link.resolved).toLowerCase() === '.md' &&
      !headingAnchors(link.resolved).has(link.fragment)
    ) {
      errors.push(
        `${relative(file)} links to missing Markdown heading: ${target}`
      );
    }
  }

  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
    const target = match[1];
    if (/[*?{}<>]/.test(target) || /\s/.test(target)) continue;
    if (
      !/^(?:(?:src|test|extension|scripts|docs|\.github)\/|(?:AGENTS|README|SECURITY|CONTRIBUTING)\.md$|package\.json$|electron(?:-builder\.yml|\.vite\.config\.ts)$)/.test(
        target
      )
    )
      continue;
    const resolved = path.resolve(root, target);
    if (!existsWithExactCase(resolved))
      errors.push(
        `${relative(file)} references missing or case-mismatched repository path: ${target}`
      );
  }
}

const architectureIndexPath = path.join(architectureDir, 'README.md');
if (fs.existsSync(architectureIndexPath)) {
  const architectureIndex = fs.readFileSync(architectureIndexPath, 'utf8');
  for (const file of architectureFiles) {
    const name = path.basename(file);
    if (name !== 'README.md' && !architectureIndex.includes(`](${name})`)) {
      errors.push(`docs/architecture/README.md does not link ${name}`);
    }
  }
}

const docsIndexPath = path.join(root, 'docs', 'README.md');
const docsIndex = fs.existsSync(docsIndexPath)
  ? fs.readFileSync(docsIndexPath, 'utf8')
  : '';
for (const target of [
  '../README.md',
  'setup.md',
  'tool-surface.md',
  'plugins.md',
  'architecture/README.md',
  '../SECURITY.md',
  '../CONTRIBUTING.md'
]) {
  if (!docsIndex.includes(`](${target})`))
    errors.push(`docs/README.md does not link maintained reference: ${target}`);
}

const topLevelDocClasses = [
  {
    pattern: /^(?:README|setup|tool-surface|plugins)\.md$/,
    markers: ['## Maintained references']
  },
  {
    pattern: /^chatgpt-turn-signals\.md$/,
    markers: ['`chatgpt-turn-signals.md`']
  },
  {
    pattern: /^codex-desktop-bridge\.md$/,
    markers: ['`codex-desktop-bridge.md`']
  },
  {
    pattern: /^computer-use-overhaul-(?:plan|implementation)\.md$/,
    markers: [
      '`computer-use-overhaul-plan.md`',
      '`computer-use-overhaul-implementation.md`'
    ]
  },
  {
    pattern: /^(?:bug-audit|bughunt|tool-error-rate)-.*\.md$/,
    markers: ['`bug-audit-*`', '`bughunt-*`', '`tool-error-rate-*`']
  },
  {
    pattern: /^public-history-privacy-incident-.*\.md$/,
    markers: ['`public-history-privacy-incident-*`']
  },
  {
    pattern: /^plugin-(?:licenses|notice-audit)\.md$/,
    markers: ['`plugin-licenses.md`', '`plugin-notice-audit.md`']
  }
];
for (const marker of new Set(
  topLevelDocClasses.flatMap(({ markers }) => markers)
)) {
  if (!docsIndex.includes(marker))
    errors.push(
      `docs/README.md is missing documentation class marker: ${marker}`
    );
}
const docsDir = path.join(root, 'docs');
const topLevelDocs = fs.existsSync(docsDir)
  ? fs.readdirSync(docsDir, { withFileTypes: true })
  : [];
for (const entry of topLevelDocs) {
  if (
    entry.isFile() &&
    entry.name.endsWith('.md') &&
    !topLevelDocClasses.some(({ pattern }) => pattern.test(entry.name))
  ) {
    errors.push(`docs/README.md has no classification for docs/${entry.name}`);
  }
}

const agentsPath = path.join(root, 'AGENTS.md');
const agentsBytes = existsWithExactCase(agentsPath)
  ? fs.statSync(agentsPath).size
  : 0;
if (agentsBytes > 16 * 1024)
  errors.push(
    `AGENTS.md is ${agentsBytes} bytes; keep the always-loaded root guide at or below 16 KiB`
  );

if (errors.length) {
  console.error(`Documentation verification failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation verification passed for ${checkedFiles.length} maintained Markdown files.`
  );
}
