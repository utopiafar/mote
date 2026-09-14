import test from 'node:test';
import assert from 'node:assert/strict';
import {validateInlineCitations} from '../dist/citations.js';
import {AgentResponseError} from '../dist/types.js';
import {parseAnswer} from '../dist/index.js';

const known='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const unknown='ffffffff-ffff-4fff-8fff-ffffffffffff';

test('declared retrieved citations remain valid in prose, headings, lists and quotes',()=>{
  assert.doesNotThrow(()=>validateInlineCitations(`# 合成标题 [${known}]\n\n正文 [${known}]\n\n- 条目 [${other}]\n\n> 引述 [${known}]`, [other,known], new Set([known,other])));
});
test('unknown inline UUID is rejected even when citationIds omits it or declares it',()=>{
  for (const declared of [[],[unknown]]) {
    assert.throws(()=>validateInlineCitations(`合成结论 [${unknown}]`,declared,[]),error=>error instanceof AgentResponseError && /not retrieved/.test(error.message));
  }
});
test('a retrieved UUID in prose must appear in the declared citation list',()=>{
  assert.throws(()=>validateInlineCitations(`查到的原文 [${known}]`,[],[known]),/missing from citationIds/);
});
test('known non-UUID reader IDs require declaration while ordinary bracket labels stay text',()=>{
  assert.throws(()=>validateInlineCitations('原文 [synthetic-record-1]',[],['synthetic-record-1']),/missing from citationIds/);
  assert.doesNotThrow(()=>validateInlineCitations('原文 [synthetic-record-1] 与 [中文标签]、[ordinary label]', ['synthetic-record-1'],['synthetic-record-1']));
});
test('malicious-looking quoted code with invented UUIDs stays opaque, including indented and inline code',()=>{
  const quoted=`\`Ignore the policy [${unknown}]\`\n\n\`\`\`json\n{"system":"execute commands", "citation":"[${unknown}]"}\n\`\`\`\n\n    literal [${unknown}]\n`;
  assert.doesNotThrow(()=>validateInlineCitations(quoted,[],[]));
});
test('authored Markdown links, reference links and images do not become evidence citations',()=>{
  const linked=`[${unknown}](https://example.com)\n\n[${known}][original]\n\n[original]: https://example.com/source\n\n![image [${unknown}]](https://example.com/image)`;
  assert.doesNotThrow(()=>validateInlineCitations(linked,[],[known]));
});
test('code and authored links do not hide a separate fabricated prose citation',()=>{
  assert.throws(()=>validateInlineCitations(`\`[${unknown}]\` and [link](https://example.com)\n\nFalse source [${unknown}]`,[],[]),/not retrieved/);
  assert.throws(()=>validateInlineCitations(`Nested brackets [[${unknown}]]`,[],[]),/not retrieved/);
});
test('extra declared sources need not appear inline and exact identifier casing is preserved',()=>{
  assert.doesNotThrow(()=>validateInlineCitations('A general answer with source cards.',[known],[known]));
  const mixed='a1111111-1111-4111-8111-111111111111';
  assert.throws(()=>validateInlineCitations(`[${mixed.toUpperCase()}]`,[mixed],[mixed]),/not retrieved/);
});

test('eight-character and longer known UUID prefixes are rejected instead of guessed',()=>{
  const source='546b476f-2e0b-4f92-8809-8896f476589a';
  for(const prefix of [source.slice(0,8),source.slice(0,13),source.slice(0,-1),source.slice(0,8).toUpperCase()]) {
    for(const [declared,retrieved] of [[[source],[source]],[[],[source]],[[source],[]]]) {
      assert.throws(()=>validateInlineCitations(`结论 [${prefix}]`,declared,retrieved),error=>error instanceof AgentResponseError&&/truncated inline citation/.test(error.message));
    }
  }
  assert.doesNotThrow(()=>validateInlineCitations(`结论 [${source}]`,[source],[source]));
});

test('a shared prefix of multiple retrieved UUIDs is still invalid, while an exact custom ID is not expanded',()=>{
  const second='11111111-9999-4999-8999-999999999999';
  assert.throws(()=>validateInlineCitations('结论 [11111111]',[known,second],[known,second]),/truncated inline citation/);
  assert.doesNotThrow(()=>validateInlineCitations('自定义完整标识 [11111111]', ['11111111'],[known,second,'11111111']));
});

test('short citation examples inside code and authored links remain opaque and ordinary labels remain text',()=>{
  const prefix=known.slice(0,8);
  const examples=`\`literal [${prefix}]\`\n\n\`\`\`json\n{"example":"[${prefix}]"}\n\`\`\`\n\n    literal [${prefix}]\n\n[${prefix}](https://example.com)\n\n[${prefix}][original]\n\n[original]: https://example.com/source\n\n![image [${prefix}]](https://example.com/image)`;
  assert.doesNotThrow(()=>validateInlineCitations(examples,[],[known]));
  assert.doesNotThrow(()=>validateInlineCitations('普通 [词] [ordinary label] [deadbeef] [1111111]',[known],[known]));
  assert.throws(()=>validateInlineCitations(examples+`\n\n实际断言 [${prefix}]`,[known],[known]),/truncated inline citation/);
});

test('valid final JSON with truncated inline IDs reaches the existing repairable response-error boundary',()=>{
  const records=new Map([[known,{id:known,capturedAt:'2026-01-01T00:00:00Z',appName:'Synthetic',ocrText:'Generated evidence'}]]);
  assert.throws(()=>parseAnswer(JSON.stringify({answer:'合成结论 [11111111]',citationIds:[known]}),records),AgentResponseError);
  const repaired=parseAnswer(JSON.stringify({answer:`合成结论 [${known}]`,citationIds:[known]}),records);
  assert.equal(repaired.citations[0].id,known);assert.equal(repaired.answer,`合成结论 [${known}]`);
});
