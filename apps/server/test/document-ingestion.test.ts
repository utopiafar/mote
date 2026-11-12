import {fixtureFilePolicy} from './fixtures/file-policy.js';
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
import {decodeOriginal} from '../src/document-decoder.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {sourceMaterialView} from '../src/source-material-view.js';
import {fileViewSchema} from '@mote/shared';
import {FileReviews} from '../src/file-reviews.js';

function pdf(text?:string,blankSecondPage=false){const content=text?`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`:'';const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [3 0 R${blankSecondPage?' 6 0 R':''}] /Count ${blankSecondPage?2:1} >>`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];if(blankSecondPage)objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>','<< /Length 0 >>\nstream\n\nendstream');let data='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const start=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(data);}
function docx(){return Buffer.from(zipSync({'[Content_Types].xml':Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),'word/document.xml':Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Generated document evidence</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>')}));}
function pdfPages(texts:(string|undefined)[]){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${texts.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${texts.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 for(const [i,text] of texts.entries()){const content=text?`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`:'';objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);}
 let data='%PDF-1.4\n';const offsets:number[]=[];for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${object}\nendobj\n`;}const start=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(data);
}

test('PDF, DOCX and XLSX share central decoding text and locators across automatic import and file processing',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-ingestion-'))),store=new Store(dir),sources=new SourceStore(store),files=new FileStore(store,sources),archive=new ArchivedFileStore(store),imports=new ImportStore(store,archive,sources),processing=new FileProcessing(files);
 t.after(async()=>{await processing.close();await imports.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 await processing.runtime.ready;
 sources.register({id:'generated-documents',name:'Generated documents',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'archive'});
 processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true},policy:fixtureFilePolicy({...processing.view().settings,enabled:true},processing.runtime.registry)});
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Generated');sheet.getCell('B2').value={formula:'1+1',result:2};sheet.getCell('A2').value='Generated cell';
 const fixtures=[{name:'generated.pdf',mime:'application/pdf',bytes:pdf('Generated PDF evidence')},{name:'generated.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:docx()},{name:'generated.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:Buffer.from(await book.xlsx.writeBuffer())}];
 for(const value of fixtures){
  const decoded=await decodeOriginal(value.bytes,value.mime);assert.equal(decoded.status,'ready');
  const begun=files.begin({sourceId:'generated-documents',previousRevision:null,item:{externalId:value.name,revision:'1',observedAt:'2025-01-01T00:00:00.000Z',title:value.name,text:'',kind:'file',layer:'original',mimeType:value.mime,deleted:false},sizeBytes:value.bytes.length,sha256:sha256(value.bytes),relativePath:value.name},()=>{});files.part(begun.uploadId,0,value.bytes,()=>{});const receipt=await files.commit(begun.uploadId,()=>{});await processing.tick();
  assert.equal(files.detail(receipt.id).job.state,'succeeded');const chunks=files.chunks(receipt.id);assert.equal(chunks.map(v=>v.ocrText).join(''),decoded.text);assert.deepEqual(chunks[0].fileEvidence?.documentLocation,{...(value.mime==='application/pdf'?{pageNumber:1}:value.name.endsWith('.xlsx')?{sheetName:'Generated',rowNumber:2,columnNumber:1,endColumnNumber:2}:{paragraphNumber:1,endParagraphNumber:2}),offset:0,length:chunks[0].ocrText.length});
  const job=await imports.create({files:[{name:value.name,mimeType:value.mime,dataBase64:value.bytes.toString('base64')}],processing:'automatic'}),result=await imports.prepare(job.id);
  assert.equal(result.status,'completed',`${value.name}: ${result.reviewGate?.reason??result.error??'no review reason'}`);
  assert.equal(result.reviewGate?.decision,'automatic');
  if(value.mime!=='application/pdf')assert.ok(result.warnings.length>0,'known decoder fidelity notes remain visible');
  assert.equal(result.captureIds.map(id=>store.evidence([id])[0].ocrText).join(''),decoded.text);assert.deepEqual(archive.read(result.files[0].id),value.bytes);
  const document=sources.getItem(job.sourceId,value.name+':0')!.document;assert.equal(document?.timeBasis,'unknown');assert.equal(document?.recordedAt,undefined);assert.equal(document?.originalMetadata?.offset,0);if(value.mime==='application/pdf')assert.equal(document?.originalMetadata?.pageNumber,1);if(value.name.endsWith('.xlsx')){assert.equal(document?.originalMetadata?.sheetName,'Generated');assert.match(decoded.text,/"formula":"1\+1","result":2/);}
 }
});
test('real text, mixed PDF, DOCX and XLSX outputs retain tail coordinates through FileView and Material',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-coverage-'))),store=new Store(dir),sources=new SourceStore(store),files=new FileStore(store,sources),processing=new FileProcessing(files),materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);
 t.after(async()=>{await organizers.close();await processing.close();store.close();rmSync(dir,{recursive:true,force:true});});
 sources.register({id:'generated-coverage',name:'Generated coverage',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'archive'});
 await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true},policy:fixtureFilePolicy({...processing.view().settings,enabled:true},processing.runtime.registry)});
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Generated');sheet.getCell('A1').value='Generated first cell';sheet.getCell('C7').value='Generated spreadsheet tail';sheet.getCell('D7').value={formula:'40+2'};
 const examples=[
  {name:'generated.txt',mime:'text/plain',bytes:Buffer.from('Generated first text.\r\n\r\nGenerated text tail.'),tail:'Generated text tail',location:{paragraphNumber:1,endParagraphNumber:2}},
  {name:'generated.pdf',mime:'application/pdf',bytes:pdfPages(['Generated first page',undefined,'Generated PDF tail']),tail:'Generated PDF tail',location:{pageNumber:3}},
  {name:'generated.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:docx(),tail:'Second paragraph',location:{paragraphNumber:1,endParagraphNumber:2}},
  {name:'generated.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:Buffer.from(await book.xlsx.writeBuffer()),tail:'Generated spreadsheet tail',location:{sheetName:'Generated',rowNumber:7,columnNumber:1,endColumnNumber:4}},
 ];
 for(const value of examples){
  const begun=files.begin({sourceId:'generated-coverage',previousRevision:null,item:{externalId:value.name,revision:'1',observedAt:'2025-01-01T00:00:00.000Z',title:value.name,text:'',kind:'file',layer:'original',mimeType:value.mime,deleted:false},sizeBytes:value.bytes.length,sha256:sha256(value.bytes),relativePath:value.name},()=>{});files.part(begun.uploadId,0,value.bytes,()=>{});const {id}=await files.commit(begun.uploadId,()=>{});
  while(await organizers.tick(100));
  assert.equal(fileViewSchema.parse(files.fileView(id)).coverage.extraction.status,'pending');
  await processing.tick();while(await organizers.tick(100));
  const view=fileViewSchema.parse(files.fileView(id)),chunks=files.chunks(id),tail=chunks.find(chunk=>chunk.ocrText.includes(value.tail));assert.ok(tail,value.name);
  const decoded=await decodeOriginal(value.bytes,value.mime);for(const chunk of chunks){const location=chunk.fileEvidence!.documentLocation!,body=location.pageNumber?decoded.pages!.find(page=>page.pageNumber===location.pageNumber)!.text:decoded.text;assert.equal(body.slice(location.offset,location.offset+location.length),chunk.ocrText,`${value.name} coordinates must select the original decoded text`);}
  assert.deepEqual(Object.fromEntries(Object.keys(value.location).map(key=>[key,(tail.fileEvidence!.documentLocation as any)[key]])),value.location);
  if(value.mime==='application/pdf')assert.deepEqual({status:view.coverage.extraction.status,completed:view.coverage.extraction.completed,total:view.coverage.extraction.total},{status:'partial',completed:2,total:3});
  else assert.equal(view.coverage.extraction.status,'ready');
  assert.notEqual(view.coverage.semantic.status,'ready');assert.equal(view.coverage.embedding.status,'unsupported');
  const material=materials.get(materialId('generated-coverage',value.name))!,page=materials.read(material.ref),span=page.spans.find(span=>span.locator?.chunkId===tail.id);
  assert.ok(span?.locator?.documentLocation,value.name);assert.deepEqual(span.locator.documentLocation,tail.fileEvidence!.documentLocation);
  const presentation=sourceMaterialView(materials,material.id,{revision:material.revision,length:8000});assert.ok(presentation.items.some(entry=>entry.text.includes(value.tail)&&entry.locator?.chunkId===tail.id));
  if(value.mime==='application/pdf'){
   const first=chunks[0],corrected=first.ocrText.replace('first','corrected');new FileReviews(files,processing).correct(id,{artifactId:first.fileEvidence!.artifactId,chunkId:first.id,originalText:first.ocrText,correctedText:corrected});
   while(await organizers.tick(100));assert.equal(materials.get(material.id)!.coverage.state,'partial');assert.equal(files.fileView(id).coverage.extraction.completed,2);assert.equal(files.fileView(id).coverage.extraction.total,3);
  }
  if(value.mime.endsWith('spreadsheetml.sheet')){const formula=chunks.find(chunk=>chunk.fileEvidence?.documentLocation?.rowNumber===7)!;assert.match(formula.ocrText,/"column":3,"value":"Generated spreadsheet tail"/);assert.match(formula.ocrText,/"formula":"40\+2","result":null/);}
 }
});
test('a scanned PDF retains its original and explicitly fails extraction without inventing text',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-empty-'))),store=new Store(dir),archive=new ArchivedFileStore(store),imports=new ImportStore(store,archive,new SourceStore(store));t.after(async()=>{await imports.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 const bytes=pdf(),decoded=await decodeOriginal(bytes,'application/pdf');assert.equal(decoded.status,'unsupported');assert.equal(decoded.coverage,'none');
 const job=await imports.create({files:[{name:'scanned.pdf',dataBase64:bytes.toString('base64')}],processing:'automatic'}),result=await imports.prepare(job.id);assert.equal(result.status,'failed');assert.match(result.error??'',/unsupported_format/);assert.deepEqual(archive.read(result.files[0].id),bytes);assert.equal(store.list().items.length,0);
});
test('file view distinguishes a scanned PDF without text from a parser failure',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-unavailable-'))),store=new Store(dir),sources=new SourceStore(store),files=new FileStore(store,sources),processing=new FileProcessing(files);
 t.after(async()=>{await processing.close();store.close();rmSync(dir,{recursive:true,force:true});});
 sources.register({id:'generated-unavailable',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'archive'});
 await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true},policy:fixtureFilePolicy({...processing.view().settings,enabled:true},processing.runtime.registry)});
 const examples=[{name:'scanned.pdf',mime:'application/pdf',bytes:pdf(),status:'unsupported'},{name:'broken.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:Buffer.from('Generated invalid document'),status:'failed'}];
 for(const value of examples){const begun=files.begin({sourceId:'generated-unavailable',previousRevision:null,item:{externalId:value.name,revision:'1',observedAt:'2025-01-01T00:00:00.000Z',title:value.name,text:'',kind:'file',layer:'original',mimeType:value.mime,deleted:false},sizeBytes:value.bytes.length,sha256:sha256(value.bytes),relativePath:value.name},()=>{});files.part(begun.uploadId,0,value.bytes,()=>{});const {id}=await files.commit(begun.uploadId,()=>{});await processing.tick();
  const view=fileViewSchema.parse(files.fileView(id));assert.equal(view.coverage.extraction.status,value.status);assert.equal(view.coverage.semantic.status,value.status);assert.equal(files.chunks(id).length,0);assert.equal(view.hasOriginal,true);
  if(value.status==='unsupported')assert.deepEqual({completed:view.coverage.extraction.completed,total:view.coverage.extraction.total},{completed:0,total:1});
 }
});
test('partial deterministic PDF extraction keeps valid text in preview for confirmation',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-document-partial-'))),store=new Store(dir),archive=new ArchivedFileStore(store),imports=new ImportStore(store,archive,new SourceStore(store));t.after(async()=>{await imports.stop();store.close();rmSync(dir,{recursive:true,force:true});});
 const bytes=pdf('Generated first page',true),job=await imports.create({files:[{name:'partial.pdf',dataBase64:bytes.toString('base64')}],processing:'automatic'});
 const preview=await imports.prepare(job.id);
 assert.equal(preview.status,'awaiting_confirmation');assert.equal(preview.reviewDecision?.confidence,'low');assert.equal(preview.reviewGate?.decision,'confirmation');
 assert.ok(preview.warnings.some(warning=>warning.includes('Pages without a text layer')));
 assert.equal(store.list().items.length,0);assert.deepEqual(archive.read(preview.files[0].id),bytes);
 const confirmed=await imports.confirm(job.id);assert.equal(confirmed.status,'completed');
 assert.match(confirmed.captureIds.map(id=>store.evidence([id])[0].ocrText).join(''),/Generated first page/);
});
