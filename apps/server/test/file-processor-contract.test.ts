import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileProcessingSchema} from '@mote/shared';
import {HttpTranscriptionProvider,ProcessorRegistry,installFileProcessorContributions,type FileProcessor} from '../src/file-processors.js';
import {decodeDocument,documentChunks} from '@mote/shared/document-decoder';

test('a failed PDF page preserves later pages and reports actual page coverage',async()=>{
 const decoded=await decodeDocument(new Uint8Array([1]),'application/pdf',{docx:async()=>{throw Error('unexpected');},pdf:async()=>({getDocument:()=>({promise:Promise.resolve({numPages:3,async getPage(number:number){if(number===2)throw Error('generated page failure');return {getTextContent:async()=>({items:[{str:number===1?'Generated first':'Generated last',hasEOL:false}]}),cleanup(){}};},async destroy(){}})})})});
 assert.deepEqual(decoded.extraction,{status:'partial',completed:2,total:3,reason:'Pages that could not be extracted: 2. PDF text layers were extracted; embedded image text was not OCRed.'});
 assert.deepEqual([...documentChunks(decoded)].map(part=>[part.documentLocation.pageNumber,part.text]),[[1,'Generated first'],[3,'Generated last']]);
});
test('paragraph and cell ranges retain bounded chunking and exact decoded offsets',async()=>{
 const text=Array.from({length:8},(_,index)=>`P${index}\n\n`).join(''),decoded=await decodeDocument(new TextEncoder().encode(text),'text/plain',{pdf:async()=>{},docx:async()=>{}}),parts=[...documentChunks(decoded,10)];
 assert.equal(parts.length,Math.ceil(text.length/10));assert.equal(parts.map(part=>part.text).join(''),text);
 assert.deepEqual([parts[0].documentLocation.paragraphNumber,parts[0].documentLocation.endParagraphNumber],[1,3]);
 for(const part of parts)assert.equal(text.slice(part.documentLocation.offset,part.documentLocation.offset+part.documentLocation.length),part.text);
 const row={rowNumber:1,cells:Array.from({length:6},(_,index)=>({column:index+1,value:`Generated ${index}`}))},sheetText=JSON.stringify({sheet:'Generated',...row})+'\n';
 const sheet={text:sheetText,parser:'exceljs',status:'ready' as const,coverage:'full' as const,warnings:[],sheets:[{name:'Generated',rows:[row]}]},cells=[...documentChunks(sheet,35)];
 assert.equal(cells.length,Math.ceil(sheetText.length/35));assert.equal(cells.map(part=>part.text).join(''),sheetText);
 assert.ok(cells.some(part=>part.documentLocation.endColumnNumber!==undefined));
 for(const part of cells)assert.equal(sheetText.slice(part.documentLocation.offset,part.documentLocation.offset+part.documentLocation.length),part.text);
});

test('offline transcription uses explicit transport constraints with an unrelated processor name',async t=>{
 const seen:string[]=[];let confirmsLocal=true;
 const server=createServer(async(req,res)=>{for await(const _ of req){}seen.push(String(req.headers['x-mote-offline']));if(confirmsLocal)res.setHeader('X-Mote-Execution','local');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated speech'}]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const settings=fileProcessingSchema.parse({audioProcessor:'example.independent-asr',endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/transcribe`});
 const provider=new HttpTranscriptionProvider(),input=()=>({body:(async function*(){yield Buffer.from('generated');})(),sizeBytes:9,mimeType:'audio/wav',settings,localOnly:true,maxAudioMs:2000,signal:AbortSignal.timeout(5000)});
 const result=await provider.transcribe(input());assert.equal(result.segments[0].text,'Generated speech');assert.deepEqual(seen,['1']);
 confirmsLocal=false;await assert.rejects(provider.transcribe(input()),/did not confirm offline execution/);
 await assert.rejects(provider.transcribe({...input(),settings:{...settings,endpoint:'https://example.test/transcribe',allowRemote:true}}),/loopback worker/);
 assert.equal(seen.length,2,'nonlocal endpoints are rejected before transmission');
});

test('processor registration rejects contradictory or malformed capability declarations',()=>{
 const registry=new ProcessorRegistry(),base:FileProcessor={id:'fixture.contract',name:'Generated',version:'1',stage:'extract',mediaTypes:['text/'],process:async()=>({durationMs:0,segments:[]})};
 assert.throws(()=>registry.register({...base,dialogue:true}),/audio extraction/);
 assert.throws(()=>registry.register({...base,dependencies:{settings:['invented' as any]}}),/dependencies/);
 assert.throws(()=>registry.register({...base,allowSummary:'yes' as any}),/capability/);
 assert.throws(()=>registry.register({...base,stage:'diarize',reuseByContent:true}),/reuse capability/);
 assert.throws(()=>registry.register({...base,reuseByContent:'yes' as any}),/reuse capability/);
 assert.throws(()=>registry.register({...base,optionalService:true}),/optional processing service/);
 assert.doesNotThrow(()=>registry.register({...base,id:'fixture.optional-service',serviceKind:'image',optionalService:true}));
 assert.doesNotThrow(()=>registry.register({...base,localOnly:true,allowSummary:true,dependencies:{settings:[]}}));
 assert.equal(registry.list().find(processor=>processor.id==='fixture.contract')?.localOnly,true);
});

test('a duplicate processor contribution fails atomically and never replaces the installed definition',()=>{
 const registry=new ProcessorRegistry(),base:FileProcessor={id:'fixture.contribution',name:'Generated original',version:'1',stage:'extract',mediaTypes:['text/'],process:async()=>({durationMs:0,segments:[]})};
 const remove=installFileProcessorContributions(registry,[{id:'generated.first',processors:[base]}]);
 assert.throws(()=>installFileProcessorContributions(registry,[{id:'generated.second',processors:[
  {...base,id:'fixture.rolled-back',name:'Generated rolled back'},
  {...base,name:'Generated replacement'},
 ]}]),/duplicate file processor/);
 assert.equal(registry.get('fixture.contribution').name,'Generated original','the existing processor keeps its definition');
 assert.throws(()=>registry.get('fixture.rolled-back'),/unavailable/,'a rejected contribution installs none of its processors');
 remove();
 assert.throws(()=>registry.get('fixture.contribution'),/unavailable/);
});
