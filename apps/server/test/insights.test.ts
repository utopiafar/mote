import {test} from 'node:test';
import assert from 'node:assert/strict';
import {staticReportHtml,insightResult} from '../src/insights.js';

const id='11111111-1111-4111-8111-111111111111',missing='22222222-2222-4222-8222-222222222222';
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
