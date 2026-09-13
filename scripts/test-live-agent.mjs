#!/usr/bin/env node
// Opt-in live tests against an explicitly configured private central node.
// Inputs and full answers are private files. Stdout contains only numeric test results.
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const argv=process.argv.slice(2);
const arg=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];};
if(argv.includes('--help')) {
 console.info('node scripts/test-live-agent.mjs --connection PRIVATE.json --facts PRIVATE.json --cases PRIVATE.json --out .mote/live-results\nUses real model configured by that node. Writes full responses privately, never prints text or tokens.');process.exit(0);
}
for(const flag of ['--connection','--facts','--cases','--out'])if(!arg(flag))throw new Error(`Required: ${flag} (use --help)`);
const connection=JSON.parse(await readFile(resolve(arg('--connection')),'utf8'));
const base=new URL(connection.url);
assert.ok(!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/');
assert.ok(base.protocol==='https:'||(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)));
assert.ok(typeof connection.token==='string'&&connection.token.length>=24);
const output=resolve(arg('--out'));await mkdir(output,{recursive:true,mode:0o700});await chmod(output,0o700);
const facts=JSON.parse(await readFile(resolve(arg('--facts')),'utf8')).records;
const cases=JSON.parse(await readFile(resolve(arg('--cases')),'utf8')).cases;
assert.ok(Array.isArray(facts)&&facts.length<=2000&&Array.isArray(cases)&&cases.length<=40);
async function call(path,body) {
 const r=await fetch(base.origin+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+connection.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(180000)});
 return {status:r.status,body:await r.json()};
}
let imported=0,duplicates=0;
for(const fact of facts) {
 const note={id:fact.id,deviceId:'private-fact-validation',deviceName:'Private Fact validation',platform:'import',capturedAt:fact.capturedAt,text:fact.text};
 const r=await call('/api/notes',note);assert.ok([200,201].includes(r.status),`Fact ingestion HTTP ${r.status}`);assert.equal(r.body.id,note.id);
 r.body.duplicate?duplicates++:imported++;
 const saved=await call('/api/notes/'+fact.id);assert.equal(saved.status,200);assert.equal(saved.body.ocrText,fact.text);assert.equal(saved.body.blobHash,null);
}
console.info(JSON.stringify({phase:'ingest',records:facts.length,imported,duplicates,exactTextRoundTrips:facts.length}));
const results=[];let windowStart=Date.now(),inWindow=0;
for(const [index,test] of cases.entries()) {
 if(inWindow>=8){await delay(Math.max(0,62000-(Date.now()-windowStart)));windowStart=Date.now();inWindow=0;}
 const started=Date.now();inWindow++;
 let response;
 try{response=await call(test.path||'/api/query',{question:test.question,timeZone:'Asia/Shanghai',deviceId:'private-fact-validation',...test.range});}
 catch(error){response={status:0,body:{errorType:error.name,message:'Transport failed or request timed out'}};}
 const ids=response.body.citations?.map(item=>item.id)||[];
 const expected=test.requiredEvidenceIds||[];
 const summary={case:index+1,status:response.status,durationMs:Date.now()-started,answerChars:response.body.answer?.length||0,citationCount:ids.length,expectedEvidence:expected.length,expectedEvidenceCited:expected.filter(id=>ids.includes(id)).length,toolCalls:response.body.trace?.length||0,tools:response.body.trace?.map(step=>step.tool)||[]};
 results.push(summary);
 await writeFile(join(output,`case-${String(index+1).padStart(2,'0')}-private.json`),JSON.stringify({caseId:test.id,question:test.question,expectedEvidenceIds:expected,...response,summary},null,2),{mode:0o600});
 await writeFile(join(output,'summary.json'),JSON.stringify({model:connection.model,reasoningEffort:connection.reasoningEffort??"unspecified",imported,duplicates,records:facts.length,results},null,2),{mode:0o600});
 console.info(JSON.stringify(summary));
}
if(results.some(r=>r.status!==200))process.exitCode=1;
