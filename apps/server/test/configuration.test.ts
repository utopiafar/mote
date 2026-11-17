import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createServer} from 'node:http';
import {authorizeFixtureModels,withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import { randomBytes } from 'node:crypto';
import type { ServerConfiguration } from '@mote/shared';
import { buildApp, type QueryAgent } from '../src/app.js';
import { serverConfiguration, configurationUrl } from '../src/configuration.js';
import {configurationBootstrap,registerBuiltinDomains,type ConfigurationPlatformOptions} from '../src/config.js';
import {ConfigService} from '../src/config-service.js';
import {parse,stringify} from 'yaml';
import {z} from 'zod';

const inactive: QueryAgent = { configured: false, query: async () => { throw Error('No model call belongs in configuration tests'); }, close: async () => {} };
function fixture(directory:string) {
  return {
    path:join(directory,'mote.yaml'),privateCredential:{token:'synthetic-configuration-access-token',tokenPath:join(directory,'private-token')},
    initialDocument:{version:1,revision:0,
      server:{host:'0.0.0.0',port:47832,profile:'test',allowedOrigins:['https://app.example.invalid'],runtime:'docker',hostConfigFile:join(directory,'mote.env'),publicUrl:'https://mote.example.invalid',tunnelEnabled:true,tunnelProvider:'cloudflare',tunnelProtocol:'http2'},
      storage:{dataDir:join(directory,'archive'),dataKey:randomBytes(32).toString('hex'),maxExportBytes:4*1024*1024,kind:'docker-volume',source:'synthetic-private-volume-name',mount:'/data'},
      execution:{insightIntervalHours:0},models:{deployment:{model:'synthetic-model-name',baseUrl:'https://model.example.invalid/v1',apiKey:'synthetic-agent-private-key',reasoningEffort:'high',maxTokens:4096,modelRequestTimeoutMs:300000,agentTimeoutMs:300000,allowUnauthenticatedLocal:false,protocol:'deepseek'},embedding:{model:'synthetic-embedding-name',baseUrl:'https://embedding.example.invalid/v1',apiKey:'synthetic-embedding-private-key'}},
      diagnostics:{enabled:true,debug:true,directory:join(directory,'private-logs'),level:'info',maxBytes:1024*1024,maxTotalBytes:512*1024*1024,maxEntries:100},
    },
  } satisfies ConfigurationPlatformOptions;
}
function value(view:ServerConfiguration,id:string,path:string,kind:'saved'|'effective'='effective'):unknown {
  return path.split('.').reduce<unknown>((current,part)=>current&&typeof current==='object'?(current as Record<string,unknown>)[part]:undefined,view.domains.find(domain=>domain.id===id)![kind]);
}

test('configuration projection is serializable, preserves effective domains and separates host paths from container paths',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-view-')),config=fixture(directory),service=new ConfigService({...config,watch:false});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  registerBuiltinDomains(service);await service.initialize();
  const view=serverConfiguration(configurationBootstrap(service,config.privateCredential),service);
  assert.deepEqual(JSON.parse(JSON.stringify(view)),view);
  assert.equal(view.configFile,config.path);assert.equal(view.hostConfigFile,config.initialDocument.server.hostConfigFile);assert.equal(Object.hasOwn(view,'envFile'),false);assert.equal(Object.hasOwn(view,'groups'),false);
  assert.equal(view.baseDir,directory);assert.equal(view.runtime,'docker');assert.equal(view.readOnly,false);assert.equal(view.restartRequired,false);
  assert.equal(view.storage.sqlitePath,join(config.initialDocument.storage.dataDir,'mote.sqlite'));assert.equal(view.storage.assetDir,join(config.initialDocument.storage.dataDir,'files','objects'));
  assert.equal(view.storage.kind,'docker-volume');assert.equal(view.storage.source,'synthetic-private-volume-name');assert.equal(view.storage.mountPath,'/data');
  assert.equal(value(view,'storage','maxStorageBytes'),undefined);assert.equal(value(view,'storage','retentionDays'),undefined);assert.equal(value(view,'storage','maxExportBytes'),4*1024*1024);
  assert.equal(value(view,'models','deployment.modelRequestTimeoutMs'),300000);assert.equal(value(view,'models','deployment.agentTimeoutMs'),300000);assert.equal(value(view,'models','deployment.maxTokens'),4096);assert.equal(value(view,'diagnostics','traceEnabled'),false);
  assert.equal(view.ownerCredential.configured,true);assert.equal(view.ownerCredential.source,'programmatic');
  for(const [id,path] of [['models','deployment.apiKey'],['models','embedding.apiKey'],['storage','dataKey']])assert.equal(value(view,id,path),true);
  for(const secret of [config.privateCredential.token,config.initialDocument.models.deployment.apiKey,config.initialDocument.models.embedding.apiKey,config.initialDocument.storage.dataKey])assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(value(view,'server','tunnelEnabled'),true);
  const keys=view.domains.flatMap(domain=>domain.fields.map(field=>domain.id+'.'+field.path));assert.ok(keys.length>40);assert.equal(new Set(keys).size,keys.length,'Canonical field paths must remain unique for stable UI rendering');
});

test('the served configuration view exposes registered canonical domains without obsolete environment sources',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-sources-')),config=fixture(directory),{app}=await buildApp(config,{agent:inactive,backgroundWorker:false});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const response=await app.inject({url:'/api/configuration',headers:{authorization:'Bearer '+config.privateCredential.token}});assert.equal(response.statusCode,200,response.body);
  const view=response.json<ServerConfiguration>();assert.ok(view.domains.some(domain=>domain.id==='models'));assert.equal(Object.hasOwn(view,'groups'),false);
  for(const domain of view.domains){assert.ok(Object.hasOwn(domain,'saved'));assert.ok(Object.hasOwn(domain,'effective'));for(const field of domain.fields)assert.equal(Object.hasOwn(field,'envVar'),false);}
  assert.doesNotMatch(response.body,/MOTE_MODEL|environment|env-file/);
});

test('URL display strips credentials, query and fragment without turning non-HTTP paths into URLs',()=>{
  const urls={model:configurationUrl('https://url-user:url-password@model.example.invalid/v1?token=hidden-query#hidden-fragment'),embedding:configurationUrl('https://url-user:url-password@embedding.example.invalid/api?key=hidden-query#hidden-fragment'),publicUrl:configurationUrl('https://url-user:url-password@mote.example.invalid/?token=hidden-query#hidden-fragment')};
  assert.equal(urls.model,'https://model.example.invalid/v1');assert.equal(urls.embedding,'https://embedding.example.invalid/api');assert.equal(urls.publicUrl,'https://mote.example.invalid/');
  for(const secret of ['url-user','url-password','hidden-query','hidden-fragment'])assert.ok(!JSON.stringify(urls).includes(secret));
  assert.equal(configurationUrl('file:///private/credentials'),null);assert.equal(configurationUrl('not a URL'),null);
});

test('owner configuration ignores obsolete env files and support remains path/secret-free', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-configuration-owner-')), config = fixture(directory);
  const file = config.initialDocument.server.hostConfigFile; await writeFile(file, 'MOTE_MODEL=synthetic-file-value\n', { mode: 0o600 });
  const { app, diagnostics } = await buildApp(config, { agent: inactive });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${config.privateCredential.token}` };
  assert.equal((await app.inject('/api/configuration')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/configuration', headers: { authorization: 'Bearer incorrect' } })).statusCode, 401);
  const response = await app.inject({ url: '/api/configuration', headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(value(response.json(),'models','deployment.model'), config.initialDocument.models.deployment.model);
  assert.equal((await app.inject({url:'/api/status',headers})).json().agent.agentTimeoutMs,300000);
  assert.equal(app.initialConfig.requestTimeout,180000,'Model budgets do not extend HTTP request upload limits');
  assert.equal(value(response.json(),'diagnostics','level'), 'info');
  assert.equal(diagnostics.snapshot().level, diagnostics.snapshot().level);
  assert.equal(diagnostics.snapshot().level, 'debug', 'Explicit debug promotes a non-silent configured level');
  await writeFile(file, 'MOTE_MODEL=synthetic-new-value-for-next-restart\n', { mode: 0o600 });
  assert.equal(value((await app.inject({ url: '/api/configuration', headers })).json(),'models','deployment.model'), config.initialDocument.models.deployment.model);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) assert.equal((await app.inject({ method, url: '/api/configuration', headers, payload: { MOTE_DATA_DIR: '/synthetic-unapproved-path', MOTE_DATA_KEY: 'replacement' } })).statusCode, 404);
  assert.equal(await readFile(file, 'utf8'), 'MOTE_MODEL=synthetic-new-value-for-next-restart\n');
  const privateValues = [directory, config.privateCredential.token, config.initialDocument.storage.dataKey!, config.initialDocument.models.deployment.apiKey, config.initialDocument.models.embedding.apiKey, config.initialDocument.storage.source, config.initialDocument.models.deployment.baseUrl];
  for (const route of ['/api/support-bundle', '/api/diagnostics']) {
    const result = await app.inject({ url: route, headers }); assert.equal(result.statusCode, 200);
    for (const value of privateValues) assert.ok(!result.body.includes(value), `${route} must exclude owner configuration`);
  }
  await diagnostics.flush();
  for (const name of await readdir(config.initialDocument.diagnostics.directory!)) {
    const log = await readFile(join(config.initialDocument.diagnostics.directory!, name), 'utf8'); for (const value of privateValues) assert.ok(!log.includes(value));
  }
});

test('owner configuration uses the shared YAML for API edits, restart state, file reload and revision conflicts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-file-')),config=fixture(directory);
  const {app,configService}=await buildApp(config,{agent:inactive,backgroundWorker:false});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.privateCredential.token}`};
  const view=()=>app.inject({url:'/api/configuration',headers});
  const update=(id:string,value:unknown,revision:number)=>app.inject({method:'PUT',url:'/api/configuration/'+id,headers,payload:{value,revision}});
  const initial=(await view()).json<ServerConfiguration>();
  assert.equal(initial.readOnly,false);assert.equal(initial.configFile,configService.path);assert.equal(initial.lastError,null);
  assert.ok(initial.domains!.some(domain=>domain.id==='models'));
  for(const secret of [config.privateCredential.token,config.initialDocument.models.deployment.apiKey,config.initialDocument.models.embedding.apiKey,config.initialDocument.storage.dataKey!])assert.ok(!JSON.stringify(initial).includes(secret));
  assert.equal((await app.inject({method:'PUT',url:'/api/configuration/server',payload:{revision:initial.revision,value:{port:47833}}})).statusCode,401);
  assert.equal((await app.inject({method:'PUT',url:'/api/configuration/server',headers,payload:{value:{port:47833}}})).statusCode,400);
  const saved=await update('server',{port:47833},initial.revision!);assert.equal(saved.statusCode,200,saved.body);
  const savedView=saved.json<ServerConfiguration>();
  assert.equal(value(savedView,'server','port'),47832);assert.equal(value(savedView,'server','port','saved'),47833);assert.equal(savedView.domains.find(domain=>domain.id==='server')!.fields.find(field=>field.path==='port')!.effect,'restart');assert.equal(savedView.restartRequired,true);
  assert.equal((await update('execution',{agentConcurrency:2},initial.revision!)).statusCode,409);
  const execution=await update('execution',{agentConcurrency:2},savedView.revision!);assert.equal(execution.statusCode,200,execution.body);
  assert.equal((await app.inject({url:'/api/execution-settings',headers})).json().agentConcurrency,2);
  const raw=parse(await readFile(configService.path,'utf8'));assert.equal(raw.server.port,47833);assert.equal(raw.models.deployment.apiKey,config.initialDocument.models.deployment.apiKey);
  assert.equal((await update('server',{unknownSetting:'generated'},execution.json().revision)).statusCode,400);
  const reuse=await update('models',{embedding:{baseUrl:'https://replacement.example.invalid/v1'}},execution.json().revision);
  assert.equal(reuse.statusCode,409);assert.equal(reuse.json().error,'model_settings_credential_reuse');
  const deploymentReuse=await update('models',{deployment:{baseUrl:'https://replacement.example.invalid/v1'}},execution.json().revision);
  assert.equal(deploymentReuse.statusCode,409);assert.equal(deploymentReuse.json().error,'model_settings_credential_reuse');
  assert.equal((await view()).json().revision,execution.json().revision);
  raw.diagnostics.debug=false;await writeFile(configService.path,stringify(raw),{mode:0o600});await configService.reload();
  const reloaded=(await view()).json<ServerConfiguration>();assert.equal(value(reloaded,'diagnostics','debug'),false);
  assert.ok(reloaded.revision!>execution.json().revision);
  const beforeInvalid=await readFile(configService.path,'utf8');
  await writeFile(configService.path,'version: 1\nrevision: 0\nserver: [generated-invalid-secret\n',{mode:0o600});
  await assert.rejects(configService.reload());
  const invalid=await view();assert.equal(invalid.statusCode,200);assert.equal(invalid.json().lastError.code,'config_invalid');
  assert.equal(value(invalid.json(),'diagnostics','debug'),false);assert.ok(!invalid.body.includes('generated-invalid-secret'));
  await writeFile(configService.path,beforeInvalid,{mode:0o600});await configService.reload();
  assert.equal((await view()).json().lastError,null);
});

test('request bursts preserve authentication and configuration access without a request quota', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-configuration-burst-')), config = fixture(directory);
  const { app } = await buildApp(config, { agent: inactive, backgroundWorker: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${config.privateCredential.token}` };
  for (let i = 0; i < 200; i++) {
    assert.equal((await app.inject('/api/configuration')).statusCode, 401);
    assert.equal((await app.inject('/api/health')).statusCode, 200);
  }
  assert.equal((await app.inject({ url: '/api/configuration', headers })).statusCode, 200);
  for (let i = 0; i < 12; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/query', headers, payload: { question: 'Generated unconfigured model request.' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'model_not_configured');
  }
});

test('generic model editor requires a credential-reuse decision before sending saved credentials to another endpoint',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-credentials-')),config=fixture(directory);
  const {app,configService}=await buildApp(config,{agent:inactive,backgroundWorker:false});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.privateCredential.token}`},value={embedding:{baseUrl:'https://replacement.example.invalid/v1'}};
  const blocked=await app.inject({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:configService.revision,value}});
  assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error,'model_settings_credential_reuse');
  const allowed=await app.inject({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:configService.revision,value,allowCredentialReuse:true}});
  assert.equal(allowed.statusCode,200,allowed.body);assert.equal(allowed.json().restartRequired,true);
  assert.equal(parse(await readFile(configService.path,'utf8')).models.embedding.apiKey,config.initialDocument.models.embedding.apiKey);
  assert.ok(!allowed.body.includes(config.initialDocument.models.embedding.apiKey));
});


test('embedding transport and status keep the effective typed tuple until the saved restart choice is activated',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-embedding-config-')),calls:{model:string;authorization:string}[]=[];
  const provider=createServer(async(request,response)=>{let body='';for await(const chunk of request)body+=chunk.toString();calls.push({model:JSON.parse(body).model,authorization:String(request.headers.authorization??'')});response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[{embedding:[0.25,0.5,0.75]}]}));});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+(provider.address() as {port:number}).port;
  const source={...fixture(directory),watch:false};source.initialDocument.models.embedding={model:'generated-before',baseUrl:endpoint,apiKey:'generated-before-key'};
  let node:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{await node?.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  node=await buildApp(source,{agent:inactive,backgroundWorker:false});await authorizeFixtureModels(node);
  const headers={authorization:'Bearer '+source.privateCredential.token},status=async()=> (await node!.app.inject({url:'/api/status',headers})).json();
  const search=(query:string)=>withFixtureOwnerModelWork(node!,()=>node!.indexer.search({query}));
  await search('Generated before restart');assert.equal((await status()).index.model,'generated-before');
  const saved=await node.app.inject({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:node.configService.revision,value:{embedding:{model:'generated-after',apiKey:'generated-after-key'}}}});
  assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().restartRequired,true);
  assert.equal((node.configService.saved('models') as {embedding:{model:string}}).embedding.model,'generated-after');
  await search('Generated pending restart');assert.equal((await status()).index.model,'generated-before');
  await node.app.close();node=await buildApp(source,{agent:inactive,backgroundWorker:false});await authorizeFixtureModels(node);
  await search('Generated after restart');assert.equal((await status()).index.model,'generated-after');
  assert.deepEqual(calls,[{model:'generated-before',authorization:'Bearer generated-before-key'},{model:'generated-before',authorization:'Bearer generated-before-key'},{model:'generated-after',authorization:'Bearer generated-after-key'}]);
});


test('owner model generations roll back when a later configuration publication fails while the saved candidate remains visible',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-model-publication-')),source={...fixture(directory),watch:false},created:string[]=[],closed:string[]=[];
  const node=await buildApp(source,{backgroundWorker:false,createModelAgent:async settings=>{created.push(settings.model);return {configured:true,query:async()=>({answer:settings.model,citations:[],trace:[],runId:'generated-publication'}),close:async()=>{closed.push(settings.model);}};}});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  await node.configService.registerPlugin({id:'s1-publish-fault',updatePaths:['enabled'],schema:z.object({enabled:z.boolean()}),defaultValue:{enabled:false},prepare:next=>({applyOrder:2000,apply(){},publish(){if(next.enabled)throw Error('generated-private-publication-fault');},rollback(){}})});
  const headers={authorization:'Bearer '+source.privateCredential.token},query=()=>node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated publication rollback query'}});
  assert.equal((await query()).json().answer,'synthetic-model-name');
  const document=parse(await readFile(source.path,'utf8'));document.models.deployment.model='generated-rejected-candidate';document.plugins.configuration['s1-publish-fault']={enabled:true};await writeFile(source.path,stringify(document),{mode:0o600});
  await assert.rejects(node.configService.reload(),{code:'config_apply_failed'});
  assert.ok(created.includes('generated-rejected-candidate'));assert.ok(closed.includes('generated-rejected-candidate'));assert.equal(closed.includes('synthetic-model-name'),false);
  assert.equal(node.modelSettings.current().model,'synthetic-model-name');assert.equal((await query()).json().answer,'synthetic-model-name');
  const view=await node.app.inject({url:'/api/configuration',headers});assert.equal(view.statusCode,200,view.body);
  assert.equal(value(view.json(),'models','deployment.model'),'synthetic-model-name');assert.equal(value(view.json(),'models','deployment.model','saved'),'generated-rejected-candidate');
  assert.equal(view.json().lastError.code,'config_apply_failed');assert.equal(view.body.includes('generated-private-publication-fault'),false);
  assert.equal(parse(await readFile(source.path,'utf8')).models.deployment.model,'generated-rejected-candidate');
});
