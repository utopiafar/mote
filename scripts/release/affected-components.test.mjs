import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { affectedComponents, workspaceGraph } from './affected-components.mjs';

const graph = [
  { name: '@mote/server', path: 'apps/server', dependencies: ['@mote/agent', '@mote/shared'] },
  { name: '@mote/web', path: 'apps/web', dependencies: ['@mote/shared'] },
  { name: '@mote/desktop', path: 'apps/desktop', dependencies: ['@mote/diagnostics', '@mote/shared'] },
  { name: '@mote/diagnostics', path: 'packages/diagnostics', dependencies: [] },
  { name: '@mote/agent', path: 'packages/agent', dependencies: ['@mote/shared'] },
  { name: '@mote/shared', path: 'packages/shared', dependencies: [] },
];
const changed = (...paths) => affectedComponents(paths, graph);
const groups = result => ['central', 'desktop', 'android'].filter(group => result[group]);

test('individual clients and central plugins select only their build consumers', () => {
  assert.deepEqual(groups(changed('apps/android/app/src/main/java/Collector.kt')), ['android']);
  assert.deepEqual(groups(changed('apps/desktop/src/queue.ts')), ['desktop']);
  assert.deepEqual(groups(changed('apps/web/src/App.tsx')), ['central']);
  assert.deepEqual(groups(changed('plugins/source-packs/recorder/plugin.mjs')), ['central']);
});
test('shared workspace changes traverse actual npm dependencies', () => {
  assert.deepEqual(groups(changed('packages/agent/src/index.ts')), ['central']);
  assert.deepEqual(groups(changed('packages/diagnostics/src/index.ts')), ['desktop']);
  const actual = workspaceGraph(fileURLToPath(new URL('../../', import.meta.url)));
  assert.deepEqual(groups(affectedComponents(['packages/diagnostics/src/index.ts'], actual)), ['desktop']);
  assert.deepEqual(groups(changed('packages/shared/src/connection.ts')), ['central', 'desktop', 'android']);
  assert.equal(changed('packages/shared/src/connection.ts').protocol, true);
});
test('protocol and release infrastructure check every affected platform without publishing', () => {
  assert.deepEqual(changed('protocol/contract.json'), { central: true, desktop: true, android: true, protocol: true, tooling: false });
  assert.deepEqual(groups(changed('scripts/release/components.mjs')), ['central', 'desktop', 'android']);
  assert.deepEqual(groups(changed('.github/workflows/component-checks.yml')), ['central', 'desktop', 'android']);
  assert.deepEqual(groups(changed('package-lock.json')), ['central', 'desktop', 'android']);
  assert.deepEqual(groups(changed('new-platform-input/config.json')), ['central', 'desktop', 'android']);
});
test('documentation and historic notes do not require app builds', () => {
  for (const path of ['docs/releasing.md', 'README.md', 'README.zh-CN.md', 'README.en.md', 'AGENTS.md', 'THIRD_PARTY_NOTICES.md', 'protocol/README.md', 'adapters/ui/README.md', 'plugins/source-packs/memex-markdown/README.md', 'release/notes/android/0.0.77.md']) {
    assert.deepEqual(changed(path), { central: false, desktop: false, android: false, protocol: false, tooling: false }, path);
  }
  // Markdown runtime prompts inside a workspace remain build inputs.
  assert.deepEqual(groups(changed('packages/agent/src/prompt.md')), ['central']);
  assert.deepEqual(groups(changed('packages/agent/skills/memory-extraction/SKILL.md')), ['central']);
});
test('component release workflows check only their platform and release tools', () => {
  for (const component of ['central', 'desktop', 'android']) {
    const result = changed(`.github/workflows/release-${component}.yml`);
    assert.deepEqual(groups(result), [component]);
    assert.equal(result.tooling, true);
  }
  assert.deepEqual(groups(changed('.github/workflows/release-android.yml', 'apps/web/src/App.tsx')), ['central', 'android']);
});
test('check-selection infrastructure runs its own regressions without app builds', () => {
  for (const name of ['affected-components', 'check-affected']) for (const suffix of ['.mjs', '.test.mjs']) {
    const result = changed(`scripts/release/${name}${suffix}`);
    assert.deepEqual(groups(result), []);
    assert.equal(result.tooling, true);
  }
});
