import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rename,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanSourceFiles} from '../src/source-files';
import {DEFAULT_SOURCE_OPTIONS,type LocalSource} from '../src/source-types';
import {readSourceEvidence} from '../src/file-evidence';
import {randomUUID} from 'node:crypto';
it('stable identity survives rename, lightweight indexes preserve version, revoked and changed reads fail closed',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-index-')));try{
 const path=join(root,'one.txt'),text='Generated evidence '.repeat(1000);await writeFile(path,text);const locations=new Map<string,string>();const options={...DEFAULT_SOURCE_OPTIONS,indexMode:'lightweight' as const,allowRead:true};
 const first=(await scanSourceFiles(root,options,undefined,undefined,locations)).items[0];expect(first.document?.fileIndex?.coverage).toBe('lightweight');expect(first.text.length).toBe(8000);
 await rename(path,join(root,'two.txt'));const second=(await scanSourceFiles(root,options,undefined,undefined,locations)).items[0];expect(second.externalId).toBe(first.externalId);
 const source:LocalSource={...options,id:'generated-source',deviceId:'fixture',name:'Generated',kind:'local-files',platform:'macos',enabled:true,path:root};const request={id:randomUUID(),sourceId:source.id,externalId:second.externalId,revision:'r1',contentVersion:second.document!.fileIndex!.contentVersion,offset:9000,length:100};
 expect(await readSourceEvidence(source,request,locations)).toMatchObject({status:'ready',text:text.slice(9000,9100)});
 expect((await readSourceEvidence({...source,allowRead:false},request,locations)).status).toBe('denied');await writeFile(join(root,'two.txt'),'changed');expect((await readSourceEvidence(source,request,locations)).status).toBe('version_changed');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('extracts generated PDF and Word content locally without uploading originals',async()=>{
 const {extractFileText}=await import('../src/file-index');const JSZip=(await import('jszip')).default;
 const zip=new JSZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Generated Word evidence</w:t></w:r></w:p></w:body></w:document>');
 expect((await extractFileText(await zip.generateAsync({type:'nodebuffer'}),'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).text).toContain('Generated Word evidence');
 const stream='BT /F1 12 Tf 10 100 Td (Generated PDF evidence) Tj ET';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});const xref=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
 expect((await extractFileText(Buffer.from(pdf),'application/pdf')).text).toContain('Generated PDF evidence');
});
