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
const packageRoot=join(repoRoot,'official-plugins/slack');
const slack={repository:'mote/official-slack-connector',tag:'v0.1.0',packageId:'mote.official.slack',localDirectory:'official-plugins/slack'};
const readScopes=['channels:read','groups:read','im:read','mpim:read','channels:history','groups:history','im:history','mpim:history','users:read'];
const owner='generated-slack-owner-'+randomUUID();
const secretName='GENERATED_SLACK_CLIENT_SECRET_'+randomUUID().replaceAll('-','_').toUpperCase();
const secretValue='generated-slack-client-secret-'+randomUUID();
const headers={authorization:'Bearer '+owner};
const baseTs=Math.floor(Date.now()/1000)-7200;
const parentTs=`${baseTs}.000100`;
const replyTs=`${baseTs}.000200`;
const followTs=`${baseTs+1}.000100`;
const newTs=`${baseTs+2}.000100`;
const postedTsValue=`${baseTs+10}.000100`;

function waitFor(check:()=>boolean,description:string){
  const until=Date.now()+10000;
  return (async()=>{while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for '+description);})();
}
function rejectingGitHub(calls:string[]):PluginReleaseTransport{
  return async url=>{calls.push(url);throw new Error('GitHub transport must not be used for the in-repo official Slack package: '+url);};
}
type Call={url:string;method:string;headers:Record<string,string>;body:string|undefined;form:Record<string,string>;pathname:string;search:Record<string,string>};
type FakeSlack={
  calls:Call[];
  fetch:typeof fetch;
  setMessageText:(ts:string,value:string)=>void;
  addMessage:(message:{ts:string;user:string;text:string;replyCount?:number})=>void;
  setPostFail:(value:boolean)=>void;
  setTokenFail:(value:boolean)=>void;
  lastPostedTs:()=>string|undefined;
  postCalls:()=>Call[];
};

/** Generated Slack transport. No request reaches Slack and every method/path is
 * recorded so tests can prove the package never calls another write method. */
function fakeSlack():FakeSlack{
  const calls:Call[]=[];
  let postFail=false,tokenFail=false,posted:string|undefined;
  let messages=[
    {type:'message',user:'U2',text:'Generated general hello',ts:parentTs,reply_count:1},
    {type:'message',user:'U3',text:'Generated general follow-up',ts:followTs},
  ];
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const transport:typeof fetch=async(input,init={})=>{
    const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;
    const parsed=new URL(url),method=String(init.method??'GET').toUpperCase();
    const headerEntries=Object.fromEntries(new Headers(init.headers).entries());
    const raw=typeof init.body==='string'?init.body:undefined;
    const form=raw?Object.fromEntries(new URLSearchParams(raw).entries()):{};
    calls.push({url,method,headers:headerEntries,body:raw,form,pathname:parsed.pathname,search:Object.fromEntries(parsed.searchParams.entries())});
    if(method==='POST'&&parsed.pathname==='/api/oauth.v2.access'){
      if(tokenFail)return json({ok:false,error:'invalid_code'},400);
      if(String(form.code).startsWith('generated-read'))return json({ok:true,authed_user:{id:'U1',scope:readScopes.join(','),access_token:'generated-read-token'},team:{id:'T1',name:'Generated Team'}});
      if(String(form.code).startsWith('generated-send'))return json({ok:true,authed_user:{id:'U1',scope:'chat:write',access_token:'generated-send-token'},team:{id:'T1',name:'Generated Team'}});
      return json({ok:false,error:'invalid_code'},400);
    }
    if(method==='GET'&&parsed.pathname==='/api/auth.test')return json({ok:true,user_id:'U1',user:'generated-owner',team_id:'T1',team:'Generated Team',url:'https://generated.slack.com/'});
    if(method==='GET'&&parsed.pathname==='/api/users.info'){
      const names:Record<string,string>={U2:'Alice',U3:'Bob',U1:'Generated Owner'};
      const id=parsed.searchParams.get('user')??'';
      return json({ok:true,user:{id,profile:{display_name:names[id]??id},real_name:names[id]??id,name:names[id]??id}});
    }
    if(method==='GET'&&parsed.pathname==='/api/conversations.list'){
      return json({ok:true,channels:[
        {id:'C1',name:'general',is_channel:true},
        {id:'C2',name:'random',is_channel:true},
        {id:'G1',name:'private-team',is_private:true},
        {id:'D1',user:'U2',is_im:true},
        {id:'G2',name:'mpdm-alice--bob-1',is_mpim:true},
      ],response_metadata:{next_cursor:''}});
    }
    if(method==='GET'&&parsed.pathname==='/api/conversations.history'){
      const channel=parsed.searchParams.get('channel'),oldest=Number(parsed.searchParams.get('oldest')??0);
      if(channel!=='C1')return json({ok:true,messages:[],response_metadata:{next_cursor:''}});
      return json({ok:true,messages:messages.filter(message=>Number(message.ts)>=oldest).map(message=>({type:'message',...message})),response_metadata:{next_cursor:''}});
    }
    if(method==='GET'&&parsed.pathname==='/api/conversations.replies'){
      const ts=parsed.searchParams.get('ts');
      if(ts!==parentTs)return json({ok:true,messages:[],response_metadata:{next_cursor:''}});
      return json({ok:true,messages:[
        {type:'message',user:'U2',text:'Generated general hello',ts:parentTs},
        {type:'message',user:'U3',text:'Generated thread reply',ts:replyTs},
      ],response_metadata:{next_cursor:''}});
    }
    if(method==='POST'&&parsed.pathname==='/api/chat.postMessage'){
      if(postFail)return json({ok:false,error:'channel_not_found'});
      posted=postedTsValue;
      return json({ok:true,channel:form.channel,ts:posted,message:{text:form.text,ts:posted}});
    }
    return json({ok:false,error:'unexpected_generated_request'},404);
  };
  return {
    calls,fetch:transport,
    setMessageText:(ts,value)=>{messages=messages.map(message=>message.ts===ts?{...message,text:value,edited:{ts:`${baseTs+3}.000000`}}:message);},
    addMessage:message=>{messages=[...messages,{type:'message',user:message.user,text:message.text,ts:message.ts,...(message.replyCount?{reply_count:message.replyCount}:{})}];},
    setPostFail:value=>{postFail=value;},
    setTokenFail:value=>{tokenFail=value;},
    lastPostedTs:()=>posted,
    postCalls:()=>calls.filter(call=>call.pathname==='/api/chat.postMessage'),
  };
}

test('official catalog and manifest declare Slack archive plus a Central message.send contract without exposing the local directory',async()=>{
  const catalog=officialPluginCatalog();
  const entry=catalog.find(value=>value.packageId===slack.packageId);
  assert.ok(entry);
  assert.equal(entry.repository,slack.repository);
  assert.equal(entry.tag,slack.tag);
  assert.equal(entry.group,'connectors');
  assert.equal(entry.runtime,'service');
  assert.equal('localDirectory' in entry,false);
  const internal=OFFICIAL_PLUGIN_CATALOG.find(value=>value.packageId===slack.packageId);
  assert.equal(internal?.localDirectory,slack.localDirectory);

  const manifest=JSON.parse(readFileSync(join(packageRoot,'mote-plugin.json'),'utf8')) as Record<string,unknown>;
  assert.equal(manifest.id,slack.packageId);
  assert.equal(manifest.runtime,'service');
  assert.equal(manifest.trust,'official');
  assert.deepEqual(manifest.capabilities,['source.connector','message.send']);
  const actions=manifest.actionCapabilities as {id:string;version:number;executionLocation:string;risk:string;constraints:Record<string,boolean>}[];
  assert.deepEqual(actions.map(value=>[value.id,value.version,value.executionLocation,value.risk]),[['message.send',1,'central-connector','message-send']]);
  assert.deepEqual(actions[0]?.constraints,{confirmsEveryMessage:true,currentEvidence:true});
  assert.equal(JSON.stringify(manifest).includes('calendar.manage'),false,'Slack declares no calendar write');
  const configuration=manifest.configuration as {id:string;type:string}[];
  assert.equal(configuration.find(field=>field.id==='clientSecret')?.type,'secret-reference');
  assert.equal(configuration.some(field=>field.id==='redirectUri'),true);
  const sourceCatalog=manifest.sourceCatalog as {title:string;kinds:string[];target:{href:string};note:string}[];
  assert.equal(sourceCatalog[0]?.title,'Slack 归档');
  assert.deepEqual(sourceCatalog[0]?.kinds,['mote.official.slack']);
  assert.equal(sourceCatalog[0]?.target.href,'#/connections?setup=official-slack');
  assert.match(sourceCatalog[0]?.note??'',/发送需要第二次授权/);
  assert.match(sourceCatalog[0]?.note??'',/问一问不能发送/);

  const module=await import(pathToFileURL(join(packageRoot,'plugin.mjs')).href) as {connector:ConnectorManifest&{create:unknown;sourceKinds:{kind:string;capabilities:{externalWrite:boolean}}[]};slackRequestKind:(method:string,pathname:string)=>string|undefined};
  assert.equal(module.connector.id,'official-slack');
  assert.equal(module.connector.sourceKinds.length,1);
  assert.equal(module.connector.sourceKinds[0]?.kind,'mote.official.slack');
  assert.equal(module.connector.sourceKinds[0]?.capabilities.externalWrite,false);
  assert.equal(typeof module.connector.create,'function');
  for(const path of ['/api/conversations.list','/api/conversations.info','/api/users.info','/api/conversations.history','/api/conversations.replies','/api/auth.test'])assert.equal(module.slackRequestKind('GET',path),'read');
  assert.equal(module.slackRequestKind('POST','/api/oauth.v2.access'),'token');
  assert.equal(module.slackRequestKind('POST','/api/chat.postMessage'),'send');
  for(const [method,path] of [['POST','/api/chat.update'],['POST','/api/chat.delete'],['POST','/api/files.upload'],['POST','/api/reactions.add'],['POST','/api/conversations.join'],['GET','/api/chat.postMessage']])assert.equal(module.slackRequestKind(method,path),undefined,'the package refuses '+method+' '+path+' before a request');

  const directory=mkdtempSync(join(tmpdir(),'mote-slack-release-')),githubCalls:string[]=[];
  try{
    const releases=new GitHubPluginReleases(join(directory,'packages'),rejectingGitHub(githubCalls),repoRoot);
    await assert.rejects(releases.resolve({repository:slack.repository,tag:'v9.9.9'}),/pinned catalog release/);
    await assert.rejects(releases.resolve({repository:slack.repository}),/pinned catalog release/);
    await assert.rejects(releases.resolve({repository:'/tmp/arbitrary-slack',tag:slack.tag}));
    assert.equal(githubCalls.length,0,'the Slack identity never falls through to GitHub');
    const preview=await releases.resolve({repository:slack.repository,tag:slack.tag});
    assert.equal(JSON.stringify(preview.preview).includes(slack.localDirectory),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('official Slack install, read-only archive, separated send authorization and host-confirmed message.send use the production host',async t=>{
  process.env[secretName]=secretValue;
  const directory=mkdtempSync(join(tmpdir(),'mote-slack-journey-'));
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),syncIntervalMs:60000,mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
  const transport=fakeSlack();
  const node=await buildApp(config,{backgroundWorker:false,connectorTesting:{fetch:transport.fetch},agent:{configured:false,async query(){throw Error('No model request belongs in the Slack fixture');},async close(){}}});
  const githubCalls:string[]=[];
  Object.defineProperty(node.pluginCenter.releases,'transport',{value:rejectingGitHub(githubCalls)});
  t.after(async()=>{delete process.env[secretName];await node.app.close();rmSync(directory,{recursive:true,force:true});});

  let view=node.pluginCenter.view();
  assert.ok(view.catalog.some(entry=>entry.repository===slack.repository&&entry.tag===slack.tag));
  assert.equal(view.sourceContributions?.length??0,0);

  const wrongTag=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:slack.repository,tag:'v9.9.9'}});
  assert.equal(wrongTag.statusCode,422);
  const withPath=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:slack.repository,tag:slack.tag,localDirectory:slack.localDirectory}});
  assert.equal(withPath.statusCode,400);
  assert.equal(githubCalls.length,0);

  const resolved=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:slack.repository,tag:slack.tag}});
  assert.equal(resolved.statusCode,200);
  const preview=resolved.json() as {id:string;installable:boolean;source:{repository:string;tag:string;digest:string}};
  assert.equal(preview.installable,true);
  assert.equal(preview.source.repository,slack.repository);
  assert.match(preview.source.digest,/^[a-f0-9]{64}$/);
  assert.equal(resolved.body.includes(slack.localDirectory),false);

  const install=await node.app.inject({method:'POST',url:'/api/plugins/install',headers,payload:{previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(install.statusCode,200);
  await waitFor(()=>node.pluginCenter.view().packages[0]?.state==='installed','Slack install');
  view=node.pluginCenter.view();
  assert.equal(view.instances.length,0,'installation creates no default instance and starts no scan');
  assert.equal(view.sourceContributions?.[0]?.title,'Slack 归档');
  assert.equal(view.sourceContributions?.[0]?.state,'installed');
  assert.equal(view.sourceContributions?.[0]?.target.href,'#/connections?setup=official-slack');
  assert.equal(transport.calls.length,0,'install creates no Slack request');

  const packageId=view.packages[0]!.id;
  const configured=await node.app.inject({method:'POST',url:'/api/plugin-instances',headers,payload:{packageId,name:'Slack archive',scope:'default',configuration:{clientId:'generated-slack-client',clientSecret:'${'+secretName+'}',redirectUri:'https://central.example/oauth/slack/callback'},expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(configured.statusCode,200);
  const instance=configured.json() as {id:string;revision:number;secretStatus:Record<string,boolean>};
  assert.equal(instance.secretStatus.clientSecret,true);
  const stored=node.store.db.prepare('SELECT json FROM plugin_build_instances').all().map(row=>String((row as {json:string}).json)).join('\n');
  assert.equal(stored.includes(secretValue),false,'the resolved secret is never persisted in the instance');
  assert.equal(stored.includes('${'+secretName+'}'),true,'only the opaque reference is persisted');
  assert.equal(transport.calls.length,0,'configuration does not contact Slack');

  const check=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/check',headers,payload:{expectedRevision:instance.revision,operationId:randomUUID()}});
  assert.equal(check.statusCode,200);
  await waitFor(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','Slack check');
  const checkedView=node.pluginCenter.instanceView(instance.id);
  assert.equal(checkedView.capabilities.some(value=>value.id==='source.connector'&&value.state==='verified'),true);
  assert.equal(checkedView.capabilities.some(value=>value.id==='message.send'&&value.state==='verified'),true);
  assert.equal(node.sources.listSources().length,0,'checking does not authorize or read Slack');
  assert.equal(transport.calls.length,0);

  const enable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:{expectedRevision:checkedView.revision,operationId:randomUUID()}});
  assert.equal(enable.statusCode,200);
  await waitFor(()=>{const value=node.pluginCenter.instanceView(instance.id);return value.desired&&value.observed==='ready';},'Slack enable');
  await waitFor(()=>node.pluginCenter.view().sourceContributions?.[0]?.state==='enabled','Slack source contribution enabled');
  for(let attempt=0;attempt<200;attempt++){
    if((await node.app.inject({url:'/api/connectors/slack',headers})).statusCode===200)break;
    if(attempt===199)throw new Error('Timed out waiting for Slack owner routes');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(node.sources.listSources().length,0,'enabling is not authorization and starts no scan');
  assert.equal(transport.calls.length,0);
  assert.equal(transport.postCalls().length,0,'enable itself never sends a message');

  let inventory=(await node.app.inject({url:'/api/action-capabilities',headers})).json() as {executionEnabled:boolean;centralConnectors:{name:string;capability:{id:string;version:number};target:Record<string,unknown>}[];providers:{identity:Record<string,unknown>;capability:{id:string}}[];grants:{id:string;state:string;capability:{id:string}}[]};
  const messageChoice=inventory.centralConnectors.find(value=>value.capability.id==='message.send');
  assert.ok(messageChoice);
  assert.equal(messageChoice.target.executionLocation,'central-connector');
  assert.equal(messageChoice.target.packageId,packageId);
  assert.equal(inventory.executionEnabled,false,'install, check and enable never grant execution');
  assert.deepEqual(inventory.providers.map(provider=>provider.capability.id),['message.send'],'Slack declares no calendar write provider');

  const readStart=await node.app.inject({method:'POST',url:'/api/connectors/slack/start',headers,payload:{}});
  assert.equal(readStart.statusCode,200);
  assert.equal((await node.app.inject({method:'POST',url:'/api/connectors/slack/start',payload:{}})).statusCode,401,'Slack owner routes reject missing owner authorization');
  const readAuthorization=new URL((readStart.json() as {authorizationUrl:string}).authorizationUrl);
  assert.equal(readAuthorization.origin,'https://slack.com');
  assert.equal(readAuthorization.pathname,'/oauth/v2/authorize');
  assert.equal(readAuthorization.searchParams.get('client_id'),'generated-slack-client');
  assert.equal(readAuthorization.searchParams.get('response_type'),'code');
  assert.equal(readAuthorization.searchParams.get('redirect_uri'),'https://central.example/oauth/slack/callback');
  const readScopeValues=(readAuthorization.searchParams.get('user_scope')??'').split(',');
  for(const scope of readScopes)assert.equal(readScopeValues.includes(scope),true,'read authorization requests '+scope);
  assert.equal(readScopeValues.includes('chat:write'),false,'archive authorization never requests a write scope');
  assert.equal(transport.calls.length,0,'OAuth start is local');

  const readState=readAuthorization.searchParams.get('state')!;
  assert.match(readState,/^slack\.read\./);
  const readCallback=await node.app.inject({url:'/oauth/slack/callback?state='+encodeURIComponent(readState)+'&code=generated-read-code'});
  assert.equal(readCallback.statusCode,200);
  assert.match(readCallback.body,/Slack 归档已连接/);
  const tokenCall=transport.calls.find(call=>call.pathname==='/api/oauth.v2.access');
  assert.ok(tokenCall);
  assert.equal(tokenCall.form.client_id,'generated-slack-client');
  assert.equal(tokenCall.form.client_secret,secretValue);
  assert.equal(tokenCall.form.redirect_uri,'https://central.example/oauth/slack/callback');
  const authTest=transport.calls.find(call=>call.pathname==='/api/auth.test');
  assert.equal(authTest?.headers.authorization,'Bearer generated-read-token');
  const readStatus=(await node.app.inject({url:'/api/connectors/slack',headers})).json() as {connected:boolean;readOnly:boolean;sendAuthorized:boolean;selected:unknown[]};
  assert.equal(readStatus.connected,true);
  assert.equal(readStatus.readOnly,true);
  assert.equal(readStatus.sendAuthorized,false,'archive authorization does not authorize sending');
  assert.deepEqual(readStatus.selected,[]);
  assert.equal(node.sources.listSources().length,0,'authorization alone pulls no Slack content');

  const candidates=await node.app.inject({method:'POST',url:'/api/connectors/slack/candidates',headers,payload:{}});
  assert.equal(candidates.statusCode,200);
  const listed=candidates.json() as {channels:{id:string;type:string;name:string}[];directMessages:{id:string;type:string;name:string}[];items:unknown[]};
  assert.deepEqual(listed.channels.map(item=>[item.id,item.type]),[['C1','channel'],['C2','channel'],['G1','channel']]);
  assert.deepEqual(listed.directMessages.map(item=>[item.id,item.type]),[['D1','im'],['G2','mpim']]);
  assert.equal(listed.directMessages.find(item=>item.id==='D1')?.name,'Alice');
  assert.equal(listed.items.length,5);
  assert.equal(transport.calls.some(call=>call.pathname==='/api/conversations.history'),false,'previewing names reads no message body');
  assert.equal(transport.calls.some(call=>call.pathname==='/api/conversations.replies'),false);

  const selected=await node.app.inject({method:'POST',url:'/api/connectors/slack/select',headers,payload:{selected:[{id:'C1',type:'channel'}]}});
  assert.equal(selected.statusCode,200);
  const selectedStatus=selected.json() as {status:{selected:{id:string;type:string}[]}};
  assert.deepEqual(selectedStatus.status.selected,[{id:'C1',type:'channel',name:'general'}]);
  const slackSources=()=>node.sources.listSources().filter(source=>source.kind==='mote.official.slack');
  assert.equal(slackSources().length,1,'only the explicitly checked channel enters the scope');
  assert.equal(slackSources()[0]!.enabled,true);
  assert.equal(transport.calls.some(call=>call.pathname==='/api/conversations.history'),false,'selection alone reads no message body');

  const firstSync=await node.app.inject({method:'POST',url:'/api/connectors/slack/sync',headers,payload:{}});
  assert.equal(firstSync.statusCode,200);
  const sourceId=slackSources()[0]!.id;
  const historyCalls=transport.calls.filter(call=>call.pathname==='/api/conversations.history');
  assert.equal(historyCalls.length,1,'only the checked channel is read');
  assert.equal(historyCalls[0]!.search.channel,'C1');
  const firstOldest=Number(historyCalls[0]!.search.oldest);
  assert.equal(Math.abs(firstOldest-(Math.floor(Date.now()/1000)-30*86400))<180,true,'the first sync window defaults to about 30 days');
  assert.equal(transport.calls.some(call=>call.pathname==='/api/conversations.history'&&call.search.channel!=='C1'),false,'unchecked channels and DMs are never read');
  assert.equal(transport.calls.some(call=>call.pathname==='/api/conversations.replies'),true,'thread replies are read for selected messages');
  const firstItem=node.sources.getItem(sourceId,parentTs);
  assert.equal(firstItem?.title.includes('general'),true);
  assert.match(firstItem?.text??'',/Generated general hello/);
  assert.match(firstItem?.text??'',/Generated thread reply/);
  assert.match(firstItem?.uri??'',/^https:\/\/generated\.slack\.com\/archives\/C1\//);
  assert.equal(node.sources.history(sourceId,parentTs).length,1);

  transport.setMessageText(followTs,'Generated general follow-up edited');
  transport.addMessage({ts:newTs,user:'U3',text:'Generated new message'});
  const secondSync=await node.app.inject({method:'POST',url:'/api/connectors/slack/sync',headers,payload:{}});
  assert.equal(secondSync.statusCode,200);
  const secondHistory=transport.calls.filter(call=>call.pathname==='/api/conversations.history').at(-1)!;
  assert.equal(secondHistory.search.channel,'C1');
  assert.equal(secondHistory.search.oldest,followTs,'later syncs resume from the last archived message');
  const followUpHistory=node.sources.history(sourceId,followTs);
  assert.equal(followUpHistory.length,2,'an edited message enters the version chain');
  assert.match(followUpHistory[0]!.text,/follow-up edited/);
  assert.match(followUpHistory[1]!.text,/follow-up/);
  assert.equal(node.sources.getItem(sourceId,newTs)?.text.includes('Generated new message'),true);

  const beforeLifecycle=transport.calls.length;
  let current=node.pluginCenter.instanceView(instance.id);
  const disable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/disable',headers,payload:{expectedRevision:current.revision,operationId:randomUUID()}});
  assert.equal(disable.statusCode,200);
  await waitFor(()=>!node.pluginCenter.instanceView(instance.id).desired,'Slack disable');
  for(let attempt=0;attempt<200;attempt++){
    if((await node.app.inject({url:'/api/connectors/slack',headers})).statusCode===404)break;
    if(attempt===199)throw new Error('Timed out waiting for Slack routes to release');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  current=node.pluginCenter.instanceView(instance.id);
  const reenable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:{expectedRevision:current.revision,operationId:randomUUID()}});
  assert.equal(reenable.statusCode,200);
  await waitFor(()=>{const value=node.pluginCenter.instanceView(instance.id);return value.desired&&value.observed==='ready';},'Slack re-enable');
  for(let attempt=0;attempt<200;attempt++){
    if((await node.app.inject({url:'/api/connectors/slack',headers})).statusCode===200)break;
    if(attempt===199)throw new Error('Timed out waiting for Slack routes to remount');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const restored=(await node.app.inject({url:'/api/connectors/slack',headers})).json() as {connected:boolean;sendAuthorized:boolean;selected:{id:string}[]};
  assert.equal(restored.connected,true,'re-enabling resumes the retained read authorization');
  assert.equal(restored.sendAuthorized,false);
  assert.equal(restored.selected[0]?.id,'C1');
  assert.equal(transport.calls.length,beforeLifecycle,'disable and enable read no Slack content');

  inventory=(await node.app.inject({url:'/api/action-capabilities',headers})).json() as typeof inventory;
  const currentChoice=inventory.centralConnectors.find(value=>value.capability.id==='message.send')!;
  const provider=inventory.providers.find(value=>value.capability.id==='message.send')!;
  const slackSource=slackSources()[0]!;
  const sourceIdentity={sourceId:slackSource.id,kind:slackSource.kind,deviceId:slackSource.deviceId,platform:slackSource.platform};
  let actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  assert.equal(actionsView.messageRevision,0);
  const beforeGrant=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'C1',conversationName:'general',text:'Generated message before grant'}}});
  assert.equal(beforeGrant.statusCode,403,'a message proposal requires the owner message.send grant');
  assert.equal(transport.postCalls().length,0);

  const draft=await node.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers,payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),capability:{id:'message.send',version:1},target:currentChoice.target,inputs:{sources:[sourceIdentity],existingArchived:true,futureInputs:true}}});
  assert.equal(draft.statusCode,200,draft.body);
  const draftValue=draft.json() as {id:string;revision:number};
  const missingAck=await node.app.inject({method:'PUT',url:'/api/action-capability-grants',headers,payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),draftId:draftValue.id,draftRevision:draftValue.revision,plugin:provider.identity}});
  assert.equal(missingAck.statusCode,400,'message.send authorization requires acknowledgeMessageSends');
  const granted=await node.app.inject({method:'PUT',url:'/api/action-capability-grants',headers,payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),draftId:draftValue.id,draftRevision:draftValue.revision,plugin:provider.identity,acknowledgeMessageSends:true}});
  assert.equal(granted.statusCode,200,granted.body);
  const grantValue=granted.json() as {id:string;state:string;capability:{id:string}};
  assert.equal(grantValue.capability.id,'message.send');
  inventory=(await node.app.inject({url:'/api/action-capabilities',headers})).json() as typeof inventory;
  assert.equal(inventory.executionEnabled,true);
  assert.equal(inventory.grants.some(value=>value.id===grantValue.id&&value.state==='active'),true);
  assert.equal(transport.postCalls().length,0,'a grant alone never sends a message');

  actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  const firstCommand={operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'C1',conversationName:'general',text:'Generated message before send authorization'}};
  const firstProposalResponse=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:firstCommand});
  assert.equal(firstProposalResponse.statusCode,200,firstProposalResponse.body);
  const firstProposal=firstProposalResponse.json() as {proposal:{id:string;kind:string;status:string;version:number;message:{conversationId:string;text:string}};revision:number};
  assert.equal(firstProposal.revision,1);
  const replayedProposal=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:firstCommand});
  assert.equal(replayedProposal.statusCode,200);
  assert.equal((replayedProposal.json() as {proposal:{id:string}}).proposal.id,firstProposal.proposal.id,'the operation identity replays the same draft');
  const staleProposal=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{...firstCommand,operationId:randomUUID()}});
  assert.equal(staleProposal.statusCode,409,'a stale expectedRevision cannot add another draft');
  assert.equal(firstProposal.proposal.kind,'message.send');
  assert.equal(firstProposal.proposal.status,'proposed');
  assert.equal(firstProposal.proposal.message.conversationId,'C1');
  assert.equal(transport.postCalls().length,0,'creating a proposal never sends');
  assert.equal((await node.app.inject({url:'/api/actions/'+firstProposal.proposal.id,headers})).statusCode,200);
  const firstConfirm=await node.app.inject({method:'POST',url:'/api/actions/'+firstProposal.proposal.id+'/confirm',headers,payload:{version:firstProposal.proposal.version,target:currentChoice.target,message:firstProposal.proposal.message}});
  assert.equal(firstConfirm.statusCode,200,firstConfirm.body);
  await waitFor(()=>node.actions.get(firstProposal.proposal.id).status==='uncertain','a send without the second authorization settles uncertain');
  assert.equal(transport.postCalls().length,0,'the read token alone can never call chat.postMessage');
  assert.equal(node.actions.get(firstProposal.proposal.id).externalId,undefined);
  assert.equal((await node.app.inject({url:'/api/connectors/slack',headers})).json().sendAuthorized,false);

  const sendStart=await node.app.inject({method:'POST',url:'/api/connectors/slack/send/start',headers,payload:{}});
  assert.equal(sendStart.statusCode,200);
  const sendAuthorization=new URL((sendStart.json() as {authorizationUrl:string}).authorizationUrl);
  assert.equal(sendAuthorization.origin,'https://slack.com');
  assert.equal(sendAuthorization.pathname,'/oauth/v2/authorize');
  assert.equal(sendAuthorization.searchParams.get('user_scope'),'chat:write');
  assert.equal(sendAuthorization.searchParams.get('client_id'),'generated-slack-client');
  const sendState=sendAuthorization.searchParams.get('state')!;
  assert.match(sendState,/^slack\.send\./);
  const sendCallback=await node.app.inject({url:'/oauth/slack/callback?state='+encodeURIComponent(sendState)+'&code=generated-send-code'});
  assert.equal(sendCallback.statusCode,200);
  assert.match(sendCallback.body,/Slack 发送授权已连接/);
  const sendStatus=(await node.app.inject({url:'/api/connectors/slack',headers})).json() as {sendAuthorized:boolean;selected:{id:string}[]};
  assert.equal(sendStatus.sendAuthorized,true,'sending needs the second user-scope authorization');
  assert.equal(sendStatus.selected[0]?.id,'C1');
  assert.equal(transport.postCalls().length,0,'the send authorization alone never sends');

  actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  assert.equal(actionsView.messageRevision,1);
  const secondProposalResponse=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'C1',conversationName:'general',text:'Generated owner approved message'}}});
  assert.equal(secondProposalResponse.statusCode,200,secondProposalResponse.body);
  const secondProposal=secondProposalResponse.json() as {proposal:{id:string;status:string;version:number;message:{conversationId:string;text:string}};revision:number};
  assert.equal(secondProposal.revision,2);
  assert.equal(transport.postCalls().length,0,'an authorized proposal still waits for owner confirmation');
  const secondConfirm=await node.app.inject({method:'POST',url:'/api/actions/'+secondProposal.proposal.id+'/confirm',headers,payload:{version:secondProposal.proposal.version,target:currentChoice.target,message:secondProposal.proposal.message}});
  assert.equal(secondConfirm.statusCode,200,secondConfirm.body);
  await waitFor(()=>node.actions.get(secondProposal.proposal.id).status==='succeeded','the host dispatches the confirmed message');
  assert.equal(transport.postCalls().length,1);
  const postedCall=transport.postCalls()[0]!;
  assert.equal(postedCall.form.channel,'C1');
  assert.equal(postedCall.form.text,'Generated owner approved message');
  assert.equal(postedCall.headers.authorization,'Bearer generated-send-token','only the send token calls chat.postMessage');
  assert.notEqual((transport.calls.find(call=>call.pathname==='/api/conversations.history')!).headers.authorization,'Bearer generated-send-token','the send token never reads history');
  const completed=node.actions.get(secondProposal.proposal.id);
  assert.equal(completed.target && 'executionLocation' in completed.target ? completed.target.executionLocation : undefined,'central-connector');
  assert.ok(completed.operationId);
  const postedTs=transport.lastPostedTs()!;
  assert.equal(completed.externalId,'C1:'+postedTs);
  const archived=node.sources.getItem(sourceId,postedTs);
  assert.equal(archived?.text.includes('Generated owner approved message'),true,'the sent message is archived again');
  assert.equal(node.sources.history(sourceId,postedTs).length,1);

  transport.setPostFail(true);
  actionsView=(await node.app.inject({url:'/api/actions',headers})).json() as {messageRevision:number};
  const failureProposalResponse=await node.app.inject({method:'POST',url:'/api/actions/messages',headers,payload:{operationId:randomUUID(),expectedRevision:actionsView.messageRevision,target:currentChoice.target,message:{conversationId:'C1',conversationName:'general',text:'Generated failing message'}}});
  assert.equal(failureProposalResponse.statusCode,200);
  const failureProposal=failureProposalResponse.json() as {proposal:{id:string;version:number;message:{conversationId:string;text:string}}};
  assert.equal((await node.app.inject({method:'POST',url:'/api/actions/'+failureProposal.proposal.id+'/confirm',headers,payload:{version:failureProposal.proposal.version,target:currentChoice.target,message:failureProposal.proposal.message}})).statusCode,200);
  await waitFor(()=>node.actions.get(failureProposal.proposal.id).status==='uncertain','a failed Slack send is not reported as success');
  const failedAction=node.actions.get(failureProposal.proposal.id);
  assert.equal(failedAction.status,'uncertain');
  assert.equal(failedAction.externalId,undefined);
  assert.equal(transport.postCalls().length,2,'the confirmed attempt reached Slack but its rejection is not success');
  transport.setPostFail(false);

  const invitation=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated Slack review device'}});
  const paired=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-slack-collector-device',deviceName:'Generated Slack collector',platform:'macos'}});
  const collector={authorization:'Bearer '+paired.json().token};
  assert.equal((await node.app.inject({method:'POST',url:'/api/actions/messages',headers:collector,payload:{operationId:randomUUID(),expectedRevision:3,target:currentChoice.target,message:{conversationId:'C1',text:'Generated collector attempt'}}})).statusCode,403,'a collector cannot create a message send proposal');
  assert.equal((await node.app.inject({method:'POST',url:'/api/actions/'+failureProposal.proposal.id+'/confirm',headers:collector,payload:{version:failedAction.version,target:currentChoice.target,message:failedAction.message}})).statusCode,403,'a collector cannot confirm a message send');

  const beforeDisconnect=transport.calls.length;
  const disconnected=await node.app.inject({method:'POST',url:'/api/connectors/slack/disconnect',headers,payload:{}});
  assert.equal(disconnected.statusCode,200);
  const afterDisconnect=disconnected.json() as {connected:boolean;sendAuthorized:boolean;selected:unknown[]};
  assert.equal(afterDisconnect.connected,false);
  assert.equal(afterDisconnect.sendAuthorized,false);
  assert.deepEqual(afterDisconnect.selected,[]);
  assert.equal(slackSources().every(source=>!source.enabled),true);
  assert.equal((await node.app.inject({method:'POST',url:'/api/connectors/slack/sync',headers,payload:{}})).statusCode,401,'disconnect stops every new Slack read');
  assert.equal(transport.calls.length,beforeDisconnect,'disconnect issues no Slack request');
  const retainedState=node.store.db.prepare("SELECT json FROM plugin_instance_state WHERE key='slack'").all().map(row=>String((row as {json:string}).json)).join('\n');
  assert.equal(retainedState.includes('generated-read-token'),false,'disconnect deletes the local read token');
  assert.equal(retainedState.includes('generated-send-token'),false,'disconnect deletes the local send token');
  assert.equal(node.sources.getItem(sourceId,postedTs)?.text.includes('Generated owner approved message'),true,'disconnect keeps archived messages');
  assert.equal(node.sources.history(sourceId,followTs).length,2,'disconnect keeps the prior version chain');

  transport.setTokenFail(true);
  const failedStart=await node.app.inject({method:'POST',url:'/api/connectors/slack/start',headers,payload:{}});
  assert.equal(failedStart.statusCode,200);
  const failedState=new URL((failedStart.json() as {authorizationUrl:string}).authorizationUrl).searchParams.get('state')!;
  const failedCallback=await node.app.inject({url:'/oauth/slack/callback?state='+encodeURIComponent(failedState)+'&code=generated-read-failure'});
  assert.equal(failedCallback.statusCode,400);
  assert.match(failedCallback.body,/Slack 归档授权未完成/);
  assert.equal((await node.app.inject({url:'/api/connectors/slack',headers})).json().connected,false,'a failed token exchange is not reported as connected');
  transport.setTokenFail(false);

  const writeCalls=transport.calls.filter(call=>call.method==='POST'&&!['/api/oauth.v2.access','/api/chat.postMessage'].includes(call.pathname));
  assert.deepEqual(writeCalls,[],'the archive path issued no Slack write request');
  assert.equal(transport.calls.some(call=>/chat\.(update|delete)|files\.upload|reactions\.|conversations\.join/.test(call.pathname)),false,'no other Slack write method was called');
  assert.equal(transport.postCalls().length,2,'only the two host-confirmed send attempts used chat.postMessage');
  assert.equal(node.actions.catalog().items.some(item=>item.id===secondProposal.proposal.id),false,'the read-only Ask catalog never exposes message sends');
});
