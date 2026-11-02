import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopes, selectScopes, automaticTasks, selectionFromOptions } from './select.mjs';
import { changedPaths } from '../release/affected-components.mjs';
const changed = (...paths) => selectScopes(paths);
const cli = fileURLToPath(new URL('select.mjs', import.meta.url));
test('Web, Agent, translations and shared wire changes retain their actual consumers', () => {
  assert.deepEqual(changed('apps/web/src/App.tsx').scopes, ['web', 'i18n']);
  assert.deepEqual(changed('apps/server/src/connections.ts').scopes, ['server', 'i18n']);
  assert.deepEqual(changed('packages/agent/src/prompt.md').scopes, ['server', 'agent']);
  for (const path of ['packages/shared/src/i18n.ts', 'packages/shared/src/i18n-en.ts', 'packages/shared/src/i18n-ja.ts', 'packages/shared/src/i18n-ru.ts', 'apps/android/app/src/main/assets/i18n-en.json', 'apps/android/app/src/main/assets/i18n-de.json']) assert.deepEqual(changed(path).scopes, ['i18n']);
  for (const path of ['packages/shared/src/protocol.ts', 'protocol/contract.json']) assert.deepEqual(changed(path).scopes, scopes.filter(name => name !== 'tooling'));
});
test('unknown inputs and locks conservatively select all light scopes and explain the fallback', () => {
  for (const path of ['package-lock.json', 'package.json', 'tsconfig.base.json', 'packages/future/src/new.ts', 'new-root/input.ts']) assert.deepEqual(changed(path), { scopes, fallback: [path], serverGroups: ['all'], androidContract: true });
  assert.deepEqual(changed('docs/testing.md', 'AGENTS.md', '.agents/skills/real-world-testing/SKILL.md').scopes, []);
  assert.deepEqual(changed('scripts/ci/select.mjs', '.github/workflows/component-checks.yml').scopes, ['tooling']);
});
test('new plugin API/host paths select Central and tooling without all-light fallback', () => {
  for (const path of ['packages/plugin-api/src/index.ts', 'packages/plugin-host/src/host.ts']) {
    const selection = changed(path);
    assert.deepEqual(selection, { scopes: ['server', 'tooling'], fallback: [], serverGroups: ['all'] }, path);
    const tasks = automaticTasks(selection).tasks;
    assert.deepEqual(tasks, ['architecture', 'tooling', 'server-build', 'server-1', 'server-2', 'server-3', 'server-4']);
    assert.ok(!tasks.some(task => /benchmark|scale|recovery/.test(task)), path);
  }
  const sdk = changed('packages/plugin-sdk/src/browser.ts');
  assert.deepEqual(sdk, { scopes: ['tooling'], fallback: [] });
  assert.deepEqual(automaticTasks(sdk).tasks, ['architecture', 'tooling']);
});
test('the exact browser login smoke path selects its current clients without broadening unknown scripts', () => {
  const login = changed('scripts/test-web-login.cjs');
  assert.deepEqual(login, { scopes: ['web', 'i18n', 'desktop'], fallback: [] });
  assert.deepEqual(automaticTasks(login), { tasks: ['architecture', 'i18n', 'web', 'desktop'], android: false });
  assert.deepEqual(automaticTasks(login, 'push'), { tasks: ['architecture', 'i18n', 'web-contract', 'desktop-contract'], android: false });
  for (const path of ['scripts/test-web-login.cjs.bak', 'scripts/test-web-login-other.cjs', 'scripts/test-web-unknown.cjs']) {
    assert.deepEqual(changed(path), { scopes, fallback: [path], serverGroups: ['all'], androidContract: true });
  }
});
test('PR selection is modular, main runs affected light contracts, neither starts specialist suites', () => {
  const web = automaticTasks(changed('apps/web/src/App.tsx'));
  assert.deepEqual(web, { tasks: ['architecture', 'i18n', 'web'], android: false });
  assert.deepEqual(automaticTasks(changed('packages/shared/src/i18n-en.ts')), { tasks: ['architecture', 'i18n'], android: false });
  assert.deepEqual(automaticTasks(changed('apps/server/src/app.ts')).tasks, ['architecture', 'i18n', 'server-build', 'server-1', 'server-2', 'server-3', 'server-4']);
  const main = automaticTasks(changed('package-lock.json'), 'push');
  assert.equal(main.android, false);
  assert.ok(main.tasks.includes('server-contract'));
  assert.ok(!main.tasks.some(task => /^server-[1-4]$|benchmark|scale|recovery/.test(task)));
  assert.throws(() => automaticTasks(changed('apps/web/src/a.ts'), 'selection-error'));
  assert.deepEqual(automaticTasks(changed('scripts/ci/architecture.mjs')).tasks, ['architecture', 'tooling']);
  assert.deepEqual(automaticTasks(changed('docs/ci.md')).tasks, []);
});
test('real Kotlin intake consumers follow exact wire inputs on PRs and main without expanding unrelated modules', () => {
  const storage = ['store', 'evidence-store', 'sqlite-database', 'capture-schema', 'vault-schema', 'vault-schema-installation'].map(name => `apps/server/src/${name}.ts`);
  for (const path of [...storage, 'apps/server/src/app.ts', 'apps/server/src/connections.ts', 'apps/server/src/source-routes.ts', 'apps/server/src/file-routes.ts', 'apps/server/src/ingress.ts', 'apps/server/src/files.ts', 'apps/server/src/features/sources.ts', 'apps/server/src/features/files.ts']) {
    const selection = changed(path);
    assert.equal(selection.androidContract, true, path);
    for (const event of ['pull_request', 'push', 'local']) {
      const plan = automaticTasks(selection, event);
      assert.equal(plan.androidContract, true, `${event}: ${path}`);
      assert.equal(plan.android, false, 'a Server producer selects the focused contract, not all Kotlin units');
    }
  }
  for (const path of ['CentralClient', 'CentralNotes', 'FileUploadConfirmation', 'IngressV2Protocol']) {
    const selection = changed(`apps/android/app/src/main/java/dev/mote/collector/${path}.kt`);
    assert.equal(automaticTasks(selection).android, true);
    assert.equal(automaticTasks(selection).androidContract, true);
    assert.equal(automaticTasks(selection, 'push').android, false);
    assert.equal(automaticTasks(selection, 'push').androidContract, true);
  }
  for (const path of ['apps/android/test-fixtures/central-kotlin-contract.ts', 'apps/android/app/src/test/java/dev/mote/collector/CentralProducerContractTest.kt', 'packages/shared/src/collector-receipt.ts', 'packages/shared/src/files.ts', 'packages/shared/src/protocol.ts', 'protocol/contract.json', 'scripts/ci/select.mjs', '.github/workflows/component-checks.yml', 'scripts/release/check-affected.mjs']) assert.equal(changed(path).androidContract, true, path);
  for (const path of ['apps/server/src/memory-review.ts', 'apps/server/src/memory-pipeline.ts', 'apps/android/app/src/main/java/dev/mote/collector/CalendarActions.kt', 'packages/shared/src/i18n-en.ts', 'scripts/ci/architecture.mjs', 'docs/testing.md']) assert.equal(Boolean(changed(path).androidContract), false, path);
  for (const options of [{ all: true }, { base: '0'.repeat(40) }]) assert.equal(selectionFromOptions(options).androidContract, true);
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
