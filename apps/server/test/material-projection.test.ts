import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {EvidenceReader} from '../src/evidence-reader.js';

test('model-facing material pages omit internal paths and metadata while retaining authorized coding events',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-projection-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const organizers=new MaterialOrganizerRuntime(store,materials);
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const at='2026-09-24T00:00:00.000Z';

  sources.register({id:'fixture-files',name:'Generated files',kind:'local-files',deviceId:'fixture-device',platform:'macos',retention:'snapshot'});
  await sources.upsert('fixture-files',{externalId:'file-1',revision:'v1',observedAt:at,title:'Generated file',
    text:'Generated file body',kind:'file',layer:'snapshot',uri:'file:///Users/fixture/private/generated.txt',
    document:{path:'/Users/fixture/private/generated.txt',attachments:[{path:'/Users/fixture/private/attachment.txt'}],
      originalMetadata:{apiToken:'generated-internal-token'}}});
  await organizers.tick(20);
  const file=reader.materialRead({ref:materials.get(materialId('fixture-files','file-1'))!.ref});
  assert.match(file.text,/Generated file body/);
  assert.doesNotMatch(file.text,/file:\/\/|\/Users\/fixture|generated-internal-token|originalMetadata|attachments/);
  assert.equal(file.material.fidelity.state,'derived');
  assert.deepEqual(file.material.fidelity.limitations,['metadata_projected']);

  sources.register({id:'fixture-coding',name:'Generated coding',kind:'coding-agent',deviceId:'fixture-device',platform:'macos',retention:'snapshot'});
  await sources.upsert('fixture-coding',{externalId:'coding:codex:event-1:0',revision:'v1',observedAt:at,title:'Generated event',
    text:'Generated tool call body',kind:'message',layer:'snapshot',
    document:{path:'/Users/fixture/private/session.jsonl',originalMetadata:{authToken:'generated-internal-token'},
      coding:{version:1,provider:'codex',projectKey:'fixture-project',sessionId:'fixture-session',
        cwd:'/Users/fixture/private',eventId:'event-1',role:'tool_call',callId:'call-1',part:0,parts:1}}});
  await organizers.tick(20);
  const coding=reader.materialRead({ref:materials.get(materialId('fixture-coding',JSON.stringify(['codex','fixture-project','fixture-session'])))!.ref});
  assert.match(coding.text,/Generated tool call body/);
  assert.match(coding.text,/"role":"tool_call"/);
  assert.match(coding.text,/"callId":"call-1"/);
  assert.match(coding.text,/"sessionId":"fixture-session"/);
  assert.doesNotMatch(coding.text,/\/Users\/fixture|generated-internal-token|"cwd"|originalMetadata/);
  assert.equal(coding.material.fidelity.state,'derived');
});
