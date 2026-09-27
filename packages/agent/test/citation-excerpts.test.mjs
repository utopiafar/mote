import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startBridge} from '../dist/bridge.js';
import {parseAnswer} from '../dist/index.js';
import {sourceTextBoundaries} from '../../shared/dist/source-presentation.js';

const words='生成引句：“先做试页” / "quoted" \\ slash\n第二行 😀👩‍💻。';
function source(text=words,format='source-record-json-v1'){
  const raw=format==='speech-json-v1'?JSON.stringify({speaker:'SPEAKER_0',text}):JSON.stringify({captureId:randomUUID(),capturedAt:'2026-09-27T00:00:00Z',source:'message',appName:'Generated source',text});
  return {id:randomUUID(),capturedAt:'2026-09-27T00:00:00Z',appName:'Generated source',ocrText:raw,sourceType:'message',evidencePresentation:format,provenance:{revision:'generated-v1'}};
}
const readerFor=record=>({search:async()=>[record],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[record],devices:async()=>[],activity:async()=>({})});
const answer=bridge=>parseAnswer(JSON.stringify({answer:`Generated [${[...bridge.records.keys()][0]}]`,citationIds:[[...bridge.records.keys()][0]]}),bridge.records);
async function seeded(record,ranges,run){
  const bridge=await startBridge(readerFor(record),{question:'Generated citation preview',evidenceIds:[record.id],evidenceRanges:ranges.map(([offset,length])=>({id:record.id,offset,length}))},8);
  try{await run(bridge);}finally{await bridge.close();}
}
test('known source and speech wrappers display decoded text while original proof and ranges stay exact',async()=>{
  for(const format of ['source-record-json-v1','speech-json-v1']){
    const record=source(words,format);
    await seeded(record,[[0,record.ocrText.length]],async bridge=>{
      assert.equal(answer(bridge).citations[0].excerpt,words);
      assert.equal(bridge.seedEvidence[0].ocrText,record.ocrText);
      assert.deepEqual(bridge.records.get(record.id).deliveredRanges,[{...bridge.seedEvidence[0].textRange,text:record.ocrText}]);
      assert.equal(bridge.seedEvidence[0].evidencePresentation,undefined);
      assert.equal(answer(bridge).citations[0].provenance.revision,'generated-v1');
    });
  }
});
test('overlapping raw disclosures merge for display without repeating a quote or changing the proof ledger',async()=>{
  const record=source(),start=record.ocrText.indexOf('生成'),length=record.ocrText.length;
  await seeded(record,[[start,18],[0,length],[start,25]],async bridge=>{
    assert.equal(answer(bridge).citations[0].excerpt,words);
    assert.equal(bridge.records.get(record.id).deliveredRanges.length,3);
  });
  const plain={...source(),ocrText:'0123456789abcdefghijklmnopqrstuvwxyz',evidencePresentation:undefined};
  await seeded(plain,[[0,15],[8,20],[28,8]],async bridge=>assert.equal(answer(bridge).citations[0].excerpt,plain.ocrText));
});
test('unread gaps and tails never enter citation text, including a truncated JSON wrapper',async()=>{
  const record=source('已读前段\nUNREAD_GAP_MUST_NOT_APPEAR\n已读后段😀\nUNREAD_TAIL_MUST_NOT_APPEAR');
  const first=record.ocrText.indexOf('已读前段'),gap=record.ocrText.indexOf('UNREAD_GAP'),second=record.ocrText.indexOf('已读后段'),tail=record.ocrText.indexOf('UNREAD_TAIL');
  await seeded(record,[[first,gap-first],[second,tail-second]],async bridge=>{
    const excerpt=answer(bridge).citations[0].excerpt;
    assert.match(excerpt,/已读前段\n … 已读后段😀\n …$/u);assert.doesNotMatch(excerpt,/UNREAD|captureId|\\n/u);
    assert.ok(!JSON.stringify(bridge.seedEvidence).includes('UNREAD_'));
  });
  await seeded(record,[[0,first]],async bridge=>assert.equal(answer(bridge).citations[0].excerpt,'…'));
});
test('JSON escapes and surrogate pairs are decoded only when their complete raw spans were delivered',async()=>{
  const record=source('开头 "引号"\n😀 后段');record.ocrText=record.ocrText.replace('😀','\\ud83d\\ude00');
  const emoji=record.ocrText.indexOf('\\ud83d'),quote=record.ocrText.indexOf('\\"');
  await seeded(record,[[0,emoji+6]],async bridge=>{
    const excerpt=answer(bridge).citations[0].excerpt;assert.match(excerpt,/开头 "引号"\n …$/);assert.doesNotMatch(excerpt,/😀|[\uD800-\uDFFF]/u);
  });
  // Neither individual fragment contains the full escape; their raw union does.
  await seeded(record,[[0,emoji+4],[emoji+4,record.ocrText.length-emoji-4]],async bridge=>assert.equal(answer(bridge).citations[0].excerpt,'开头 "引号"\n😀 后段'));
  await seeded(record,[[quote+1,record.ocrText.length-quote-1]],async bridge=>{
    const excerpt=answer(bridge).citations[0].excerpt;assert.match(excerpt,/^… 引号"/u);assert.doesNotMatch(excerpt,/\\u|\\"/u);
  });
});
test('JSON-looking captures, unknown formats and incompatible schemas remain literal',async()=>{
  for(const change of [r=>{delete r.evidencePresentation;},r=>{r.evidencePresentation='custom-json';},r=>{r.ocrText=JSON.stringify({speaker:'SPEAKER_0',text:words,unexpected:'literal field'});r.evidencePresentation='speech-json-v1';}]){
    const record=source();change(record);
    await seeded(record,[[0,record.ocrText.length]],async bridge=>assert.equal(answer(bridge).citations[0].excerpt,record.ocrText));
  }
  assert.equal(sourceTextBoundaries('source-record-json-v1','{"text":"first","text":"second"}'),undefined);
});
test('source wrappers without a body disclose no invented preview text',async()=>{
  const record=source();const payload=JSON.parse(record.ocrText);delete payload.text;record.ocrText=JSON.stringify(payload);
  await seeded(record,[[0,record.ocrText.length]],async bridge=>assert.equal(answer(bridge).citations[0].excerpt,'…'));
});
test('display coordinates survive safe tool serialization, but never cross revisions or content layers',async()=>{
  const record=source(),bridge=await startBridge(readerFor(record),{question:'Generated open archive'},8);
  const call=async(tool,args)=>{const r=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(r.status,200);return r.json();};
  try{
    const first=await call('search_context',{query:'生成'});assert.equal(answer(bridge).citations[0].excerpt,words);
    assert.equal(first.data[0].ocrText,record.ocrText.slice(first.data[0].textRange.start,first.data[0].textRange.end));assert.equal(first.data[0].evidencePresentation,undefined);
    await call('evidence',{ids:[record.id],offset:0,length:record.ocrText.length});assert.equal(answer(bridge).citations[0].excerpt,words);
    delete record.evidencePresentation;
    await call('evidence',{ids:[record.id],offset:0,length:record.ocrText.length});assert.equal(answer(bridge).citations[0].excerpt,record.ocrText);
    record.evidencePresentation='source-record-json-v1';
    record.ocrText=source('新版本正文').ocrText;record.provenance.revision='generated-v2';
    await call('search_context',{query:'新版本'});assert.equal(answer(bridge).citations[0].excerpt,'新版本正文');
    record.contentLayer='L2_model_interpretation';record.ocrText=source('不替换原件').ocrText;
    await call('search_context',{query:'原件'});assert.equal(answer(bridge).citations[0].excerpt,'新版本正文');
  }finally{await bridge.close();}
});
test('preview character limits never split emoji at the display boundary',async()=>{
  const record=source('a'.repeat(559)+'😀'+words);
  await seeded(record,[[0,record.ocrText.length]],async bridge=>{
    const excerpt=answer(bridge).citations[0].excerpt;assert.equal(excerpt,'a'.repeat(559)+' …');assert.doesNotMatch(excerpt,/[\uD800-\uDFFF]/u);
  });
});
