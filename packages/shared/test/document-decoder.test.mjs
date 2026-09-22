import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDocument,documentChunks} from '../dist/document-decoder.js';
const none=async()=>{throw Error('Unexpected library load');};
test('PDF text layer gaps and page limits retain explicit coverage and original page locations',async()=>{
 let destroyed=0;const libraries={docx:none,pdf:async()=>({getDocument:()=>({promise:Promise.resolve({numPages:3,getPage:async n=>({getTextContent:async()=>({items:n===2?[]:[{str:'page '+n}]}),cleanup(){}}),destroy:async()=>{destroyed++;}})})})};
 const value=await decodeDocument(new Uint8Array(),'application/pdf',libraries);
 assert.equal(value.coverage,'partial');assert.match(value.warnings[0],/Pages without a text layer: 2/);assert.equal(destroyed,1);
 assert.deepEqual([...documentChunks(value)].map(v=>v.documentLocation),[{pageNumber:1,offset:0,length:6},{pageNumber:3,offset:0,length:6}]);
});
test('strict UTF-8 has bounded coverage and chunks never split a surrogate pair',async()=>{
 const value=await decodeDocument(new TextEncoder().encode('abc🌱de'),'text/plain',{pdf:none,docx:none});const chunks=[...documentChunks(value,4)];
 assert.deepEqual(chunks.map(v=>v.text),['abc','🌱de']);assert.equal(chunks.map(v=>v.text).join(''),value.text);
 const invalid=await decodeDocument(new Uint8Array([255]),'text/plain',{pdf:none,docx:none});assert.equal(invalid.status,'unsupported');
 const partial=await decodeDocument(new TextEncoder().encode('x'.repeat(2_000_001)),'text/plain',{pdf:none,docx:none});assert.equal(partial.coverage,'partial');assert.equal(partial.text.length,2_000_000);
});
