import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopes, selectScopes, automaticTasks } from './select.mjs';
import { changedPaths } from '../release/affected-components.mjs';
const changed = (...paths) => selectScopes(paths);
const cli = fileURLToPath(new URL('select.mjs', import.meta.url));
test('Web, Agent, translations and shared wire changes retain their actual consumers', () => {
  assert.deepEqual(changed('apps/web/src/App.tsx').scopes, ['web', 'i18n']);
  assert.deepEqual(changed('apps/server/src/connections.ts').scopes, ['server', 'i18n']);
  assert.deepEqual(changed('packages/agent/src/prompt.md').scopes, ['server', 'agent']);
  for (const path of ['packages/shared/src/i18n.ts', 'packages/shared/src/i18n-en.ts', 'apps/android/app/src/main/assets/i18n-en.json']) assert.deepEqual(changed(path).scopes, ['i18n']);
  for (const path of ['packages/shared/src/protocol.ts', 'protocol/contract.json']) assert.deepEqual(changed(path).scopes, scopes.filter(name => name !== 'tooling'));
});
test('unknown inputs and locks conservatively select all light scopes and explain the fallback', () => {
  for (const path of ['package-lock.json', 'package.json', 'tsconfig.base.json', 'packages/future/src/new.ts', 'new-root/input.ts']) assert.deepEqual(changed(path), { scopes, fallback: [path], serverGroups: ['all'] });
  assert.deepEqual(changed('docs/testing.md', 'AGENTS.md', '.agents/skills/real-world-testing/SKILL.md').scopes, []);
  assert.deepEqual(changed('scripts/ci/select.mjs', '.github/workflows/component-checks.yml').scopes, ['tooling']);
});
test('PR selection is modular, main runs affected light contracts, neither starts specialist suites', () => {
  const web = automaticTasks(changed('apps/web/src/App.tsx'));
  assert.deepEqual(web, { tasks: ['i18n', 'web'], android: false });
  assert.deepEqual(automaticTasks(changed('packages/shared/src/i18n-en.ts')), { tasks: ['i18n'], android: false });
  assert.deepEqual(automaticTasks(changed('apps/server/src/app.ts')).tasks, ['i18n', 'server-build', 'server-1', 'server-2', 'server-3', 'server-4']);
  const main = automaticTasks(changed('package-lock.json'), 'push');
  assert.equal(main.android, false);
  assert.ok(main.tasks.includes('server-contract'));
  assert.ok(!main.tasks.some(task => /^server-[1-4]$|benchmark|scale|recovery/.test(task)));
  assert.throws(() => automaticTasks(changed('apps/web/src/a.ts'), 'selection-error'));
});
function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-ci-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const write = (path, content = 'generated fixture\n') => { mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), content); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Generated'); git('config', 'user.email', 'generated@example.invalid');
  write('apps/web/src/old.ts'); write('packages/agent/src/removed.ts'); git('add', '.'); git('commit', '-m', 'generated base');
  return { directory, git, write, base: git('rev-parse', 'HEAD') };
}
test('real rename and deletion keep the old consumers even when code moves to docs', t => {
  const { directory, git, base } = repository(t);
  mkdirSync(join(directory, 'docs')); renameSync(join(directory, 'apps/web/src/old.ts'), join(directory, 'docs/old.ts'));
  rmSync(join(directory, 'packages/agent/src/removed.ts')); git('add', '.'); git('commit', '-m', 'generated move and deletion');
  const paths = changedPaths({ directory, base, head: 'HEAD' });
  assert.ok(paths.includes('apps/web/src/old.ts')); assert.ok(paths.includes('packages/agent/src/removed.ts'));
  assert.deepEqual(selectScopes(paths).scopes, ['web', 'server', 'agent', 'i18n']);
});
test('selector CLI failures do not publish no-op outputs; missing base and unsupported event fail closed', t => {
  const { directory, base } = repository(t);
  for (const args of [['--base', 'missing'], ['--head'], ['--event', 'broken'], ['--unknown']]) {
    const output = join(directory, `output-${args[0].slice(2)}`);
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.notEqual(result.status, 0, result.stdout);
  }
  const result = spawnSync(process.execPath, [cli, '--base', '0'.repeat(40), '--head', base, '--event', 'push'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).scopes, scopes);
});

test('common Server leaf modules and direct tests narrow regressions; shared owners and unknowns broaden conservatively', async () => {
  const { selectedServerFiles, serverGroups } = await import('./server-tests.mjs');
  const notes = changed('apps/server/src/notes.ts');
  assert.deepEqual(notes.serverGroups, ['intake']);
  const files = selectedServerFiles(notes.serverGroups);
  assert.ok(files.includes('apps/server/test/notes.test.ts'));
  assert.ok(files.includes('apps/server/test/connections.test.ts'));
  assert.ok(!files.includes('apps/server/test/memory-review.test.ts'));
  const direct = changed('apps/server/test/memory-review.test.ts');
  assert.deepEqual(direct.serverGroups, ['file:apps/server/test/memory-review.test.ts']);
  assert.deepEqual(selectedServerFiles(direct.serverGroups), ['apps/server/test/connections.test.ts', 'apps/server/test/memory-review.test.ts', 'apps/server/test/runtime-listener.test.ts']);
  for (const file of ['apps/server/src/store.ts', 'apps/server/src/app.ts', 'apps/server/src/memory-pipeline.ts', 'apps/server/src/model-authorization-host.ts', 'apps/server/src/unmapped-new-module.ts', 'apps/server/test/fixtures/memory-result.ts']) assert.deepEqual(serverGroups([file]), ['all']);
  assert.deepEqual(selectedServerFiles(['file:apps/server/test/deleted.test.ts']), selectedServerFiles(['all']));
  assert.throws(() => selectedServerFiles(['typo']));
});

test('shared Server modules conservatively retain direct consumers across feature prefixes', async () => {
  const { selectedServerFiles } = await import('./server-tests.mjs');
  for (const [source, consumer] of [
    ['provider-admission', 'import-capacity-wait'],
    ['file-processing', 'image-processing'],
    ['memory-strategies', 'material-inputs'],
  ]) {
    const selection = changed(`apps/server/src/${source}.ts`);
    assert.deepEqual(selection.serverGroups, ['all']);
    assert.ok(selectedServerFiles(selection.serverGroups).includes(`apps/server/test/${consumer}.test.ts`), consumer);
  }
});
