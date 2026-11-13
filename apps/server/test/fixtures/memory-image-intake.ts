import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import sharp from 'sharp';
import type {ContextReader,QueryInput} from '@mote/agent';
import {PluginHost} from '@mote/plugin-host';
import {ProviderFailure,type MediaModelStatus} from '@mote/shared';
import type {buildApp} from '../../src/app.js';
import {ExecutionEngine} from '../../src/execution-engine.js';
import {createPluginControlPlatform,pluginControlDeclaration,type PluginCenter} from '../../src/plugin-center.js';
import {GitHubPluginReleases} from '../../src/plugin-release.js';
import {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection} from '../../src/plugins/local-image-processing.js';
import {LOCAL_IMAGE_ERRORS,LOCAL_IMAGE_PROTOCOL,localImageRequestSchema,parseLocalImageResponse,type LocalImageSuccess} from '../../src/local-image-contract.js';
import {requestLocalJson} from '../../src/local-http.js';
import {Store,sha256} from '../../src/store.js';
import {startLocalImageFixtureWorker,type LocalImageFixture} from './local-image.js';

type Node=Awaited<ReturnType<typeof buildApp>>;
export const MEMORY_IMAGE_OCR='GENERATED_OCR_TEXT: the article author resigned.';

/** The #868 app has no CORE-03/IMG-03 default plugin binding yet. Only the
 * intake model factory is bridged here, using IMG-02's actual durable selection
 * and IMG-00's actual HTTP serializer/parser. Archive, products, organizer,
 * Memory admission, independent review and publication remain production code.
 * Model installation/readiness and inference are generated boundaries. */
export async function memoryImageIntakeBoundary(directory:string,ocr:'text'|'empty'){
 const width=ocr==='text'?720:16,height=ocr==='text'?80:16;
 const bytes=ocr==='text'?await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="80"><rect width="720" height="80" fill="white"/><text x="10" y="42" font-size="17">${MEMORY_IMAGE_OCR}</text></svg>`)).png().toBuffer():await sharp({create:{width,height,channels:3,background:'#ff0000'}}).png().toBuffer();
 const image:LocalImageFixture={id:ocr==='text'?'small-text':'empty-ocr',bytes,width,height,mimeType:'image/png',ocr:{durationMs:0,segments:ocr==='text'?[{startMs:0,endMs:0,text:MEMORY_IMAGE_OCR}]:[]},
  interpretation:{text:ocr==='text'?'A generated third-party article says its unidentified author resigned. It does not establish an owner experience.':'A generated red rectangle. The creator and event date are unknown.',regions:[]}};
 const worker=await startLocalImageFixtureWorker([image]),store=new Store(join(directory,'image-control')),executor=new ExecutionEngine(store),host=new PluginHost({kind:'central',id:randomUUID()});
 let plugins:PluginCenter|undefined,installed=true,running=false,configuredCalls=0;
 const responses:LocalImageSuccess[]=[];
 const local=createLocalImageProcessing({desired:()=>plugins?.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.desired,
  modelStatus:():MediaModelStatus=>({role:'local-image',state:installed?'ready':'not_installed',version:'generated-memory-image',bytes:0,totalBytes:0,source:'generated',runtimeReady:running}),
  createWorker:()=>({prepare(){},start(){running=true;},quiesce(){},stop(){running=false;},dispose(){running=false;}})});
 const control=createPluginControlPlatform({store,executor,host,releases:new GitHubPluginReleases(join(directory,'packages'))},[local.build]);
 const handle=await host.install({identity:{host:host.identity,packageId:'mote.plugin-control',installationId:'generated-image-control',instanceId:'control',activationId:randomUUID()},contributions:[pluginControlDeclaration],factory:control.factory});
 plugins=control.assembly;await control.startBuilds();
 return {image,worker,responses,local,counts:()=>({local:worker.requests.length,configured:configuredCalls}),
  setInstalled(value:boolean){installed=value;},
  async select(enabled:boolean){return plugins!.selectBuild(LOCAL_IMAGE_PROCESSING_INSTANCE,{operationId:randomUUID(),expectedRevision:plugins!.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.revision??plugins!.revision(),selection:enabled?localImageProcessingSelection:null});},
  async interpret(node:Node,input:QueryInput,reader:ContextReader){
   const direct=input.directImages![0],record=node.store.evidence([direct.id])[0];
   assert.equal(direct.hash,sha256(bytes));
   const pixels=await reader.readImage!({id:direct.id});
   assert.equal(pixels.data,bytes.toString('base64'));
   const port=local.selection();
   if(!port){configuredCalls++;return image.interpretation;}
   return port.run(async signal=>{
    const stored=node.store.db.prepare("SELECT json FROM image_products WHERE capture_id=? AND kind='ocr' AND current=1").get(direct.id),document=record.provenance?.document;
    const request=localImageRequestSchema.parse({version:LOCAL_IMAGE_PROTOCOL.version,operationId:input.traceContext!.operationId,captureId:direct.id,image:pixels,
     ...(stored?{ocr:JSON.parse(String(stored.json)).payload}:{}),
     context:{capturedAt:record.capturedAt,sourceType:record.source,sourceId:record.provenance?.sourceId,sourceRevision:record.provenance?.revision,title:record.windowTitle,
      attributionContext:(input.taskContext?.imageEvidence as {attributionContext?:unknown}|undefined)?.attributionContext,
      document:document?{contentRole:document.contentRole,timeBasis:document.timeBasis,recordedAt:document.recordedAt,occurredAt:document.occurredAt}:undefined}});
    const body=Buffer.from(JSON.stringify(request));
    const response=parseLocalImageResponse(await requestLocalJson(worker.url,{method:LOCAL_IMAGE_PROTOCOL.method,headers:{authorization:`Bearer ${worker.token}`,'content-type':'application/json','content-length':String(body.length)},body:(async function*(){yield body;})(),signal,limit:LOCAL_IMAGE_PROTOCOL.maxResponseBytes,requireOfflineExecution:true}),request);
    if(response.status==='error'){const failure=LOCAL_IMAGE_ERRORS[response.error.code];throw new ProviderFailure({category:failure.category,code:failure.hostCode});}
    responses.push(response);return response.result;
   },input.signal!);
  },
  async close(){try{await handle.close('shutdown');await host.close();}finally{try{await executor.close();store.close();}finally{await worker.close();}}},
 };
}

/** Real authenticated upload, including revision CAS and content-object reuse. */
export async function uploadMemoryImage(node:Node,bytes:Buffer,revision='1',previousRevision?:string){
 const headers={authorization:`Bearer ${node.featureServices.config.token}`};
 const begun=await node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:{sourceId:'generated-memory-image',...(previousRevision?{previousRevision}:{}),item:{externalId:'generated.png',revision,observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',mimeType:'image/png',title:'Generated image',text:'',document:{contentRole:'reference',timeBasis:'unknown'}},sha256:sha256(bytes),sizeBytes:bytes.length}});
 assert.equal(begun.statusCode,200,begun.body);const upload=begun.json();
 if(upload.ack)return String(upload.ack.id);
 const part=await node.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(part.statusCode,200,part.body);
 const committed=await node.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,headers,payload:{}});assert.equal(committed.statusCode,200,committed.body);
 assert.equal(committed.json().receipt.state,'received');return String(committed.json().id);
}
