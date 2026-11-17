import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {GitHubPluginReleases,type PluginReleaseTransport} from '../src/plugin-release.js';
import {OFFICIAL_PLUGIN_CATALOG,officialPluginCatalog} from '../src/official-plugin-catalog.js';
import type {ConnectorManifest} from '../src/connectors/registry.js';
import {materialId} from '../src/materials.js';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const packageRoot=join(repoRoot,'official-plugins/notion');
const notion={repository:'mote/official-notion-connector',tag:'v0.1.0',packageId:'mote.official.notion',localDirectory:'official-plugins/notion'};
const owner='generated-notion-owner-'+randomUUID();
const secretName='GENERATED_NOTION_CLIENT_SECRET_'+randomUUID().replaceAll('-','_').toUpperCase();
const secretValue='generated-notion-client-secret-'+randomUUID();
const headers={authorization:'Bearer '+owner};
const notionHeaders={'content-type':'application/json'};

function waitFor(check:()=>boolean|Promise<boolean>,description:string){
  const until=Date.now()+8000;
  return (async()=>{while(Date.now()<until){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for '+description);})();
}
function rejectingGitHub(calls:string[]):PluginReleaseTransport{
  return async url=>{calls.push(url);throw new Error('GitHub transport must not be used for the in-repo official Notion package: '+url);};
}
type Call={url:string;method:string;headers:Record<string,string>;body:unknown;pathname:string};
type FakeNotion={calls:Call[];fetch:typeof fetch;setPageText:(value:string)=>void;setPageEdited:(value:string)=>void;setFailToken:(value:boolean)=>void;setFailPage:(value:boolean)=>void;setDatabaseEntries:(value:any[])=>void;setBlocks:(value:any[])=>void;setChildren:(id:string,value:any[])=>void;setQueryFailure:(value:boolean)=>void};

/** Generated Notion transport. It records every request so tests can prove the
 * adapter only reads and never creates, updates, deletes or appends. */
function fakeNotion():FakeNotion{
  const calls:Call[]=[];
  let pageText='First generated page body.',pageEdited='2026-11-01T00:00:00.000Z',failToken=false,failPage=false;
  let databaseEntries:any[]=[{object:'page',id:'entry-1',url:'https://www.notion.so/Entry-1',last_edited_time:'2026-11-02T00:00:00.000Z',properties:{Name:{type:'title',title:[{plain_text:'Row one'}]},Status:{type:'select',select:{name:'Todo'}}}}],blocks:any[]|undefined,queryFailure=false;
  const children=new Map<string,any[]>(),identified=(id:string,values:any[])=>values.map((block,index)=>({id:id+'-block-'+index,...block}));
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
    if(method==='GET'&&parsed.pathname.startsWith('/v1/pages/')){
      const entry=databaseEntries.find(value=>value.id===decodeURIComponent(parsed.pathname.slice('/v1/pages/'.length)));
      if(entry)return json(entry);
    }
    if(method==='GET'&&/^\/v1\/blocks\/[^/]+\/children$/.test(parsed.pathname)){
      const id=decodeURIComponent(parsed.pathname.split('/')[3]!),entry=databaseEntries.find(value=>value.id===id);
      const all=children.get(id)??(id==='page-1'?blocks??identified(id,[{object:'block',type:'paragraph',paragraph:{rich_text:[{plain_text:pageText}]}}]):entry?identified(id,[{object:'block',type:'paragraph',paragraph:{rich_text:[{plain_text:'Generated database body '+id}]}}]):undefined);
      if(!all)return json({object:'error',message:'Unknown generated children'},404);
      const offset=Number(parsed.searchParams.get('start_cursor')??0),results=all.slice(offset,offset+100),more=offset+results.length<all.length;
      return json({object:'list',has_more:more,next_cursor:more?String(offset+results.length):null,results});
    }
    if(method==='POST'&&parsed.pathname==='/v1/databases/db-1/query'){
      if(queryFailure)return json({code:'generated_read_failure'},503);
      const query=body as {start_cursor?:string;page_size:number;filter?:{and:{last_edited_time:{on_or_before?:string;on_or_after?:string}}[]}};
      const filters=query.filter?.and??[],all=databaseEntries.filter(entry=>filters.every(filter=>!filter.last_edited_time.on_or_before||Date.parse(entry.last_edited_time)<=Date.parse(filter.last_edited_time.on_or_before))).filter(entry=>filters.every(filter=>!filter.last_edited_time.on_or_after||Date.parse(entry.last_edited_time)>=Date.parse(filter.last_edited_time.on_or_after))).sort((a,b)=>b.last_edited_time.localeCompare(a.last_edited_time)||a.id.localeCompare(b.id));
      if(query.start_cursor&&!/^offset-\d+$/.test(query.start_cursor))return json({code:'validation_error'},400);
      const offset=Number(query.start_cursor?.slice(7)??0),results=all.slice(offset,offset+query.page_size),more=offset+results.length<all.length;
      return json({object:'list',has_more:more,next_cursor:more?'offset-'+(offset+results.length):null,results});
    }
    return json({object:'error',message:'Unexpected generated transport request'},404);
  };
  return {
    calls,fetch:transport,
    setPageText:value=>{pageText=value;},
    setPageEdited:value=>{pageEdited=value;},
    setFailToken:value=>{failToken=value;},
    setFailPage:value=>{failPage=value;},
    setDatabaseEntries:value=>{databaseEntries=value;},setBlocks:value=>{blocks=identified('page-1',value);},setChildren:(id,value)=>children.set(id,identified(id,value)),setQueryFailure:value=>{queryFailure=value;},
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
  const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:owner,tokenPath:join(directory,'owner-token')},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1024*1024},server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',baseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'},connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}}};
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
  const selectedSource=selected.json().status.selected[0];
  assert.equal(selectedSource.sourceId,notionSources()[0]!.id);
  assert.equal(selectedSource.initialSync,'all');
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


async function installedNotion(t:import('node:test').TestContext,transport=fakeNotion()){
 process.env[secretName]=secretValue;
 const directory=mkdtempSync(join(tmpdir(),'mote-notion-continuation-'));
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:owner,tokenPath:join(directory,'owner-token')},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1024*1024},server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'},connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}}};
 const boot=()=>buildApp(config,{backgroundWorker:false,connectorTesting:{fetch:transport.fetch},agent:{configured:false,async query(){throw Error('No models in Notion continuation fixture');},async close(){}}});
 let node=await boot();
 t.after(async()=>{delete process.env[secretName];await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const request=async(path:string,payload?:unknown,status=200)=>{const response=await node.app.inject({url:path,headers,...(payload!==undefined?{method:'POST' as const,payload}:{})});assert.equal(response.statusCode,status,response.body);return response.json();};
 const preview=await request('/api/plugins/resolve',{repository:notion.repository,tag:notion.tag});
 await request('/api/plugins/install',{previewId:preview.id,expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});
 await waitFor(()=>node.pluginCenter.view().packages[0]?.state==='installed','continuation package install');
 const instance=await request('/api/plugin-instances',{packageId:node.pluginCenter.view().packages[0]!.id,name:'Generated Notion continuation',scope:'default',configuration:{clientId:'generated-client-id',clientSecret:'${'+secretName+'}',redirectUri:'https://central.example/oauth/notion/callback'},expectedRevision:node.pluginCenter.view().revision,operationId:randomUUID()});
 await request('/api/plugin-instances/'+instance.id+'/check',{expectedRevision:instance.revision,operationId:randomUUID()});
 await waitFor(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','continuation check');
 await request('/api/plugin-instances/'+instance.id+'/enable',{expectedRevision:node.pluginCenter.instanceView(instance.id).revision,operationId:randomUUID()});
 await waitFor(()=>node.pluginCenter.instanceView(instance.id).desired&&node.pluginCenter.instanceView(instance.id).observed==='ready','continuation enable');
 const start=await request('/api/connectors/notion/start',{}),state=new URL(start.authorizationUrl).searchParams.get('state')!;
 const callback=await node.app.inject({url:'/oauth/notion/callback?state='+encodeURIComponent(state)+'&code=generated-code'});assert.equal(callback.statusCode,200,callback.body);
 const scan=(slot=0)=>{const row=node.store.db.prepare('SELECT json FROM plugin_instance_state WHERE key=?').get('notion.scan.'+slot);return row?JSON.parse(String(row.json)):undefined;};
 return {get node(){return node;},transport,request,scan,instanceId:instance.id,
  select:(selected:{id:string;type:'page'|'database'}[])=>request('/api/connectors/notion/select',{selected}),
  async restart(){await node.app.close();node=await boot();await waitFor(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','continuation restart');},
  async toggle(){for(const action of ['disable','enable']){await request('/api/plugin-instances/'+instance.id+'/'+action,{expectedRevision:node.pluginCenter.instanceView(instance.id).revision,operationId:randomUUID()});await waitFor(()=>action==='disable'?!node.pluginCenter.instanceView(instance.id).desired:node.pluginCenter.instanceView(instance.id).desired&&node.pluginCenter.instanceView(instance.id).observed==='ready','continuation '+action);}},
 };
}
const databaseRow=(index:number,at='2026-11-01T00:00:00.000Z',created='2026-10-01T00:00:00.000Z')=>({object:'page',id:'generated-entry-'+String(index).padStart(4,'0'),url:'https://www.notion.so/generated-'+index,created_time:created,last_edited_time:at,properties:{Name:{type:'title',title:[{plain_text:'Generated row '+index}]}}});

test('installed Notion checkpoints bounded database pages after durable upserts, replays safely and exposes idle partial coverage',async t=>{
 const f=await installedNotion(t);f.transport.setDatabaseEntries(Array.from({length:250},(_,index)=>databaseRow(index)));f.transport.setChildren(databaseRow(249).id,[{object:'block',type:'image',image:{}}]);await f.select([{id:'db-1',type:'database'}]);
 const source=f.node.sources.listSources()[0]!,sourceId=source.id;
 // Fail the checkpoint after all 100 upserts committed, as a process failure
 // between the archive and state transactions would. The prior cursor survives.
 f.node.store.db.exec("CREATE TRIGGER generated_checkpoint_failure BEFORE UPDATE ON plugin_instance_state WHEN new.key='notion.scan.0' AND json_extract(new.json,'$.processed')=100 BEGIN SELECT RAISE(ABORT,'generated checkpoint failure'); END");
 await f.request('/api/connectors/notion/sync',{},502);
 assert.equal(f.node.sources.listItems({sourceId,limit:200}).items.length,100);assert.equal(f.scan().processed,0);assert.equal(f.scan().cursor,undefined);
 const failed=f.node.sources.getSource(sourceId).status!;assert.equal(failed.coverage?.processed,0);assert.equal(failed.coverage?.remaining,null);assert.equal(failed.coverage?.failed,1);
 const window=f.scan().window,newEdited=new Date(Date.parse(window.to)+1).toISOString();
 f.transport.setDatabaseEntries([...Array.from({length:250},(_,index)=>databaseRow(index)),databaseRow(300,newEdited,newEdited)]);
 f.node.store.db.exec('DROP TRIGGER generated_checkpoint_failure');await f.restart();
 const replay=await f.request('/api/connectors/notion/sync',{});assert.equal(replay.duplicates,100);assert.equal(replay.imported,0);assert.equal(f.scan().processed,100);assert.deepEqual(f.scan().window,window);assert.equal(f.scan().cursor,'offset-100');
 let status=f.node.sources.getSource(sourceId).status!;assert.equal(status.state,'idle');assert.equal(status.coverage?.state,'partial');assert.equal(status.coverage?.remaining,null);assert.equal(status.coverage?.failed,0);assert.deepEqual(status.coverage?.limitations,['pagination_pending','content_partial']);
 f.transport.setQueryFailure(true);await f.request('/api/connectors/notion/sync',{},503);assert.equal(f.scan().cursor,'offset-100');assert.equal(f.scan().processed,100);assert.equal(f.node.sources.getSource(sourceId).status?.coverage?.failed,1,'a failed page is one unresolved read, not 100 failed entries');f.transport.setQueryFailure(false);
 await f.toggle();await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().processed,200);assert.deepEqual(f.scan().window,window);assert.equal(f.scan().cursor,'offset-200');
 await f.restart();await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().processed,250);assert.equal(f.scan().complete,true);assert.equal(f.scan().cursor,undefined);
 const first=f.node.sources.listItems({sourceId,limit:200}),second=f.node.sources.listItems({sourceId,limit:200,cursor:first.nextCursor!});assert.equal(first.items.length+second.items.length,250);assert.equal(new Set([...first.items,...second.items].map(item=>item.externalId)).size,250);
 for(const entry of [...first.items,...second.items])assert.equal(f.node.sources.history(sourceId,entry.externalId).length,1);
 const queries=f.transport.calls.filter(call=>call.pathname==='/v1/databases/db-1/query');assert.deepEqual(queries.map(call=>(call.body as any).start_cursor),[undefined,undefined,'offset-100','offset-100','offset-200']);assert.ok(queries.every(call=>(call.body as any).page_size===100));assert.ok(queries.every(call=>JSON.stringify((call.body as any).filter)===JSON.stringify((queries[0]!.body as any).filter)));
 status=f.node.sources.getSource(sourceId).status!;assert.equal(status.state,'idle');assert.equal(status.coverage?.processed,250);assert.deepEqual(status.coverage?.limitations,['content_partial']);assert.equal(status.coverage?.remaining,null,'unsupported row content is not zero remaining work');
 const ownerSources=await f.request('/api/sources'),connectorStatus=await f.request('/api/connectors/notion');assert.deepEqual(ownerSources.items[0].status.coverage,status.coverage);assert.deepEqual(connectorStatus.selected[0].coverage,status.coverage);
 const states=f.node.store.db.prepare("SELECT key,bytes FROM plugin_instance_state WHERE key='notion' OR key LIKE 'notion.scan.%'").all();assert.equal(states.length,2);assert.ok(states.every(row=>Number(row.bytes)<64*1024));
 await assertCoverageDom(f.node,sourceId);
 assert.equal(f.node.sources.getItem(sourceId,databaseRow(300).id),undefined,'an entry edited beyond the fixed query window cannot leak into its continuation');
 await f.request('/api/connectors/notion/sync',{});assert.ok(f.node.sources.getItem(sourceId,databaseRow(300).id));assert.equal(f.scan().processed,1);assert.equal(f.scan().window.from,window.to,'the next fixed window collects updates beyond the previous anchor');
});

async function assertCoverageDom(node:Awaited<ReturnType<typeof buildApp>>,sourceId:string){
 const {JSDOM}=await import('jsdom'),React=await import('react'),{createRoot}=await import('react-dom/client'),{Sources}=await import('../../web/src/plugins/sources/Sources.js'),{configureLocale}=await import('@mote/shared/i18n');configureLocale(()=> 'zh-CN');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/#/connections?sourceId='+sourceId,pretendToBeVisual:true}),previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value]of Object.entries({React,window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')!);
 const api={request:async(path:string)=>{const response=await node.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);return response.json();}} as any;
 try{await React.act(async()=>root.render(React.createElement(Sources,{api,onOpen:()=>{},onImport:()=>{}})));const d=dom.window.document;assert.equal(d.querySelector('.source-final-current')!.textContent,'等待下次同步');assert.equal(d.querySelector('.source-final-coverage')!.getAttribute('data-coverage-state'),'partial');assert.match(d.querySelector('.source-final-coverage')!.textContent!,/部分覆盖.*250.*剩余条目数未知.*部分正文尚未读取/s);}
 finally{await React.act(async()=>root.unmount());for(const [key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);dom.window.close();}
}

test('Notion selected-object slots survive reordering and never carry another range cursor or old complete coverage',async t=>{
 const f=await installedNotion(t);f.transport.setDatabaseEntries(Array.from({length:250},(_,index)=>databaseRow(index)));
 await f.select([{id:'db-1',type:'database'},{id:'page-1',type:'page'}]);await f.request('/api/connectors/notion/sync',{});
 const database=f.node.sources.listSources().find(source=>source.name==='Notion · Tasks')!,pageSource=f.node.sources.listSources().find(source=>source.name==='Notion · Roadmap')!;
 assert.equal(f.scan(0).id,'db-1');assert.equal(f.scan(0).cursor,'offset-100');assert.equal(f.scan(1).id,'page-1');assert.equal(f.node.sources.getSource(pageSource.id).status?.coverage?.state,'complete');
 const window=f.scan(0).window;await f.select([{id:'page-1',type:'page'},{id:'db-1',type:'database'}]);await f.request('/api/connectors/notion/sync',{});
 assert.equal(f.scan(0).processed,200);assert.deepEqual(f.scan(0).window,window);assert.equal(f.scan(0).cursor,'offset-200');assert.equal(f.scan(1).id,'page-1');
 f.node.sources.update(database.id,{enabled:false});const queryCount=()=>f.transport.calls.filter(call=>call.pathname==='/v1/databases/db-1/query').length,beforePause=queryCount();await f.request('/api/connectors/notion/sync',{});assert.equal(queryCount(),beforePause,'polling cannot silently re-enable an owner-paused source');assert.equal(f.scan(0).processed,200);
 await f.select([{id:'page-1',type:'page'}]);await f.select([{id:'db-1',type:'database'}]);assert.equal(f.scan(0),null);assert.equal(f.node.sources.getSource(database.id).status?.coverage,undefined);
 await f.request('/api/connectors/notion/sync',{});assert.equal((f.transport.calls.filter(call=>call.pathname==='/v1/databases/db-1/query').at(-1)!.body as any).start_cursor,undefined);assert.equal(f.scan(0).processed,100);
 await f.select([{id:'page-1',type:'page'}]);assert.equal(f.scan(0),null);assert.equal(f.node.sources.getSource(pageSource.id).status?.coverage,undefined,'a reselected page cannot retain its earlier complete claim');
 await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan(0).id,'page-1');assert.equal(f.scan(0).cursor,undefined);assert.equal(f.node.sources.getSource(pageSource.id).status?.coverage?.state,'complete');
});

test('Notion new-only databases baseline old objects and retain known revisions; single pages skip only their baseline revision',async t=>{
 const f=await installedNotion(t);f.transport.setDatabaseEntries(Array.from({length:250},(_,index)=>databaseRow(index)));await f.select([{id:'db-1',type:'database'}]);await f.request('/api/connectors/notion/sync',{});
 const database=f.node.sources.listSources()[0]!,known=f.node.sources.getItem(database.id,databaseRow(0).id)!;assert.ok(known);assert.equal(f.node.sources.getItem(database.id,databaseRow(249).id),undefined);
 const clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});
 const patch=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+database.id,headers,payload:{initialSync:'new_only'}});assert.equal(patch.statusCode,200,patch.body);assert.equal(patch.json().status.coverage,undefined);
 await f.request('/api/connectors/notion/sync',{});const anchor=f.scan().baselineAt;assert.equal(anchor,new Date(clock).toISOString());assert.equal(f.scan().processed,0);assert.equal((f.transport.calls.filter(call=>call.pathname==='/v1/databases/db-1/query').at(-1)!.body as any).start_cursor,undefined,'new history policy starts a new cursor scope');
 t.mock.timers.tick(1000);const edited=new Date(clock+1000).toISOString(),created=new Date(clock+500).toISOString();
 f.transport.setDatabaseEntries([databaseRow(0,edited),databaseRow(249,edited),databaseRow(300,edited,created)]);await f.request('/api/connectors/notion/sync',{});
 assert.equal(f.scan().processed,2);assert.equal(f.node.sources.history(database.id,databaseRow(0).id).length,2,'already collected objects retain new revisions');assert.ok(f.node.sources.getItem(database.id,databaseRow(300).id));assert.equal(f.node.sources.getItem(database.id,databaseRow(249).id),undefined,'editing an old uncollected object does not make it newly created');
 t.mock.timers.tick(1000);f.transport.setDatabaseEntries([{...databaseRow(301,new Date(clock+2000).toISOString()),created_time:undefined}]);await f.request('/api/connectors/notion/sync',{},502);assert.equal(f.node.sources.getSource(database.id).status?.coverage?.state,'partial');assert.equal(f.node.sources.getSource(database.id).status?.coverage?.failed,1,'missing baseline metadata cannot establish completion');
 await f.select([{id:'page-1',type:'page'}]);const pageSource=f.node.sources.listSources().find(source=>source.name==='Notion · Roadmap')!;
 const pagePatch=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+pageSource.id,headers,payload:{initialSync:'new_only'}});assert.equal(pagePatch.statusCode,200,pagePatch.body);
 const blocksBefore=f.transport.calls.filter(call=>call.pathname==='/v1/blocks/page-1/children').length;await f.request('/api/connectors/notion/sync',{});await f.request('/api/connectors/notion/sync',{});
 assert.equal(f.node.sources.getItem(pageSource.id,'page-1'),undefined);assert.equal(f.transport.calls.filter(call=>call.pathname==='/v1/blocks/page-1/children').length,blocksBefore,'the baseline revision is not imported or repeatedly read');
 t.mock.timers.tick(1000);f.transport.setPageEdited(new Date(clock+3000).toISOString());f.transport.setPageText('Generated content after the single-page baseline');await f.request('/api/connectors/notion/sync',{});
 assert.equal(f.node.sources.history(pageSource.id,'page-1').length,1);assert.match(f.node.sources.getItem(pageSource.id,'page-1')!.text,/after the single-page baseline/);
});

const paragraph=(value:string,id?:string)=>({...(id?{id}:{}),object:'block',type:'paragraph',paragraph:{rich_text:[{plain_text:value}]}});

async function materialBody(f:Awaited<ReturnType<typeof installedNotion>>,sourceId:string,externalId='page-1'){
 await waitFor(async()=>{await f.node.materialOrganizer.tick(1000);const record=f.node.materials.get(materialId(sourceId,externalId)),head=f.node.sources.getItem(sourceId,externalId);return Boolean(record&&record.coverage.reason!=='source_evidence_changed'&&f.node.materials.members(record.ref).items.some(member=>member.ref==='capture:'+head?.captureId));},'current Notion Material');
 const id=materialId(sourceId,externalId),record=await f.request('/api/materials/'+id),read=await f.request('/api/materials/'+id+'/read?length=12000');
 assert.equal(read.material.ref,record.ref);assert.deepEqual(read.material.coverage,record.coverage);
 const model=await f.request('/api/agent-view/material-read?ref='+encodeURIComponent(record.ref)+'&length=4000');assert.deepEqual(model.material.coverage,record.coverage);
 return {id,record,read,model};
}

test('Notion retains its new-only anchor when a crash leaves a durable scan before any status report',async t=>{
 const f=await installedNotion(t);f.transport.setDatabaseEntries([]);await f.select([{id:'db-1',type:'database'}]);const source=f.node.sources.listSources()[0]!,clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});const patch=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers,payload:{initialSync:'new_only'}});assert.equal(patch.statusCode,200,patch.body);
 t.mock.method(f.node.sources,'reportStatus',()=>{throw Error('Generated stop before status acknowledgement');});await f.request('/api/connectors/notion/sync',{},502);const anchor=f.scan().baselineAt,window=f.scan().window;assert.equal(anchor,new Date(clock).toISOString());assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);
 t.mock.timers.tick(1000);const at=new Date(clock+500).toISOString();f.transport.setDatabaseEntries([databaseRow(400,at,at)]);await f.restart();await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().baselineAt,anchor);assert.deepEqual(f.scan().window,window);assert.equal(f.scan().processed,0);await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().baselineAt,anchor);assert.equal(f.scan().processed,1);assert.ok(f.node.sources.getItem(source.id,databaseRow(400).id),'a new object between the saved anchor and restart must not fall behind a replacement baseline');
});

test('Notion page bodies resume after the 200-block and 100000-character budgets and publish truthful searchable Materials',async t=>{
 const f=await installedNotion(t);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;
 f.transport.setBlocks(Array.from({length:250},(_,index)=>paragraph('Generated bounded block '+index)));await f.request('/api/connectors/notion/sync',{});
 let coverage=f.node.sources.getSource(source.id).status?.coverage;assert.equal(coverage?.state,'partial');assert.equal(coverage?.remaining,null);assert.deepEqual(coverage?.limitations,['content_partial']);assert.equal(f.transport.calls.filter(call=>call.pathname==='/v1/blocks/page-1/children').length,2,'the existing two-page block budget is retained');assert.ok(!f.node.sources.getItem(source.id,'page-1')!.text.includes('block 200'));assert.equal(f.scan().processed,0,'a retained prefix is not an additional processed page');
 const partial=await materialBody(f,source.id);assert.equal(partial.record.coverage.state,'partial');assert.equal(partial.record.coverage.reason,'source_body_pagination_pending');assert.equal(partial.record.memorySource.status,'waiting');assert.equal(f.node.materials.input(partial.record.ref,['material'])?.ready,false);assert.match(partial.read.text,/Generated bounded block 0/);
 const prefixSearch=await f.request('/api/materials?query='+encodeURIComponent('Generated bounded block 199'));assert.equal(prefixSearch.items[0].coverage.state,'partial');assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated bounded block 249'))).items.length,0);
 assert.ok(JSON.stringify(f.scan()).length<60000);assert.ok(!JSON.stringify(f.scan()).includes('Generated bounded block'),'state contains positions and a prefix hash, not document text');
 const window=f.scan().window;await f.restart();await f.request('/api/connectors/notion/sync',{});assert.deepEqual(f.scan().window,window);assert.equal(f.scan().processed,1);assert.equal(f.scan().complete,true);assert.equal(f.scan().body,undefined);
 let item=f.node.sources.getItem(source.id,'page-1')!;assert.match(item.text,/block 199\nGenerated bounded block 200/);assert.ok(item.text.endsWith('Generated bounded block 249'));assert.deepEqual(item.document?.bodyCoverage,{state:'complete'});
 const complete=await materialBody(f,source.id);assert.equal(complete.record.coverage.state,'complete');assert.equal(complete.record.memorySource.status,'ready');assert.equal(f.node.materials.input(complete.record.ref,['material'])?.ready,true);assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated bounded block 249'))).items[0].id,complete.id);
 f.transport.setPageEdited('2026-11-03T00:00:00.000Z');f.transport.setBlocks([{object:'block',type:'child_page',child_page:{title:'Generated unselected child page'}}]);await f.request('/api/connectors/notion/sync',{});coverage=f.node.sources.getSource(source.id).status?.coverage;assert.equal(coverage?.state,'partial');assert.deepEqual(coverage?.limitations,['content_partial']);assert.equal((await materialBody(f,source.id)).record.coverage.reason,'source_body_unsupported_content','unread child pages are not claimed as complete block text');
 f.transport.setPageEdited('2026-11-04T00:00:00.000Z');f.transport.setBlocks(Array.from({length:100},()=>paragraph('x'.repeat(1200))));await f.request('/api/connectors/notion/sync',{});assert.equal(f.node.sources.getItem(source.id,'page-1')!.text.length,100000);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');assert.ok(f.scan().body.stack[0].textOffset>0,'a long block retains its exact character position');
 await f.restart();await f.request('/api/connectors/notion/sync',{});item=f.node.sources.getItem(source.id,'page-1')!;assert.equal(item.text,'Name: Roadmap\n'+Array.from({length:100},()=> 'x'.repeat(1200)).join('\n'));assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');assert.equal(item.document?.fileIndex,undefined,'unknown full text length is never fabricated as a file index');assert.equal(f.scan().processed,1);
 const textMaterial=await materialBody(f,source.id),tail=await f.request('/api/materials/'+textMaterial.id+'/read?offset=119900&length=1000');assert.match(tail.text,/x{100}/);assert.equal(tail.material.coverage.state,'complete','the actual material reader retains text beyond the former cap');
});

test('Notion character continuation preserves a Unicode pair crossing the single-round text boundary',async t=>{
 const f=await installedNotion(t);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!,content='z'+'😀'.repeat(60000)+' Generated Unicode tail';f.transport.setBlocks([paragraph(content)]);await f.request('/api/connectors/notion/sync',{});const prefix=f.node.sources.getItem(source.id,'page-1')!;assert.equal(prefix.text.length,99999);assert.ok(Buffer.byteLength(prefix.text)>prefix.text.length,'ingest retains the UTF-8 bytes rather than treating the character budget as a byte cap');assert.equal(/[\uD800-\uDBFF]$/.test(prefix.text),false);assert.equal(f.scan().body.prefix.hash,createHash('sha256').update(prefix.text).digest('hex'));assert.equal(f.scan().processed,0);
 await f.restart();await f.request('/api/connectors/notion/sync',{});assert.equal(f.node.sources.getItem(source.id,'page-1')!.text,'Name: Roadmap\n'+content);assert.equal(f.scan().processed,1);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');const material=await materialBody(f,source.id);assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated Unicode tail'))).items[0].id,material.id);
});

test('Notion durable DFS keeps parent, deep child and sibling order across rounds and restarts',async t=>{
 const f=await installedNotion(t);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;
 f.transport.setBlocks([...Array.from({length:180},(_,index)=>paragraph('Generated prefix '+index)),{id:'deep-0',object:'block',type:'toggle',has_children:true,toggle:{rich_text:[{plain_text:'Generated parent 0'}]}},paragraph('Generated final root sibling')]);
 for(let depth=0;depth<25;depth++)f.transport.setChildren('deep-'+depth,depth===24?[paragraph('Generated deepest tail')]:[{id:'deep-'+(depth+1),object:'block',type:'toggle',has_children:true,toggle:{rich_text:[{plain_text:'Generated parent '+(depth+1)}]}},paragraph('Generated child sibling '+depth)]);
 await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().processed,0);assert.ok(f.scan().body.stack.length>10);assert.ok(!f.node.sources.getItem(source.id,'page-1')!.text.includes('Generated deepest tail'));
 const position=f.scan().body,window=f.scan().window;await f.restart();assert.deepEqual(f.scan().body,position);await f.request('/api/connectors/notion/sync',{});assert.deepEqual(f.scan().window,window);
 const body=f.node.sources.getItem(source.id,'page-1')!.text;assert.equal(f.scan().processed,1);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');assert.match(body,/Generated parent 24\nGenerated deepest tail\nGenerated child sibling 23/);assert.ok(body.endsWith('Generated child sibling 0\nGenerated final root sibling'));assert.equal(body.split('Generated deepest tail').length,2,'replayed ancestors do not duplicate descendants');
 const material=await materialBody(f,source.id);assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated deepest tail'))).items[0].id,material.id);
});

test('Notion empty terminal pages publish a coverage-only revision and replay an archived completion after checkpoint failure',async t=>{
 const transport=fakeNotion(),delegate=transport.fetch;
 transport.setBlocks(Array.from({length:200},(_,index)=>paragraph('Generated empty-terminal body '+index)));
 transport.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url),response=await delegate(input,init);if(url.pathname==='/v1/blocks/page-1/children'&&url.searchParams.get('start_cursor')==='100'){const body=await response.json() as any;return new Response(JSON.stringify({...body,has_more:true,next_cursor:'200'}),{headers:notionHeaders});}return response;};
 const f=await installedNotion(t,transport);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;await f.request('/api/connectors/notion/sync',{});
 const partial=f.node.sources.getItem(source.id,'page-1')!,position=f.scan().body;assert.equal(partial.document?.bodyCoverage?.state,'partial');assert.equal(f.scan().processed,0);
 f.node.store.db.exec("CREATE TRIGGER generated_terminal_checkpoint_failure BEFORE UPDATE ON plugin_instance_state WHEN new.key='notion.scan.0' AND json_extract(new.json,'$.processed')=1 BEGIN SELECT RAISE(ABORT,'generated terminal checkpoint failure'); END");
 await f.request('/api/connectors/notion/sync',{},502);const complete=f.node.sources.getItem(source.id,'page-1')!;assert.equal(complete.text,partial.text);assert.notEqual(complete.revision,partial.revision);assert.deepEqual(complete.document?.bodyCoverage,{state:'complete'});assert.equal(f.node.sources.history(source.id,'page-1').length,2);assert.deepEqual(f.scan().body,position);assert.equal(f.scan().processed,0);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');
 f.node.store.db.exec('DROP TRIGGER generated_terminal_checkpoint_failure');await f.restart();const replay=await f.request('/api/connectors/notion/sync',{});assert.equal(replay.duplicates,1);assert.equal(replay.imported,0);assert.equal(f.scan().processed,1);assert.equal(f.scan().complete,true);assert.equal(f.node.sources.history(source.id,'page-1').length,2);assert.equal(f.node.sources.getItem(source.id,'page-1')!.captureId,complete.captureId);assert.equal((await materialBody(f,source.id)).record.coverage.state,'complete');
});

test('Notion body failures preserve the prefix and cursor; an invalid cursor rebuilds without dropping or duplicating the tail',async t=>{
 const transport=fakeNotion(),delegate=transport.fetch;let failure=0;
 transport.setBlocks(Array.from({length:250},(_,index)=>paragraph('Generated recoverable body '+index)));
 transport.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);if(failure&&url.pathname==='/v1/blocks/page-1/children'&&url.searchParams.get('start_cursor')==='100')return new Response(JSON.stringify({error:'generated body read failure'}),{status:failure,headers:notionHeaders});return delegate(input,init);};
 const f=await installedNotion(t,transport);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;await f.request('/api/connectors/notion/sync',{});const position=f.scan().body,prefix=f.node.sources.getItem(source.id,'page-1')!;
 failure=503;await f.request('/api/connectors/notion/sync',{},503);assert.deepEqual(f.scan().body,position);assert.equal(f.scan().processed,0);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.failed,1);assert.equal(f.node.sources.getItem(source.id,'page-1')!.captureId,prefix.captureId);assert.equal((await materialBody(f,source.id)).record.coverage.state,'partial');
 failure=400;await f.restart();await f.request('/api/connectors/notion/sync',{},409);assert.equal(f.scan().body,undefined);assert.equal(f.scan().processed,0);assert.equal(f.scan().complete,false);assert.equal(f.node.sources.getItem(source.id,'page-1')!.captureId,prefix.captureId);
 failure=0;const replay=await f.request('/api/connectors/notion/sync',{});assert.equal(replay.duplicates,1);assert.equal(f.scan().processed,0);await f.request('/api/connectors/notion/sync',{});const final=f.node.sources.getItem(source.id,'page-1')!;assert.ok(final.text.endsWith('Generated recoverable body 249'));assert.equal(final.text.split('Generated recoverable body 199').length,2);assert.equal(f.node.sources.history(source.id,'page-1').length,2);assert.equal(f.scan().processed,1);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');
});

test('Notion changed revisions start a fresh body instead of appending an old cursor outside the fixed window',async t=>{
 const f=await installedNotion(t);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;
 f.transport.setBlocks(Array.from({length:250},(_,index)=>paragraph('Generated old revision '+index)));await f.request('/api/connectors/notion/sync',{});const window=f.scan().window,edited=new Date(Date.parse(window.to)+1000).toISOString();
 f.transport.setPageEdited(edited);f.transport.setBlocks(Array.from({length:250},(_,index)=>paragraph('Generated replacement revision '+index)));await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().complete,true);assert.equal(f.scan().body,undefined);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');assert.ok(!f.node.sources.getItem(source.id,'page-1')!.text.includes('replacement'));
 t.mock.timers.enable({apis:['Date'],now:Date.parse(edited)+1000});await f.request('/api/connectors/notion/sync',{});const prefix=f.node.sources.getItem(source.id,'page-1')!;assert.ok(prefix.text.includes('Generated replacement revision 0'));assert.ok(!prefix.text.includes('Generated old revision'));assert.equal(f.scan().body.stack[0].cursor,'100');assert.equal(f.scan().processed,0);await f.restart();await f.request('/api/connectors/notion/sync',{});const final=f.node.sources.getItem(source.id,'page-1')!;assert.ok(final.text.endsWith('Generated replacement revision 249'));assert.equal(final.text.includes('Generated old revision'),false);assert.equal(f.scan().processed,1);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');
});

test('a database row revised outside a pending body window cannot turn an empty requery into full coverage',async t=>{
 const f=await installedNotion(t);f.transport.setDatabaseEntries([databaseRow(0)]);f.transport.setChildren(databaseRow(0).id,Array.from({length:250},(_,index)=>paragraph('Generated database old body '+index)));await f.select([{id:'db-1',type:'database'}]);const source=f.node.sources.listSources()[0]!;await f.request('/api/connectors/notion/sync',{});const window=f.scan().window,edited=new Date(Date.parse(window.to)+1000).toISOString();
 f.transport.setDatabaseEntries([databaseRow(0,edited)]);f.transport.setChildren(databaseRow(0).id,Array.from({length:250},(_,index)=>paragraph('Generated database new body '+index)));await f.request('/api/connectors/notion/sync',{},409);assert.equal(f.scan().body,undefined);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().complete,true);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial','the query bound is not an external historical snapshot');assert.equal(f.scan().processed,0);assert.ok(!f.node.sources.getItem(source.id,databaseRow(0).id)!.text.includes('new body'));
 t.mock.timers.enable({apis:['Date'],now:Date.parse(edited)+1000});await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().processed,0);assert.ok(!f.node.sources.getItem(source.id,databaseRow(0).id)!.text.includes('old body'));await f.restart();await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().processed,1);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');assert.ok(f.node.sources.getItem(source.id,databaseRow(0).id)!.text.endsWith('Generated database new body 249'));assert.equal((await materialBody(f,source.id,databaseRow(0).id)).record.coverage.state,'complete');
});

test('Notion database properties and a multi-round row body share one identity and one processed entry',async t=>{
 const f=await installedNotion(t);f.transport.setDatabaseEntries([databaseRow(0),databaseRow(1)]);f.transport.setChildren(databaseRow(0).id,Array.from({length:250},(_,index)=>paragraph('Generated first row body '+index)));await f.select([{id:'db-1',type:'database'}]);const source=f.node.sources.listSources()[0]!;
 await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().rowIndex,0);assert.equal(f.scan().processed,0);assert.equal(f.scan().body.id,databaseRow(0).id);assert.equal(f.node.sources.getItem(source.id,databaseRow(1).id),undefined);const prefix=f.node.sources.getItem(source.id,databaseRow(0).id)!;assert.match(prefix.text,/Name: Generated row 0/);assert.match(prefix.text,/Generated first row body 199/);assert.equal(prefix.document?.bodyCoverage?.state,'partial');
 await f.restart();await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().processed,2);assert.equal(f.scan().complete,true);assert.equal(f.scan().rowIndex,undefined);assert.equal(f.node.sources.listItems({sourceId:source.id}).items.length,2);assert.equal(f.node.sources.history(source.id,databaseRow(0).id).length,2);assert.equal(f.node.sources.history(source.id,databaseRow(1).id).length,1);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');assert.ok(f.node.sources.getItem(source.id,databaseRow(0).id)!.text.endsWith('Generated first row body 249'));const material=await materialBody(f,source.id,databaseRow(0).id);assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated first row body 249'))).items[0].id,material.id);
});

test('Notion rejects repeated blocks, ancestor cycles and cursor cycles instead of claiming complete coverage',async t=>{
 for(const kind of ['duplicate','ancestor','cursor'] as const)await t.test(kind,async sub=>{
  const transport=fakeNotion(),delegate=transport.fetch;
  if(kind==='duplicate')transport.setBlocks([paragraph('Generated duplicate one','same-block'),paragraph('Generated duplicate two','same-block')]);
  if(kind==='ancestor'){transport.setBlocks([{id:'nested-cycle',object:'block',type:'toggle',has_children:true,toggle:{rich_text:[]}}]);transport.setChildren('nested-cycle',[{id:'page-1',object:'block',type:'toggle',has_children:true,toggle:{rich_text:[]}}]);}
  if(kind==='cursor')transport.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);if(url.pathname==='/v1/blocks/page-1/children'){const cursor=url.searchParams.get('start_cursor');return new Response(JSON.stringify({results:[paragraph('Generated cursor '+cursor,'cursor-block-'+cursor)],has_more:true,next_cursor:cursor==='loop-a'?'loop-b':'loop-a'}),{headers:notionHeaders});}return delegate(input,init);};
  const f=await installedNotion(sub,transport);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;await f.request('/api/connectors/notion/sync',{},502);assert.equal(f.node.sources.getItem(source.id,'page-1'),undefined);assert.equal(f.scan().processed,0);assert.equal(f.scan().complete,false);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.failed,1);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');
 });
});

test('a properties-only persisted database checkpoint rebuilds unread historical bodies without replacing selection or authorization',async t=>{
 const f=await installedNotion(t);f.transport.setDatabaseEntries(Array.from({length:250},(_,index)=>databaseRow(index)));await f.select([{id:'db-1',type:'database'}]);const source=f.node.sources.listSources()[0]!,to=new Date().toISOString();
 // #972's persisted producer shape: all 250 properties snapshots are durable,
 // enumeration complete, bodies explicitly partial, no body continuation.
 for(let index=0;index<250;index++){const row=databaseRow(index),title='Generated row '+index,content='Name: '+title,uri=row.url,modifiedAt=row.last_edited_time;await f.node.sources.upsert(source.id,{externalId:row.id,revision:createHash('sha256').update(JSON.stringify({id:row.id,title,content,uri,modifiedAt})).digest('hex'),observedAt:to,modifiedAt,title,text:content,kind:'file',layer:'snapshot',mimeType:'text/markdown',uri,metadata:{version:1,provider:{updatedAt:modifiedAt}}});}
 const stateRow=f.node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key='notion'").get()!,doc=JSON.parse(String(stateRow.json)),selected=doc.selected[0],scope=createHash('sha256').update(JSON.stringify([doc.token.workspaceId,doc.token.botId,doc.token.connectedAt,selected.id,selected.type,selected.selection,'all',source.syncScopeVersion??0])).digest('hex'),scan={version:1,id:'db-1',type:'database',scope,mode:'all',window:{to},processed:250,failed:0,complete:true,contentPartial:true},json=JSON.stringify(scan);
 f.node.store.db.prepare("INSERT INTO plugin_instance_state(package_id,installation_id,instance_id,key,json,bytes,revision,updated_at) SELECT package_id,installation_id,instance_id,'notion.scan.0',?,?,1,? FROM plugin_instance_state WHERE key='notion'").run(json,Buffer.byteLength(json),to);f.node.sources.reportStatus(source.id,{state:'idle',coverage:{state:'partial',window:{to},processed:250,remaining:null,failed:0,limitations:['content_partial'],updatedAt:to}});
 const authorizationCalls=f.transport.calls.filter(call=>call.pathname==='/v1/oauth/token').length;await f.restart();assert.equal(f.scan().processed,250);assert.equal(f.scan().bodyFormat,undefined);
 await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().processed,100);assert.equal(f.scan().cursor,'offset-100');assert.deepEqual(f.scan().window,{to});assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');await f.restart();await f.request('/api/connectors/notion/sync',{});await f.request('/api/connectors/notion/sync',{});
 assert.equal(f.scan().processed,250);assert.equal(f.scan().complete,true);assert.deepEqual(f.scan().window,{to});assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'complete');const first=f.node.sources.listItems({sourceId:source.id,limit:200}),second=f.node.sources.listItems({sourceId:source.id,limit:200,cursor:first.nextCursor!});assert.equal(first.items.length+second.items.length,250);for(const item of [...first.items,...second.items]){assert.match(item.text,/Generated database body/);assert.equal(f.node.sources.history(source.id,item.externalId).length,2,'the old properties revision remains beside one body revision');assert.deepEqual(item.document?.bodyCoverage,{state:'complete'});}
 assert.equal(f.transport.calls.filter(call=>call.pathname==='/v1/oauth/token').length,authorizationCalls,'body backfill reuses the retained authorization');assert.equal(JSON.parse(String(f.node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key='notion'").get()!.json)).selected[0].selection,selected.selection);const material=await materialBody(f,source.id,databaseRow(249).id);assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated database body '+databaseRow(249).id))).items[0].id,material.id);for(let index=0;index<250;index++)assert.deepEqual(f.node.materials.get(materialId(source.id,databaseRow(index).id))?.coverage,{state:'complete'},'every backfilled current Material has the new body coverage');
});

for(const mode of ['new_only','aba'] as const)for(const outcome of ['success','error'] as const)test(`owner ${mode} change fences a suspended Notion page ${outcome} without old coverage recovery`,async t=>{
 const transport=fakeNotion(),delegate=transport.fetch;let armed=false,enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 transport.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;if(armed&&new URL(url).pathname==='/v1/blocks/page-1/children'){armed=false;enter();await gate;if(outcome==='error')return new Response(JSON.stringify({error:'generated delayed read failure'}),{status:500,headers:notionHeaders});}return delegate(input,init);};
 let running:ReturnType<Awaited<ReturnType<typeof buildApp>>['app']['inject']>|undefined;
 try{
  const f=await installedNotion(t,transport);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!,version=source.syncScopeVersion??0;
  armed=true;running=f.node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});await entered;const checkpoint=f.scan();
  for(const initialSync of mode==='aba'?['new_only','all']:['new_only']){const response=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers,payload:{initialSync}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status.coverage,undefined);}
  const configured=f.node.sources.getSource(source.id);assert.ok((configured.syncScopeVersion??0)>version);assert.equal(configured.initialSync,mode==='aba'?'all':'new_only');
  release();const response=await running;assert.equal(response.statusCode,409,response.body);
  const current=(await f.request('/api/sources')).items.find((value:any)=>value.id===source.id);assert.equal(current.status?.coverage,undefined,'neither success nor catch may restore an old range coverage');assert.equal(f.node.sources.getItem(source.id,'page-1'),undefined,'old all-history work cannot archive after a new mode takes effect');assert.deepEqual(f.scan(),checkpoint,'the old generation cannot advance or fail its checkpoint after reconfiguration');
  await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().mode,mode==='aba'?'all':'new_only');assert.equal(Boolean(f.node.sources.getItem(source.id,'page-1')),mode==='aba','the next scan follows the effective policy');
 }finally{release();await running?.catch(()=>{});}
});

test('an owner mode ABA fences Notion upserts queued behind an earlier source write and preserves archived history',async t=>{
 const f=await installedNotion(t);await f.select([{id:'page-1',type:'page'}]);await f.request('/api/connectors/notion/sync',{});
 const source=f.node.sources.listSources()[0]!,prior=f.node.sources.getItem(source.id,'page-1')!,version=source.syncScopeVersion??0;
 const {captureId,sourceId,receivedAt,current,...item}=prior;let entered!:()=>void,release!:()=>void,queued!:()=>void,hold=true;
 const gate=new Promise<void>(resolve=>release=resolve),preparing=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>queued=resolve),prepare=f.node.store.prepare.bind(f.node.store),upsert=f.node.sources.upsert.bind(f.node.sources);
 t.mock.method(f.node.store,'prepare',async(raw:unknown)=>{if(hold){hold=false;entered();await gate;}return prepare(raw);});
 const blocker=upsert(source.id,item,()=>{f.node.sources.assertSyncScope(source.id,version);}).then(()=>{throw Error('Old queued source write should be rejected');},error=>assert.equal(error.statusCode,409));
 let running:ReturnType<typeof f.node.app.inject>|undefined;
 try{
  await preparing;f.transport.setPageEdited('2026-11-04T00:00:00.000Z');f.transport.setPageText('Generated late replacement that must stay unarchived');
  t.mock.method(f.node.sources,'upsert',(...args:Parameters<typeof upsert>)=>{queued();return upsert(...args);});
  running=f.node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});await waiting;const checkpoint=f.scan();
  for(const initialSync of ['new_only','all']){const response=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers,payload:{initialSync}});assert.equal(response.statusCode,200,response.body);}
  release();await blocker;const response=await running;assert.equal(response.statusCode,409,response.body);assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);
  assert.equal(f.node.sources.history(source.id,'page-1').length,1);assert.equal(f.node.sources.getItem(source.id,'page-1')?.captureId,prior.captureId,'history committed before the range change remains intact');
 }finally{release();await blocker;await running?.catch(()=>{});}
});

for(const outcome of ['success','error'] as const)test(`owner ABA fences a resumed Notion body ${outcome} while retaining its already archived prefix`,async t=>{
 const transport=fakeNotion(),delegate=transport.fetch;let armed=false,enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 transport.setBlocks(Array.from({length:250},(_,index)=>paragraph('Generated scoped continuation '+index)));
 transport.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);if(armed&&url.pathname==='/v1/blocks/page-1/children'&&url.searchParams.has('start_cursor')){armed=false;enter();await gate;if(outcome==='error')return new Response(JSON.stringify({error:'generated late body failure'}),{status:500,headers:notionHeaders});}return delegate(input,init);};
 let running:ReturnType<Awaited<ReturnType<typeof buildApp>>['app']['inject']>|undefined;
 try{const f=await installedNotion(t,transport);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;await f.request('/api/connectors/notion/sync',{});const prefix=f.node.sources.getItem(source.id,'page-1')!,checkpoint=f.scan();armed=true;running=f.node.app.inject({method:'POST',url:'/api/connectors/notion/sync',headers,payload:{}});await entered;
  for(const initialSync of ['new_only','all']){const response=await f.node.app.inject({method:'PATCH',url:'/api/sources/'+source.id,headers,payload:{initialSync}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status.coverage,undefined);}
  release();const response=await running;assert.equal(response.statusCode,409,response.body);assert.deepEqual(f.scan(),checkpoint);assert.equal(f.node.sources.getSource(source.id).status?.coverage,undefined);assert.equal(f.node.sources.getItem(source.id,'page-1')!.captureId,prefix.captureId);assert.equal(f.node.sources.history(source.id,'page-1').length,1);assert.ok(!prefix.text.includes('Generated scoped continuation 249'));
 }finally{release();await running?.catch(()=>{});}
});

test('the real SourceStore validates body coverage reasons before archiving provider declarations',async t=>{
 const f=await installedNotion(t);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!,entry={externalId:'generated-contract',revision:'generated-revision',observedAt:new Date().toISOString(),kind:'file',layer:'snapshot',text:'Generated contract body'};
 for(const bodyCoverage of [{state:'partial'},{state:'complete',reason:'pagination_pending'},{state:'partial',reason:'invented'}, {state:'complete',totalCharacters:0}])await assert.rejects(f.node.sources.upsert(source.id,{...entry,document:{bodyCoverage}}));
 assert.equal(f.node.sources.getItem(source.id,entry.externalId),undefined);await f.node.sources.upsert(source.id,{...entry,document:{bodyCoverage:{state:'partial',reason:'pagination_pending'}}});const material=await materialBody(f,source.id,entry.externalId);assert.equal(material.record.coverage.state,'partial');assert.equal(material.model.material.coverage.reason,'source_body_pagination_pending');
});

test('a queued selection applies after a legal earlier scan rather than invalidating it before the selection takes effect',async t=>{
 const transport=fakeNotion(),delegate=transport.fetch;let armed=false,enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
 transport.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;if(armed&&new URL(url).pathname==='/v1/blocks/page-1/children'){armed=false;enter();await gate;}return delegate(input,init);};
 let running:Promise<unknown>|undefined,selection:Promise<unknown>|undefined;
 try{const f=await installedNotion(t,transport);await f.select([{id:'page-1',type:'page'}]);const id=f.node.sources.listSources()[0]!.id;armed=true;running=f.request('/api/connectors/notion/sync',{});await entered;selection=f.select([{id:'db-1',type:'database'}]);release();await running;await selection;assert.ok(f.node.sources.getItem(id,'page-1'),'the old scan completed while its selection was still effective');assert.equal(f.node.sources.getSource(id).enabled,false);assert.equal(f.node.sources.listSources().find(source=>source.id!==id)?.status?.coverage,undefined,'the newly effective selection has no inherited coverage');}
 finally{release();await running?.catch(()=>{});await selection?.catch(()=>{});}
});

test('Notion temporary image URL refresh cannot discard the continuation of unchanged text',async t=>{
 const transport=fakeNotion(),delegate=transport.fetch;let reads=0;
 transport.setBlocks([{object:'block',type:'image',image:{type:'file',file:{url:'https://generated.notion.example/image?signature=original',expiry_time:'2026-11-17T01:00:00Z'},caption:[]}},paragraph('Generated stable body '+ 'x'.repeat(120000)+' Generated signed URL tail')]);
 transport.fetch=async(input,init)=>{
  const response=await delegate(input,init),url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);
  if(url.pathname==='/v1/blocks/page-1/children'){
   const body=await response.json();body.request_id='generated-observation-'+(reads+1);body.results[0].image.file.url='https://generated.notion.example/image?signature='+ ++reads;body.results[0].image.file.expiry_time=new Date(Date.UTC(2026,10,17,reads)).toISOString();
   return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  }
  return response;
 };
 const f=await installedNotion(t,transport);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;
 await f.request('/api/connectors/notion/sync',{});const first=f.node.sources.getItem(source.id,'page-1')!,checkpoint=f.scan();
 assert.equal(first.text.length,100000);assert.equal(checkpoint.processed,0);assert.equal(checkpoint.body.partial,true);assert.ok(!first.text.includes('Generated signed URL tail'));
 await f.restart();await f.request('/api/connectors/notion/sync',{});
 const completeText=f.node.sources.getItem(source.id,'page-1')!;assert.ok(completeText.text.endsWith('Generated signed URL tail'));
 assert.deepEqual(completeText.document?.bodyCoverage,{state:'partial',reason:'unsupported_content'},'the image stays explicitly unread even though the text traversal is finished');assert.equal(f.scan().processed,1);assert.deepEqual(f.scan().window,checkpoint.window);assert.ok(completeText.text.startsWith(first.text));assert.equal(f.node.sources.history(source.id,'page-1').length,2);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.failed,0);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');assert.ok(transport.calls.every(call=>new URL(call.url).hostname==='api.notion.com'),'temporary media URLs are never fetched');const material=await materialBody(f,source.id);assert.equal(material.model.material.coverage.state,'partial');assert.equal(material.record.coverage.reason,'source_body_unsupported_content');assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated signed URL tail'))).items[0].id,material.id);
});

test('Notion database cover URL refresh cannot restart an unchanged row body',async t=>{
 const transport=fakeNotion(),delegate=transport.fetch;let reads=0;
 transport.setDatabaseEntries([databaseRow(0),databaseRow(1)]);transport.setChildren(databaseRow(0).id,Array.from({length:250},(_,i)=>paragraph('Generated stable row body '+i)));
 transport.fetch=async(input,init)=>{
  const response=await delegate(input,init),url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);
  if(url.pathname==='/v1/databases/db-1/query'){
   const body=await response.json();body.request_id='generated-query-observation-'+(reads+1);body.results[0].cover={type:'file',file:{url:'https://generated.notion.example/cover?signature='+ ++reads,expiry_time:new Date(Date.UTC(2026,10,17,reads)).toISOString()}};
   return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  }
  return response;
 };
 const f=await installedNotion(t,transport);await f.select([{id:'db-1',type:'database'}]);const source=f.node.sources.listSources()[0]!;
 await f.request('/api/connectors/notion/sync',{});assert.equal(f.scan().rowIndex,0);assert.equal(f.scan().processed,0);assert.equal(f.scan().body.id,databaseRow(0).id);const checkpoint=f.scan(),prefix=f.node.sources.getItem(source.id,databaseRow(0).id)!;
 await f.restart();await f.request('/api/connectors/notion/sync',{});
 assert.ok(f.node.sources.getItem(source.id,databaseRow(0).id)!.text.endsWith('Generated stable row body 249'));assert.equal(f.scan().processed,2);assert.equal(f.scan().complete,true);assert.deepEqual(f.scan().window,checkpoint.window);assert.ok(f.node.sources.getItem(source.id,databaseRow(0).id)!.text.startsWith(prefix.text));assert.equal(f.node.sources.history(source.id,databaseRow(0).id).length,2);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.failed,0);const material=await materialBody(f,source.id,databaseRow(0).id);assert.equal((await f.request('/api/materials?query='+encodeURIComponent('Generated stable row body 249'))).items[0].id,material.id);
});


test('Notion block continuation still rejects actual content, order, structure and external URL changes',async t=>{
 for(const change of ['text','order','structure','external URL'] as const)await t.test(change,async sub=>{
  const transport=fakeNotion(),delegate=transport.fetch;let changed=false;
  transport.setBlocks([{object:'block',type:'image',image:{type:'external',external:{url:'https://generated.example/original-image'},caption:[]}},paragraph('Generated stable prefix '+'x'.repeat(120000)+' Generated guarded tail'),paragraph('Generated final sibling')]);
  transport.fetch=async(input,init)=>{const response=await delegate(input,init),url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);if(changed&&url.pathname==='/v1/blocks/page-1/children'){const body=await response.json();if(change==='text')body.results[1].paragraph.rich_text[0].plain_text='Generated actual changed body';if(change==='order')body.results.reverse();if(change==='structure')body.results[1].has_children=true;if(change==='external URL')body.results[0].image.external.url='https://generated.example/replaced-image';return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};
  const f=await installedNotion(sub,transport);await f.select([{id:'page-1',type:'page'}]);const source=f.node.sources.listSources()[0]!;await f.request('/api/connectors/notion/sync',{});const prefix=f.node.sources.getItem(source.id,'page-1')!;assert.equal(prefix.text.length,100000);changed=true;await f.restart();const failure=await f.request('/api/connectors/notion/sync',{},409);assert.equal(failure.error,'notion_page_changed');assert.equal(f.node.sources.getItem(source.id,'page-1')!.captureId,prefix.captureId);assert.equal(f.node.sources.history(source.id,'page-1').length,1);assert.equal(f.scan().processed,0);assert.equal(f.scan().complete,false);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');assert.equal(f.node.sources.getSource(source.id).status?.coverage?.failed,1);
 });
});

test('Notion database continuation still rejects actual property, revision and pagination changes',async t=>{
 for(const change of ['properties','revision','pagination'] as const)await t.test(change,async sub=>{
  const transport=fakeNotion(),delegate=transport.fetch;let changed=false;
  transport.setDatabaseEntries([databaseRow(0),databaseRow(1)]);transport.setChildren(databaseRow(0).id,Array.from({length:250},(_,index)=>paragraph('Generated guarded row body '+index)));
  transport.fetch=async(input,init)=>{const response=await delegate(input,init),url=new URL(typeof input==='string'?input:input instanceof URL?input.toString():input.url);if(changed&&url.pathname==='/v1/databases/db-1/query'){const body=await response.json();if(change==='properties')body.results[0].properties.Name.title[0].plain_text='Generated changed property';if(change==='revision')body.results[0].last_edited_time='2026-11-03T00:00:00.000Z';if(change==='pagination'){body.has_more=true;body.next_cursor='offset-2';}return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};
  const f=await installedNotion(sub,transport);await f.select([{id:'db-1',type:'database'}]);const source=f.node.sources.listSources()[0]!;await f.request('/api/connectors/notion/sync',{});const prefix=f.node.sources.getItem(source.id,databaseRow(0).id)!;assert.equal(f.scan().rowIndex,0);changed=true;await f.restart();const failure=await f.request('/api/connectors/notion/sync',{},409);assert.equal(failure.error,'notion_page_changed');assert.equal(f.node.sources.getItem(source.id,databaseRow(0).id)!.captureId,prefix.captureId);assert.equal(f.node.sources.history(source.id,databaseRow(0).id).length,1);assert.equal(f.scan().processed,0);assert.equal(f.scan().complete,false);assert.equal(f.node.sources.getSource(source.id).status?.coverage?.state,'partial');assert.equal(f.node.sources.getSource(source.id).status?.coverage?.failed,1);
 });
});
