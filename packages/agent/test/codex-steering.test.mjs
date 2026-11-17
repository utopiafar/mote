import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexSession} from '../dist/codex-session.js';
import {createAgent} from '../dist/index.js';

async function until(check){const end=Date.now()+5000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated steering transport did not settle');}
async function fixture(t,mode='accepted'){
  const root=await mkdtemp(join(tmpdir(),'mote-codex-steering-')),executable=join(root,'generated-codex'),rpcPath=join(root,'rpc.ndjson');
  await writeFile(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-steering-secret'}),{mode:0o600});
  await writeFile(executable,`#!${process.execPath}
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let turn=0;
const finish=()=>{send({method:'item/completed',params:{threadId:'generated-thread',turnId:'generated-turn-'+turn,item:{id:'message-'+turn,type:'agentMessage',text:JSON.stringify({answer:'Generated adjusted answer '+turn,citationIds:[]})}}});send({method:'turn/completed',params:{threadId:'generated-thread',turn:{id:'generated-turn-'+turn,status:'completed'}}});};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},line+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread'},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){turn++;send({id:m.id,result:{turn:{id:'generated-turn-'+turn}}});send({method:'turn/started',params:{threadId:'generated-thread',turn:{id:'generated-turn-'+turn,status:'inProgress'}}});
  if(${JSON.stringify(mode)}==='pre-ack-draft')send({method:'item/completed',params:{threadId:'generated-thread',turnId:'generated-turn-'+turn,item:{id:'old-draft',type:'agentMessage',text:'Generated pre-correction answer'}}});
  if(${JSON.stringify(mode)}==='stale-turn'&&turn>1){send({id:9007,method:'item/tool/call',params:{threadId:'generated-thread',turnId:'generated-turn-1',tool:'generated_stale_tool',arguments:{}}});send({method:'item/completed',params:{threadId:'generated-thread',turnId:'generated-turn-1',item:{id:'stale-answer',type:'agentMessage',text:'Generated stale answer'}}});send({method:'turn/completed',params:{threadId:'generated-thread',turn:{id:'generated-turn-1',status:'completed'}}});}
 }
 else if(m.method==='turn/steer'){if(m.params.expectedTurnId!=='generated-turn-'+turn)process.exit(5);
  if(${JSON.stringify(mode)}==='terminal-before-ack')finish();
  send({id:m.id,result:{turnId:${JSON.stringify(mode)}==='wrong-ack'?'generated-other-turn':'generated-turn-'+turn}});
  if(${JSON.stringify(mode)}==='pre-ack-draft')send({method:'turn/completed',params:{threadId:'generated-thread',turn:{id:'generated-turn-'+turn,status:'completed'}}});else if(${JSON.stringify(mode)}==='same-frame')finish();else if(${JSON.stringify(mode)}!=='terminal-before-ack')setTimeout(finish,10);
 }
});
`,{mode:0o700});
  const session=new CodexSession({model:'generated-steering-model',agentTimeoutMs:5000,codex:{executable,home:root}},async()=>{throw Error('No generated tool call');});
  t.after(async()=>{await session.close();await rm(root,{recursive:true,force:true});});
  await session.start('Generated Host policy',[]);
  const rpc=async()=>{try{return (await readFile(rpcPath,'utf8')).trim().split('\n').map(JSON.parse);}catch{return [];}};
  const begin=async()=>{const running=session.run('Generated original task');void running.catch(()=>{});await until(async()=>(await rpc()).filter(row=>row.method==='turn/start').length);return {running};};
  return {session,rpc,begin,root,executable};
}

test('Codex text steering uses the current native turn and its actual ACK, without starting a replacement prompt',async t=>{
  const f=await fixture(t);assert.equal(typeof f.session.steeringTarget,'function');
  const {running}=await f.begin(),target=await until(()=>f.session.steeringTarget());
  assert.equal(target.turnId,'generated-turn-1');assert.deepEqual(await f.session.steer(target.turnId,'Generated owner correction'),{turnId:target.turnId});
  assert.equal(JSON.parse(await running).answer,'Generated adjusted answer 1');assert.equal(f.session.steeringTarget(),undefined);
  const rpc=await f.rpc();assert.equal(rpc.filter(row=>row.method==='turn/start').length,1);assert.deepEqual(rpc.find(row=>row.method==='turn/steer').params,{threadId:'generated-thread',expectedTurnId:target.turnId,input:[{type:'text',text:'Generated owner correction',text_elements:[]}]});
});

for(const mode of ['wrong-ack','terminal-before-ack'])test(`Codex steering rejects ${mode} instead of claiming the correction was applied`,async t=>{
  const f=await fixture(t,mode);assert.equal(typeof f.session.steeringTarget,'function');const {running}=await f.begin(),target=await until(()=>f.session.steeringTarget());
  await assert.rejects(f.session.steer(target.turnId,'Generated late correction'));await assert.rejects(running);assert.equal(f.session.steeringTarget(),undefined);
});

test('a completed native turn cannot steer the next turn in the same process',async t=>{
  const f=await fixture(t);assert.equal(typeof f.session.steeringTarget,'function');let {running}=await f.begin();const first=await until(()=>f.session.steeringTarget());await f.session.steer(first.turnId,'Generated first correction');await running;
  running=f.session.run('Generated next task');void running.catch(()=>{});const second=await until(()=>f.session.steeringTarget());assert.notEqual(second.turnId,first.turnId);
  await assert.rejects(f.session.steer(first.turnId,'Generated stale correction'));assert.equal((await f.rpc()).filter(row=>row.method==='turn/steer').length,1);
  await f.session.steer(second.turnId,'Generated current correction');assert.equal(JSON.parse(await running).answer,'Generated adjusted answer 2');
});

test('late native items, tool calls and terminal events keep their original turn fence',async t=>{
  const f=await fixture(t,'stale-turn');let {running}=await f.begin();const first=await until(()=>f.session.steeringTarget());await f.session.steer(first.turnId,'Generated first correction');await running;
  running=f.session.run('Generated next task');void running.catch(()=>{});const second=await until(()=>f.session.steeringTarget());
  const rejection=await until(async()=>(await f.rpc()).find(row=>row.id===9007));assert.equal(rejection.error.code,-32600);assert.deepEqual(f.session.steeringTarget(),second);
  await f.session.steer(second.turnId,'Generated current correction');assert.equal(JSON.parse(await running).answer,'Generated adjusted answer 2');
});

test('a native draft completed before the steering ACK cannot become the adjusted answer',async t=>{
  const f=await fixture(t,'pre-ack-draft'),{running}=await f.begin(),target=await until(()=>f.session.steeringTarget());
  await f.session.steer(target.turnId,'Generated owner correction');assert.equal(await running,'','the Host must obtain a current candidate instead of accepting the old draft');
});

for(const fail of [false,true])test(`Host output waits for its local steering receipt commit after a same-frame native ACK/terminal (${fail?'failure':'success'})`,async t=>{
  const f=await fixture(t,'same-frame'),reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],devices:async()=>[],activity:async()=>({})};
  const agent=createAgent({provider:'codex',protocol:'codex-app-server',model:'generated-steering-model',codex:{executable:f.executable,home:f.root},reader,agentTimeoutMs:5000});let control,committed=false;
  try{
    const running=agent.query({question:'Generated active Host work',onRuntimeControl:port=>{control=port;return()=>{control=undefined;};},validateOutput:()=>{assert.equal(committed,true,'a candidate cannot precede the actual Host receipt commit');}});void running.catch(()=>{});
    const target=await until(()=>control?.current()),failure=Error('Generated local accepted-write failure');
    const steering=control.steer(target,'Generated owner correction',()=>{if(fail)throw failure;committed=true;});
    if(fail){await assert.rejects(steering,error=>error===failure);await assert.rejects(running,error=>error===failure);}else{await steering;assert.equal((await running).answer,'Generated adjusted answer 1');}
    assert.equal(control,undefined,'cleanup withdraws the old local port');
  }finally{await agent.close();}
});

test('real Host repair must not accept an old native item and terminal before the next turn/start ACK',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-steer-start-fence-')),binary=join(root,'generated-codex'),log=join(root,'rpc.ndjson');
 await writeFile(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-private-fence-key'}),{mode:0o600});
 await writeFile(binary,`#!${process.execPath}
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let turn=0;
const item=(id,text)=>({method:'item/completed',params:{threadId:'generated-thread',turnId:id,item:{id:'message-'+id,type:'agentMessage',text}}});
const terminal=id=>({method:'turn/completed',params:{threadId:'generated-thread',turn:{id,status:'completed'}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify({...m,pid:process.pid})+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread'},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  turn++;const id='generated-turn-'+turn;
  if(turn===1){send({id:m.id,result:{turn:{id}}});send(item(id,'Generated invalid initial response requiring the existing bounded repair'));send(terminal(id));}
  else {
   // Delayed transport frames from the settled first native turn arrive while
   // the new turn/start request still awaits its own native ACK.
   send(item('generated-turn-1',JSON.stringify({answer:'STALE_PRE_ACK_OLD_TURN_RESULT',citationIds:[]})));
   send(terminal('generated-turn-1'));
   send({id:m.id,result:{turn:{id}}});
   send(item(id,JSON.stringify({answer:'CURRENT_NATIVE_REPAIR_RESULT',citationIds:[]})));send(terminal(id));
  }
 }
});
`,{mode:0o700});
 const reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],devices:async()=>[],activity:async()=>({})};
 const agent=createAgent({provider:'codex',protocol:'codex-app-server',model:'generated-fence-model',codex:{executable:binary,home:root},reader,agentTimeoutMs:5000});
 t.after(async()=>{await agent.close();await rm(root,{recursive:true,force:true});});
 const answer=await agent.query({question:'Generated owner request; use the current repair candidate'});
 const rpc=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),starts=rpc.filter(row=>row.method==='turn/start');
 console.log('INDEPENDENT_PRE_ACK_NATIVE_MEASURED',JSON.stringify({answer:answer.answer,turnStarts:starts.length,pids:[...new Set(starts.map(row=>row.pid))],toolCalls:answer.trace.length}));
 assert.equal(starts.length,2,'the actual existing Host repair must run, without an extra prompt or relaxed repair budget');
 assert.equal(answer.answer,'CURRENT_NATIVE_REPAIR_RESULT','an explicitly old native terminal cannot complete the new Host attempt before its start ACK');
});

for(const early of ['tool','terminal'])test(`the next native start ACK admits its early current ${early} frames and rejects old tools`,{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-start-current-')),binary=join(root,'generated-codex'),log=join(root,'rpc.ndjson');
 await writeFile(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-start-key'}),{mode:0o600});
 await writeFile(binary,`#!${process.execPath}
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let turn=0;
const item=(id,text)=>({method:'item/completed',params:{threadId:'generated-thread',turnId:id,item:{id:'message-'+id,type:'agentMessage',text}}});
const terminal=id=>({method:'turn/completed',params:{threadId:'generated-thread',turn:{id,status:'completed'}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify({...m,pid:process.pid})+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread'},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  turn++;const id='generated-turn-'+turn;
  if(turn===1){send({id:m.id,result:{turn:{id}}});send(item(id,'Generated first result'));send(terminal(id));}
  else {
   send({id:9007,method:'item/tool/call',params:{threadId:'generated-thread',turnId:'generated-turn-1',tool:'generated_read',arguments:{generation:'old'}}});send(item('generated-turn-1','Generated old result'));send(terminal('generated-turn-1'));
   if(${JSON.stringify(early)}==='tool')send({id:9008,method:'item/tool/call',params:{threadId:'generated-thread',turnId:id,tool:'generated_read',arguments:{generation:'current'}}});
   send(item(id,'Generated current result'));
   if(${JSON.stringify(early)}==='terminal')send(terminal(id));
   send({id:m.id,result:{turn:{id}}});
  }
 }else if(m.id===9008){if(m.result?.success!==true)process.exit(4);send(terminal('generated-turn-2'));}
});
`,{mode:0o700});
 const calls=[],session=new CodexSession({model:'generated-start-model',agentTimeoutMs:5000,codex:{executable:binary,home:root}},async(name,args,callId)=>{calls.push({name,args,callId});return{generated:true};});
 t.after(async()=>{await session.close();await rm(root,{recursive:true,force:true});});
 await session.start('Generated Host policy',[{type:'function',name:'generated_read',description:'Generated read-only tool',inputSchema:{type:'object'}}]);
 assert.equal(await session.run('Generated first request'),'Generated first result');assert.equal(await session.run('Generated next request'),'Generated current result');
 const rpc=await until(async()=>{const entries=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);return entries.some(row=>row.id===9007)&&(!(early==='tool')||entries.some(row=>row.id===9008))?entries:undefined;});
 assert.equal(rpc.find(row=>row.id===9007).error.code,-32600,'an old tool never reaches the tool callback');
 assert.deepEqual(calls,early==='tool'?[{name:'generated_read',args:{generation:'current'},callId:'9008'}]:[]);
 assert.equal(rpc.filter(row=>row.method==='turn/start').length,2);assert.equal(new Set(rpc.map(row=>row.pid)).size,1);
});
