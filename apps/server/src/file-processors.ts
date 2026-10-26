import {InstallationEpochs} from './installation-epochs.js';
import {ProviderFailure,providerHttpFailure} from '@mote/shared';
import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import {extractDocument,extractUtf8} from './format-work.js';
import { moteText } from './i18n.js';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import {pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';
import {isLoopback,requestLocalJson} from './local-http.js';
import {transcriptSchema,diarizationSchema,fileProcessingSchema,type Transcript,type FileProcessingSettings,processorParameterSchema,type ProcessorParameter} from '@mote/shared';
import {StoreError,sha256} from './store.js';
import type {ModelConnection} from './background-model-authorization.js';
import type {ProcessingService} from '@mote/shared';
import {BackendPluginScope} from './backend-plugin-scope.js';
import {ImportIntakeRegistry,installImportIntake} from './import-intake.js';
import {FileRecipeRegistry,FileOutputRegistry,installFileRecipes,type ComponentRef} from './file-recipes.js';
import {ImageInputRegistry} from './image-inputs.js';
import {ImageRecipeRegistry,installImageRecipes} from './image-recipes.js';

export type MediaRequestIdentity={requestId:string;requestScope:string;onRequest:()=>void;onExecutionFacts?:(supported:boolean)=>void};
export interface TranscriptionProvider {
  transcribe(input:{body:AsyncIterable<Buffer>;sizeBytes:number;mimeType:string;settings:FileProcessingSettings;localOnly?:boolean;maxAudioMs:number;signal:AbortSignal;request?:MediaRequestIdentity;authorizeModel?:()=>void}):Promise<Transcript>;
}
export {isLoopback} from './local-http.js';
export async function readProcessorJson(response:Response,limit=32*1024*1024){
  if(!response.ok){await response.body?.cancel();throw new ProviderFailure(providerHttpFailure(response.status,response.headers.get('retry-after')));}
  const reader=response.body?.getReader();if(!reader)throw new StoreError('Empty processing response',502);
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new StoreError('Processing response exceeds limit',502);chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
const postLocalProcessor=(endpoint:string,headers:Record<string,string>,body:AsyncIterable<Buffer>,signal:AbortSignal,requireOfflineExecution=true,request?:MediaRequestIdentity,authorizeModel?:()=>void)=>requestLocalJson(endpoint,{method:'POST',headers:{...headers,...(request?{'X-Mote-Request-Id':request.requestId,'X-Mote-Request-Scope':request.requestScope}:{})},body,signal,requireOfflineExecution,
  onRequest:()=>{authorizeModel?.();request?.onRequest();},...(request?{onResponseHeaders:headers=>request.onExecutionFacts?.(headers['x-mote-receipt-id']===request.requestId)}:{})});
export class HttpTranscriptionProvider implements TranscriptionProvider {
  async transcribe(input:Parameters<TranscriptionProvider['transcribe']>[0]){
    const {settings,signal,localOnly=false}=input;
    if(localOnly&&!isLoopback(settings.endpoint))throw new StoreError('Local dialogue requires a loopback worker',409);
    const headers={'Content-Type':'application/octet-stream','Content-Length':String(input.sizeBytes),'X-Mote-Max-Audio-Ms':String(input.maxAudioMs),...(isLoopback(settings.endpoint)?{'X-Mote-Processing-Timeout-Ms':String(settings.timeoutMs)}:{}),...(localOnly?{'X-Mote-Offline':'1'}:{}),...(settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{})};
    if(localOnly||isLoopback(settings.endpoint))return transcriptSchema.parse(await postLocalProcessor(settings.endpoint,headers,input.body,signal,localOnly,input.request,input.authorizeModel));
    signal.throwIfAborted();input.authorizeModel?.();
    const response=await fetch(settings.endpoint,{method:'POST',headers,body:input.body as unknown as BodyInit,duplex:'half',redirect:'error',signal} as RequestInit);
    return transcriptSchema.parse(await readProcessorJson(response));
  }
}
/** Only builtin, host-controlled transports can declare their actual model
 * destination. Secrets are incorporated only into the final digest. */
export function mediaModelConnection(processor:Pick<FileProcessor,'id'|'version'|'localOnly'>,service:ProcessingService,settings:FileProcessingSettings):ModelConnection|undefined {
 if(!['audio.http','audio.local-dialogue','audio.diarize','audio.diarize-wespeaker','image.http'].includes(processor.id))return;
 if(processor.localOnly&&service.execution!=='local')return;
 const endpoint=processor.id==='image.http'?settings.imageEndpoint:settings.endpoint;
 if(!endpoint)return;
 const url=new URL(endpoint);if(processor.id==='audio.diarize'||processor.id==='audio.diarize-wespeaker')url.pathname=url.pathname.replace(/\/transcribe\/?$/,'/diarize');
 return {id:'media:'+service.id+':'+processor.id,fingerprint:sha256(JSON.stringify({processor:processor.id,version:processor.version,service:service.id,execution:service.execution,endpoint:url.toString(),model:service.model,credential:sha256(settings.apiKey??'')}))};
}
export interface ProcessorInput {
  file:{id:string;title:string;mimeType:string;sizeBytes:number};
  parameters?:Record<string,string|number|boolean|null>;settings:FileProcessingSettings;signal:AbortSignal;maxAudioMs:number;
  request?:MediaRequestIdentity;authorizeModel?:()=>void;
  readOriginal():AsyncIterable<Buffer>;
}
export interface FileProcessor {
  id:string;version:string;name:string;stage:'extract'|'diarize';mediaTypes:string[];localOnly?:boolean;serviceKind?:'asr'|'image'|'file';parameters?:ProcessorParameter[];
  allowSummary?:boolean;
  /** Compose the selected diarizer, exact alignment and optional semantic grouping. */
  dialogue?:boolean;
  /** Opt into the host-managed dialogue worker's model availability/version. */
  managedModel?:'dialogue'|'speaker-wespeaker';
  /** Omitted dependencies conservatively include all settings and parameters. */
  dependencies?:{settings:(keyof FileProcessingSettings)[];parameters?:string[]};
  /** Output depends only on original bytes, MIME and the pinned processor inputs,
   * never on a record ID, title, owner context or human corrections. */
  reuseByContent?:boolean;
  /** Issued HTTP calls retain their deadline after publication is cancelled. Default: forward cancellation. */
  awaitResponseOnCancel?:boolean;
  output?:ComponentRef;
  recipe?:ComponentRef;
  process(input:ProcessorInput):Promise<unknown>;
}
// Only host-authored builtin metadata is translated; plugin-authored strings stay literal.
const builtinProcessors=new WeakSet<FileProcessor>();
export class ProcessorRegistry {
  private entries=new Map<string,FileProcessor>();
  readonly epochs=new InstallationEpochs();
  register(processor:FileProcessor){
    if(!/^[a-z][a-z0-9.-]{0,99}$/.test(processor.id)||!processor.version||this.entries.has(processor.id))throw new Error('Invalid or duplicate file processor');
    if(processor.awaitResponseOnCancel!==undefined&&typeof processor.awaitResponseOnCancel!=='boolean')throw new Error('Invalid processor cancellation capability');
    if(processor.dialogue&&(processor.stage!=='extract'||!processor.mediaTypes.length||!processor.mediaTypes.every(type=>type.startsWith('audio/'))))throw new Error('Dialogue composition requires an audio extraction processor');
    if(processor.managedModel!==undefined&&!['dialogue','speaker-wespeaker'].includes(processor.managedModel))throw new Error('Unknown managed processing model');
    if(processor.reuseByContent!==undefined&&(typeof processor.reuseByContent!=='boolean'||processor.stage!=='extract'))throw new Error('Invalid content reuse capability');
    if(processor.dialogue!==undefined&&typeof processor.dialogue!=='boolean'||processor.localOnly!==undefined&&typeof processor.localOnly!=='boolean'||processor.allowSummary!==undefined&&typeof processor.allowSummary!=='boolean')throw new Error('Invalid processing capability');
    if(processor.dependencies){
      const {settings,parameters}=processor.dependencies;
      if(!Array.isArray(settings)||settings.some(key=>!Object.hasOwn(fileProcessingSchema.innerType().shape,key))||new Set(settings).size!==settings.length||
        parameters!==undefined&&(!Array.isArray(parameters)||parameters.some(key=>typeof key!=='string'||!key||key.length>128)||new Set(parameters).size!==parameters.length))throw new Error('Invalid processor dependencies');
    }
    if(processor.parameters){processor.parameters=processor.parameters.map(p=>processorParameterSchema.parse(p));if(new Set(processor.parameters.map(p=>p.key)).size!==processor.parameters.length)throw new Error('Duplicate processor parameter');}
    const revoke=this.epochs.install(processor.id);this.entries.set(processor.id,processor);
    return ()=>{revoke();if(this.entries.get(processor.id)===processor)this.entries.delete(processor.id);};
  }
  get(id:string){const processor=this.entries.get(id);if(!processor)throw new StoreError('Processing plugin is unavailable',409);return processor;}
  list(){return [...this.entries.values()].map(processor=>{
    const {process,...metadata}=processor;
    if(!builtinProcessors.has(processor))return metadata;
    // Keep canonical labels in the registry; concurrent request locales get independent views.
    return {...metadata,name:moteText(metadata.name),...(metadata.parameters?{parameters:metadata.parameters.map(parameter=>({...parameter,label:moteText(parameter.label),...(parameter.description!==undefined?{description:moteText(parameter.description)}:{})}))}:{})};
  });}
}
declare module '@deepseek-ai/cordis' {interface Context {moteFileProcessors:ProcessorRegistry;}}
function builtin(processor:FileProcessor):Plugin {
  builtinProcessors.add(processor);
  return {name:'mote-'+processor.id,inject:['moteFileProcessors'],apply(ctx:Context){ctx.effect(()=>ctx.moteFileProcessors.register(processor));}};
}
/** File processing plugins live in the shared backend context when mounted by the server. */
export class FileProcessorRuntime {
  readonly context:Context;readonly registry=new ProcessorRegistry();readonly ready:Promise<void>;private readonly pluginScope:BackendPluginScope;
  readonly intake=new ImportIntakeRegistry();readonly recipes=new FileRecipeRegistry();readonly outputs=new FileOutputRegistry();
  readonly imageRecipes=new ImageRecipeRegistry();readonly imageInputs=new ImageInputRegistry();
  constructor(provider:TranscriptionProvider=new HttpTranscriptionProvider(),plugins:Plugin[]=[],modules:string[]=[],contextProcessors?:import('./processing-runtime.js').ContextProcessorRegistry,root?:Context){
    this.pluginScope=new BackendPluginScope(root);this.context=this.pluginScope.context;
    this.pluginScope.provide('moteFileProcessors',this.registry);
    this.pluginScope.provide('moteImportIntake',this.intake);
    this.pluginScope.provide('moteFileRecipes',this.recipes);
    this.pluginScope.provide('moteFileOutputs',this.outputs);
    this.pluginScope.provide('moteImageRecipes',this.imageRecipes);
    this.pluginScope.provide('moteImageInputs',this.imageInputs);
    if(contextProcessors&&!root)this.pluginScope.provide('moteContextProcessors',contextProcessors);
    const audio=(id:string,localOnly=false)=>builtin({id,version:localOnly?'4':'3',name:localOnly?"本地多人录音":"转写接口",stage:'extract',mediaTypes:['audio/'],localOnly,serviceKind:'asr',awaitResponseOnCancel:true,
      ...(localOnly?{dialogue:true,managedModel:'dialogue' as const}:{}),dependencies:{settings:['endpoint','apiKey','allowRemote'],parameters:[]},
      parameters:localOnly?[{key:'speakerCount',label:"预期说话人数",type:'number',nullable:true,default:null,min:1,max:16,integer:true,description:"留空由模型自动识别"},{key:'speakerMin',label:'说话人数下限',type:'number',nullable:true,default:null,min:1,max:16,integer:true,description:'仅在已知范围时填写；与准确人数互斥'},{key:'speakerMax',label:'说话人数上限',type:'number',nullable:true,default:null,min:1,max:16,integer:true},{key:'semanticTurns',label:"使用所选语言模型合并自然发言轮次",type:'boolean',default:false}]:[],
      process:input=>provider.transcribe({body:input.readOriginal(),sizeBytes:input.file.sizeBytes,mimeType:input.file.mimeType,settings:input.settings,localOnly,maxAudioMs:input.maxAudioMs,signal:input.signal,request:input.request,authorizeModel:input.authorizeModel})});
    const pluginScope=this.pluginScope;
    this.ready=(async()=>{
      try{
        await pluginScope.install({name:'mote-file-capabilities',apply:ctx=>{ctx.effect(()=>installImportIntake(this.intake));ctx.effect(()=>installFileRecipes(this.recipes,this.outputs));ctx.effect(()=>installImageRecipes(this.imageRecipes));}});
        await pluginScope.install(audio('audio.http'));
        await pluginScope.install(audio('audio.local-dialogue',true));
        await pluginScope.install(builtin({id:'text.utf8',version:'3',name:"UTF-8 文字提取",stage:'extract',mediaTypes:['text/'],localOnly:true,dependencies:{settings:[]},process:input=>extractUtf8(input.readOriginal(),input.file.sizeBytes,input.signal)}));
        await pluginScope.install(builtin({id:'document.generic',version:'1',name:"文档文字提取",stage:'extract',mediaTypes:[...DOCUMENT_MIME_TYPES],localOnly:true,dependencies:{settings:[]},process:input=>extractDocument(input.readOriginal(),input.file.sizeBytes,input.file.mimeType,input.signal)}));
        await pluginScope.install(builtin({id:'image.http',version:'2',name:"图片文字提取接口",stage:'extract',mediaTypes:['image/'],serviceKind:'image',awaitResponseOnCancel:true,reuseByContent:true,dependencies:{settings:['imageEndpoint','apiKey','allowRemote']},async process(input){
          if(!input.settings.imageEndpoint)throw new StoreError('Image processing service is not configured',409);
          const headers={'Content-Type':'application/octet-stream','Content-Length':String(input.file.sizeBytes),'X-Mote-Media-Type':input.file.mimeType,...(input.settings.apiKey?{Authorization:`Bearer ${input.settings.apiKey}`}:{})};
          input.signal.throwIfAborted();input.authorizeModel?.();
          const value=isLoopback(input.settings.imageEndpoint)?await postLocalProcessor(input.settings.imageEndpoint,headers,input.readOriginal(),input.signal,false,input.request,input.authorizeModel):await readProcessorJson(await fetch(input.settings.imageEndpoint,{method:'POST',headers,body:input.readOriginal() as unknown as BodyInit,duplex:'half',signal:input.signal,redirect:'error'} as RequestInit));
          const transcript=transcriptSchema.parse(value);if(transcript.durationMs!==0)throw new StoreError('Image text cannot have audio duration',502);return transcript;
        }}));
        for(const alternative of [false,true])await pluginScope.install(builtin({id:alternative?'audio.diarize-wespeaker':'audio.diarize',version:alternative?'1':'3',name:alternative?'本地说话人分离 · WeSpeaker 中文':'本地说话人分离',stage:'diarize',mediaTypes:['audio/'],localOnly:true,managedModel:alternative?'speaker-wespeaker':'dialogue',awaitResponseOnCancel:true,dependencies:alternative?{settings:['endpoint','apiKey','speakerCount','speakerMin','speakerMax'],parameters:['speakerCount','speakerMin','speakerMax']}:{settings:['endpoint','apiKey','speakerCount'],parameters:['speakerCount']},async process(input){
          if(!isLoopback(input.settings.endpoint))throw new StoreError('Diarization requires a loopback worker',409);
          const endpoint=new URL(input.settings.endpoint);endpoint.pathname=endpoint.pathname.replace(/\/transcribe\/?$/,'/diarize');
          if(!endpoint.pathname.endsWith('/diarize'))throw new StoreError('Local worker URL must end with /transcribe',409);
          if(!alternative&&input.settings.speakerMin!==null)throw new StoreError('Speaker range requires the WeSpeaker plugin',409);
          const headers={...(alternative?{'X-Mote-Speaker-Model':'wespeaker-zh',...(input.settings.speakerMin!==null?{'X-Mote-Speaker-Min':String(input.settings.speakerMin),'X-Mote-Speaker-Max':String(input.settings.speakerMax)}:{})}:{}),'Content-Type':'application/octet-stream','Content-Length':String(input.file.sizeBytes),'X-Mote-Offline':'1','X-Mote-Max-Audio-Ms':String(input.maxAudioMs),'X-Mote-Processing-Timeout-Ms':String(input.settings.timeoutMs),'X-Mote-Speaker-Count':String(input.settings.speakerCount??0),...(input.settings.apiKey?{Authorization:`Bearer ${input.settings.apiKey}`}:{})};
          return diarizationSchema.parse(await postLocalProcessor(endpoint.toString(),headers,input.readOriginal(),input.signal,true,input.request,input.authorizeModel));
        }}));
        for(const plugin of plugins)await pluginScope.install(plugin);
        for(const specifier of modules){
          // Only deployment configuration selects executable plugin modules. HTTP callers cannot install code.
          const loaded=await import(isAbsolute(specifier)?pathToFileURL(specifier).href:specifier);
          await pluginScope.install(loaded.default??loaded);
        }
      }catch(error){await pluginScope.close();throw error;}
    })();
    // Initialization is explicitly awaited by the central app and by tick().
    void this.ready.catch(()=>{});
  }
  async close(){await this.ready.catch(()=>{});await this.pluginScope.close();}
}
