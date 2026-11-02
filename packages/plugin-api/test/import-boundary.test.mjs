import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {moduleReferences} from '../../../scripts/ci/architecture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'src');
const sourceFiles = directory => readdirSync(directory, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? sourceFiles(resolve(directory, entry.name)) : entry.name.endsWith('.ts') ? [resolve(directory, entry.name)] : []);
function checkReferences(file, text, base = source, extension = '.ts') {
  return moduleReferences(file, text).flatMap(reference => {
    const name = reference.specifier;
    if (typeof name !== 'string' || !name.startsWith('.')) return [`${file}: forbidden ${reference.kind} import ${name}`];
    const target = resolve(dirname(file), name.replace(/\.js$/, extension));
    if (relative(base, target).startsWith('..') || !existsSync(target)) return [`${file}: outside/unresolved ${name}`];
    return [];
  });
}

test('every plugin-api source file is independently checked, including erased type imports', () => {
  const files = sourceFiles(source);
  assert.ok(files.length >= 8);
  const failures = files.flatMap(file => checkReferences(file, readFileSync(file, 'utf8')));
  assert.deepEqual(failures, []);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  for (const entry of Object.values(manifest.exports)) {
    const output = resolve(root, entry.import);
    assert.ok(existsSync(output), entry.import);
    assert.deepEqual(checkReferences(output, readFileSync(output, 'utf8'), resolve(root, 'dist'), '.js'), []);
  }
});

test('the package boundary guard detects Node, private implementation and computed loader edges', () => {
  const file = resolve(source, 'index.ts');
  for (const text of [
    "import fs from 'node:fs';", "export * from '../../../apps/server/src/app.js';",
    "import type {Store} from '@mote/server';", "const load = (path: string) => import(path);",
    "export type T = import('../../../apps/server/src/store.js').Store;",
  ]) assert.ok(checkReferences(file, text).length > 0, text);
});
