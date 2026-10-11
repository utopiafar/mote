import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {parseAnswer} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('HTTP-imported maximum notes remain readable through native Ask and current correction fences',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-query-import-context-')),token='generated-context-owner';
  const prefix='These generated diary narrators are mine; quoted visitors remain separate. ',instruction=prefix+'甲'.repeat(12000-prefix.length);
  assert.equal(instruction.length,12000);
  const config:Config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://fixture.invalid',apiKey:'fixture-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  let node:Awaited<ReturnType<typeof buildApp>>,verified=0,phase:'original'|'during'|'current'='original',correctedId:string|undefined;
  node=await buildApp(config,{backgroundWorker:false,
    prepareImport:async({workspace,inputPaths})=>{
      writeFileSync(join(workspace,'records.jsonl'),[1,2].map(index=>JSON.stringify({item:{externalId:'entry-'+index,revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',title:'Generated diary '+index,text:'I planned a walk. A visitor preferred staying home.'},evidencePaths:inputPaths})).join('\n')+'\n');
      return {summary:'Generated independent diary entries'};
    },
    createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
      const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
      const bridge=await startBridge(reader,input,40);
      try{
        const call=async(tool:string,args:Record<string,unknown>={})=>{
          const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});
          return {status:response.status,body:await response.json()};
        };
        const catalog=await call('material_catalog',{limit:2});assert.equal(catalog.status,200,JSON.stringify(catalog.body));
        assert.equal(catalog.body.data.items.length,2);assert.ok(JSON.stringify(catalog.body).length<16000);
        assert.equal(JSON.stringify(catalog.body).includes(instruction),false);
        const ref=(phase==='current'?catalog.body.data.items.find((item:{id:string})=>item.id===correctedId):catalog.body.data.items[0]).ref as string;
        let text='',offset:number|null=0,expectedFingerprint:string|undefined;
        while(offset!==null){
          const result=await call('attribution_context',{ref,offset,length:12000,...(expectedFingerprint?{expectedFingerprint}:{})});
          assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(JSON.stringify(result.body).length<=16000);
          const page=result.body.data;assert.equal(page.citationAuthority,false);assert.equal(page.offset,offset);
          expectedFingerprint??=page.contextFingerprint;text+=page.text;offset=page.nextOffset;
        }
        const context=JSON.parse(text);assert.equal(context.ownerRelation,phase==='current'?'third_party':'unknown');assert.equal(context.importStatements[0].instruction,instruction);
        assert.equal(bridge.records.size,0,'declarations grant no original citation');
        const captureId=context.importDeclarations[0].captureIds[0];
        assert.throws(()=>parseAnswer(JSON.stringify({answer:`Unread [${captureId}]`,citationIds:[captureId]}),bridge.records),/not retrieved/);
        for(const length of [1,128]){
          const result=await call('material_read',{ref,length});assert.equal(result.status,200,JSON.stringify(result.body));
          assert.ok(JSON.stringify(result.body).length<=16000);assert.equal(JSON.stringify(result.body).includes(instruction),false);
        }
        verified++;
        if(phase==='during'){
          const material=node.materials.get(ref)!;
          const corrected=node.materials.correctContext(material.id,material.revision,'third_party');
          correctedId=corrected.id;
          assert.equal(node.materials.get(ref),undefined,'the corrected Material invalidates its old pin');
          assert.equal(node.materials.get(corrected.ref)?.attributionContext?.importStatements?.[0].instruction,instruction);
        }
        return {answer:'Generated context transport verified',citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies};
      }finally{await bridge.close();}
    }}),
  });
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+token};
  const created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{instruction,files:[{name:'generated.custom',dataBase64:Buffer.from('Generated independent diary fixture').toString('base64')}]}});
  assert.equal(created.statusCode,202,created.body);
  const importId=created.json().id;
  for(let i=0;i<100&&node.imports.get(importId).status!=='awaiting_confirmation';i++)await setTimeout(10);
  assert.equal(node.imports.get(importId).status,'awaiting_confirmation');
  const confirmed=await node.app.inject({method:'POST',url:'/api/imports/'+importId+'/confirm',headers});assert.equal(confirmed.statusCode,202,confirmed.body);
  for(let i=0;i<100&&node.imports.get(importId).status!=='completed';i++)await setTimeout(10);
  assert.equal(node.imports.get(importId).status,'completed');
  await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);
  const answer=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Inspect generated diary context'}});
  assert.equal(answer.statusCode,200,answer.body);assert.equal(verified,1);
  phase='during';
  const late=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Inspect generated diary context during correction'}});
  assert.equal(late.statusCode,409,late.body);assert.equal(verified,2,'correction revokes an already-reading query');
  phase='current';
  const current=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Inspect the corrected diary context'}});
  assert.equal(current.statusCode,200,current.body);assert.equal(verified,3,'a new query reads the current correction and the original import note');
});
