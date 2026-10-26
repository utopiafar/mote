import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { serverFiles, scaleFiles } from './server-tests.mjs';
export { serverFiles, scaleFiles } from './server-tests.mjs';
import { largeMemoryCase, manualCases, manualFiles, automaticSkipPattern, escapePattern } from './partitions.mjs';
export { largeMemoryCase, manualCases, manualFiles, automaticSkipPattern } from './partitions.mjs';
import { specialistScopes } from './manual-selection.mjs';

// These cases remain in their original files with unchanged assertions, scales and timeouts.
// Exact case selection keeps short authorization/cancellation coverage automatic.
export const node = (...args) => ({ command: process.execPath, args });
export const npm = (...args) => ({ command: 'npm', args: ['run', ...args] });
export function listTests(directory, suffix, root = '.') {
  try {
    const files = readdirSync(resolve(root, directory)).filter(name => name.endsWith(suffix)).sort().map(name => `${directory}/${name}`);
    if (!files.length && directory !== 'scripts/ci') throw Error(`No tests found in ${directory}`);
    return files;
  }
  catch (error) { if (directory === 'scripts/ci' && error.code === 'ENOENT') return []; throw error; }
}
const server = (files, ...options) => {
  if (!files.length) throw Error('An empty server partition cannot run as a successful check');
  const timeout = options.find(option => option.startsWith('--test-timeout=')) ?? '--test-timeout=120000';
  return node('--import', 'tsx', '--test', '--test-concurrency=4', timeout, ...options.filter(option => !option.startsWith('--test-timeout=')), ...files);
};
const sharedBuild = () => npm('build', '-w', '@mote/shared');
const agentBuild = () => npm('build', '-w', '@mote/agent');
const libs = () => [sharedBuild(), agentBuild()];
export function taskPlan(task, root = '.', selectedServer = ['all']) {
  if (task === 'central-units') return [
    npm('test', '-w', '@mote/shared', '-w', '@mote/agent', '-w', '@mote/web'),
    ...[1, 2, 3, 4].map(shard => server(serverFiles(shard, root), '--test-skip-pattern', automaticSkipPattern)),
    node('--test', ...listTests('scripts/release', '.test.mjs', root), ...listTests('scripts/ci', '.test.mjs', root)), node('scripts/test-central-runner.mjs'),
  ];
  if (task === 'integration-units') return [
    npm('test', '-w', '@mote/shared', '-w', '@mote/agent', '-w', '@mote/diagnostics', '-w', '@mote/desktop', '-w', '@mote/web'),
    ...[1, 2, 3, 4].map(shard => server(serverFiles(shard, root), '--test-skip-pattern', automaticSkipPattern)),
    node('--test', ...listTests('scripts/release', '.test.mjs', root), ...listTests('scripts/ci', '.test.mjs', root), 'scripts/media-workers.test.mjs', 'scripts/security-tests.mjs', 'scripts/reset-mvp-vault.test.mjs', 'scripts/journey-network-proxy.test.mjs'),
    node('--import', 'tsx', '--test', 'scripts/client.test.ts'), node('scripts/test-central-runner.mjs'),
  ];
  if (task === 'tooling') return [node('--test', ...listTests('scripts/ci', '.test.mjs', root), ...listTests('scripts/release', '.test.mjs', root))];
  if (task === 'i18n') return [sharedBuild(), npm('check:i18n'), node('--test', 'packages/shared/test/i18n.test.mjs')];
  if (task === 'shared') return [sharedBuild(), npm('test', '-w', '@mote/shared')];
  if (task === 'web') return [sharedBuild(), npm('build', '-w', '@mote/web'), npm('test', '-w', '@mote/web')];
  if (task === 'web-contract') return [sharedBuild(), node('--import', 'tsx', '--test', 'apps/web/test/api.test.ts')];
  if (task === 'agent' || task === 'agent-contract') return [...libs(), node('--test', ...(task === 'agent' ? listTests('packages/agent/test', '.test.mjs', root) : ['packages/agent/test/task-context.test.mjs', 'packages/agent/test/tool-contributions.test.mjs']))];
  if (task === 'server-build') return [...libs(), npm('build', '-w', '@mote/server')];
  if (/^server-[1-4]$/.test(task)) return [...libs(), server(serverFiles(Number(task.at(-1)), root, selectedServer), '--test-skip-pattern', automaticSkipPattern)];
  if (task === 'server-contract') return [...libs(), server(['apps/server/test/connections.test.ts', 'apps/server/test/runtime-listener.test.ts']), node('--test', 'scripts/update-tests.mjs', 'scripts/update-deployment-tests.mjs'), node('scripts/test-central-runner.mjs')];
  if (task === 'desktop' || task === 'desktop-contract') {
    const plan = [sharedBuild(), npm('build', '-w', '@mote/diagnostics')];
    if (task === 'desktop') plan.push(npm('typecheck', '-w', '@mote/desktop'), npm('test', '-w', '@mote/diagnostics'), npm('test', '-w', '@mote/desktop'));
    else plan.push(npm('test', '-w', '@mote/desktop', '--', 'test/connection-binding.test.ts', 'test/coding-transport-compatibility.test.ts'));
    return plan;
  }
  throw Error(`Unknown check task: ${task}`);
}

// A local entrypoint and a manual workflow share this inventory. No live models/devices.
export const manualScopes = specialistScopes;
export function manualPlan(suite, scope = 'all', root = '.') {
  if (!manualScopes[suite] || (scope !== 'all' && !manualScopes[suite].includes(scope))) throw Error(`Invalid manual suite/scope: ${suite}/${scope}`);
  const selected = scope === 'all' ? manualScopes[suite] : [scope], plan = [];
  for (const name of selected) {
    for (const item of [...manualCases, ...manualFiles].filter(item => item.suite === suite && item.scope === name)) {
      plan.push(server([item.file], `--test-timeout=${item.fileTimeout}`, ...(item.name ? ['--test-name-pattern', `^${escapePattern(item.name)}$`] : [])));
    }
    if (suite === 'recovery') {
      if (name === 'replay') {
        const files = listTests('scripts', '.test.ts', root).filter(file => /^scripts\/test-heldout-memory-/.test(file));
        if (!files.length) throw Error('Recovery replay inventory is empty');
        plan.push(node('--import', 'tsx', '--test', ...files));
      }
      if (name === 'process') plan.push(node('scripts/test-central-process-lifecycle.mjs'));
      if (name === 'arrivals') plan.push(node('--import', 'tsx', '--test', 'scripts/material-load-arrivals.test.cjs', 'scripts/material-load-recovery.test.cjs'));
    }
    if (suite === 'benchmark' && name !== 'guards') plan.push(node('--import', 'tsx', `scripts/benchmark-${{ sync: 'sync-scale', harness: 'harness-startup' }[name] ?? name}.ts`));
  }
  return plan;
}

export function testNames(file, root = '.') {
  const ts = createRequire(resolve(root, 'package.json'))('typescript');
  const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const bindings = new Map(), namespaces = new Set(), tests = [];
  const runnerKind = name => ['test', 'it', 'default'].includes(name) ? 'test' : ['describe', 'suite'].includes(name) ? 'suite' : null;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:test') continue;
    const clause = statement.importClause;
    if (clause?.name) bindings.set(clause.name.text, { kind: 'test' });
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
    if (named && ts.isNamedImports(named)) for (const specifier of named.elements) {
      const kind = runnerKind((specifier.propertyName ?? specifier.name).text);
      if (kind) bindings.set(specifier.name.text, { kind });
    }
  }
  const registration = expression => {
    if (ts.isIdentifier(expression)) return bindings.get(expression.text);
    if (ts.isElementAccessExpression(expression) && (registration(expression.expression)
      || (ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)))) throw Error(`Unsupported dynamic node:test registration: ${expression.getText(source)}`);
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    const property = expression.name.text;
    if (ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) {
      const kind = runnerKind(property); return kind ? { kind } : undefined;
    }
    const base = registration(expression.expression);
    if (!base) return undefined;
    if (['only', 'skip', 'todo'].includes(property)) return { ...base, modifier: property };
    if (runnerKind(property)) return { kind: runnerKind(property) };
    if (['before', 'after', 'beforeEach', 'afterEach', 'mock', 'run'].includes(property)) return undefined;
    throw Error(`Unsupported node:test registration property: ${expression.getText(source)}`);
  };
  // Imported aliases, direct variable aliases and namespace destructuring are
  // resolved explicitly. Escapes such as test.bind(...) fail closed.
  for (;;) {
    const before = bindings.size + namespaces.size;
    const aliases = node => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          const kind = registration(node.initializer);
          if (kind) bindings.set(node.name.text, kind);
          if (ts.isIdentifier(node.initializer) && namespaces.has(node.initializer.text)) namespaces.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer) && namespaces.has(node.initializer.text)) {
          for (const element of node.name.elements) {
            const kind = runnerKind((element.propertyName ?? element.name).getText(source));
            if (kind && ts.isIdentifier(element.name)) bindings.set(element.name.text, { kind });
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const kind = registration(node.right);
        if (kind) bindings.set(node.left.text, kind);
      }
      ts.forEachChild(node, aliases);
    };
    aliases(source);
    if (bindings.size + namespaces.size === before) break;
  }
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const kind = registration(node.expression);
      if (!kind && node.arguments.some(argument => registration(argument))) throw Error(`Unsupported node:test registration escape: ${node.getText(source)}`);
      if (kind) {
        const name = node.arguments[0];
        tests.push({ ...kind, name: name && ts.isStringLiteralLike(name) ? name.text : null, expression: name?.getText(source), topLevel: ts.isExpressionStatement(node.parent) && node.parent.parent === source });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tests;
}
export function verifyManualOnly(file, declared, root = '.') {
  if (testNames(file, root).some(test => test.kind !== 'test' || test.modifier || !test.name || !declared.includes(test.name))) throw Error(`Manual-only file has unclassified or modified registrations: ${file}`);
}
export function memoryCaseNames(root = '.') {
  const names = testNames('apps/server/test/memory-read-batch.test.ts', root);
  if (names.some(test => test.kind !== 'test' || test.modifier || test.name === null || !test.topLevel) || names.filter(test => test.name === largeMemoryCase).length !== 1) throw Error('Memory case partition requires reviewed, literal top-level test names');
  return names.map(test => test.name);
}
export function verifyInventory(root = '.') {
  const shards = [1, 2, 3, 4].flatMap(shard => serverFiles(shard, root));
  const actual = listTests('apps/server/test', '.test.ts', root);
  if (new Set(shards).size !== shards.length || JSON.stringify([...shards, ...scaleFiles].sort()) !== JSON.stringify(actual)) throw Error('Server shards omit or duplicate test files');
  const memoryNames = memoryCaseNames(root);
  if (new Set(manualCases.map(item => `${item.file}:${item.name}`)).size !== manualCases.length) throw Error('Duplicate manual case');
  const declarations = actual.flatMap(file => testNames(file, root).map(test => ({ ...test, file })));
  for (const item of manualCases) {
    if (!manualScopes[item.suite]?.includes(item.scope)) throw Error(`Unknown manual scope: ${item.suite}/${item.scope}`);
    if (declarations.filter(test => test.name === item.name).length !== 1) throw Error(`Manual test name must be globally unique: ${item.name}`);
    const matches = testNames(item.file, root).filter(test => test.name === item.name);
    if (matches.length !== 1 || matches[0].kind !== 'test' || matches[0].modifier || !matches[0].topLevel) throw Error(`Manual case must remain unique, literal and top-level: ${item.file}: ${item.name}`);
  }
  for (const file of scaleFiles.filter(file => !manualFiles.some(item => item.file === file))) {
    const declared = manualCases.filter(item => item.file === file).map(item => item.name);
    verifyManualOnly(file, declared, root);
  }
  for (const suite of Object.keys(manualScopes)) for (const step of manualPlan(suite, 'all', root)) {
    for (const file of step.args.filter(arg => /\.(?:ts|cjs)$/.test(arg))) readFileSync(resolve(root, file));
  }
  return { serverFiles: actual.length, automaticFiles: shards.length, manualOnlyFiles: scaleFiles.length, partitionedManualCases: manualCases.length, automaticMemoryCases: memoryNames.length - 1, manualMemoryCases: 1 };
}
