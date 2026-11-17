import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';

test('file journey gives explicit owner consent after processing setup and before intake without widening exclusions',async t=>{
  const source=await readFile(new URL('./test-file-journey-live.ts',import.meta.url),'utf8');
  const parsed=ts.createSourceFile('test-file-journey-live.ts',source,ts.ScriptTarget.Latest,true);
  const main=parsed.statements.find(statement=>ts.isTryStatement(statement)&&
    statement.tryBlock.statements.some(item=>ts.isForOfStatement(item)&&item.expression.getText(parsed)==='manifest.files'));
  assert.ok(main);
  const intake=main.tryBlock.statements.find(item=>ts.isForOfStatement(item)&&item.expression.getText(parsed)==='manifest.files');
  const consent=main.tryBlock.statements.find(item=>ts.isExpressionStatement(item)&&item.expression.getText(parsed)==='await authorizeFixtureModels(node)');
  assert.ok(consent,'the actual public journey must consent before its original intake loop');
  const processingSetup=main.tryBlock.statements.find(item=>ts.isIfStatement(item)&&item.expression.getText(parsed)==='priorSettings');
  assert.ok(processingSetup.end<=consent.pos&&consent.end<=intake.pos,'consent follows both the processing setup and resume branch');
  assert.ok(parsed.statements.some(item=>ts.isImportDeclaration(item)&&
    item.moduleSpecifier.text==='../apps/server/test/fixtures/model-authorization.js'&&
    item.importClause?.namedBindings?.elements?.some(binding=>binding.name.text==='authorizeFixtureModels')));

  const {buildApp}=await import('../apps/server/src/app.ts');
  const {authorizeFixtureModels}=await import('../apps/server/test/fixtures/model-authorization.ts');

  const directory=await mkdtemp(join(tmpdir(),'mote-file-journey-consent-'));
  const token='generated-file-journey-owner';
  const node=await buildApp({path:join(directory,'mote.yaml'),privateCredential:{token,tokenPath:join(directory,'token')},
    initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},
      server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},
      models:{deployment:{model:'',baseUrl:'',apiKey:'',allowUnauthenticatedLocal:false},embedding:{model:'',baseUrl:'',apiKey:''}},
      diagnostics:{level:'silent'}}},{backgroundWorker:false});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
  const request=async(method,url,payload)=>{
    const response=await node.app.inject({method,url,headers:{...headers,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})},...(payload===undefined?{}:{payload})});
    assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);return response.json();
  };
  const closed=await request('GET','/api/model-authorization');
  assert.equal(closed.authorization.state,'off','a generated profile retains the closed product default');
  assert.equal((await node.app.inject({url:'/api/model-authorization'})).statusCode,401);
  await request('POST','/api/model-authorization/commands',{revision:closed.authorization.revision,operationId:randomUUID(),action:'exclude',excludedSourceIds:['generated-excluded']});
  const processing=await request('GET','/api/file-processing');
  await request('PUT','/api/file-processing',{revision:processing.revision,settings:{...processing.settings,enabled:true,summarize:false,semanticTurns:false,timeoutMs:600000},policy:processing.policy});
  const events=[],inject=node.app.inject.bind(node.app);
  t.mock.method(node.app,'inject',function(options,...args){events.push({method:options.method??'GET',url:options.url,payload:options.payload});return inject(options,...args);});
  const consented=await authorizeFixtureModels(node);
  assert.equal(consented.state,'on');assert.deepEqual(consented.excludedSourceIds,['generated-excluded']);
  await request('POST','/api/sources',{id:'generated-journey-source',name:'Generated file journey',kind:'local-files',deviceId:'generated-journey-device',platform:'import',retention:'archive'});
  const bytes=Buffer.from('Generated original intake only; no decoder or model is invoked.');
  const upload=await request('POST','/api/file-sync/v1/uploads',{sourceId:'generated-journey-source',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
    item:{externalId:'generated.wav',revision:'1',observedAt:'2026-11-17T00:00:00Z',title:'Generated original',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false}});
  await request('PUT',`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,bytes);
  const ack=await request('POST',`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,{});
  assert.equal(ack.receipt.state,'received');
  assert.deepEqual(events.slice(0,4).map(({method,url})=>[method,url]),[
    ['GET','/api/model-authorization'],['POST','/api/model-authorization/commands'],
    ['POST','/api/sources'],['POST','/api/file-sync/v1/uploads'],
  ]);
  const command=events[1].payload;
  assert.deepEqual(Object.keys(command).sort(),['action','operationId','revision']);assert.equal(command.action,'on');
  assert.match(command.operationId,/^[0-9a-f-]{36}$/);
  assert.deepEqual((await request('GET','/api/model-authorization')).authorization.excludedSourceIds,['generated-excluded']);
});
