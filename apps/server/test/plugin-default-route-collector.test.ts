import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const agent={configured:false,query:async()=>{throw Error('No model in route collector fixture');},close:async()=>{}};

/** One real default host read crosses the source-owned Notes/Capture/Files
 * mounts and the selected Material domain. The collector, not a Host push,
 * supplies each route; unselected feature evidence remains covered by the
 * existing distribution and plugin-omission tests. */
test('the real default host serves one cross-domain note through the selected route collector',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-default-collector-')),token='generated-default-collector-owner';
  const options:ConfigurationPlatformOptions={path:dataDir+'/mote.yaml',privateCredential:{token,tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
  const node=await buildApp(options,{agent,backgroundWorker:false});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+token},id=randomUUID(),text='Generated cross-domain note through the selected route collector';
  const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-collector-device',deviceName:'Generated collector',platform:'android',capturedAt:'2026-10-29T01:00:00Z',text}});
  assert.equal(created.statusCode,201,created.body);
  const notes=await node.app.inject({url:'/api/notes',headers});assert.equal(notes.statusCode,200,notes.body);
  assert.ok(notes.json().items.some((item:{id:string})=>item.id===id),'the Notes feature mounts through the collector');
  const captures=await node.app.inject({url:'/api/captures?source=note',headers});assert.equal(captures.statusCode,200,captures.body);
  assert.ok(captures.json().items.some((item:{id:string})=>item.id===id),'the Capture feature sees the same original');
  const files=await node.app.inject({url:'/api/files',headers});assert.equal(files.statusCode,200,files.body);
  await node.materialOrganizer.tick(100);
  const projected=await node.app.inject({method:'POST',url:'/api/library/source-view',headers,payload:{after:'2026-10-28T00:00:00Z',before:'2026-10-30T00:00:00Z',stream:'materials',limit:20}});
  assert.equal(projected.statusCode,200,projected.body);
  assert.ok(projected.json().items.some((item:{origin:{externalId:string}})=>item.origin.externalId===id),'the Sources feature projects the same Material');
  const materials=await node.app.inject({url:'/api/materials',headers});assert.equal(materials.statusCode,200,materials.body);
  assert.ok(materials.json().items.some((item:{origin:{externalId:string}})=>item.origin.externalId===id),'the selected Material domain consumes the note original');
});
