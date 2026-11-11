import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {GitHubPluginReleases,type PluginReleaseTransport} from '../src/plugin-release.js';
import {OFFICIAL_PLUGIN_CATALOG,officialPluginCatalog} from '../src/official-plugin-catalog.js';
import type {ConnectorManifest} from '../src/connectors/registry.js';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const packageRoot=join(repoRoot,'official-plugins/notion');
const notion={repository:'mote/official-notion-connector',tag:'v0.1.0',packageId:'mote.official.notion',localDirectory:'official-plugins/notion'};
const owner='generated-notion-owner-'+randomUUID();
const secretName='GENERATED_NOTION_CLIENT_SECRET_'+randomUUID().replaceAll('-','_').toUpperCase();
const secretValue='generated-notion-client-secret-'+randomUUID();
const headers={authorization:'Bearer '+owner};
const notionHeaders={'content-type':'application/json'};

function waitFor(check:()=>boolean,description:string){
  const until=Date.now()+8000;
  return (async()=>{while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for '+description);})();
}
function rejectingGitHub(calls:string[]):PluginReleaseTransport{
  return async url=>{calls.push(url);throw new Error('GitHub transport must not be used for the in-repo official Notion package: '+url);};
}
type Call={url:string;method:string;headers:Record<string,string>;body:unknown;pathname:string};
type FakeNotion={calls:Call[];fetch:typeof fetch;setPageText:(value:string)=>void;setPageEdited:(value:string)=>void;setFailToken:(value:boolean)=>void;setFailPage:(value:boolean)=>void};

/** Generated Notion transport. It records every request so tests can prove the
 * adapter only reads and never creates, updates, deletes or appends. */
function fakeNotion():FakeNotion{
  const calls:Call[]=[];
  let pageText='First generated page body.',pageEdited='2026-11-01T00:00:00.000Z',failToken=false,failPage=false;
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const transport:typeof fetch=async(input,init={})=>{
    const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;
    const parsed=new URL(url),method=String(init.method??'GET').toUpperCase();
    const headers=Object.fromEntries(new Headers(init.headers).entries());
    const body=typeof init.body==='string'?JSON.parse(init.body) as unknown:undefined;
    calls.push({url,method,headers,body,pathname:parsed.pathname});
    if(method==='POST'&&parsed.pathname==='/v1/oauth/token'){
      return failToken?json({error:'invalid_grant'},400):json({access_token:'generated-notion-access-token',workspace_id:'generated-workspace-id',workspace_name:'Generated Notion workspace',bot_id:'generated-bot-id'});
    }
    if(method==='POST'&&parsed.pathname==='/v1/search'){
      return json({object:'list',has_more:false,results:[
        {object:'page',id:'page-1',url:'https://www.notion.so/Roadmap-1?pvs=4',last_edited_time:pageEdited,properties:{Name:{type:'title',title:[{plain_text:'Roadmap'}]}}},
        {object:'database',id:'db-1',url:'https://www.notion.so/Tasks-2',last_edited_time:'2026-11-01T00:00:00.000Z',title:[{plain_text:'Tasks'}]},
      ]});
    }
    if(method==='GET'&&parsed.pathname==='/v1/pages/page-1'){
      return failPage?json({object:'error',message:'generated failure'},500):json({object:'page',id:'page-1',url:'https://www.notion.so/Roadmap-1?pvs=4',created_time:'2026-10-01T00:00:00.000Z',last_edited_time:pageEdited,properties:{Name:{type:'title',title:[{plain_text:'Roadmap'}]}}});
    }
    if(method==='GET'&&parsed.pathname==='/v1/blocks/page-1/children'){
      return json({object:'list',has_more:false,results:[{object:'block',type:'paragraph',paragraph:{rich_text:[{plain_text:pageText}]}}]});
    }
    if(method==='POST'&&parsed.pathname==='/v1/databases/db-1/query'){
      return json({object:'list',has_more:false,results:[{object:'page',id:'entry-1',url:'https://www.notion.so/Entry-1',last_edited_time:'2026-11-02T00:00:00.000Z',properties:{Name:{type:'title',title:[{plain_text:'Row one'}]},Status:{type:'select',select:{name:'Todo'}}}}]});
    }
    return json({object:'error',message:'Unexpected generated transport request'},404);
  };
  return {
    calls,fetch:transport,
    setPageText:value=>{pageText=value;},
    setPageEdited:value=>{pageEdited=value;},
    setFailToken:value=>{failToken=value;},
    setFailPage:value=>{failPage=value;},
  };
}
function writeCalls(calls:Call[]){
  return calls.filter(call=>['PATCH','PUT','DELETE'].includes(call.method)||call.method==='POST'&&call.pathname!=='/v1/oauth/token'&&call.pathname!=='/v1/search'&&!/^\/v1\/databases\/[^/]+\/query$/.test(call.pathname));
}

test('official catalog declares Notion as a read-only in-repo service package without exposing its directory',async()=>{
  const catalog=officialPluginCatalog();
  const entry=catalog.find(value=>value.packageId===notion.packageId);
  assert.ok(entry);
  assert.equal(entry.repository,notion.repository);
  assert.equal(entry.tag,notion.tag);
  assert.equal(entry.group,'connectors');
  assert.equal(entry.runtime,'service');
  assert.equal('localDirectory' in entry,false);
  const internal=OFFICIAL_PLUGIN_CATALOG.find(value=>value.packageId===notion.packageId);
  assert.equal(internal?.localDirectory,notion.localDirectory);

  const manifest=JSON.parse(readFileSync(join(packageRoot,'mote-plugin.json'),'utf8')) as Record<string,unknown>;
  assert.equal(manifest.id,notion.packageId);
  assert.equal(manifest.runtime,'service');
  assert.equal(manifest.trust,'official');
  assert.deepEqual(manifest.capabilities,['source.connector']);
  assert.equal('actionCapabilities' in manifest,false);
  const configuration=manifest.configuration as {id:string;type:string}[];
  assert.equal(configuration.find(field=>field.id==='clientSecret')?.type,'secret-reference');
  assert.equal(configuration.some(field=>field.type==='secret-reference'),true);
  assert.equal(JSON.stringify(manifest.access).includes('read-only'),true);
  const sourceCatalog=manifest.sourceCatalog as {kinds:string[];target:{href:string}}[];
  assert.deepEqual(sourceCatalog[0]?.kinds,['mote.official.notion']);
  assert.equal(sourceCatalog[0]?.target.href,'#/connections?setup=official-notion');
  const module=await import(pathToFileURL(join(packageRoot,'plugin.mjs')).href) as {connector:ConnectorManifest&{create:unknown}};
  assert.equal(module.connector.id,'official-notion');
  assert.equal(module.connector.sourceKinds.length,1);
  const descriptor=module.connector.sourceKinds[0];
  assert.equal(typeof descriptor==='object'&&descriptor.capabilities.externalWrite,false,'the Notion source kind is read-only');
  assert.equal('executeAction' in module.connector,false,'the package declares no write action');
  assert.equal(typeof module.connector.create,'function');

  const directory=mkdtempSync(join(tmpdir(),'mote-notion-release-')),githubCalls:string[]=[];
  try{
    const releases=new GitHubPluginReleases(join(directory,'packages'),rejectingGitHub(githubCalls),repoRoot);
    await assert.rejects(releases.resolve({repository:notion.repository,tag:'v9.9.9'}),/pinned catalog release/);
    await assert.rejects(releases.resolve({repository:notion.repository}),/pinned catalog release/);
    await assert.rejects(releases.resolve({repository:'/tmp/arbitrary-notion',tag:notion.tag}));
    assert.equal(githubCalls.length,0,'the Notion identity never falls through to GitHub');
    const preview=await releases.resolve({repository:notion.repository,tag:notion.tag});
    assert.equal(JSON.stringify(preview.preview).includes(notion.localDirectory),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('official Notion install, OAuth selection and read-only archiving use the production connector host',async t=>{
  process.env[secretName]=secretValue;
  const directory=mkdtempSync(join(tmpdir(),'mote-notion-journey-'));
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
  const transport=fakeNotion();
  const node=await buildApp(config,{backgroundWorker:false,connectorTesting:{fetch:transport.fetch},agent:{configured:false,async query(){throw Error('No model request belongs in the Notion fixture');},async close(){}}});
  const githubCalls:string[]=[];
  Object.defineProperty(node.pluginCenter.releases,'transport',{value:rejectingGitHub(githubCalls)});
  t.after(async()=>{delete process.env[secretName];await node.app.close();rmSync(directory,{recursive:true,force:true});});

  let view=node.pluginCenter.view();
  assert.ok(view.catalog.some(entry=>entry.repository===notion.repository&&entry.tag===notion.tag));
  assert.equal(view.sourceContributions?.length??0,0);

  const wrongTag=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:notion.repository,tag:'v9.9.9'}});
  assert.equal(wrongTag.statusCode,422);
  const withPath=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:notion.repository,tag:notion.tag,localDirectory:notion.localDirectory}});
  assert.equal(withPath.statusCode,400);
  assert.equal(githubCalls.length,0);

  const resolved=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:notion.repository,tag:notion.tag}});
  assert.equal(resolved.statusCode,200);
  const preview=resolved.json() as {id:string;installable:boolean;source:{repository:string;tag:string;digest:string}};
  assert.equal(preview.installable,true);
  assert.equal(preview.source.repository,notion.repository);
  assert.match(preview.source.digest,/^[a-f0-9]{64}$/);
  assert.equal(resolved.body.includes(notion.localDirectory),false);

  const install=await node.app.inject({method:'POST',url:'/api/plugins/install',headers,payload:{previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(install.statusCode,200);
  await waitFor(()=>node.pluginCenter.view().packages[0]?.state==='installed','Notion install');
  view=node.pluginCenter.view();
  assert.equal(view.instances.length,0,'installation creates no default instance');
  assert.equal(view.sourceContributions?.[0]?.title,'Notion（只读）');
  assert.equal(view.sourceContributions?.[0]?.state,'installed');
  assert.equal(view.sourceContributions?.[0]?.target.href,'#/connections?setup=official-notion');
  assert.equal(transport.calls.length,0,'install, check and configuration cannot read Notion');

  const packageId=view.packages[0]!.id;
  const configured=await node.app.inject({method:'POST',url:'/api/plugin-instances',headers,payload:{packageId,name:'Notion read-only',scope:'default',configuration:{clientId:'generated-client-id',clientSecret:'${'+secretName+'}',redirectUri:'https://central.example/oauth/notion/callback'},expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(configured.statusCode,200);
  const instance=configured.json() as {id:string;revision:number;secretStatus:Record<string,boolean>};
  assert.equal(instance.secretStatus.clientSecret,true);
  const stored=node.store.db.prepare('SELECT json FROM plugin_build_instances').all().map(row=>String((row as {json:string}).json)).join('\n');
  assert.equal(stored.includes(secretValue),false,'the resolved secret is never persisted in the instance');
  assert.equal(stored.includes('${'+secretName+'}'),true,'only the opaque reference is persisted');
  assert.equal(transport.calls.length,0,'configure resolves the reference without contacting Notion');

  const check=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/check',headers,payload:{expectedRevision:instance.revision,operationId:randomUUID()}});
  assert.equal(check.statusCode,200);
  await waitFor(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','Notion check');
  assert.equal(node.pluginCenter.instanceView(instance.id).capabilities.some(value=>value.id==='source.connector'&&value.state==='verified'),true);
  assert.equal(node.sources.listSources().length,0,'checking does not authorize or read history');
  assert.equal(transport.calls.length,0);

  const checked=node.pluginCenter.instanceView(instance.id);
  const enable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:{expectedRevision:checked.revision,operationId:randomUUID()}});
  assert.equal(enable.statusCode,200);
  await waitFor(()=>{const value=node.pluginCenter.instanceView(instance.id);return value.desired&&value.observed==='ready';},'Notion enable');
  await waitFor(()=>Boolean(node.pluginCenter.view().sourceContributions?.[0]?.state==='enabled'),'Notion source contribution enabled');
  assert.equal(node.sources.listSources().length,0,'enabling is not authorization and starts no scan');
  assert.equal(transport.calls.length,0);
  assert.deepEqual(node.pluginCenter.actionProviders(),[],'the read-only package declares no write action provider');

  const started=await node.app.inject({method:'POST',url:'/api/connectors/notion/start',headers,payload:{}});
  assert.equal(started.statusCode,200);
  assert.equal((await node.app.inject({method:'POST',url:'/api/connectors/notion/start',payload:{}})).statusCode,401,'Notion owner routes reject missing owner authorization');
  assert.equal((await node.app.inject({url:'/api/connectors/notion'})).statusCode,401);
  const authorization=new URL((started.json() as {authorizationUrl:string}).authorizationUrl);
  assert.equal(authorization.origin,'https://api.notion.com');
  assert.equal(authorization.pathname,'/v1/oauth/authorize');
  assert.equal(authorization.searchParams.get('client_id'),'generated-client-id');
  assert.equal(authorization.searchParams.get('response_type'),'code');
  assert.equal(authorization.searchParams.get('redirect_uri'),'https://central.example/oauth/notion/callback');
  assert.equal(authorization.searchParams.has('scope'),false,'Notion read-only authorization requests no write scope');
  assert.equal(transport.calls.length,0,'OAuth start is local and reads no Notion content');

  const state=authorization.searchParams.get('state')!;
  assert.match(state,/^notion\./);
  const callback=await node.app.inject({url:'/oauth/notion/callback?state='+encodeURIComponent(state)+'&code=generated-code'});
  assert.equal(callback.statusCode,200);
  assert.match(callback.body,/Notion 已连接/);
  const tokenCall=transport.calls.find(call=>call.pathname==='/v1/oauth/token');
  assert.ok(tokenCall);
  assert.equal(tokenCall.headers.authorization,'Basic '+Buffer.from('generated-client-id:'+secretValue).toString('base64'));
  const status=await node.app.inject({url:'/api/connectors/notion',headers});
  assert.equal(status.statusCode,200);
  const connected=status.json() as {connected:boolean;readOnly:boolean;workspace:string;selected:unknown[]};
  assert.equal(connected.connected,true);
  assert.equal(connected.readOnly,true);
  assert.equal(connected.workspace,'Generated Notion workspace');
  assert.deepEqual(connected.selected,[]);
  assert.equal(node.sources.listSources().length,0,'authorization alone pulls no page');

  const candidates=await node.app.inject({method:'POST',url:'/api/connectors/notion/candidates',headers,payload:{}});
  assert.equal(candidates.statusCode,200);
  const listed=candidates.json() as {items:{id:string;type:string;title:string}[]};
  assert.deepEqual(listed.items.map(item=>[item.id,item.type]),[['page-1','page'],['db-1','database']]);
  assert.equal(transport.calls.some(call=>call.pathname==='/v1/pages/page-1'),false,'listing candidates does not fetch content');

  const selected=await node.app.inject({method:'POST',url:'/api/connectors/notion/select',headers,payload:{selected:[{id:'page-1',type:'page'}]}});
  assert.equal(selected.statusCode,200);
  const notionSources=()=>node.sources.listSources().filter(source=>source.kind==='mote.official.notion');
  assert.equal(notionSources().length,1);
  assert.equal(notionSources()[0]!.enabled,true);
  assert.equal(transport.calls.some(call=>call.pathname==='/v1/pages/page-1'),false,'selection alone does not pull content');
  assert.equal(transport.calls.some(call=>call.pathname==='/v1/databases/db-1/query'),false,'the unselected database is never queried');

  const firstSync=await node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});
  assert.equal(firstSync.statusCode,200);
  const sourceId=notionSources()[0]!.id;
  const first=node.sources.getItem(sourceId,'page-1');
  assert.equal(first?.title,'Roadmap');
  assert.match(first?.text??'',/First generated page body\./);
  assert.match(first?.uri??'',/^https:\/\/www\.notion\.so\//);
  assert.equal(node.sources.history(sourceId,'page-1').length,1);
  assert.equal(transport.calls.some(call=>call.pathname==='/v1/databases/db-1/query'),false,'page selection never reads the database');

  transport.setPageEdited('2026-11-03T00:00:00.000Z');
  transport.setPageText('Second generated page body.');
  const secondSync=await node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});
  assert.equal(secondSync.statusCode,200);
  const history=node.sources.history(sourceId,'page-1');
  assert.equal(history.length,2,'each changed page revision enters the source version chain');
  assert.match(history[0]!.text,/Second generated page body\./);
  assert.match(history[1]!.text,/First generated page body\./,'the prior revision is retained');

  const pageFetches=transport.calls.filter(call=>call.pathname==='/v1/pages/page-1').length;
  const switched=await node.app.inject({method:'POST',url:'/api/connectors/notion/select',headers,payload:{selected:[{id:'db-1',type:'database'}]}});
  assert.equal(switched.statusCode,200);
  assert.equal(node.sources.getSource(sourceId).enabled,false,'an unselected page source stops receiving new revisions');
  const databaseSource=notionSources().find(source=>source.id!==sourceId)!;
  assert.equal(databaseSource.enabled,true);
  const databaseSync=await node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});
  assert.equal(databaseSync.statusCode,200);
  assert.equal(transport.calls.filter(call=>call.pathname==='/v1/pages/page-1').length,pageFetches,'a disabled page is not fetched again');
  const entry=node.sources.getItem(databaseSource.id,'entry-1');
  assert.equal(entry?.title,'Row one');
  assert.match(entry?.text??'',/Status: Todo/);
  assert.equal(node.sources.history(sourceId,'page-1').length,2,'switching selection keeps archived page history');

  const beforeDisconnect=transport.calls.length;
  const disconnected=await node.app.inject({method:'POST',url:'/api/connectors/notion/disconnect',headers,payload:{}});
  assert.equal(disconnected.statusCode,200);
  assert.equal((disconnected.json() as {connected:boolean}).connected,false);
  assert.equal(notionSources().every(source=>!source.enabled),true);
  const afterDisconnect=await node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});
  assert.equal(afterDisconnect.statusCode,401);
  assert.equal(transport.calls.length,beforeDisconnect,'disconnect stops every new Notion read');
  assert.equal(node.sources.history(sourceId,'page-1').length,2,'disconnect keeps archived history');
  assert.equal(node.sources.getItem(databaseSource.id,'entry-1')?.title,'Row one');

  transport.setFailToken(true);
  const failedStart=await node.app.inject({method:'POST',url:'/api/connectors/notion/start',headers,payload:{}});
  assert.equal(failedStart.statusCode,200);
  const failedState=new URL((failedStart.json() as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!;
  const failedCallback=await node.app.inject({url:'/oauth/notion/callback?state='+encodeURIComponent(failedState)+'&code=generated-failure'});
  assert.equal(failedCallback.statusCode,400);
  assert.match(failedCallback.body,/Notion 授权未完成/);
  const failedStatus=await node.app.inject({url:'/api/connectors/notion',headers});
  assert.equal((failedStatus.json() as {connected:boolean}).connected,false,'a failed token exchange is not reported as connected');

  transport.setFailToken(false);
  const retryStart=await node.app.inject({method:'POST',url:'/api/connectors/notion/start',headers,payload:{}});
  const retryState=new URL((retryStart.json() as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!;
  assert.equal((await node.app.inject({url:'/oauth/notion/callback?state='+encodeURIComponent(retryState)+'&code=generated-retry'})).statusCode,200);
  assert.equal((await node.app.inject({method:'POST',url:'/api/connectors/notion/select',headers,payload:{selected:[{id:'page-1',type:'page'}]}})).statusCode,200);
  const beforeFailure=node.sources.history(sourceId,'page-1').length;
  transport.setFailPage(true);
  const failedSync=await node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});
  assert.equal(failedSync.statusCode,502);
  const failureStatus=await node.app.inject({url:'/api/connectors/notion',headers});
  assert.equal((failureStatus.json() as {state:string;code:string}).state,'error');
  assert.equal((failureStatus.json() as {code:string}).code,'notion_request_failed');
  assert.equal(node.sources.history(sourceId,'page-1').length,beforeFailure,'a failed read commits no new revision');
  assert.equal(writeCalls(transport.calls).length,0,'the adapter issued no Notion write request');
  assert.equal(transport.calls.some(call=>/^\/v1\/(pages|blocks)\//.test(call.pathname)&&call.method!=='GET'),false);

  transport.setFailPage(false);
  const beforeLifecycle=transport.calls.length;
  let current=node.pluginCenter.instanceView(instance.id);
  const disable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/disable',headers,payload:{expectedRevision:current.revision,operationId:randomUUID()}});
  assert.equal(disable.statusCode,200);
  await waitFor(()=>!node.pluginCenter.instanceView(instance.id).desired,'Notion disable');
  current=node.pluginCenter.instanceView(instance.id);
  const reenable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:{expectedRevision:current.revision,operationId:randomUUID()}});
  assert.equal(reenable.statusCode,200);
  await waitFor(()=>{const value=node.pluginCenter.instanceView(instance.id);return value.desired&&value.observed==='ready';},'Notion re-enable');
  const restored=await node.app.inject({url:'/api/connectors/notion',headers});
  assert.equal(restored.statusCode,200,'re-enabling remounts the owner routes');
  assert.equal((restored.json() as {connected:boolean}).connected,true,'the connector resumes its retained authorization');
  assert.equal((restored.json() as {selected:{id:string}[]}).selected[0]?.id,'page-1','the selected range is retained');
  assert.equal(transport.calls.length,beforeLifecycle,'disable and enable read no Notion content');
});
