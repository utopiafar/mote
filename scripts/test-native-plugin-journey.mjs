#!/usr/bin/env node
/** Manual generated native-plugin journey: real buildApp/loopback, no fake host. */
import assert from 'node:assert/strict';
import {createTwoRuns,generatedNote} from '../test-fixtures/native-plugins/runs.mjs';
import {createAckLossProxy,createControlledHttpBoundary} from '../test-fixtures/native-plugins/faults.mjs';

const report={status:'running',runId:null,candidateSha:null,checks:[],layers:{T2:false,T3:false,T4:false}};
let pair,failure;
try{
  pair=await createTwoRuns({versions:['old','new']});
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
  report.status='passed';
}catch(error){
  report.status='failed';failure=error;report.failure=error instanceof Error?error.message:String(error);
}finally{
  await pair?.close();
  report.runs=pair?.runs.map(run=>run.metadata())??[];
  console.log(JSON.stringify(report,null,2));
  if(failure)process.exitCode=1;
}
