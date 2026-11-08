import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {contributionSurfaces, packageManifestSchema, runtimeLocations} from '@mote/plugin-api';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const documentPath = resolve(root, 'docs/plugin-surfaces.md');
const document = readFileSync(documentPath, 'utf8');

// Public methods of ExtensionHost in packages/plugin-host/src/extensions.ts.
// The card requires the author reference to cover all six.
const extensionMethods = ['define', 'provide', 'members', 'single', 'collection', 'chain'];
const sectionParts = ['**What it does.**', '**Manifest fields.**', '**Minimal example.**', '**Lifecycle.**', '**Common errors.**'];
const sectionKey = (kind, name) => `${kind.toLowerCase()}:${name}`;

function sections(text) {
  const found = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^### (Surface|Runtime|Extension): `([^`]+)`$/.exec(line);
    if (heading) {
      current = {key: sectionKey(heading[1], heading[2]), lines: []};
      found.set(current.key, current);
      continue;
    }
    if (/^#{1,3} /.test(line)) current = undefined;
    else current?.lines.push(line);
  }
  return found;
}

/** One checker used by the normal run and the reverse self-check in T3-04. */
function checkDocument(text) {
  const found = sections(text);
  const missing = [];
  for (const name of contributionSurfaces) if (!found.has(sectionKey('Surface', name))) missing.push(sectionKey('Surface', name));
  for (const name of runtimeLocations) if (!found.has(sectionKey('Runtime', name))) missing.push(sectionKey('Runtime', name));
  for (const name of extensionMethods) if (!found.has(sectionKey('Extension', name))) missing.push(sectionKey('Extension', name));
  const incomplete = [...found.values()]
    .filter(section => sectionParts.some(part => !section.lines.some(line => line.startsWith(part))))
    .map(section => section.key);
  return {found, missing, incomplete};
}

function removeSection(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => {
    const heading = /^### (Surface|Runtime|Extension): `([^`]+)`$/.exec(line);
    return heading !== null && sectionKey(heading[1], heading[2]) === key;
  });
  assert.notEqual(start, -1, `section ${key} must exist before it can be removed`);
  let end = start + 1;
  while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

test('the author reference has a five-part section for every contribution surface and runtime location', () => {
  const checked = checkDocument(document);
  assert.deepEqual(checked.missing, []);
  assert.deepEqual(checked.incomplete, []);
  assert.equal(checked.found.size, contributionSurfaces.length + runtimeLocations.length + extensionMethods.length);
  assert.match(document, /iOS does not load plugins today/);
});

test('every examples link in the author reference resolves to a real file', () => {
  const links = [...document.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map(match => match[1].split(/[?#]/, 1)[0].trim().replace(/^<|>$/g, ''))
    .filter(target => target.includes('examples/'));
  assert.ok(links.length >= 16, 'the author reference must point authors at the examples');
  for (const target of links) assert.ok(existsSync(resolve(dirname(documentPath), decodeURIComponent(target))), target);
});

test('every manifest example in the author reference parses with packageManifestSchema', () => {
  const examples = [...document.matchAll(/```json manifest-example\r?\n([\s\S]*?)\r?\n```/g)].map(match => match[1]);
  assert.equal(examples.length, contributionSurfaces.length + runtimeLocations.length + extensionMethods.length);
  for (const example of examples) packageManifestSchema.parse(JSON.parse(example));
  const invalid = JSON.parse(examples[0]);
  delete invalid.archive;
  assert.throws(() => packageManifestSchema.parse(invalid), error => error?.code === 'invalid_contract');
});

test('the surface checker reports the exact missing section when the reference drops one', () => {
  assert.deepEqual(checkDocument(document).missing, []);
  const damaged = removeSection(document, 'surface:card');
  assert.deepEqual(checkDocument(damaged).missing, ['surface:card']);
  assert.notEqual(damaged, document);
});
