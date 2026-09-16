import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {zipSync} from 'fflate';
import ExcelJS from 'exceljs';
import {prepareImportInput} from '../src/import-runtime.js';

async function helper(t:any,entries:Record<string,string|Buffer>){
 const workspace=realpathSync(mkdtempSync(join(tmpdir(),'mote-parser-')));t.after(()=>rmSync(workspace,{recursive:true,force:true}));
 const inputPaths=Object.entries(entries).map(([name,value])=>{const path=join(workspace,name);writeFileSync(path,value);return path;});
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
 writeFileSync(path,JSON.stringify(record));assert.deepEqual(await api.validateRecords(path),{valid:true,count:1,errors:[]});
 writeFileSync(path,JSON.stringify({...record,evidencePaths:['/tmp/elsewhere']}));const invalid=await api.validateRecords(path);assert.equal(invalid.valid,false);assert.match(invalid.errors[0].error,/supplied/);
});
