import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {EvidenceDependencies,QueryScope} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import type {AssistantCardPublication} from '../src/assistant-cards.js';
import {StoreError} from '../src/evidence-store.js';

const all:QueryScope={kind:'all'};
const dependencies=(ids:string[]):EvidenceDependencies=>({version:1,complete:true,ids});

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-feed-'));
 const config:ConfigurationPlatformOptions={path:directory+'/mote.yaml',privateCredential:{token:'generated-feed-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.privateCredential!.token},cards=node.featureServices.assistantCards;
 const publish=(input:AssistantCardPublication,expectedRevision:number|undefined=undefined,scope:QueryScope=all)=>cards.publish(input,expectedRevision,scope,ids=>{if(ids.some(id=>!node.featureServices.evidenceReader.memories.isCurrentEvidence(id)))throw new StoreError('Generated evidence is no longer current',409);});
 const capture=async(text:string)=>{const id=randomUUID();await node.store.ingest({id,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:text});return id;};
 const item=(id:string,title:string,extra:Partial<AssistantCardPublication>={}):AssistantCardPublication=>({id,kind:'activity',matterId:null,version:'one',state:'open',title,body:'Generated body for '+title,evidence:[],evidenceDependencies:dependencies([]),...extra});
 const query=(values:Record<string,string>={})=>new URLSearchParams({scope:JSON.stringify(all),...values});
 const feed=async(values:Record<string,string>={})=>{const response=await node.app.inject({url:'/api/assistant-cards?'+query(values),headers});assert.equal(response.statusCode,200,response.body);return response.json();};
 const setCreated=(id:string,at:string)=>node.store.db.prepare('UPDATE assistant_cards SET created_at=? WHERE id=?').run(at,id);
 const saveInsight=(id:string,at:string,title:string,answer:string)=>node.store.db.prepare('INSERT INTO insights(id,created_at,json) VALUES(?,?,?)').run(id,at,JSON.stringify({answer,artifact:{id,title,html:'<p>Generated</p>',createdAt:at,skillId:'personal-insight',skillVersion:'1'}}));
 return {node,cards,headers,publish,capture,item,query,feed,setCreated,saveInsight};
}

test('assistant feed filters, categories, discoveries and cursors use generated data',async t=>{
 await t.test('FE1-01 a three-day window keeps today and yesterday, not last week',async t=>{
  const f=await fixture(t),now=Date.now();
  const today=f.publish(f.item(randomUUID(),'FE1-01 today')),yesterday=f.publish(f.item(randomUUID(),'FE1-01 yesterday')),lastWeek=f.publish(f.item(randomUUID(),'FE1-01 last week'));
  f.setCreated(today.id,new Date(now).toISOString());f.setCreated(yesterday.id,new Date(now-24*60*60*1000).toISOString());f.setCreated(lastWeek.id,new Date(now-8*24*60*60*1000).toISOString());
  const page=await f.feed({window:'3d',tz:'UTC',limit:'50'});
  const ids=page.items.map((value:{id:string})=>value.id);
  assert.ok(ids.includes(today.id));assert.ok(ids.includes(yesterday.id));assert.ok(!ids.includes(lastWeek.id));
 });

 await t.test('FE1-02 unread excludes read cards and counts drop after marking read',async t=>{
  const f=await fixture(t),first=f.publish(f.item(randomUUID(),'FE1-02 first')),second=f.publish(f.item(randomUUID(),'FE1-02 second'));
  let page=await f.feed({unread:'1',limit:'50'});assert.deepEqual(page.items.map((value:{id:string})=>value.id).sort(),[first.id,second.id].sort());
  f.cards.feedback(first.id,{expectedRevision:first.revision,action:'read'},all);
  page=await f.feed({unread:'1',limit:'50'});assert.deepEqual(page.items.map((value:{id:string})=>value.id),[second.id]);
  f.cards.feedback(second.id,{expectedRevision:second.revision,action:'read'},all);
  page=await f.feed({unread:'1',limit:'50'});assert.deepEqual(page.items,[]);
 });

 await t.test('FE1-03 an activity kind excludes suggestions and questions',async t=>{
  const f=await fixture(t),activity=f.publish(f.item(randomUUID(),'FE1-03 activity')),suggestion=f.publish(f.item(randomUUID(),'FE1-03 suggestion',{kind:'suggestion'})),question=f.publish(f.item(randomUUID(),'FE1-03 question',{kind:'question'}));
  const page=await f.feed({kinds:'activity',limit:'50'});
  const ids=page.items.map((value:{id:string})=>value.id);
  assert.ok(ids.includes(activity.id));assert.ok(!ids.includes(suggestion.id));assert.ok(!ids.includes(question.id));
 });

 await t.test('FE1-04 model categories count correctly and an uncategorized card still lists',async t=>{
  const f=await fixture(t),workA=f.publish(f.item(randomUUID(),'FE1-04 work A',{category:'工作'})),workB=f.publish(f.item(randomUUID(),'FE1-04 work B',{category:'工作'})),life=f.publish(f.item(randomUUID(),'FE1-04 life',{category:'生活'})),plain=f.publish(f.item(randomUUID(),'FE1-04 plain'));
  const page=await f.feed({limit:'50'});
  assert.deepEqual(page.categories,[{name:'工作',count:2},{name:'生活',count:1}]);
  const plainItem=page.items.find((value:{id:string})=>value.id===plain.id);assert.ok(plainItem);assert.equal(plainItem.category,undefined);
  const work=await f.feed({category:'工作',limit:'50'});
  assert.deepEqual(work.items.map((value:{id:string})=>value.id).sort(),[workA.id,workB.id].sort());
  assert.deepEqual(work.categories,[{name:'工作',count:2},{name:'生活',count:1}],'counts keep the other categories visible');
  assert.ok(!work.items.some((value:{id:string})=>value.id===life.id));
 });

 await t.test('FE1-05 overlong or control-character annotations are dropped without losing the card',async t=>{
  const f=await fixture(t),card=f.publish(f.item(randomUUID(),'FE1-05 annotated',{category:'工作',subject:'x'.repeat(41),action:'bad\u0001action',gist:'y'.repeat(121)}));
  const page=await f.feed({q:'FE1-05',limit:'50'}),saved=page.items.find((value:{id:string})=>value.id===card.id);
  assert.ok(saved);assert.equal(saved.category,'工作');assert.equal(saved.subject,undefined);assert.equal(saved.action,undefined);assert.equal(saved.gist,undefined);
 });

 await t.test('FE1-06 deleting the cited original withdraws the card on the next feed read',async t=>{
  const f=await fixture(t),original=await f.capture('Generated FE1-06 original'),card=f.publish(f.item(randomUUID(),'FE1-06 deleted source',{evidence:[{id:original,quote:'Generated FE1-06 original'}],evidenceDependencies:dependencies([original])}));
  assert.ok((await f.feed({q:'FE1-06',limit:'50'})).items.some((value:{id:string})=>value.id===card.id));
  const deletion=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+original,headers:f.headers});assert.equal(deletion.statusCode,200,deletion.body);
  assert.ok(!(await f.feed({q:'FE1-06',limit:'50'})).items.some((value:{id:string})=>value.id===card.id));
 });

 await t.test('FE1-07 searching a gist returns the card and paginates without repeats',async t=>{
  const f=await fixture(t),first=f.publish(f.item(randomUUID(),'FE1-07 first',{gist:'Generated searchable needle'})),second=f.publish(f.item(randomUUID(),'FE1-07 second',{gist:'Generated searchable needle'})),other=f.publish(f.item(randomUUID(),'FE1-07 other',{gist:'Generated different text'}));
  const page=await f.feed({q:'needle',limit:'1'});assert.equal(page.items.length,1);assert.ok(page.nextCursor);
  const secondPage=await f.feed({q:'needle',limit:'1',cursor:page.nextCursor});assert.equal(secondPage.items.length,1);
  const ids=[page.items[0].id,secondPage.items[0].id];assert.deepEqual(ids.sort(),[first.id,second.id].sort());assert.equal(secondPage.nextCursor,null);
  assert.ok(!ids.includes(other.id));
  const decoded=JSON.parse(Buffer.from(page.nextCursor,'base64url').toString());decoded.id=randomUUID();
  const tampered=await f.node.app.inject({url:'/api/assistant-cards?'+f.query({q:'needle',limit:'1',cursor:Buffer.from(JSON.stringify(decoded)).toString('base64url')}),headers:f.headers});
  assert.equal(tampered.statusCode,400,tampered.body);
 });

 await t.test('FE1-08 discoveries can be selected alone and merge with cards by time',async t=>{
  const f=await fixture(t),now=Date.now(),insightA=randomUUID(),insightB=randomUUID(),cardA=f.publish(f.item(randomUUID(),'FE1-08 card A')),cardB=f.publish(f.item(randomUUID(),'FE1-08 card B'));
  f.saveInsight(insightA,new Date(now-1000).toISOString(),'Generated discovery A','# Generated discovery A\n\nGenerated body A');
  f.saveInsight(insightB,new Date(now-3000).toISOString(),'Generated discovery B','Generated body B');
  f.setCreated(cardA.id,new Date(now-2000).toISOString());f.setCreated(cardB.id,new Date(now-4000).toISOString());
  const alone=await f.feed({kinds:'discovery',limit:'50'});assert.deepEqual(alone.items.map((value:{id:string})=>value.id),[insightA,insightB]);
  const seen:string[]=[];let cursor:string|undefined;
  for(let page=0;page<4;page++){
   const body=await f.feed({kinds:'activity,discovery',limit:'1',...(cursor?{cursor}:{})});
   assert.equal(body.items.length,1);seen.push(body.items[0].id);cursor=body.nextCursor??undefined;
  }
  assert.deepEqual(seen,[insightA,cardA.id,insightB,cardB.id]);
  assert.equal(new Set(seen).size,seen.length);assert.equal(cursor,undefined);
 });

 await t.test('FE1-09 the same card falls in each timezone own today',async t=>{
  const f=await fixture(t),card=f.publish(f.item(randomUUID(),'FE1-09 boundary')),now=new Date(),utcStart=new Date(now);utcStart.setUTCHours(0,0,0,0);
  // Shanghai is UTC+8. When the UTC date is already behind Shanghai, a time
  // just after UTC midnight is still the previous Shanghai day; before 16:00Z
  // the previous Shanghai morning is already the current Shanghai day.
  const shanghaiStart=utcStart.getTime()+(now.getUTCHours()>=16?16:-8)*60*60*1000;
  const boundary=new Date(now.getUTCHours()>=16?utcStart.getTime()+60*1000:shanghaiStart+60*1000).toISOString();
  f.setCreated(card.id,boundary);
  const shanghai=await f.feed({window:'today',tz:'Asia/Shanghai',limit:'50'}),utc=await f.feed({window:'today',tz:'UTC',limit:'50'});
  const shanghaiExpected=Date.parse(boundary)>=shanghaiStart&&Date.parse(boundary)<shanghaiStart+24*60*60*1000,utcExpected=Date.parse(boundary)>=utcStart.getTime()&&Date.parse(boundary)<utcStart.getTime()+24*60*60*1000;
  assert.notEqual(shanghaiExpected,utcExpected,'the generated boundary distinguishes the two local days');
  assert.equal(shanghai.items.some((value:{id:string})=>value.id===card.id),shanghaiExpected);
  assert.equal(utc.items.some((value:{id:string})=>value.id===card.id),utcExpected);
 });

 await t.test('feed rejects a limit above the page contract and a cursor for other filters',async t=>{
  const f=await fixture(t);f.publish(f.item(randomUUID(),'FE1 limit one'));f.publish(f.item(randomUUID(),'FE1 limit two'));
  const tooMany=await f.node.app.inject({url:'/api/assistant-cards?'+f.query({limit:'51'}),headers:f.headers});assert.equal(tooMany.statusCode,400);
  const first=await f.feed({limit:'1'}),other=await f.node.app.inject({url:'/api/assistant-cards?'+f.query({limit:'1',window:'week',cursor:first.nextCursor}),headers:f.headers});
  assert.equal(other.statusCode,400,other.body);
 });
});
