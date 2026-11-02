#!/usr/bin/env node
/** Manual generated native-plugin journey: real buildApp/loopback, no fake host. */
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createTwoRuns,generatedNote} from '../test-fixtures/native-plugins/runs.mjs';
import {createAckLossProxy,createControlledHttpBoundary,createRequestGateProxy} from '../test-fixtures/native-plugins/faults.mjs';
import {createPrivateProcess} from '../test-fixtures/native-plugins/process.mjs';

function chunkedJson(base,path,body,token){
  const target=new URL(path,base);
  return new Promise((resolve,reject)=>{
    const request=httpRequest(target,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(Buffer.from(chunk)));response.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode,body:text?JSON.parse(text):undefined});
      });
    });
    request.on('error',reject);request.write(JSON.stringify(body));request.end();
  });
}

const report={status:'running',mode:process.argv.includes('--subprocess-restart')?'subprocess-restart':'in-process',runId:null,candidateSha:null,checks:[],layers:{T2:false,T3:false,T4:false}};
let failure;

async function inProcess(){
  const pair=await createTwoRuns({versions:['old','new']});
  try{
    report.runId=pair.runId;report.candidateSha=pair.candidateSha;
    const [oldRun,newRun]=pair.runs;
    assert.notEqual(oldRun.dataDir,newRun.dataDir);
    assert.notEqual(oldRun.token,newRun.token);
    assert.notEqual(oldRun.url,newRun.url);
    report.checks.push('two real loopback runs have distinct data dirs, tokens and origins');

    const oldNote=generatedNote('old');
    const newNote=generatedNote('new');
    assert.equal((await oldRun.writeNote(oldNote)).receipt.state,'received');
    assert.equal((await newRun.writeNote(newNote)).receipt.state,'received');
    assert.equal((await oldRun.readNote(oldNote.id)).ocrText,oldNote.text);
    assert.equal((await newRun.readNote(newNote.id)).ocrText,newNote.text);
    let isolated;
    try{await newRun.readNote(oldNote.id);}catch(error){isolated=error;}
    assert.equal(isolated?.status,404);
    report.layers.T2=true;
    report.checks.push('real producer/readback is isolated across the two runs');

    const lostNote=generatedNote('lost-ack');
    const proxy=await createAckLossProxy(oldRun.url,{path:'/api/notes'});
    try{
      let lost;
      try{await proxy.request('/api/notes',{method:'POST',body:lostNote,token:oldRun.token});}catch(error){lost=error;}
      assert.equal(lost?.status,502);
      assert.equal(lost?.code,'generated_receipt_lost');
      assert.equal(proxy.drops(),1);
      const retry=await oldRun.writeNote(lostNote);
      assert.equal(retry.receipt.duplicate,true);
      assert.equal((await oldRun.readNote(lostNote.id)).ocrText,lostNote.text);
      report.layers.T3=true;
      report.checks.push('lost ACK preserves the actual server error, then same-ID retry deduplicates and reads the original');
    }finally{await proxy.close();}

    const chunkedNote=generatedNote('chunked-ack');
    const chunkedProxy=await createAckLossProxy(oldRun.url,{path:'/api/notes'});
    try{
      const lost=await chunkedJson(chunkedProxy.url,'/api/notes',chunkedNote,oldRun.token);
      assert.equal(lost.status,502);
      assert.equal(lost.body.error,'generated_receipt_lost');
      const retry=await oldRun.writeNote(chunkedNote);
      assert.equal(retry.receipt.duplicate,true);
      assert.equal((await oldRun.readNote(chunkedNote.id)).ocrText,chunkedNote.text);
      report.checks.push('chunked producer request reaches Central through the ACK-loss proxy and retries by the same ID');
    }finally{await chunkedProxy.close();}

    const slow=await createControlledHttpBoundary({body:{ok:true}});
    try{
      const controller=new AbortController();
      const pending=fetch(slow.url,{signal:controller.signal}).catch(error=>error);
      await slow.waitForRequest();
      controller.abort();
      slow.release();
      assert.ok((await pending) instanceof Error);
      assert.equal(slow.state.requests,1);
      report.checks.push('explicit controlled boundary accepted cancellation without random delay');
    }finally{await slow.close();}

    await oldRun.restart();
    assert.equal((await oldRun.readNote(oldNote.id)).ocrText,oldNote.text);
    assert.equal((await oldRun.writeNote(oldNote)).receipt.duplicate,true);
    report.layers.T4=true;
    report.checks.push('same private profile restart preserves identity and does not duplicate the original');
  }finally{
    try{await pair.close();}catch(error){report.cleanupFailure=error instanceof Error?error.message:String(error);throw error;}
  }
}

async function subprocessRestart(){
  const run=await createPrivateProcess({version:'process-restart'});
  const gate=await createRequestGateProxy(run.url,{path:'/api/notes'});
  try{
    report.runId=run.runId;report.candidateSha=run.candidateSha;
    const note=generatedNote('process-restart');
    const pending=gate.request('/api/notes',{method:'POST',body:note,token:run.token});
    await gate.waitForHeld();
    await run.stop();
    await run.restart();
    gate.release();
    const ack=await pending;
    assert.equal(ack.receipt.state,'received');
    assert.equal((await run.readNote(note.id)).ocrText,note.text);
    assert.equal((await run.writeNote(note)).receipt.duplicate,true);
    report.layers.T4=true;
    report.checks.push('actual index.ts private profile stopped and restarted; held real producer completed late and same identity deduplicated');
  }finally{
    const errors=[];try{await gate.close();}catch(error){errors.push(error);}try{await run.close();}catch(error){errors.push(error);}
    if(errors.length){report.cleanupFailure=errors.map(error=>error instanceof Error?error.message:String(error)).join('; ');throw new AggregateError(errors,'Native plugin subprocess cleanup failed');}
  }
}

try{
  if(report.mode==='subprocess-restart')await subprocessRestart();
  else await inProcess();
  report.status='passed';
}catch(error){
  report.status='failed';failure=error;report.failure=error instanceof Error?error.message:String(error);
}finally{
  console.log(JSON.stringify(report,null,2));
  if(failure)process.exitCode=1;
}
