import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildContextEnvelope,prepareTaskContext,skillCatalog} from '@mote/agent';
import {staticReportHtml,insightResult,validateInsightOutput} from '../src/insights.js';

const id='11111111-1111-4111-8111-111111111111',missing='22222222-2222-4222-8222-222222222222';
test('plain text and malformed JSON request repair instead of completing without a report',()=>{
 for(const answer of ['Generated ordinary prose','{broken JSON','{}','null','{"title":"Generated","markdown":"","html":"<p>Empty</p>"}']){
  const value={answer,citations:[],trace:[],runId:'generated-invalid-report'};
  assert.throws(()=>insightResult(value),{statusCode:502});
  assert.equal(validateInsightOutput(value)?.code,'insight_shape');
 }
 assert.equal(validateInsightOutput({answer:JSON.stringify({title:'Generated',markdown:'No evidence in this generated window.',html:'<p>No evidence in this generated window.</p>'}),citations:[],trace:[],runId:'generated-valid-report'}),undefined);
});
test('registered insight descriptor assembles a partial snapshot and its report passes host validation',()=>{
 const sourceStates=Array.from({length:32},(_,i)=>({sourceId:'generated-source-'+i,state:'ready'})),snapshot={version:3,seriesId:'generated-series',asOf:'2026-10-01T00:00:00Z',scope:{after:'2026-09-01T00:00:00Z',before:'2026-10-01T00:00:00Z',timeZone:'UTC'},coverage:{sourceStates,limitations:['generated_partial']}};
 const input={question:'Generated review',skill:'personal-insight',responseMode:'personal-insight',insightSnapshot:snapshot},prepared=prepareTaskContext(input),envelope=buildContextEnvelope(input,[]);
 assert.equal(prepared.id,'insight');assert.equal(prepared.version,'1');assert.equal(prepared.responseMode,'personal-insight');assert.equal(prepared.skill?.version,'1.0.5');
 assert.equal(envelope.taskId,'insight');assert.deepEqual(envelope.taskProfile,{output:'personal-insight',retrieval:'archive'});assert.equal(envelope.hostInsightSnapshot.coverage.sourceStates.length,30);assert.equal(envelope.hostInsightSnapshot.coverage.sourceStatesTotal,32);assert.equal(envelope.hostInsightSnapshot.coverage.sourceStatesTruncated,true);
 const candidate={answer:JSON.stringify({title:'Generated partial review',markdown:'Only the inspected samples are described.',html:'<p>Only the inspected samples are described.</p>'}),citations:[],trace:[],runId:'generated-insight'};
 assert.equal(validateInsightOutput(candidate),undefined);assert.equal(snapshot.coverage.sourceStates.length,32,'assembly never mutates the host snapshot');
});
test('stored report provenance identifies the selected insight policy version',()=>{
  const result=insightResult({answer:JSON.stringify({title:'Generated recap',markdown:`A bounded observation [${id}]`,html:`<p>A bounded observation [${id}]</p>`}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:'Generated fixture'}],trace:[],runId:'generated-run'});
  assert.equal(result.artifact?.skillId,'personal-insight');
  assert.equal(result.artifact?.skillVersion,skillCatalog().find(skill=>skill.id==='personal-insight')?.version);
});
test('HTML report citations follow the same retrieved-ID boundary as its Markdown fallback',()=>{
  const result={answer:JSON.stringify({title:'Generated report',markdown:`Supported [${id}]`,html:`<p>Unsupported [${missing}]</p>`}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:'Generated fixture'}],trace:[],runId:'generated-run'};
  assert.throws(()=>insightResult(result),/not retrieved/);
  assert.throws(()=>staticReportHtml(`<p>&#91;<span>${missing}</span>&#93;</p>`,[id]),/not retrieved/);
  assert.throws(()=>staticReportHtml(`<p>[${id.slice(0,8)}]</p>`,[id]),/truncated/);
  assert.throws(()=>staticReportHtml(`<p>[${missing}](ordinary visible text)</p>`,[id]),/not retrieved/);
});

test('HTML report validation handles formatted visible references without treating styles or code examples as prose',()=>{
  const html=staticReportHtml(`<style>p[data-label="[${missing}]"]{color:green}</style><p>&#91;<strong>${id}</strong>&#93;</p><pre>[${missing}]</pre><code>[${missing}]</code>`,[id]);
  assert.match(html,/color:green/);assert.match(html,new RegExp(`<strong>${id}</strong>`));assert.match(html,new RegExp(`<pre>\\[${missing}\\]</pre>`));
});
