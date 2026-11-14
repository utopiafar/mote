import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer,type IncomingMessage} from 'node:http';
import type {TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {mediaModelIdentities} from '../../src/media-assets.js';
import {FUNASR_PROTOCOL,parseFunasrRequest,parseFunasrResponse,type FunasrRequest,type FunasrSpeakers} from '../../src/funasr-contract.js';
import {sha256} from '../../src/store.js';

/** Only inference is generated. The production Python serializer emits the
 * current wire/checkpoint bytes consumed by the real TypeScript processors. */
export function generatedFunasr(input:{audio:Buffer;durationMs:number;segments:{startMs:number;endMs:number;text:string;speaker:number}[];speakers?:FunasrSpeakers}){
  const producer=spawnSync('python3',['-c',String.raw`
import json,sys
import mote_asr_contract as c
from test_mote_asr_contract import generated_identity,generated_source
data=json.load(sys.stdin)
identity=generated_identity();identity['models']=data['models']
source=generated_source(data['durationMs']);source['audioSha256']=data['audioSha256']
request={'protocol':c.PROTOCOL,'operation':'recognize','audioSha256':source['audioSha256'],'maxAudioMs':data['durationMs'],'identity':identity}
rows=[{'start':s['startMs'],'end':s['endMs'],'text':s['text']} for s in data['segments']]
native={'text':'\n'.join(row['text'] for row in rows),'sentence_info':rows}
recognition=c.recognize_to_checkpoint(request,source,identity,{'value':[[0,data['durationMs']]]},native,[{'text':native['text']}])
diarize={**request,'operation':'diarize','checkpoint':json.loads(recognition)['checkpoint'],'speakers':data['speakers']}
result=c.speakers_from_sdk(c.read_checkpoint(diarize['checkpoint']),diarize['speakers'],
                         [{**row,'spk':s['speaker']} for row,s in zip(rows,data['segments'])],
                         [[s['startMs']/1000,s['endMs']/1000,s['speaker']] for s in data['segments']],[])
diarization=c.diarize_from_checkpoint(diarize,source,identity,lambda cp,options:result)
print(c.serialize({'identity':identity,'recognition':recognition,'diarization':diarization}))
`],{cwd:fileURLToPath(new URL('../../../../scripts/',import.meta.url)),encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
    input:JSON.stringify({...input,audio:undefined,audioSha256:sha256(input.audio),models:mediaModelIdentities('dialogue'),speakers:input.speakers??{mode:'unknown'}})});
  assert.equal(producer.status,0,producer.stderr||String(producer.error));
  const generated=JSON.parse(producer.stdout);
  const recognition=parseFunasrResponse(generated.recognition);
  assert.ok(recognition.status==='succeeded'&&recognition.operation==='recognize');
  const diarization=parseFunasrResponse(generated.diarization);
  assert.ok(diarization.status==='succeeded'&&diarization.operation==='diarize');
  return {
    health:{protocol:FUNASR_PROTOCOL,execution:'local',asr:true,diarization:true,identity:generated.identity,missingDependencies:[]},
    recognition,
    diarization,
    response(request:FunasrRequest){
      assert.equal(request.audioSha256,sha256(input.audio));
      assert.ok(request.maxAudioMs>=input.durationMs);
      if(request.operation==='diarize')assert.deepEqual(request.checkpoint,recognition.checkpoint,'diarization retains the original recognition bytes');
      const response=generated[request.operation==='recognize'?'recognition':'diarization'] as string;
      parseFunasrResponse(response,request);
      return response;
    },
  };
}

/** Decode the actual multipart request before comparing its original bytes. */
export async function readFunasrRequest(req:IncomingMessage,audio:Buffer){
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=Buffer.concat(chunks);assert.equal(body.length,Number(req.headers['content-length']));
  const form=await new Response(body,{headers:{'content-type':String(req.headers['content-type'])}}).formData();
  const file=form.get('audio');assert.ok(file instanceof Blob);const bytes=Buffer.from(await file.arrayBuffer());assert.deepEqual(bytes,audio);
  const request=parseFunasrRequest(String(form.get('request')));assert.equal(request.audioSha256,sha256(audio));
  assert.equal(request.operation,req.url==='/transcribe'?'recognize':'diarize');
  return {request,audio:bytes};
}

export async function serveGeneratedFunasr(t:TestContext,input:Parameters<typeof generatedFunasr>[0],onRecognize?:()=>void){
  const generated=generatedFunasr(input),requests:FunasrRequest[]=[],originals:{path:string;bytes:Buffer}[]=[],errors:unknown[]=[],token='generated-funasr-worker';
  const service=createServer((req,res)=>{void(async()=>{
    assert.equal(req.headers.authorization,'Bearer '+token);
    res.setHeader('Content-Type','application/json');res.setHeader('X-Mote-Execution','local');
    if(req.url==='/health'){res.end(JSON.stringify(generated.health));return;}
    assert.ok(req.url==='/transcribe'||req.url==='/diarize');
    const {request,audio}=await readFunasrRequest(req,input.audio);requests.push(request);originals.push({path:req.url,bytes:audio});
    if(request.operation==='recognize')onRecognize?.();
    if(req.headers['x-mote-request-id'])res.setHeader('X-Mote-Receipt-Id',String(req.headers['x-mote-request-id']));
    res.end(generated.response(request));
  })().catch(error=>{errors.push(error);res.writeHead(500).end();});});
  t.after(async()=>{service.closeAllConnections();await new Promise<void>(resolve=>service.close(()=>resolve()));assert.deepEqual(errors,[],'generated inference boundary assertions must surface');});
  await new Promise<void>(resolve=>service.listen(0,'127.0.0.1',resolve));
  return {...generated,requests,originals,token,endpoint:`http://127.0.0.1:${(service.address() as {port:number}).port}/transcribe`};
}
