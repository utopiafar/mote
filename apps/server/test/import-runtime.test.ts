import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateImportManifest} from '../src/import-manifest-worker.js';
import {pathToFileURL} from 'node:url';
import {zipSync} from 'fflate';
import ExcelJS from 'exceljs';
import {prepareImportInput} from '../src/import-runtime.js';

async function helper(t:any,entries:Record<string,string|Buffer>){
 const workspace=realpathSync(mkdtempSync(join(tmpdir(),'mote-parser-')));t.after(()=>rmSync(workspace,{recursive:true,force:true}));
 const inputPaths=Object.entries(entries).map(([name,value])=>{const path=join(workspace,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,value);return path;});
 const prepared=prepareImportInput({workspace,inputPaths,instruction:'Synthetic fixtures only'});
 const api=await import(pathToFileURL(prepared.helperPath).href);return {workspace,inputPaths,prepared,api};
}
function pdf(text?:string){
 const content=text?`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`:'';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
 let data='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const start=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(data);
}
test('helper imports absolute dependencies and preserves generic JSON, CSV, YAML and source lines',async t=>{
 const {api,inputPaths,prepared}=await helper(t,{'note.md':'# 合成标题\n\n原文。','data.json':'{"entries":[{"when":"2020-01-01","text":"synthetic"}]}','rows.csv':'id,text\r\n1,"line one\nline two"\r\n2,"a ""quote"""\r\n','data.yaml':'entries:\n  - title: synthetic\n','data.jsonl':'{"id":1}\n\n{"id":2}\n','binary.bin':Buffer.from([0,255,2])});
 assert.equal((await api.extractFile(inputPaths[0])).text,'# 合成标题\n\n原文。');assert.equal((await api.extractFile(inputPaths[1])).data.entries[0].when,'2020-01-01');
 assert.deepEqual((await api.extractFile(inputPaths[2])).rows,[['id','text'],['1','line one\nline two'],['2','a "quote"']]);assert.equal((await api.extractFile(inputPaths[3])).data.entries[0].title,'synthetic');
 assert.deepEqual((await api.extractFile(inputPaths[4])).records.map((r:any)=>r.lineNumber),[1,3]);assert.equal((await api.extractFile(inputPaths[5])).status,'unsupported');
 assert.ok(prepared.manifestSchema.definitions?.ImportRecord);
 assert.equal(prepared.schemaPath,join(prepared.workspace,'manifest-schema.json'));assert.deepEqual(JSON.parse(readFileSync(prepared.schemaPath,'utf8')),prepared.manifestSchema);assert.equal(statSync(prepared.schemaPath).mode&0o777,0o600);
 await assert.rejects(api.extractFile('/tmp/not-supplied'));
});
test('helper extracts PDF page numbers and explicitly reports missing text/OCR',async t=>{
 const {api,inputPaths}=await helper(t,{'text.pdf':pdf('Synthetic PDF text'),'scan.pdf':pdf()});
 const text=await api.extractFile(inputPaths[0]);assert.equal(text.status,'parsed');assert.equal(text.pages[0].pageNumber,1);assert.match(text.pages[0].text,/Synthetic PDF text/);
 const empty=await api.extractFile(inputPaths[1]);assert.equal(empty.status,'unsupported');assert.match(empty.warnings.join(' '),/no OCR/i);
});
test('helper extracts DOCX paragraphs and XLSX coordinates without evaluating formulas',async t=>{
 const document=zipSync({'[Content_Types].xml':Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),'_rels/.rels':Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),'word/document.xml':Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic paragraph one</w:t></w:r></w:p><w:p><w:r><w:t>Paragraph two</w:t></w:r></w:p></w:body></w:document>')});
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Synthetic');sheet.getCell('A2').value='raw text';sheet.getCell('B2').value={formula:'1+1',result:2};
 const {api,inputPaths}=await helper(t,{'fixture.docx':Buffer.from(document),'fixture.xlsx':Buffer.from(await workbook.xlsx.writeBuffer())});
 const docx=await api.extractFile(inputPaths[0]);assert.equal(docx.status,'parsed');assert.match(docx.text,/Synthetic paragraph one\n\nParagraph two/);
 const xlsx=await api.extractFile(inputPaths[1]);assert.equal(xlsx.status,'parsed');assert.equal(xlsx.sheets[0].rows[0].rowNumber,2);assert.deepEqual(xlsx.sheets[0].rows[0].cells[1],{column:2,value:{formula:'1+1',result:2}});
});
test('helper validates complete records against shared source schema and supplied paths',async t=>{
 const {api,workspace,inputPaths}=await helper(t,{'fixture.txt':'synthetic'}),path=join(workspace,'records.jsonl');
 const record={item:{externalId:'1',revision:'v1',observedAt:'2026-09-15T12:00:00Z',title:'合成',text:'synthetic',kind:'file',layer:'original'},evidencePaths:inputPaths};
 writeFileSync(join(workspace,'dispositions.json'),JSON.stringify({items:inputPaths.map(path=>({path,status:'parsed',reason:'Generated text'}))}));
 writeFileSync(path,JSON.stringify(record));assert.deepEqual(await api.validateRecords(path),{valid:true,count:1,errors:[]});
 writeFileSync(path,JSON.stringify({...record,evidencePaths:['/tmp/elsewhere']}));const invalid=await api.validateRecords(path);assert.equal(invalid.valid,false);assert.match(invalid.errors[0].error,/supplied/);
});

// Regression: the model helper used to accept evidence marked attachment, while
// the host rejected it only after the writable model session had closed.
test('helper and host agree on disposition failures and corrected previews, including CLI execution',async t=>{
 const {api,workspace,inputPaths,prepared}=await helper(t,{'inputs/note.md':'Generated text','inputs/asset.bin':'Generated attachment'});
 const record={item:{externalId:'generated',revision:'v1',observedAt:'2026-09-15T12:00:00Z',title:'Generated',text:'Generated text',kind:'file',layer:'original'},evidencePaths:['inputs/note.md'],attachments:['inputs/asset.bin']};
 const inputs=inputPaths.map((path,index)=>{const bytes=readFileSync(path);return {path,file:{id:'fixture-'+index,hash:createHash('sha256').update(bytes).digest('hex'),name:index?'asset.bin':'note.md',relativePath:index?'asset.bin':'note.md',mimeType:'application/octet-stream',sizeBytes:bytes.length,createdAt:'2026-09-15T12:00:00Z'}};});
 const task={kind:'manifest' as const,workspace,path:'records.jsonl',output:'prepared.jsonl',inputs,dispositions:true};
 const disposition=(path:string,status:string)=>({path,status,reason:'Generated fixture'});
 const write=(items:unknown[],value=record)=>{
  // Physical line numbers must include empty lines and CRLF.
  writeFileSync(join(workspace,'records.jsonl'),'\r\n'+JSON.stringify(value)+'\r\n');
  writeFileSync(join(workspace,'dispositions.json'),JSON.stringify({items}));
 };
 for(const status of ['attachment','container','excluded','unsupported']){
  write([disposition(inputPaths[0],status),disposition('inputs/asset.bin','attachment')]);
  const checked=await api.validateRecords('records.jsonl');assert.equal(checked.valid,false);assert.equal(checked.errors[0].line,2);
  const error=checked.errors[0].error;assert.match(error,/manifest line 2, evidencePaths/);assert.ok(error.includes('status='+status));assert.match(error,/path="inputs\/note.md"/);assert.ok(!error.includes(workspace));
  assert.throws(()=>validateImportManifest(task),(rejected:Error)=>rejected.message===error);
  if(status==='attachment'){
   const cli=spawnSync(process.execPath,[prepared.helperPath,'validate','records.jsonl'],{cwd:workspace,encoding:'utf8'});
   assert.equal(cli.status,1,cli.stderr);assert.equal(JSON.parse(cli.stdout).errors[0].error,error);
  }
 }
 for(const status of ['container','excluded','unsupported']){
  write([disposition(inputPaths[0],'parsed'),disposition(inputPaths[1],status)]);
  const checked=await api.validateRecords('records.jsonl');assert.equal(checked.valid,false);assert.match(checked.errors[0].error,/attachments.*expected=parsed or attachment/);
  assert.throws(()=>validateImportManifest(task),(rejected:Error)=>rejected.message===checked.errors[0].error);
 }
 for(const items of [
  [disposition(inputPaths[0],'parsed')],
  [disposition(inputPaths[0],'parsed'),disposition('inputs/./note.md','parsed'),disposition(inputPaths[1],'attachment')],
  [disposition(inputPaths[0],'parsed'),disposition(inputPaths[1],'attachment'),disposition('inputs/not-supplied','excluded')],
 ]){
  write(items);const checked=await api.validateRecords('records.jsonl');assert.equal(checked.valid,false);assert.equal(checked.errors[0].line,0);
  assert.throws(()=>validateImportManifest(task),(rejected:Error)=>rejected.message===checked.errors[0].error);
 }
 write([disposition(inputPaths[0],'parsed'),disposition(inputPaths[1],'attachment')]);
 const cli=spawnSync(process.execPath,[prepared.helperPath,'validate','records.jsonl'],{cwd:workspace,encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),{valid:true,count:1,errors:[]});
 assert.equal(validateImportManifest(task).count,1);
 // A combined record must mark every contributing original parsed.
 write([disposition(inputPaths[0],'parsed'),disposition(inputPaths[1],'attachment')],{...record,evidencePaths:inputPaths,attachments:[]});
 assert.equal((await api.validateRecords('records.jsonl')).valid,false);
 write([disposition(inputPaths[0],'parsed'),disposition(inputPaths[1],'parsed')],{...record,evidencePaths:inputPaths,attachments:[]});
 assert.equal((await api.validateRecords('records.jsonl')).valid,true);assert.equal(validateImportManifest(task).count,1);
 write([disposition(inputPaths[0],'excluded'),disposition(inputPaths[1],'unsupported')]);writeFileSync(join(workspace,'records.jsonl'),'');
 assert.deepEqual(await api.validateRecords('records.jsonl'),{valid:true,count:0,errors:[]});assert.equal(validateImportManifest(task).count,0);
 rmSync(join(workspace,'dispositions.json'));
 const missing=await api.validateRecords('records.jsonl');assert.equal(missing.valid,false);assert.match(missing.errors[0].error,/did not provide dispositions.json/);
 // Existing host compatibility remains: old parsers without dispositions need review.
 assert.ok(validateImportManifest(task).warnings.some(w=>w.includes('per-file disposition')));
});

test('host-retained media references validate without readable bytes but cannot become parsed evidence or hide missing attachments',async t=>{
 const {workspace,inputPaths}=await helper(t,{'inputs/note.md':'![Generated](photo.png)'}),mediaPath=join(workspace,'inputs/photo.png');
 const prepared=prepareImportInput({workspace,inputPaths,hostMedia:[{path:mediaPath,relativePath:'photo.png',mimeType:'image/png',contentAvailable:false,processing:'after_confirmation'}],instruction:'Generated media contract'});
 const {validateRecords,extractFile}=await import(pathToFileURL(prepared.helperPath).href+'?host-media');
 const file=(path:string,id:string,bytes:Buffer)=>({path,file:{id,hash:createHash('sha256').update(bytes).digest('hex'),name:id,relativePath:id,mimeType:'application/octet-stream',sizeBytes:bytes.length,createdAt:'2026-10-26T00:00:00Z'}});
 const inputs=[file(inputPaths[0],'note.md',readFileSync(inputPaths[0])),file(mediaPath,'photo.png',Buffer.from('generated retained image'))];
 const record={item:{externalId:'link-only',revision:'v1',observedAt:'2026-10-26T00:00:00Z',title:'Generated diary',text:'![Generated](photo.png)',kind:'file',layer:'original'},evidencePaths:inputPaths,attachments:[mediaPath]};
 const task={kind:'manifest' as const,workspace,path:'records.jsonl',output:'prepared.jsonl',inputs,hostAttachmentPaths:[mediaPath],dispositions:true};
 const dispositions={items:[{path:inputPaths[0],status:'parsed',reason:'Generated diary'}]};
 writeFileSync(join(workspace,'dispositions.json'),JSON.stringify(dispositions));
 const write=(value:unknown)=>writeFileSync(join(workspace,'records.jsonl'),JSON.stringify(value)+'\n');
 write(record);assert.deepEqual(await validateRecords('records.jsonl'),{valid:true,count:1,errors:[]});
 const valid=validateImportManifest(task);assert.equal(valid.count,1);assert.equal(valid.samples[0].attachmentCount,1);assert.equal(valid.dispositions?.items.length,1);
 const stored=JSON.parse(readFileSync(join(workspace,'prepared.jsonl'),'utf8'));assert.equal(stored.item.document.attachments[0].id,'photo.png');
 await assert.rejects(extractFile(mediaPath),/supplied input paths/);
 write({...record,attachments:[join(workspace,'inputs/missing.png')]});
 assert.equal((await validateRecords('records.jsonl')).valid,false);assert.throws(()=>validateImportManifest(task),/outside the supplied inputs/);
 write({...record,evidencePaths:[mediaPath],attachments:[]});
 assert.equal((await validateRecords('records.jsonl')).valid,false);assert.throws(()=>validateImportManifest(task),/cannot be claimed as parsed evidence/);
 rmSync(join(workspace,'dispositions.json'));assert.throws(()=>validateImportManifest(task),/cannot be claimed as parsed evidence/);
 write(record);writeFileSync(join(workspace,'dispositions.json'),JSON.stringify({items:[...dispositions.items,{path:mediaPath,status:'parsed',reason:'Invented media extraction'}]}));
 assert.equal((await validateRecords('records.jsonl')).valid,false);assert.throws(()=>validateImportManifest(task),/outside the supplied inputs/);
});
