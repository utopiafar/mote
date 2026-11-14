// A fresh Node process must configure its global proxy agents at startup.
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {fileProcessingSchema} from '@mote/shared';
import {FileProcessorRuntime,HttpTranscriptionProvider,type ProcessorInput} from '../../src/file-processors.js';
import {requestLocalJson} from '../../src/local-http.js';
import {sha256} from '../../src/store.js';
import {generatedFunasr} from './funasr.js';
import {parseFunasrArchive,parseFunasrResponse,projectFunasrDiarization} from '../../src/funasr-contract.js';

const endpoint=process.argv[2],url=new URL(endpoint),request=url.protocol==='https:'?httpsRequest:httpRequest;
await new Promise<void>((resolve,reject)=>{
  const req=request(new URL('/proxy-control',endpoint),res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{assert.equal(JSON.parse(text).proxyControl,true);resolve();}catch(error){reject(error);}});});
  req.on('error',reject);req.end();
});
const audio=Buffer.from([0,255,1,2,3,10,13,0]),image=Buffer.from([137,80,78,71,0,255,3]),apiKey='generated-worker-token';
const native=generatedFunasr({audio,durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated speech',speaker:0}]});
const settings=fileProcessingSchema.parse({endpoint:endpoint+'/transcribe',imageEndpoint:endpoint+'/ocr',apiKey,timeoutMs:1800000});
const body=(bytes:Buffer)=>(async function*(){yield bytes.subarray(0,3);yield bytes.subarray(3);})();
const provider=new HttpTranscriptionProvider(),input=()=>({body:body(audio),sizeBytes:audio.length,mimeType:'audio/wav',settings,maxAudioMs:2000,signal:AbortSignal.timeout(5000)});
assert.equal((await provider.transcribe({...input(),localOnly:true})).segments[0].text,'Generated speech');
assert.equal((await provider.transcribe({...input(),localOnly:false})).segments[0].text,'Generated speech');
const runtime=new FileProcessorRuntime();await runtime.ready;
try{
  const processorInput=(bytes:Buffer,mimeType:string):ProcessorInput=>({file:{id:'generated-id',title:'Generated fixture',mimeType,sizeBytes:bytes.length,sha256:sha256(bytes)},settings,maxAudioMs:2000,signal:AbortSignal.timeout(5000),recognition:native.recognition.checkpoint,readOriginal:()=>body(bytes)});
  const response=parseFunasrResponse(await runtime.registry.get('audio.diarize').process(processorInput(audio,'audio/wav')));
  assert.ok(response.status==='succeeded'&&response.operation==='diarize');
  const diarization=projectFunasrDiarization(parseFunasrArchive(response.checkpoint),response.diarization);assert.equal(diarization.observedSpeakers,1);
  const ocr=await runtime.registry.get('image.http').process(processorInput(image,'image/png')) as {durationMs:number};assert.equal(ocr.durationMs,0);
  const health=await requestLocalJson(endpoint+'/health',{headers:{Authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(5000),limit:4096}) as {execution:string};assert.equal(health.execution,'local');
}finally{await runtime.close();}
console.log('passed');
