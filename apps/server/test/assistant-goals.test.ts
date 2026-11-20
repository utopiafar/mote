import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calendarInstant,type QueryResult,type QueryScope} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import type {CommitmentProposal} from '../src/assistant-commitments.js';
import {sha256} from '../src/evidence-store.js';
import {TodoStore} from '../src/todos.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const all:QueryScope={kind:'all'};
const at='2026-10-01T10:00:00Z';
const zone='Asia/Shanghai';

const localDate=(value:Date,tz:string)=>{
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'})
  .formatToParts(value).map(part=>[part.type,part.value]));
 return `${parts.year}-${parts.month}-${parts.day}`;
};
const todayAt=(tz:string,time:string)=>calendarInstant(localDate(new Date(),tz)+'T'+time,tz);

function fixture(t:TestContext){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-goals-'));
 return (async()=>{
  const config:ConfigurationPlatformOptions={path:dataDir+'/mote.yaml',privateCredential:{token:'generated-goals-owner',tokenPath:'fixture'},
   initialDocument:{version:1,revision:0,storage:{dataDir,maxExportBytes:1000000},
    server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},
    models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},
     embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}});
  await node.app.ready();
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const headers={authorization:'Bearer generated-goals-owner'};
  const capture=async(body:string)=>{
   const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/notes',headers,
    payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:at,text:body}});
   assert.equal(response.statusCode,201,response.body);return {id,body};
  };
  const memory=(source:{id:string;body:string},title:string)=>{
   const result:QueryResult={answer:JSON.stringify({memories:[{title,statement:`${title}: ${source.body} [${source.id}]`,
    uncertainty:'Generated identity',evidenceIds:[source.id]}]}),
    citations:[{id:source.id,capturedAt:at,appName:'Generated',excerpt:source.body}],trace:[],runId:randomUUID()};
   const draft=node.memories.extract(fixtureMemoryResult(node.memories,result),'generated').items[0]!;
   return node.memories.publish(draft.id,draft.version);
  };
  const matter=(goal:string)=>node.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal,scope:all},
   {currentEvidence:()=>[],currentTask:()=>undefined});
  const proposal=(commitmentId:string,source:{id:string;body:string},kind:CommitmentProposal['kind'],
   changes:CommitmentProposal['changes'],options:{direction?:'theirs'|'mine';summary?:string}={}):CommitmentProposal=>({
    commitmentId,eventId:randomUUID(),kind,occurredAt:null,summary:options.summary??source.body,changes,
    ...(options.direction?{direction:options.direction}:{}),evidence:[{id:source.id,quote:source.body,offset:0}],
    evidenceDependencies:{version:1,complete:true,ids:[source.id]}});
  const publish=(value:CommitmentProposal,expectedRevision?:number)=>node.featureServices.assistantCommitments.publish(value,expectedRevision,all,()=>{});
  const calendar=(source:{id:string;body:string},options:{status?:string;start?:string;end?:string;title?:string}={})=>{
   const record=node.store.evidence([source.id])[0]!;
   const fingerprint=sha256(JSON.stringify([record.id,record.ocrText,record.metadata,record.provenance,
    (record as typeof record&{fileEvidence?:unknown}).fileEvidence]));
   const id=randomUUID(),now=new Date().toISOString();
   const event={title:options.title??'Generated meeting',start:options.start??todayAt(zone,'15:00'),end:options.end??todayAt(zone,'16:00'),
    allDay:false,timeZone:zone,location:'',description:''};
   const value={id,kind:'calendar.create',event,uncertainty:'',
    evidence:[{id:source.id,quote:source.body,fingerprint,source:'Generated',capturedAt:at}],
    status:options.status??'succeeded',version:1,createdAt:now,updatedAt:now};
   node.store.db.prepare('INSERT INTO action_proposals VALUES(?,?)').run(id,JSON.stringify(value));
   return {id,event};
  };
  const goals=async(query:{group:'matter'|'person';scope:QueryScope;tz?:string})=>{
   const params=new URLSearchParams({group:query.group,scope:JSON.stringify(query.scope),...(query.tz?{tz:query.tz}:{})});
   return node.app.inject({method:'GET',url:'/api/assistant/goals?'+params,headers});
  };
  return {node,headers,capture,memory,matter,proposal,publish,calendar,goals};
 })();
}

const items=(groups:any[])=>groups.flatMap(group=>[...group.theirs,...group.mine,...group.unconfirmed]);
const find=(groups:any[],id:string)=>items(groups).find(item=>item.id===id);

test('GO1-01 generated commitments group by matter and by person',async t=>{
 const f=await fixture(t);
 const alice=await f.capture('Generated Alice from the studio owes a plan.'),bob=await f.capture('Generated Bob from the buyer owes a review.'),carol=await f.capture('Generated Carol from design owes a draft.');
 const personA=f.memory(alice,'Alice'),personB=f.memory(bob,'Bob'),personC=f.memory(carol,'Carol');
 const first=f.matter('Generated project one'),second=f.matter('Generated project two');
 f.publish(f.proposal(randomUUID(),alice,'commitment',{title:'Generated Alice plan',status:'confirmed',matterId:first.id,personMemoryId:personA.id},{direction:'theirs'}));
 f.publish(f.proposal(randomUUID(),bob,'commitment',{title:'Generated Bob review',status:'confirmed',matterId:second.id,personMemoryId:personB.id},{direction:'mine'}));
 f.publish(f.proposal(randomUUID(),carol,'commitment',{title:'Generated Carol draft',status:'confirmed',matterId:first.id,personMemoryId:personC.id},{direction:'mine'}));

 const byMatter=(await f.goals({group:'matter',scope:all,tz:zone})).json();
 const matterKeys=byMatter.groups.map((group:any)=>group.key);
 assert.deepEqual(matterKeys.filter((key:any)=>key.kind==='matter').map((key:any)=>key.id).sort(),[first.id,second.id].sort());
 const one=byMatter.groups.find((group:any)=>group.key.kind==='matter'&&group.key.id===first.id);
 assert.deepEqual(one.theirs.map((item:any)=>item.title),['Generated Alice plan']);
 assert.deepEqual(one.mine.map((item:any)=>item.title),['Generated Carol draft']);
 const two=byMatter.groups.find((group:any)=>group.key.kind==='matter'&&group.key.id===second.id);
 assert.deepEqual(two.mine.map((item:any)=>item.title),['Generated Bob review']);

 const byPerson=(await f.goals({group:'person',scope:all,tz:zone})).json();
 assert.deepEqual(byPerson.groups.map((group:any)=>group.key).sort((left:any,right:any)=>left.name.localeCompare(right.name)),
  [{kind:'person',name:'Alice'},{kind:'person',name:'Bob'},{kind:'person',name:'Carol'}]);
 assert.equal(byPerson.groups.find((group:any)=>group.key.name==='Alice').theirs[0].title,'Generated Alice plan');
});

test('GO1-02 rejecting an inferred commitment cancels it and removes it from goals',async t=>{
 const f=await fixture(t),source=await f.capture('Generated assistant thinks the owner promised a report.');
 const saved=f.publish(f.proposal(randomUUID(),source,'commitment',{title:'Generated inferred report',status:'pending_confirmation'},{direction:'mine'}));
 const before=(await f.goals({group:'matter',scope:all,tz:zone})).json();
 assert.equal(find(before.groups,saved.id)?.inferred,true);
 const rejected=await f.node.app.inject({method:'POST',url:`/api/assistant/goals/${saved.id}/action`,headers:f.headers,
  payload:{kind:'commitment',action:'reject',expectedRevision:saved.revision,scope:all}});
 assert.equal(rejected.statusCode,200,rejected.body);
 assert.equal(rejected.json().status,'cancelled');
 const after=(await f.goals({group:'matter',scope:all,tz:zone})).json();
 assert.equal(find(after.groups,saved.id),undefined);
});

test('GO1-03 following a commitment creates one routine and marks it handed to Mote',async t=>{
 const f=await fixture(t),source=await f.capture('Generated owner promised to send the roadmap.'),project=f.matter('Generated roadmap project');
 const saved=f.publish(f.proposal(randomUUID(),source,'commitment',{title:'Generated roadmap',status:'confirmed',matterId:project.id},{direction:'mine'}));
 const first=await f.node.app.inject({method:'POST',url:`/api/assistant/goals/${saved.id}/follow`,headers:f.headers,
  payload:{expectedRevision:saved.revision}});
 assert.equal(first.statusCode,200,first.body);
 assert.equal(first.json().followed,true);
 const repeated=await f.node.app.inject({method:'POST',url:`/api/assistant/goals/${saved.id}/follow`,headers:f.headers,
  payload:{expectedRevision:saved.revision}});
 assert.equal(repeated.statusCode,200,repeated.body);
 assert.equal(repeated.json().routineId,first.json().routineId);
 const view=(await f.goals({group:'matter',scope:all,tz:zone})).json(),item=find(view.groups,saved.id);
 assert.equal(item.followup.followed,true);
 assert.equal(item.actions.includes('follow'),false);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routines WHERE request_id=?').get(saved.id)!.n,1);
});

test('GO1-04 a deleted progress source removes that progress but keeps the commitment',async t=>{
 const f=await fixture(t),source=await f.capture('Generated owner promised to send the plan.'),progress=await f.capture('Generated the plan was sent yesterday.');
 const saved=f.publish(f.proposal(randomUUID(),source,'commitment',{title:'Generated plan delivery',status:'confirmed'}));
 f.publish(f.proposal(saved.id,progress,'progress',{}, {summary:progress.body}),saved.revision);
 const before=(await f.goals({group:'matter',scope:all,tz:zone})).json();
 assert.equal(find(before.groups,saved.id).lastProgress.summary,progress.body);
 assert.equal(find(before.groups,saved.id).lastProgress.evidenceId,progress.id);
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+progress.id,headers:f.headers});
 assert.equal(removed.statusCode,200,removed.body);
 const after=(await f.goals({group:'matter',scope:all,tz:zone})).json(),item=find(after.groups,saved.id);
 assert.ok(item,'the commitment remains after its progress source is deleted');
 assert.equal(item.lastProgress,undefined);
});

test('GO1-05 a deadline later today returns a due marker in the requested zone',async t=>{
 const f=await fixture(t),source=await f.capture('Generated owner promised a same-day reply.'),deadline=todayAt(zone,'23:59');
 const saved=f.publish(f.proposal(randomUUID(),source,'commitment',{title:'Generated same-day reply',status:'confirmed',deadline:{text:'今天',at:deadline}}));
 const view=(await f.goals({group:'matter',scope:all,tz:zone})).json(),item=find(view.groups,saved.id);
 assert.equal(item.due.at,deadline);
 assert.ok(['today','overdue'].includes(item.dueState),String(item.dueState));
});

test('GO1-06 a manually created goal enters mine without an inferred marker',async t=>{
 const f=await fixture(t),due={text:'Generated Friday',at:todayAt(zone,'18:00')};
 const created=await f.node.app.inject({method:'POST',url:'/api/assistant/goals',headers:f.headers,payload:{title:'Generated manual goal',due}});
 assert.equal(created.statusCode,201,created.body);
 const view=(await f.goals({group:'matter',scope:all,tz:zone})).json(),item=find(view.groups,created.json().id);
 assert.equal(item.kind,'todo');
 assert.equal(item.direction,'mine');
 assert.equal(item.inferred,false);
 assert.ok(view.groups.some((group:any)=>group.mine.some((value:any)=>value.id===item.id)));
});

test('GO1-07 theirs goes to waiting, while a legacy commitment without direction stays mine',async t=>{
 const f=await fixture(t),theirs=await f.capture('Generated Alex promised to send the file.'),mine=await f.capture('Generated the owner promised to review it.');
 const person=f.memory(theirs,'Generated Alex');
 const waiting=f.publish(f.proposal(randomUUID(),theirs,'commitment',{title:'Generated Alex file',status:'confirmed',personMemoryId:person.id},{direction:'theirs'}));
 const legacy=f.publish(f.proposal(randomUUID(),mine,'commitment',{title:'Generated owner review',status:'confirmed'}));
 const view=(await f.goals({group:'person',scope:all,tz:zone})).json();
 assert.equal(view.groups.find((group:any)=>group.key.kind==='person'&&group.key.name==='Generated Alex').theirs[0].id,waiting.id);
 assert.equal(find(view.groups,legacy.id).direction,'mine');
 assert.ok(view.groups.some((group:any)=>group.mine.some((value:any)=>value.id===legacy.id)));
});

test('GO1-08 a todo and a calendar event both enter mine with their own due markers',async t=>{
 const f=await fixture(t),source=await f.capture('Generated a calendar source for the review.'),base=Date.now()+3600000;
 const todo=new TodoStore(f.node.store).create({title:'Generated todo',dueAt:new Date(base).toISOString()});
 const event=f.calendar(source,{start:new Date(base).toISOString(),end:new Date(base+3600000).toISOString(),status:'succeeded'});
 const view=(await f.goals({group:'matter',scope:all,tz:zone})).json(),
  todoItem=find(view.groups,todo.id),eventItem=find(view.groups,event.id);
 assert.equal(todoItem.kind,'todo');
 assert.equal(eventItem.kind,'event');
 assert.ok(view.groups.some((group:any)=>group.mine.some((value:any)=>value.id===todo.id)));
 assert.ok(view.groups.some((group:any)=>group.mine.some((value:any)=>value.id===event.id)));
 assert.ok(todoItem.due.at);assert.ok(eventItem.due.at);
 assert.ok(todoItem.dueState);assert.ok(eventItem.dueState);
});
