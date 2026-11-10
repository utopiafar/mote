import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDocument,documentChunks} from '../dist/document-decoder.js';
const none=async()=>{throw Error('Unexpected library load');};
test('PDF text layer gaps retain explicit coverage and original page locations',async()=>{
 let destroyed=0;const libraries={docx:none,pdf:async()=>({getDocument:()=>({promise:Promise.resolve({numPages:3,getPage:async n=>({getTextContent:async()=>({items:n===2?[]:[{str:'page '+n}]}),cleanup(){}}),destroy:async()=>{destroyed++;}})})})};
 const value=await decodeDocument(new Uint8Array(),'application/pdf',libraries);
 assert.equal(value.coverage,'partial');assert.match(value.warnings[0],/Pages without a text layer: 2/);assert.equal(destroyed,1);
 assert.deepEqual([...documentChunks(value)].map(v=>v.documentLocation),[{pageNumber:1,offset:0,length:6},{pageNumber:3,offset:0,length:6}]);
});
test('strict UTF-8 decodes completely and chunks never split a surrogate pair',async()=>{
 const value=await decodeDocument(new TextEncoder().encode('abc🌱de'),'text/plain',{pdf:none,docx:none});const chunks=[...documentChunks(value,4)];
 assert.deepEqual(chunks.map(v=>v.text),['abc','🌱de']);assert.equal(chunks.map(v=>v.text).join(''),value.text);
 const invalid=await decodeDocument(new Uint8Array([255]),'text/plain',{pdf:none,docx:none});assert.equal(invalid.status,'unsupported');
 const full=await decodeDocument(new TextEncoder().encode('x'.repeat(2_000_001)),'text/plain',{pdf:none,docx:none});assert.equal(full.coverage,'full');assert.equal(full.text.length,2_000_001);
});

test('PDF decoding reads every page instead of stopping at an old page or character cap',async()=>{
 const libraries={docx:none,pdf:async()=>({getDocument:()=>({promise:Promise.resolve({numPages:501,getPage:async n=>({getTextContent:async()=>({items:[{str:'page '+n}]}),cleanup(){}}),destroy:async()=>{}})})})};
 const value=await decodeDocument(new Uint8Array(),'application/pdf',libraries);
 assert.equal(value.coverage,'full');assert.equal(value.pages.length,501);assert.equal(value.pageCount,501);assert.equal(value.pages.at(-1).text,'page 501');
});

test('XLSX decoding keeps every sheet, row and column and still rejects unsafe Office containers',async()=>{
 const {zipSync}=await import('fflate');
 const sheet=(name,rows)=>({name,eachRow(_options,visit){rows.forEach((cells,index)=>visit({eachCell(_options,cell){cells.forEach((value,position)=>cell({value},position+1));}},index+1));}});
 const rows=Array.from({length:20_001},(_,index)=>['Generated row '+index]);
 const wide=Array.from({length:501},(_,index)=>'Generated cell '+index);
 const workbook={worksheets:[sheet('Generated long',rows),sheet('Generated wide',[wide]),...Array.from({length:99},(_,index)=>sheet('Generated '+index,[['value']]))]};
 const libraries={pdf:none,docx:none,xlsx:async()=>({Workbook:class{xlsx={load:async()=>{}};constructor(){Object.assign(this,workbook);}}})};
 const bytes=zipSync({'[Content_Types].xml':Buffer.from('generated office fixture')});
 const value=await decodeDocument(bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',libraries);
 assert.equal(value.coverage,'full');assert.equal(value.sheets.length,101);assert.equal(value.sheets[0].rows.length,20_001);assert.equal(value.sheets[0].rows.at(-1).cells[0].value,'Generated row 20000');assert.equal(value.sheets[1].rows[0].cells.length,501);
 const unsafe=Buffer.from(bytes);for(let i=0;i<unsafe.length-4;i++)if(unsafe.readUInt32LE(i)===0x02014b50){unsafe.writeUInt32LE(64*1024*1024+1,i+24);break;}
 const rejected=await decodeDocument(unsafe,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',libraries);
 assert.equal(rejected.status,'unsupported');assert.match(rejected.warnings[0],/decompression limits/);
 const oversized=await decodeDocument(new Uint8Array(64*1024*1024+1),'text/plain',{pdf:none,docx:none});
 assert.equal(oversized.status,'unsupported');assert.match(oversized.warnings[0],/64 MiB/);
});
