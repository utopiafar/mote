import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scopes, automaticTasks } from './select.mjs';
import { taskPlan, manualPlan, serverFiles, listTests, scaleFiles, largeMemoryCase, manualScopes, verifyInventory, automaticSkipPattern, manualCases } from './suites.mjs';
import { verifyGate } from './gate.mjs';

test('Server shards plus explicit scale cases cover the original glob once, with all short Memory guards automatic', () => {
  const inventory = verifyInventory();
  assert.equal(inventory.serverFiles, listTests('apps/server/test', '.test.ts').length);
  const automatic = [1, 2, 3, 4].flatMap(shard => serverFiles(shard));
  assert.deepEqual([...automatic, ...scaleFiles].sort(), listTests('apps/server/test', '.test.ts'));
  assert.equal(automatic.filter(path => path.endsWith('memory-read-batch.test.ts')).length, 1);
  assert.ok(automatic.includes('apps/server/test/read-model-performance.test.ts'), 'bounded correctness stays automatic despite the historical filename');
  assert.ok(automatic.includes('apps/server/test/execution-recovery-window.test.ts'), 'short restart/retry coverage stays automatic');
  for (const shard of [1, 2, 3, 4]) {
    const check = taskPlan(`server-${shard}`).at(-1);
    assert.ok(check.args.includes('--test-timeout=120000'));
    assert.equal(check.args[check.args.indexOf('--test-skip-pattern') + 1], automaticSkipPattern);
  }
  const memory = manualPlan('scale', 'memory').find(step => step.args.at(-1) === 'apps/server/test/memory-read-batch.test.ts');
  assert.equal(memory.args[memory.args.indexOf('--test-name-pattern') + 1], `^${largeMemoryCase}$`);
  const original = readFileSync('apps/server/test/memory-read-batch.test.ts', 'utf8');
  assert.ok(original.includes('{timeout:240000}'));
  assert.ok(original.includes('length:4097'));
});
test('every automatic plan excludes the long file and large case, while manual scopes retain the union', () => {
  for (const event of ['pull_request', 'push', 'local']) for (const task of automaticTasks({ scopes }, event).tasks) {
    const checks = taskPlan(task);
    assert.ok(!JSON.stringify(checks).includes('query-large-lineage-http.test.ts'));
    assert.ok(!checks.some(step => step.args.some(arg => /benchmark-|test-heldout-memory-|test:e2e|test:media-e2e|check:local|check:central/.test(arg))));
  }
  for (const [suite, names] of Object.entries(manualScopes)) assert.deepEqual(names.flatMap(name => manualPlan(suite, name)), manualPlan(suite));
  const replay = manualPlan('recovery', 'replay')[0].args.filter(arg => arg.endsWith('.test.ts'));
  assert.deepEqual(replay, listTests('scripts', '.test.ts').filter(path => /^scripts\/test-heldout-memory-/.test(path)));
  assert.throws(() => manualPlan('scale', 'typo')); assert.throws(() => taskPlan('typo')); assert.throws(() => serverFiles(0));
});
test('required gate rejects selection failure, failed/cancelled jobs and an unexpected skip', () => {
  const needs = { affected: { result: 'success', outputs: { node: 'true', android: 'false' } }, regressions: { result: 'success' }, android: { result: 'skipped' } };
  verifyGate(needs);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) assert.throws(() => verifyGate({ ...needs, regressions: { result } }));
  for (const result of ['failure', 'cancelled', 'skipped']) assert.throws(() => verifyGate({ ...needs, affected: { ...needs.affected, result } }));
  assert.throws(() => verifyGate({ ...needs, affected: { result: 'success', outputs: {} } }));
  verifyGate({ ...needs, affected: { result: 'success', outputs: { node: 'false', android: 'false' } }, regressions: { result: 'skipped' } });
  assert.throws(() => verifyGate({ ...needs, android: { result: 'success' } }));
});

test('real Node name filters partition actual Memory names, nested descriptions and dynamic test names without omission or duplication', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { memoryCaseNames } = await import('./suites.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'mote-ci-case-partition-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'names.test.mjs');
  const names = memoryCaseNames();
  writeFileSync(fixture, `import {test,describe} from 'node:test';\nimport {appendFileSync} from 'node:fs';\nconst hit=name=>appendFileSync(process.env.MOTE_GENERATED_MARKER,JSON.stringify(name)+'\\n');\n${names.map(name => `test(${JSON.stringify(name)},()=>hit(${JSON.stringify(name)}));`).join('\n')}\ndescribe('nested suite',()=>test('bounded nested guard',()=>hit('nested full name')));\nfor(const suffix of ['one','two'])test('dynamic '+suffix,()=>hit('dynamic '+suffix));\n`);
  const hits = [];
  for (const mode of ['automatic', 'manual']) {
    const marker = join(directory, mode);
    const args = ['--test', mode === 'automatic' ? '--test-skip-pattern' : '--test-name-pattern', `^${largeMemoryCase}$`, fixture];
    const env = { ...process.env, MOTE_GENERATED_MARKER: marker }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const ran = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (mode === 'manual') assert.deepEqual(ran, [largeMemoryCase]);
    else assert.deepEqual(ran.sort(), [...names.filter(name => name !== largeMemoryCase), 'nested full name', 'dynamic one', 'dynamic two'].sort());
    hits.push(...ran);
  }
  assert.deepEqual(hits.sort(), [...names, 'nested full name', 'dynamic one', 'dynamic two'].sort());
  assert.equal(new Set(hits).size, hits.length);
});

test('nested/dynamic Memory definitions fail inventory validation instead of silently dropping a scale case', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { memoryCaseNames } = await import('./suites.mjs');
  // Use this repository's dependency loader while replacing only the source inventory.
  const root = mkdtempSync(join(process.cwd(), '.mote-case-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/server/test'), { recursive: true });
  for (const source of [`describe('nested',()=>test('${largeMemoryCase}',()=>{}));`, `const dynamic='${largeMemoryCase}'; test(dynamic,()=>{});`]) {
    writeFileSync(join(root, 'apps/server/test/memory-read-batch.test.ts'), source);
    assert.throws(() => memoryCaseNames(root), /literal top-level|changed/);
  }
});

test('all mixed-file heavy cases partition through the actual automatic regex and manual commands exactly once', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process'); const { testNames } = await import('./suites.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'mote-ci-all-partitions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'partition.test.mjs');
  const declarations = [...new Set(manualCases.map(item => item.file))].flatMap(file => testNames(file).filter(test => test.name).map(test => ({ file, name: test.name })));
  const keys = declarations.map(item => `${item.file}:${item.name}`);
  writeFileSync(fixture, `import {test} from 'node:test';import {appendFileSync} from 'node:fs';\n${declarations.map((item, index) => `test(${JSON.stringify(item.name)},()=>appendFileSync(process.env.MOTE_GENERATED_MARKER,${JSON.stringify(JSON.stringify(keys[index])+'\n')}));`).join('\n')}`);
  const partitions = [{ pattern: automaticSkipPattern, flag: '--test-skip-pattern' }, ...manualCases.map(item => ({ pattern: manualPlan(item.suite, item.scope).find(step => step.args.at(-1) === item.file).args.at(-2), flag: '--test-name-pattern' }))];
  const combined = [];
  for (const [index, partition] of partitions.entries()) {
    const marker = join(directory, `hits-${index}`), env = { ...process.env, MOTE_GENERATED_MARKER: marker }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', partition.flag, partition.pattern, fixture], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const ran = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (index > 0) assert.equal(ran.length, 1);
    combined.push(...ran);
  }
  assert.deepEqual(combined.sort(), keys.sort()); assert.equal(new Set(combined).size, combined.length);
});

test('manual-only inventory rejects newly unclassified it, imported/variable aliases, and modified registration forms', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { verifyManualOnly, testNames } = await import('./suites.mjs');
  const root = mkdtempSync(join(process.cwd(), '.mote-registration-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  const file = 'test/registration.test.ts', known = 'Generated declared manual case';
  for (const extra of [
    `it('new it',()=>{});`,
    `check('new imported alias',()=>{});`,
    `const alias=test; alias('new variable alias',()=>{});`,
    `let assigned; assigned=test; assigned('new assigned alias',()=>{});`,
    `test.only('new only',()=>{});`,
    `runner.it('new namespace test',()=>{});`,
    `runner.default('new namespace default test',()=>{});`,
    `import { default as defaultAlias } from 'node:test'; defaultAlias('new named default test',()=>{});`,
    `const {it: other}=runner; other('new destructured alias',()=>{});`,
  ]) {
    writeFileSync(join(root, file), `import test,{it,test as check} from 'node:test';import * as runner from 'node:test';test('${known}',()=>{});${extra}`);
    assert.equal(testNames(file, root).length, 2, extra);
    assert.throws(() => verifyManualOnly(file, [known], root), /unclassified|modified/, extra);
  }
  writeFileSync(join(root, file), `import test from 'node:test'; const alias=test.bind(null); alias('unknown bound registration',()=>{});`);
  assert.throws(() => testNames(file, root), /Unsupported/);
  for (const extra of [`test['only']('unknown indexed registration',()=>{});`, `registerSomewhere(test);`]) {
    writeFileSync(join(root, file), `import test from 'node:test';test('${known}',()=>{});${extra}`);
    assert.throws(() => testNames(file, root), /Unsupported/);
  }
});

test('Web regression preparation builds the Agent runtime needed by real Server fixtures before testing', () => {
  const plan = taskPlan('web');
  const build = workspace => plan.findIndex(step => step.command === 'npm' && step.args[0] === 'run' && step.args[1] === 'build' && step.args.includes(workspace));
  const webTests = plan.findIndex(step => step.command === 'npm' && step.args[1] === 'test' && step.args.includes('@mote/web'));
  assert.ok(build('@mote/shared') >= 0, 'Agent and Web build against Shared outputs');
  assert.ok(build('@mote/agent') >= 0, 'Web fixtures import Server modules which load @mote/agent/dist');
  assert.ok(build('@mote/shared') < build('@mote/agent'));
  assert.ok(build('@mote/agent') < build('@mote/web'));
  assert.ok(build('@mote/web') < webTests);
  assert.ok(!plan.some(step => step.args.includes('test') && (step.args.includes('@mote/agent') || step.args.includes('@mote/server'))));
  assert.deepEqual(taskPlan('web-contract').filter(step => step.command === 'npm').map(step => step.args), [['run', 'build', '-w', '@mote/shared']]);
});
