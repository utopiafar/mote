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
