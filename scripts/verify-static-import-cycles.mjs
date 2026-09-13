import fs from 'node:fs';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import * as ast from 'typescript/unstable/ast';

const ROOT = path.resolve('src');
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function sourceFiles(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(target));
    else if (SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension)) && !entry.name.endsWith('.d.ts')) out.push(target);
  }
  return out;
}

/** Static runtime imports/re-exports only; dynamic import() is an asynchronous load boundary. */
function runtimeSpecifiers(source) {
  const out = [];
  const moduleText = node => ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
  for (const statement of source.statements) {
    if (ast.isImportDeclaration(statement)) {
      const specifier = moduleText(statement.moduleSpecifier);
      if (!specifier) continue;
      const clause = statement.importClause;
      if (!clause) { out.push(specifier); continue; }
      if (clause.isTypeOnly) continue;
      if (clause.name || !clause.namedBindings || ast.isNamespaceImport(clause.namedBindings)) {
        out.push(specifier); continue;
      }
      if (clause.namedBindings.elements.some(element => !element.isTypeOnly)) out.push(specifier);
      continue;
    }
    if (ast.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const specifier = moduleText(statement.moduleSpecifier);
      if (!specifier || statement.isTypeOnly) continue;
      if (!statement.exportClause || ast.isNamespaceExport(statement.exportClause) ||
          statement.exportClause.elements.some(element => !element.isTypeOnly)) out.push(specifier);
      continue;
    }
    if (ast.isImportEqualsDeclaration(statement) && !statement.isTypeOnly &&
        ast.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression) {
      const specifier = moduleText(statement.moduleReference.expression);
      if (specifier) out.push(specifier);
    }
  }
  return out;
}

function resolveSource(from, specifier, known) {
  if (!specifier.startsWith('.')) return null;
  const absolute = path.resolve(path.dirname(from), specifier);
  const withoutJs = /\.(?:m?js|cjs)$/.test(absolute) ? absolute.replace(/\.(?:m?js|cjs)$/, '') : absolute;
  const candidates = [
    ...SOURCE_EXTENSIONS.map(extension => `${withoutJs}${extension}`),
    ...SOURCE_EXTENSIONS.map(extension => path.join(withoutJs, `index${extension}`))
  ];
  return candidates.find(candidate => known.has(candidate)) ?? null;
}

const files = sourceFiles(ROOT).map(file => path.resolve(file));
const known = new Set(files);
const graph = new Map(files.map(file => [file, new Set()]));
const api = new API({ cwd: process.cwd() });
const snapshot = api.updateSnapshot({ openProjects: [path.resolve('tsconfig.json')] });
const project = snapshot.getProjects().find(candidate => path.resolve(candidate.configFileName) === path.resolve('tsconfig.json'));
if (!project) throw new Error('TypeScript project could not be loaded');

try {
  for (const file of files) {
    const source = project.program.getSourceFile(file);
    if (!source) throw new Error(`TypeScript did not load ${path.relative(process.cwd(), file)}`);
    for (const specifier of runtimeSpecifiers(source)) {
      const target = resolveSource(file, specifier, known);
      if (target) graph.get(file).add(target);
    }
  }
} finally {
  snapshot.dispose();
  api.close();
}

let nextIndex = 0;
const indices = new Map();
const lows = new Map();
const stack = [];
const onStack = new Set();
const cycles = [];

function visit(file) {
  indices.set(file, nextIndex);
  lows.set(file, nextIndex++);
  stack.push(file);
  onStack.add(file);
  for (const target of graph.get(file)) {
    if (!indices.has(target)) {
      visit(target);
      lows.set(file, Math.min(lows.get(file), lows.get(target)));
    } else if (onStack.has(target)) {
      lows.set(file, Math.min(lows.get(file), indices.get(target)));
    }
  }
  if (lows.get(file) !== indices.get(file)) return;
  const component = [];
  while (stack.length) {
    const member = stack.pop();
    onStack.delete(member);
    component.push(member);
    if (member === file) break;
  }
  if (component.length > 1 || graph.get(file).has(file)) cycles.push(component);
}

for (const file of files) if (!indices.has(file)) visit(file);

if (cycles.length) {
  console.error('Runtime import cycles detected:');
  for (const component of cycles.sort((left, right) => right.length - left.length)) {
    const members = new Set(component);
    console.error(`\n${component.map(file => path.relative(process.cwd(), file)).sort().join('\n')}`);
    for (const file of component) {
      for (const target of graph.get(file)) {
        if (members.has(target)) console.error(`  ${path.relative(process.cwd(), file)} -> ${path.relative(process.cwd(), target)}`);
      }
    }
  }
  process.exitCode = 1;
} else {
  console.log(`Static runtime import graph is acyclic (${files.length} source files checked).`);
}
