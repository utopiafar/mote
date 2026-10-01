import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDestination, readWorkspaceRoute, workspaceHash } from '../src/workspace-route';
const collections = ['records', 'segments', 'materials', 'sources', 'files', 'activity', 'media', 'memories', 'extension'];
const readPage = (hash: string) => ({'library/files':'files','library/segments':'timeline','library/materials':'materials','library/memories':'memories','library':'archive'} as Record<string,string>)[hash.replace(/^#\//,'').split('?')[0]] ?? 'overview';
test('existing collection links open the matching type in the unified library', () => {
  for (const [route,collection] of [['files','files'],['segments','segments'],['materials','materials'],['memories','memories']]) {
    assert.deepEqual(readWorkspaceRoute('#/library/'+route+'?evidence=abc',readPage,collections),{page:'archive',collection});
  }
});
test('registered collection types remain deep-linkable; invalid types fall back safely', () => {
  assert.deepEqual(readWorkspaceRoute('#/library?view=extension',readPage,collections),{page:'archive',collection:'extension'});
  assert.deepEqual(readWorkspaceRoute('#/library?view=unknown',readPage,collections),{page:'archive',collection:'records'});
  assert.deepEqual(canonicalDestination('notes','files',collections),{page:'notes',collection:'files'});
});
test('switching library types preserves direct evidence and other filters', () => {
  const hash=workspaceHash('library','files','#/library?view=records&evidence=abc&after=2026-01-01');
  const query=new URLSearchParams(hash.split('?')[1]);
  assert.equal(hash.split('?')[0],'#/library');
  assert.equal(query.get('view'),'files');
  assert.equal(query.get('evidence'),'abc');
  assert.equal(query.get('after'),'2026-01-01');
  assert.equal(workspaceHash('today'),'#/today');
});
