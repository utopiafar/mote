import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pageHash, pageRoutes} from '../dist/page-routes.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

/** Collect literal routes and references to the shared table in page registrations. */
async function declaredRoutes(directory) {
  const routes = new Set();
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const route of await declaredRoutes(path)) routes.add(route);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/\broute\s*:\s*['"]([^'"]+)['"]/g)) routes.add(match[1]);
    for (const match of source.matchAll(/\broute\s*:\s*pageRoutes\.(\w+)/g)) routes.add(pageRoutes[match[1]]);
  }
  return routes;
}

test('every shared page route is registered by the central web surface', async () => {
  const registered = new Set([
    ...await declaredRoutes(join(root, 'apps/web/src/plugins')),
    ...await declaredRoutes(join(root, 'apps/web/src/features')),
  ]);
  for (const [key, route] of Object.entries(pageRoutes)) {
    assert.ok(registered.has(route), `${key} page route #/${route} is missing from the Web registration`);
  }
});

test('page hashes keep the route key and only add encoded query data', () => {
  const expected = {
    chat: '#/chat',
    library: '#/library',
    models: '#/system/models',
    skills: '#/system/plugins',
    connections: '#/connections',
    lark: '#/connections/lark',
    actions: '#/actions',
    activity: '#/activity',
  };
  for (const key of Object.keys(pageRoutes)) assert.equal(pageHash(key), expected[key], key);
  assert.equal(pageHash('chat', {evidence: 'capture:generated id'}), '#/chat?evidence=capture%3Agenerated+id');
  assert.equal(pageHash('chat', {}), '#/chat');
  assert.equal(pageHash('library', {loginTicket: 'generated-ticket'}), '#/library?loginTicket=generated-ticket');
  assert.throws(() => pageHash('generated-unknown'), /Invalid page route/);
});

test('the table only holds route paths, never credentials or query data', () => {
  for (const [key, route] of Object.entries(pageRoutes)) {
    assert.match(route, /^[a-z0-9/.-]+$/, key);
    assert.equal(route.includes('?'), false, key);
    assert.equal(route.includes('#'), false, key);
    assert.equal(/token|ticket|bearer|credential/i.test(route), false, key);
  }
});
