import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('dev dependency check reports missing packages and accepts hoisted, types-only and unbuilt workspace packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mote-dependencies-'));
  try {
    const workspace = join(root, 'apps/server');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'package.json'), JSON.stringify({
      name: '@fixture/server', dependencies: { '@fixture/runtime': '1', '@fixture/shared': '1' },
      devDependencies: { '@types/fixture': '1' },
    }));
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./check-dependencies.mjs', import.meta.url))], { cwd: workspace, encoding: 'utf8' });
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /@fixture\/runtime, @fixture\/shared, @types\/fixture/);
    assert.match(missing.stderr, /npm ci from the repository root/);
    for (const name of ['@fixture/runtime', '@types/fixture']) {
      const directory = join(root, 'node_modules', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, exports: {} }));
    }
    const shared = join(root, 'packages/shared');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'package.json'), JSON.stringify({ name: '@fixture/shared', main: 'dist/index.js' }));
    await symlink(shared, join(root, 'node_modules/@fixture/shared'), 'dir');
    const installed = run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
