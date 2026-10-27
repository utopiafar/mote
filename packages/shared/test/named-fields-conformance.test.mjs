import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {extractUiPages, uiRulesSchema, uiSnapshotSchema, uiPageSchema} from '../dist/ui-page.js';
const fixtures = JSON.parse(readFileSync(new URL('../../../adapters/ui/fixtures/named-field-conformance.json', import.meta.url), 'utf8')).cases;
const builtin = JSON.parse(readFileSync(new URL('../../../adapters/ui/builtin.json', import.meta.url), 'utf8'));
function hash(snapshot, node) {
  const children = snapshot.nodes.filter(candidate => candidate.parentId === node.id).sort((a, b) => a.childIndex - b.childIndex);
  return createHash('sha256').update(JSON.stringify([node.resourceId, node.role, children.map(child => hash(snapshot, child))])).digest('hex');
}
for (const fixture of fixtures) test(`generated current-version ${fixture.name} fields require the portable reviewed subtree`, () => {
  const rules = uiRulesSchema.parse([fixture.rule]), snapshot = uiSnapshotSchema.parse(fixture.snapshot);
  assert.equal(hash(snapshot, snapshot.nodes[0]), fixture.expectedSubtreeHash, 'Node crypto independently verifies historical portable guard encoding');
  const pages = extractUiPages(snapshot, rules, 'android');
  if (!fixture.expectedFields.length) {
    assert.deepEqual(pages, [], 'container accessibility descriptions are unavailable after on-device leaf sanitization');
  } else {
    assert.equal(pages.length, 1); assert.equal(uiPageSchema.parse(pages[0]).version, 3);
    assert.deepEqual(pages[0].objects[0].fields, fixture.expectedFields);
    assert.equal(pages[0].observations.count, 1);
  }
  assert.deepEqual(extractUiPages({...snapshot, appVersion: snapshot.appVersion + '-changed'}, rules, 'android'), []);
  const changed = structuredClone(snapshot); changed.nodes.at(-1).role = 'dev.generated.ChangedRole';
  assert.deepEqual(extractUiPages(changed, rules, 'android'), [], 'same captured text on changed topology cannot grant the old field meaning');
});

test('original child indices survive a removed sibling and cannot slide body mapping onto a neighbor', () => {
  const fixture = fixtures[0], rule = structuredClone(fixture.rule), snapshot = structuredClone(fixture.snapshot);
  delete rule.repeatSubtreeHash; // A generated resource-free path fixture isolates index behavior; this is never installed.
  snapshot.nodes = snapshot.nodes.filter(node => node.childIndex !== 1);
  const pages = extractUiPages(uiSnapshotSchema.parse(snapshot), uiRulesSchema.parse([rule]), 'android');
  assert.deepEqual(pages[0].objects[0].fields, fixture.expectedFields);
  snapshot.nodes.find(node => node.childIndex === 2).childIndex = 1;
  const moved = extractUiPages(uiSnapshotSchema.parse(snapshot), uiRulesSchema.parse([rule]), 'android');
  assert.deepEqual(moved[0].objects[0].fields.map(field => field.name), ['note_visible_title']);
});

test('all matching named rules retain separate observations and repeated identical bookshelf titles', () => {
  const chosen = fixtures.filter(f => f.name.startsWith('video-detail-'));
  const nodes = chosen.flatMap((fixture, fi) => fixture.snapshot.nodes.map(node => ({...node, id: fi + ':' + node.id, ...(node.parentId ? {parentId: fi + ':' + node.parentId} : {})})));
  const snapshot = uiSnapshotSchema.parse({...chosen[0].snapshot, nodes});
  const pages = extractUiPages(snapshot, uiRulesSchema.parse(chosen.map(f => f.rule)), 'android');
  assert.deepEqual(pages.map(page => page.adapterId), chosen.map(f => f.rule.id));
  assert.deepEqual(pages.map(page => page.objects[0].fields), chosen.map(f => f.expectedFields));
  const rule = builtin.find(rule => rule.id === 'weread-bookshelf-android-10.2.2');
  const books = uiSnapshotSchema.parse({appId: rule.appId, appVersion: rule.appVersion, activity: '', observedAt: '2026-10-24T00:00:00.000Z', truncated: false, nodes: [0, 1].map(index => ({id: String(index), resourceId: rule.repeat.resourceId, role: 'android.widget.TextView', bounds: {x: 0, y: index * 20, width: 100, height: 20}, text: 'Generated repeated title'}))});
  const repeated = extractUiPages(books, uiRulesSchema.parse([rule]), 'android');
  assert.equal(repeated.length, 2); assert.equal(repeated[0].objects[0].fields[0].values[0].text, repeated[1].objects[0].fields[0].values[0].text);
});

test('Android replay ignores retired selected-node rules and bounds repeated field values without losing field provenance', () => {
  const snapshot=uiSnapshotSchema.parse({appId:'fixture.current',appVersion:'1',activity:'',observedAt:'2026-10-24T00:00:00.000Z',truncated:false,nodes:Array.from({length:70},(_,i)=>({id:String(i),resourceId:'fixture:text',role:'android.widget.TextView',bounds:{x:0,y:i,width:1,height:1},text:`Generated ${i}`}))});
  const legacy=uiRulesSchema.parse([{id:'legacy',version:'1',platform:'android',appId:snapshot.appId,select:{resourceId:'fixture:text'}}]);
  assert.deepEqual(extractUiPages(snapshot,legacy,'android'),[]);
  const rules=uiRulesSchema.parse([{id:'current',version:'1',formatVersion:3,platform:'android',appId:snapshot.appId,appVersion:'1',kind:'visible_text',fields:{visible_text:{select:{resourceId:'fixture:text'},source:'text',cardinality:'many',required:true}}}]);
  const pages=extractUiPages(snapshot,rules,'android');
  assert.equal(pages.length,1);assert.equal(pages[0].status,'partial');assert.equal(pages[0].objects[0].fields[0].values.length,64);assert.equal(pages[0].objects[0].fields[0].values.at(-1).text,'Generated 63');
});

test('an odd remaining text budget never publishes an empty value or a split Unicode character', () => {
  const base={appId:'fixture.current',appVersion:'1',activity:'',observedAt:'2026-10-24T00:00:00.000Z',truncated:false};
  const snapshot=uiSnapshotSchema.parse({...base,nodes:[['a','', 'x'.repeat(31999)],['b','y'.repeat(32000),''],['c','','😀']].map(([id,text,description],i)=>({id,resourceId:id,text,description,role:'Text',bounds:{x:0,y:i,width:1,height:1}}))});
  const fields=Object.fromEntries(['a','b','c'].map(name=>[name,{select:{resourceId:name},source:name==='b'?'text':'description',required:name!=='c'}]));
  const rules=uiRulesSchema.parse([{id:'budget',version:'1',formatVersion:3,platform:'android',appId:base.appId,appVersion:'1',kind:'visible_text',fields}]);
  const pages=extractUiPages(snapshot,rules,'android');
  assert.equal(pages.length,1);assert.equal(pages[0].status,'partial');assert.deepEqual(pages[0].objects[0].fields.map(field=>field.name),['a','b']);
  assert.equal(pages[0].objects[0].fields.reduce((n,f)=>n+f.values[0].text.length,0),63999);
});

test('even a zero-duration activity record requires its selected duration channel', async () => {
  const {captureSchema}=await import('../dist/index.js');
  const record={id:'12345678-1234-4234-8234-123456789012',deviceId:'fixture',deviceName:'Generated',platform:'android',capturedAt:'2026-10-24T00:00:00.000Z',durationMs:0,appId:'fixture.current',appName:'Generated',source:'activity',privacy:{excluded:false,redacted:false,mode:'local',collection:'activity'},metadata:{version:1,observedAt:'2026-10-24T00:00:00.000Z',captureObservation:{id:'12345678-1234-4234-8234-123456789013',selected:{duration:false,screenshots:false,structured:true}}}};
  assert.equal(captureSchema.safeParse(record).success,false);
  record.metadata.captureObservation.selected.duration=true;
  assert.equal(captureSchema.safeParse(record).success,true);
});

test('named field limits apply per field and in total with codepoint ordering before clipping', () => {
  const bounds = {x: 0, y: 0, width: 100, height: 20};
  const snapshot = uiSnapshotSchema.parse({appId: 'dev.generated', appVersion: '1', activity: '', observedAt: '2026-10-24T00:00:00.000Z', truncated: false, nodes: [{id: 'root', resourceId: 'root', role: 'Container', text: '', bounds}, ...Array.from({length: 130}, (_, index) => ({id: String(index), parentId: 'root', childIndex: index, resourceId: 'value', role: 'Text', text: 'Generated ' + index, bounds}))]});
  const field = {select: {resourceId: 'value'}, source: 'text', cardinality: 'many'};
  const rules = uiRulesSchema.parse([{formatVersion: 3, id: 'generated.field-limits', version: '1', platform: 'android', appId: snapshot.appId, appVersion: snapshot.appVersion, kind: 'generated', region: {resourceId: 'root'}, fields: {aa: field, a_: field}}]);
  const [page] = extractUiPages(snapshot, rules, 'android');
  assert.deepEqual(page.objects[0].fields.map(field => [field.name, field.values.length]), [['a_', 64], ['aa', 64]]);
  assert.equal(page.truncated, true); assert.equal(page.status, 'partial');
  assert.equal(uiPageSchema.safeParse(page).success, true);
});

test('requested Android app upgrades retain exact version and reviewed subtree fences', () => {
  for (const [appId, currentVersion, previousVersion] of [['com.xingin.xhs', '9.51.0', '9.50.0'], ['tv.danmaku.bili', '9.16.1', '9.15.0']]) {
    const catalog = builtin.filter(rule => rule.appId === appId);
    assert.ok(catalog.length > 0);
    assert.ok(catalog.every(rule => rule.appVersion === currentVersion));
    for (const fixture of fixtures.filter(value => value.snapshot.appId === appId)) {
      const installedRule = catalog.find(rule => rule.id === fixture.rule.id);
      assert.deepEqual(installedRule, fixture.rule);
      assert.ok(installedRule.repeatSubtreeHash, 'rebinding never removes a subtree guard');
      assert.deepEqual(extractUiPages({...fixture.snapshot, appVersion: previousVersion}, uiRulesSchema.parse([installedRule]), 'android'), []);
      const changed = structuredClone(fixture.snapshot);
      changed.nodes.at(-1).role = 'dev.generated.ChangedRole';
      assert.deepEqual(extractUiPages(changed, uiRulesSchema.parse([installedRule]), 'android'), []);
    }
  }
});
