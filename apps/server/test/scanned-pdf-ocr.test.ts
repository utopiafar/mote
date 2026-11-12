import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {decodePdfWithOcr} from '../src/pdf-ocr.js';

type PageSpec={text?:string;image?:boolean};
/** A tiny generated PDF. The raster XObject has no text layer, so PDF.js
 * classifies its page as scanned without needing a real scanner. */
function generatedPdf(pages:PageSpec[]){
 const rgb=Buffer.alloc(8*8*3);for(let i=0;i<rgb.length;i+=3){rgb[i]=(i*7)%255;rgb[i+1]=80;rgb[i+2]=120;}
 const imageId=4,fontId=3,pageIds=pages.map((_,index)=>5+index*2),contentIds=pages.map((_,index)=>6+index*2);
 const objects:string[]=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${pageIds.map(id=>id+' 0 R').join(' ')}] /Count ${pages.length} >>`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n${rgb.toString('latin1')}\nendstream`,
 ];
 for(const [index,page] of pages.entries()){
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`);
  const content=[page.text?`BT /F1 12 Tf 72 720 Td (${page.text}) Tj ET`:'',page.image?`q 300 0 0 300 100 400 cm /Im1 Do Q`:''].filter(Boolean).join('\n');
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
 }
 let data='%PDF-1.4\n';const offsets=[0];
 for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(data,'latin1'));data+=`${index+1} 0 obj\n${object}\nendobj\n`;}
 const start=Buffer.byteLength(data,'latin1');
 data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 return Buffer.from(data,'latin1');
}

type OcrRequest={page:number;contentType:string;bytes:Buffer;authorization?:string};
async function startOcr(t:any,respond:(input:{page:number;attempt:number;request:OcrRequest;res:ServerResponse})=>void|Promise<void>){
 const requests:OcrRequest[]=[],attempts=new Map<number,number>();
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  const page=Number(req.headers['x-mote-document-page']),attempt=(attempts.get(page)??0)+1;attempts.set(page,attempt);
  const request={page,contentType:String(req.headers['content-type']??''),bytes:Buffer.concat(chunks),...(req.headers.authorization?{authorization:req.headers.authorization}:{})};
  requests.push(request);await respond({page,attempt,request,res});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 return {endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}/ocr`,requests,attempts};
}
function answer(res:ServerResponse,status:number,body:unknown){res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));}
function transcript(page:number){return {durationMs:0,segments:[{startMs:0,endMs:0,text:`OCR page ${page}`}],engine:'fixture-ocr'};}

test('mixed PDF reads text pages directly and sends only scanned pages to OCR',async t=>{
 const {endpoint,requests}=await startOcr(t,({page,res})=>answer(res,200,transcript(page)));
 const decoded=await decodePdfWithOcr(generatedPdf([{text:'Generated text page'},{image:true},{image:true}]),{endpoint});
 assert.equal(decoded.status,'ready');assert.equal(decoded.coverage,'full');assert.equal(decoded.parser,'pdfjs+ocr');
 assert.deepEqual(decoded.pages?.map(page=>({pageNumber:page.pageNumber,text:page.text})),[
  {pageNumber:1,text:'Generated text page'},{pageNumber:2,text:'OCR page 2'},{pageNumber:3,text:'OCR page 3'},
 ]);
 assert.deepEqual(requests.map(request=>request.page).sort(),[2,3]);
 assert.ok(requests.every(request=>request.contentType==='image/png'),'rendered pages use a PNG body');
 assert.ok(requests.every(request=>request.bytes.subarray(1,4).toString()==='PNG'));
 assert.ok(decoded.warnings.some(warning=>warning.includes('read with OCR')&&warning.includes('uncorrected')));
 assert.ok(!decoded.warnings.some(warning=>warning.includes('No OCR was performed')));
});

test('a failed scanned page is retried while successful pages are not sent again',async t=>{
 const {endpoint,requests}=await startOcr(t,({page,attempt,res})=>page===3&&attempt===1?answer(res,503,{error:'generated transient failure'}):answer(res,200,transcript(page)));
 const decoded=await decodePdfWithOcr(generatedPdf([{text:'Generated text page'},{image:true},{image:true}]),{endpoint});
 assert.equal(decoded.status,'ready');assert.equal(decoded.coverage,'full');
 assert.equal(decoded.pages?.[1].text,'OCR page 2');assert.equal(decoded.pages?.[2].text,'OCR page 3');
 assert.equal(requests.filter(request=>request.page===2).length,1,'a successful page is never re-rendered or re-sent');
 assert.equal(requests.filter(request=>request.page===3).length,2,'only the failed page is retried');
 assert.ok(!decoded.warnings.some(warning=>warning.includes('OCR failed')));
});

test('a permanently failed page reports partial coverage without discarding successful pages',async t=>{
 const {endpoint,requests}=await startOcr(t,({page,res})=>page===3?answer(res,422,{error:'generated unsupported page'}):answer(res,200,transcript(page)));
 const decoded=await decodePdfWithOcr(generatedPdf([{text:'Generated text page'},{image:true},{image:true}]),{endpoint});
 assert.equal(decoded.status,'ready');assert.equal(decoded.coverage,'partial');
 assert.equal(decoded.pages?.[1].text,'OCR page 2');assert.equal(decoded.pages?.[2].text,'');
 assert.equal(requests.filter(request=>request.page===2).length,1);
 assert.equal(requests.filter(request=>request.page===3).length,1,'permanent failures are not retried');
 assert.ok(decoded.warnings.some(warning=>warning.includes('OCR failed for page(s) 3')));
 assert.ok(decoded.warnings.some(warning=>warning.includes('provider_request_invalid')));
});

test('missing or non-loopback OCR capability is reported instead of inventing text',async t=>{
 const mixed=generatedPdf([{text:'Generated text page'},{image:true}]);
 const missing=await decodePdfWithOcr(mixed,{});
 assert.equal(missing.status,'ready');assert.equal(missing.coverage,'partial');assert.equal(missing.pages?.[1].text,'');
 assert.ok(missing.warnings.some(warning=>warning.includes('not configured')&&warning.includes('not OCR')));

 const scanned=await decodePdfWithOcr(generatedPdf([{image:true}]),{});
 assert.equal(scanned.status,'unsupported');assert.equal(scanned.coverage,'none');assert.equal(scanned.pages?.[0].text,'');
 assert.ok(scanned.warnings.some(warning=>warning.includes('not configured')));

 const remote=await decodePdfWithOcr(mixed,{endpoint:'https://generated.example.invalid/ocr'});
 assert.equal(remote.coverage,'partial');
 assert.ok(remote.warnings.some(warning=>warning.includes('not a loopback service')));
});

test('cancelling PDF OCR stops requests and leaves no reusable render state',async t=>{
 let received!:()=>void;const arrived=new Promise<void>(resolve=>received=resolve);
 let closed!:()=>void;const closedPromise=new Promise<void>(resolve=>closed=resolve);
 const server=createServer(async(req,res)=>{
  for await(const _ of req){}
  received();res.once('close',closed);
  setTimeout(()=>{try{answer(res,200,transcript(2));}catch{}},5000).unref();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const endpoint=`http://127.0.0.1:${(server.address() as AddressInfo).port}/ocr`,controller=new AbortController();
 const pending=decodePdfWithOcr(generatedPdf([{text:'Generated text page'},{image:true}]),{endpoint},controller.signal);
 await arrived;controller.abort();
 await assert.rejects(pending,{name:'AbortError'});
 await Promise.race([closedPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('OCR request survived cancellation')),2000))]);
});

test('file processing sends scanned pages through the configured local OCR service',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-scanned-pdf-')),store=new Store(dir),sources=new SourceStore(store),files=new FileStore(store,sources),processing=new FileProcessing(files);
 t.after(async()=>{await processing.close();store.close();rmSync(dir,{recursive:true,force:true});});
 await processing.runtime.ready;
 sources.register({id:'generated-scanned-pdf',name:'Generated scanned PDF',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'archive'});
 const {endpoint,requests}=await startOcr(t,({page,res})=>answer(res,200,transcript(page)));
 const settings={...processing.view().settings,enabled:true,imageEndpoint:endpoint};
 processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
 const bytes=generatedPdf([{text:'Generated text page'},{image:true}]);
 const begun=files.begin({sourceId:'generated-scanned-pdf',previousRevision:null,item:{externalId:'generated-mixed.pdf',revision:'1',observedAt:'2025-01-01T00:00:00.000Z',title:'generated-mixed.pdf',text:'',kind:'file',layer:'original',mimeType:'application/pdf',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes),relativePath:'generated-mixed.pdf'},()=>{});
 files.part(begun.uploadId,0,bytes,()=>{});const receipt=await files.commit(begun.uploadId,()=>{});
 await processing.tick();await processing.tick();
 assert.equal(files.detail(receipt.id).job.state,'succeeded');
 const text=files.chunks(receipt.id).map(chunk=>chunk.ocrText).join('\n');
 assert.match(text,/Generated text page/);assert.match(text,/OCR page 2/);
 const chunk=files.chunks(receipt.id).find(chunk=>chunk.ocrText.includes('OCR page 2'))!;
 assert.equal(chunk.fileEvidence?.documentLocation?.pageNumber,2);
 assert.deepEqual(requests.map(request=>request.page),[2]);
});
