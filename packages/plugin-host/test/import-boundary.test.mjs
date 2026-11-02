import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {moduleReferences} from '../../../scripts/ci/architecture.mjs';

// H07/H11 own global scanner integration. Check this new package independently now.
const source = fileURLToPath(new URL('../src', import.meta.url));
const files = directory => readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory()
  ? files(resolve(directory, entry.name)) : entry.name.endsWith('.ts') ? [resolve(directory, entry.name)] : []);
function violations(file, text) {
  return moduleReferences(file, text).flatMap(({specifier}) => {
    if (specifier === '@deepseek-ai/cordis' || specifier === '@mote/plugin-api' || specifier === '@mote/plugin-api/contracts') return [];
    if (typeof specifier !== 'string' || !specifier.startsWith('.')) return [String(specifier)];
    const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
    return relative(source, target).startsWith('..') || !existsSync(target) ? [specifier] : [];
  });
}
test('the host package uses Cordis and public contracts without importing business assembly', () => {
  for (const file of files(source)) assert.deepEqual(violations(file, readFileSync(file, 'utf8')), [], file);
  const file = resolve(source, 'host.ts');
  for (const text of ["import type {Store} from '@mote/server';", "import '../../../apps/server/src/app.js';", 'const load = path => import(path);']) {
    assert.ok(violations(file, text).length, text);
  }
});
