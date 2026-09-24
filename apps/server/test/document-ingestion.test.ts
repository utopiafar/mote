import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {zipSync} from 'fflate';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ImportStore} from '../src/imports.js';
import {extractFileText} from '../../desktop/src/file-index.js';

function pdf(text?:string,blankSecondPage=false){const content=text?`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`:'';const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [3 0 R${blankSecondPage?' 6 0 R':''}] /Count ${blankSecondPage?2:1} >>`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];if(blankSecondPage)objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>','<< /Length 0 >>\nstream\n\nendstream');let data='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const start=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(data);}
function docx(){return Buffer.from(zipSync({'[Content_Types].xml':Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),'word/document.xml':Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Generated document evidence</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>')}));}

test('PDF, DOCX and XLSX share text and locators across Desktop, automatic import, and central processing',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-ingestion-'))),store=new Store(dir),sources=new SourceStore(store),files=new FileStore(store,sources),archive=new ArchivedFileStore(store),imports=new ImportStore(store,archive,sources),processing=new FileProcessing(files);
 t.after(async()=>{await processing.close();store.close();rmSync(dir,{recursive:true,force:true});});
 sources.register({id:'generated-documents',name:'Generated documents',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'archive'});
 processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true}});
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Generated');sheet.getCell('B2').value={formula:'1+1',result:2};sheet.getCell('A2').value='Generated cell';
 const fixtures=[{name:'generated.pdf',mime:'application/pdf',bytes:pdf('Generated PDF evidence')},{name:'generated.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:docx()},{name:'generated.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:Buffer.from(await book.xlsx.writeBuffer())}];
 for(const value of fixtures){
  const desktop=await extractFileText(value.bytes,value.mime);assert.equal(desktop.status,'ready');
  const begun=files.begin({sourceId:'generated-documents',previousRevision:null,item:{externalId:value.name,revision:'1',observedAt:'2025-01-01T00:00:00.000Z',title:value.name,text:'',kind:'file',layer:'original',mimeType:value.mime,deleted:false},sizeBytes:value.bytes.length,sha256:sha256(value.bytes),relativePath:value.name},()=>{});files.part(begun.uploadId,0,value.bytes,()=>{});const receipt=await files.commit(begun.uploadId,()=>{});await processing.tick();
  assert.equal(files.detail(receipt.id).job.state,'succeeded');const chunks=files.chunks(receipt.id);assert.equal(chunks.map(v=>v.ocrText).join(''),desktop.text);assert.deepEqual(chunks[0].fileEvidence?.documentLocation,{...(value.mime==='application/pdf'?{pageNumber:1}:value.name.endsWith('.xlsx')?{sheetName:'Generated',rowNumber:2}:{}),offset:0,length:chunks[0].ocrText.length});
  const job=await imports.create({files:[{name:value.name,mimeType:value.mime,dataBase64:value.bytes.toString('base64')}],processing:'automatic'}),result=await imports.prepare(job.id);
  assert.equal(result.status,'completed',`${value.name}: ${result.reviewGate?.reason??result.error??'no review reason'}`);
  assert.equal(result.reviewGate?.decision,'automatic');
  if(value.mime!=='application/pdf')assert.ok(result.warnings.length>0,'known decoder fidelity notes remain visible');
  assert.equal(result.captureIds.map(id=>store.evidence([id])[0].ocrText).join(''),desktop.text);assert.deepEqual(archive.read(result.files[0].id),value.bytes);
  const document=sources.getItem(job.sourceId,value.name+':0')!.document;assert.equal(document?.timeBasis,'unknown');assert.equal(document?.recordedAt,undefined);assert.equal(document?.originalMetadata?.offset,0);if(value.mime==='application/pdf')assert.equal(document?.originalMetadata?.pageNumber,1);if(value.name.endsWith('.xlsx')){assert.equal(document?.originalMetadata?.sheetName,'Generated');assert.match(desktop.text,/"formula":"1\+1","result":2/);}
 }
});
test('a scanned PDF retains its original and explicitly fails extraction without inventing text',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-empty-'))),store=new Store(dir),archive=new ArchivedFileStore(store),imports=new ImportStore(store,archive,new SourceStore(store));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const bytes=pdf(),desktop=await extractFileText(bytes,'application/pdf');assert.equal(desktop.status,'unsupported');assert.equal(desktop.coverage,'none');
 const job=await imports.create({files:[{name:'scanned.pdf',dataBase64:bytes.toString('base64')}],processing:'automatic'}),result=await imports.prepare(job.id);assert.equal(result.status,'failed');assert.match(result.error??'',/unsupported_format/);assert.deepEqual(archive.read(result.files[0].id),bytes);assert.equal(store.list().items.length,0);
});
test('partial deterministic PDF extraction keeps valid text in preview for confirmation',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-partial-'))),store=new Store(dir),archive=new ArchivedFileStore(store),imports=new ImportStore(store,archive,new SourceStore(store));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const bytes=pdf('Generated first page',true),job=await imports.create({files:[{name:'partial.pdf',dataBase64:bytes.toString('base64')}],processing:'automatic'});
 const preview=await imports.prepare(job.id);
 assert.equal(preview.status,'awaiting_confirmation');assert.equal(preview.reviewDecision?.confidence,'low');assert.equal(preview.reviewGate?.decision,'confirmation');
 assert.ok(preview.warnings.some(warning=>warning.includes('Pages without a text layer')));
 assert.equal(store.list().items.length,0);assert.deepEqual(archive.read(preview.files[0].id),bytes);
 const confirmed=await imports.confirm(job.id);assert.equal(confirmed.status,'completed');
 assert.match(confirmed.captureIds.map(id=>store.evidence([id])[0].ocrText).join(''),/Generated first page/);
});
