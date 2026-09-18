/** Opt-in regression against the local Codex App Server. Generated data only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAgent,type ContextRecord,type QueryInput} from '../packages/agent/src/index.js';
const id=randomUUID(),other=randomUUID();
const original:ContextRecord={id,capturedAt:'2026-09-18T00:00:00Z',appName:'Generated observatory',deviceId:'generated',ocrText:'Synthetic background without opening hours. '.repeat(500)+'\nANCHOR_ZETA: The revised opening is Thursday at 16:45. The previous Wednesday 14:30 plan is cancelled.\n'+'Synthetic appendix. '.repeat(80)};
const old:ContextRecord={...original,id:other,ocrText:'Outdated draft: Wednesday at 14:30. Superseded by the revised ANCHOR_ZETA schedule.',capturedAt:'2026-09-17T00:00:00Z'};
let retrieval=0;
const agent=createAgent({provider:'codex',protocol:'codex-app-server',model:process.env.MOTE_TEST_CODEX_MODEL??'gpt-6-astra',reasoningEffort:'low',agentTimeoutMs:180000,reader:{
 search:async()=>{retrieval++;return [original,old];},timeline:async()=>{retrieval++;return [original,old];},evidence:async({ids})=>[original,old].filter(r=>ids.includes(r.id)),activity:async()=>({}),devices:async()=>[],
}});
async function run(name:string,input:QueryInput,check:(result:Awaited<ReturnType<typeof agent.query>>)=>void){const start=Date.now();const result=await agent.query(input);check(result);console.log(JSON.stringify({name,ok:true,durationMs:Date.now()-start,tools:result.trace.map(t=>t.tool),citations:result.citations.length,answer:result.answer,personalDataUsed:false}));return result;}
try{
 const summary=await run('long-working-context',{question:'Compact this dialogue into at most 1800 characters. Preserve explicit rejected proposals and unresolved decisions.',skill:'working-memory',language:'en',taskContext:{turns:[{turnId:'first',question:'Never upload the project to a public cloud. I explicitly reject cloud deployment.',answer:'Understood; local-only remains required.'},...Array.from({length:12},(_,i)=>({turnId:'generated-'+i,question:'Generated progress '+i,answer:'Synthetic context filler; no change to prior constraints. '.repeat(50)})),{turnId:'last',question:'The export date is undecided.',answer:'Awaiting a decision.'}]}},r=>{assert.equal(r.trace.length,0);assert.equal(r.citations.length,0);assert.match(r.answer,/cloud/i);assert.match(r.answer,/reject|never|not|prohibit|local.only/i);assert.ok(r.answer.length<=1800);});
 assert.equal(retrieval,0,'working task cannot call archive retrieval');
 await run('followup-retains-rejected-option',{question:'Can we now publish the project to a public cloud based on our earlier decisions?',language:'en',conversation:{turns:[],omittedTurns:0,workingMemory:{text:summary.answer,coveredTurns:14,generatedAt:new Date().toISOString()}}},r=>{assert.match(r.answer,/no|not|reject|prohibit/i);assert.match(r.answer,/cloud/i);});
 await run('late-evidence-and-conflicting-old-record',{question:'Search ANCHOR_ZETA. Read the relevant original evidence range and report the revised opening day and time, explicitly distinguishing the superseded draft. Cite the source. Do not assume the first preview is the full document.',language:'en'},r=>{assert.match(r.answer,/Thursday/);assert.match(r.answer,/16:45/);assert.ok(r.citations.some(c=>c.id===id));assert.ok(r.trace.some(t=>t.tool==='evidence'));assert.match(r.citations.find(c=>c.id===id)!.excerpt,/16:45/);});
}finally{await agent.close();}
