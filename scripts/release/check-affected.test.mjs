import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkPlan, runChecks } from './check-affected.mjs';
import { changedPaths } from './affected-components.mjs';

const cli = fileURLToPath(new URL('check-affected.mjs', import.meta.url));
const tests = ['scripts/release/affected-components.test.mjs'];
const npmChecks = affected => checkPlan(affected, tests).filter(step => step.command === 'npm').map(step => step.args[1]);

test('local plans select components, include Android, and retain broad integration checks', () => {
  assert.deepEqual(checkPlan({}, tests), []);
  assert.deepEqual(npmChecks({ central: true }), ['check:i18n', 'check:central']);
  assert.deepEqual(npmChecks({ desktop: true }), ['check:i18n', 'check:desktop']);
  const android = checkPlan({ android: true, tooling: true }, tests);
  assert.deepEqual(npmChecks({ android: true }), ['check:i18n']);
  assert.equal(android[1].command, process.execPath);
  assert.equal(android.at(-1).command, 'apps/android/gradlew');
  assert.ok(android.at(-1).args.includes(':app:testDebugUnitTest'));
  assert.deepEqual(npmChecks({ central: true, desktop: true, android: true }), ['check:local']);
  assert.equal(checkPlan({ central: true, desktop: true, android: true }, tests).at(-1).command, 'apps/android/gradlew');
  assert.deepEqual(checkPlan({ tooling: true }, tests), [{ command: process.execPath, args: ['--test', ...tests] }]);
});

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-affected-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const write = (path, text = 'generated fixture\n') => {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  for (const component of ['server', 'web', 'desktop']) write(`apps/${component}/package.json`, JSON.stringify({ name: `@mote/${component}` }));
  mkdirSync(join(directory, 'packages'));
  mkdirSync(join(directory, 'scripts/release'), { recursive: true });
  write('README.md');
  write('apps/desktop/src/old.ts');
  write('.gitignore', 'ignored/\n');
  git('add', '.');
  git('commit', '-m', 'fixture base');
  const base = git('rev-parse', 'HEAD');
  const dryRun = (...args) => spawnSync(process.execPath, [cli, '--base', base, '--dry-run', ...args], { cwd: directory, encoding: 'utf8' });
  return { directory, git, write, base, dryRun };
}

test('actual CLI includes committed, staged, unstaged and untracked inputs; explicit head is committed-only', t => {
  const { directory, git, write, base, dryRun } = repository(t);
  write('apps/server/src/committed.ts');
  git('add', '.'); git('commit', '-m', 'central fixture');
  write('apps/desktop/src/staged.ts'); git('add', '.');
  write('apps/web/package.json', JSON.stringify({ name: '@mote/web', fixture: true }));
  write('apps/android/new.kt');
  write('ignored/private.kt');
  const paths = changedPaths({ base, directory });
  for (const path of ['apps/server/src/committed.ts', 'apps/desktop/src/staged.ts', 'apps/web/package.json', 'apps/android/new.kt']) assert.ok(paths.includes(path), path);
  assert.ok(!paths.includes('ignored/private.kt'));
  const result = dryRun();
  assert.equal(result.status, 0, result.stderr);
  const local = JSON.parse(result.stdout);
  assert.equal(local.affected.android, true);
  assert.equal(local.affected.desktop, true);
  const committed = dryRun('--head', 'HEAD');
  assert.equal(committed.status, 0, committed.stderr);
  assert.deepEqual(JSON.parse(committed.stdout).affected, { central: true, desktop: false, android: false, protocol: false, tooling: false });
});

test('documentation-only CLI skips builds, while moving runtime code into docs retains the old consumer', t => {
  const { directory, git, write, base, dryRun } = repository(t);
  write('AGENTS.md'); write('README.zh-CN.md');
  let result = dryRun();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('"checks": []'));
  mkdirSync(join(directory, 'docs'));
  renameSync(join(directory, 'apps/desktop/src/old.ts'), join(directory, 'docs/old.ts'));
  git('add', '.');
  assert.ok(changedPaths({ base, directory }).includes('apps/desktop/src/old.ts'));
  result = dryRun();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).affected.desktop, true);
  git('commit', '-m', 'move runtime fixture into docs');
  assert.ok(changedPaths({ base, directory, head: 'HEAD' }).includes('apps/desktop/src/old.ts'));
});

test('an advanced base branch does not turn its unrelated changes into PR inputs', t => {
  const { directory, git, write } = repository(t);
  git('switch', '-c', 'feature');
  write('apps/android/feature.kt'); git('add', '.'); git('commit', '-m', 'android feature');
  git('switch', 'main');
  write('apps/desktop/src/base-only.ts'); git('add', '.'); git('commit', '-m', 'unrelated base change');
  git('switch', 'feature');
  assert.deepEqual(changedPaths({ base: 'main', head: 'HEAD', directory }), ['apps/android/feature.kt']);
});

test('opposite staged and working edits to the same file cannot hide a consumer', t => {
  const { directory, git, write, base, dryRun } = repository(t);
  write('apps/desktop/src/old.ts', 'generated staged change\n');
  git('add', '.');
  write('apps/desktop/src/old.ts');
  assert.equal(git('diff', 'HEAD', '--name-only'), '');
  assert.ok(changedPaths({ base, directory }).includes('apps/desktop/src/old.ts'));
  assert.equal(JSON.parse(dryRun().stdout).affected.desktop, true);
});

test('invalid revisions and options fail instead of reporting no checks', t => {
  const { dryRun } = repository(t);
  for (const args of [['--head', 'missing-revision'], ['--base'], ['--unknown']]) assert.notEqual(dryRun(...args).status, 0);
});

test('actual tooling-only CLI executes regression checks without invoking application tools', t => {
  const { directory, write, base } = repository(t);
  const marker = join(directory, 'regression-ran');
  write('scripts/release/affected-components.mjs');
  write('scripts/release/check-affected.test.mjs', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'passed');`);
  // Start as a user's CLI, not as a child worker of this test runner.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [cli, '--base', base], { cwd: directory, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('"tooling": true'));
  assert.ok(!result.stdout.includes('"command": "npm"'));
  assert.ok(existsSync(marker), result.stdout);
  assert.equal(readFileSync(marker, 'utf8'), 'passed');
});

test('check execution stops at the first failing command', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-check-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'unexpected');
  const status = runChecks([
    { command: process.execPath, args: ['-e', 'process.exit(7)'] },
    { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`] },
  ]);
  assert.equal(status, 7);
  assert.deepEqual(execFileSync(process.execPath, ['-e', `console.log(require('node:fs').existsSync(${JSON.stringify(marker)}))`], { encoding: 'utf8' }).trim(), 'false');
});
