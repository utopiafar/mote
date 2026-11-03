import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDestination, readWorkspaceRoute, workspaceHash } from '../src/workspace-route';
const collections = ['materials', 'records', 'segments', 'sources', 'files', 'activity', 'media', 'memories', 'extension'];
const readPage = (hash:string)=>hash.replace(/^#\//,'').split('?')[0]==='library'?'archive':'overview';
test('collection links use explicit query parameters while retired path aliases fall through', () => {
  for(const collection of ['files','segments','materials','memories']){
    assert.deepEqual(readWorkspaceRoute('#/library?view='+collection,readPage,collections),{page:'archive',collection});
    assert.deepEqual(readWorkspaceRoute('#/library/'+collection,readPage,collections),{page:'overview',collection:'materials'});
  }
});
test('canonical destinations no longer rewrite retired page names',()=>{
  for(const [page,collection] of Object.entries({archive:'materials',notes:'files',insights:'insights'}))assert.deepEqual(canonicalDestination(page,collection,collections),{page,collection});
  assert.deepEqual(canonicalDestination('library','materials',collections),{page:'library',collection:'materials'});
  assert.equal(workspaceHash('library','materials'),'#/library?view=materials');
});
test('explicit unavailable collection types stay visible instead of opening unrelated materials', () => {
  assert.deepEqual(readWorkspaceRoute('#/library?view=extension',readPage,collections),{page:'archive',collection:'extension'});
  assert.deepEqual(readWorkspaceRoute('#/library?view=unknown',readPage,collections),{page:'archive',collection:'unknown'});
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

test('overview is the default while explicit library and raw links retain their meaning',()=>{
  for(const hash of ['', '#', '#/'])assert.deepEqual(readWorkspaceRoute(hash,readPage,collections),{page:'overview',collection:'materials'});
  assert.deepEqual(readWorkspaceRoute('#/library',readPage,collections),{page:'archive',collection:'materials'});
  assert.deepEqual(readWorkspaceRoute('#/library?view=records',readPage,collections),{page:'archive',collection:'records'});
});

test('retired Library work activity links retain the Activity destination',()=>{
  assert.deepEqual(readWorkspaceRoute('#/library?view=work-activity',readPage,collections),{page:'activity',collection:'materials'});
  assert.deepEqual(readWorkspaceRoute('#/library?view=records',readPage,collections),{page:'archive',collection:'records'});
});
