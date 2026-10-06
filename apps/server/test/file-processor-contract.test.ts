import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileProcessingSchema} from '@mote/shared';
import {HttpTranscriptionProvider,ProcessorRegistry,type FileProcessor} from '../src/file-processors.js';

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
 assert.doesNotThrow(()=>registry.register({...base,localOnly:true,allowSummary:true,dependencies:{settings:[]}}));
 assert.equal(registry.list()[0].localOnly,true);
});
