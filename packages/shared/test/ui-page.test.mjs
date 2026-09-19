import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {captureSchema,uiRulesSchema,uiSnapshotSchema,extractUiPage,uiPageText,builtinUiRules} from '../dist/index.js';
const fixtures=JSON.parse(readFileSync(new URL('../../../adapters/ui/fixtures/conformance.json',import.meta.url)));
for(const f of fixtures)test(`UI adapter conformance: ${f.name}`,()=>{
 const page=extractUiPage(uiSnapshotSchema.parse(f.snapshot),uiRulesSchema.parse(f.rules),f.platform);
 assert.deepEqual(page?{status:page.status,ids:page.nodes.map(n=>n.id)}:null,f.expected);
});
const f=fixtures[0];
const page=extractUiPage(uiSnapshotSchema.parse(f.snapshot),uiRulesSchema.parse(f.rules),'android');
export const event={id:randomUUID(),deviceId:'fixture',deviceName:'Fixture',platform:'android',capturedAt:'2026-09-20T00:00:00Z',durationMs:0,source:'ui_page',appId:f.snapshot.appId,appName:'Fixture App',ocrText:uiPageText(page),privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:'2026-09-20T00:00:00Z',collector:{method:'accessibility'},uiPage:page}};
test('page protocol preserves evidence and rejects cross-source leakage',()=>{
 assert.deepEqual(captureSchema.parse(event).metadata.uiPage,page);
 for(const patch of [{source:'activity'},{source:'note'},{durationMs:100},{imageBase64:'x',imageMime:'image/png'},{ocrText:'forged'},{privacy:{...event.privacy,collection:'activity'}},{metadata:{...event.metadata,uiPage:{...page,truncated:true,status:'ok'}}}])assert.equal(captureSchema.safeParse({...event,...patch}).success,false);
});
test('rule runtime rejects action/code keys, duplicate IDs, missing selectors and invalid trees',()=>{
 for(const r of [{...f.rules[0],action:'click'},{...f.rules[0],script:'fetch()'},{...f.rules[0],select:{}}])assert.equal(uiRulesSchema.safeParse([r]).success,false);
 assert.equal(uiRulesSchema.safeParse([f.rules[0],f.rules[0]]).success,false);
 const s=structuredClone(f.snapshot);s.nodes[0].parentId='2';assert.equal(uiSnapshotSchema.safeParse(s).success,false);
 assert.deepEqual(builtinUiRules,uiRulesSchema.parse(JSON.parse(readFileSync(new URL('../../../adapters/ui/builtin.json',import.meta.url)))));
});
