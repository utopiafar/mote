import {ProviderFailure,providerHttpFailure} from '@mote/shared';
import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import {extractDocument,extractUtf8} from './format-work.js';
import { moteText } from './i18n.js';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import {pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {once} from 'node:events';
import {transcriptSchema,diarizationSchema,type Transcript,type FileProcessingSettings,processorParameterSchema,type ProcessorParameter} from '@mote/shared';
import {StoreError} from './store.js';
import {BackendPluginScope} from './backend-plugin-scope.js';

export interface TranscriptionProvider {
  transcribe(input:{body:AsyncIterable<Buffer>;sizeBytes:number;mimeType:string;settings:FileProcessingSettings;maxAudioMs:number;signal:AbortSignal}):Promise<Transcript>;
}
export function isLoopback(endpoint:string){try{return ['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname);}catch{return false;}}
export async function readProcessorJson(response:Response,limit=32*1024*1024){
  if(!response.ok){await response.body?.cancel();throw new ProviderFailure(providerHttpFailure(response.status,response.headers.get('retry-after')));}
  const reader=response.body?.getReader();if(!reader)throw new StoreError('Empty processing response',502);
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new StoreError('Processing response exceeds limit',502);chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function postLocalProcessor(endpoint:string,headers:Record<string,string>,body:AsyncIterable<Buffer>,signal:AbortSignal,limit=32*1024*1024){
  const url=new URL(endpoint),request=url.protocol==='https:'?httpsRequest:httpRequest;
  return new Promise<unknown>((resolve,reject)=>{
    const outgoing=request(url,{method:'POST',headers,signal},async incoming=>{
      try{
        if((incoming.statusCode??0)<200||(incoming.statusCode??0)>=300){incoming.resume();throw new ProviderFailure(providerHttpFailure(incoming.statusCode??502,String(incoming.headers['retry-after']??'')));}
        if(incoming.headers['x-mote-execution']!=='local'){incoming.resume();throw new StoreError('Local worker did not confirm offline execution',502);}
        const chunks:Buffer[]=[];let length=0;
        for await(const chunk of incoming){length+=chunk.length;if(length>limit)throw new StoreError('Processing response exceeds limit',502);chunks.push(chunk);}
        resolve(JSON.parse(Buffer.concat(chunks,length).toString('utf8')));
      }catch(error){reject(error);}
    });
    outgoing.on('error',reject);
    void (async()=>{let sent=0;for await(const chunk of body){signal.throwIfAborted();sent+=chunk.length;if(!outgoing.write(chunk))await once(outgoing,'drain',{signal});}if(sent!==Number(headers['Content-Length']))throw new StoreError('Local upload size changed',409);outgoing.end();})().catch(error=>{outgoing.destroy();reject(error);});
  });
}
export class HttpTranscriptionProvider implements TranscriptionProvider {
  async transcribe(input:Parameters<TranscriptionProvider['transcribe']>[0]){
    const {settings,signal}=input,localOnly=settings.audioProcessor==='audio.local-dialogue';
    if(localOnly&&!isLoopback(settings.endpoint))throw new StoreError('Local dialogue requires a loopback worker',409);
    const headers={'Content-Type':'application/octet-stream','Content-Length':String(input.sizeBytes),'X-Mote-Max-Audio-Ms':String(input.maxAudioMs),...(localOnly?{'X-Mote-Offline':'1'}:{}),...(settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{})};
    if(localOnly)return transcriptSchema.parse(await postLocalProcessor(settings.endpoint,headers,input.body,signal));
    const response=await fetch(settings.endpoint,{method:'POST',headers,body:input.body as unknown as BodyInit,duplex:'half',redirect:'error',signal} as RequestInit);
    return transcriptSchema.parse(await readProcessorJson(response));
  }
}
export interface ProcessorInput {
  file:{id:string;title:string;mimeType:string;sizeBytes:number};
  parameters?:Record<string,string|number|boolean|null>;settings:FileProcessingSettings;signal:AbortSignal;maxAudioMs:number;
  readOriginal():AsyncIterable<Buffer>;
}
export interface FileProcessor {
  id:string;version:string;name:string;stage:'extract'|'diarize';mediaTypes:string[];localOnly?:boolean;serviceKind?:'asr'|'image'|'file';parameters?:ProcessorParameter[];
  process(input:ProcessorInput):Promise<unknown>;
}
export class ProcessorRegistry {
  private entries=new Map<string,FileProcessor>();
  register(processor:FileProcessor){
    if(!/^[a-z][a-z0-9.-]{0,99}$/.test(processor.id)||!processor.version||this.entries.has(processor.id))throw new Error('Invalid or duplicate file processor');
    if(processor.parameters){processor.parameters=processor.parameters.map(p=>processorParameterSchema.parse(p));if(new Set(processor.parameters.map(p=>p.key)).size!==processor.parameters.length)throw new Error('Duplicate processor parameter');}
    this.entries.set(processor.id,processor);
    return ()=>{if(this.entries.get(processor.id)===processor)this.entries.delete(processor.id);};
  }
  get(id:string){const processor=this.entries.get(id);if(!processor)throw new StoreError('Processing plugin is unavailable',409);return processor;}
  list(){return [...this.entries.values()].map(({process,...metadata})=>metadata);}
}
declare module '@deepseek-ai/cordis' {interface Context {moteFileProcessors:ProcessorRegistry;}}
function builtin(processor:FileProcessor):Plugin {
  return {name:'mote-'+processor.id,inject:['moteFileProcessors'],apply(ctx:Context){ctx.effect(()=>ctx.moteFileProcessors.register(processor));}};
}
/** File processing plugins live in the shared backend context when mounted by the server. */
export class FileProcessorRuntime {
  readonly context:Context;readonly registry=new ProcessorRegistry();readonly ready:Promise<void>;private readonly pluginScope:BackendPluginScope;
  constructor(provider:TranscriptionProvider=new HttpTranscriptionProvider(),plugins:Plugin[]=[],modules:string[]=[],contextProcessors?:import('./processing-runtime.js').ContextProcessorRegistry,root?:Context){
    this.pluginScope=new BackendPluginScope(root);this.context=this.pluginScope.context;
    this.pluginScope.provide('moteFileProcessors',this.registry);
    if(contextProcessors&&!root)this.pluginScope.provide('moteContextProcessors',contextProcessors);
    const audio=(id:string,localOnly=false)=>builtin({id,version:'1',name:localOnly?moteText("本地多人录音"):moteText("转写接口"),stage:'extract',mediaTypes:['audio/'],localOnly,serviceKind:'asr',parameters:localOnly?[{key:'speakerCount',label:moteText("预期说话人数"),type:'number',nullable:true,default:null,min:1,max:16,integer:true,description:moteText("留空由模型自动识别")},{key:'semanticTurns',label:moteText("使用本地语言模型合并自然发言轮次"),type:'boolean',default:false}]:[],
      process:input=>provider.transcribe({body:input.readOriginal(),sizeBytes:input.file.sizeBytes,mimeType:input.file.mimeType,settings:input.settings,maxAudioMs:input.maxAudioMs,signal:input.signal})});
    const pluginScope=this.pluginScope;
    this.ready=(async()=>{
      try{
        await pluginScope.install(audio('audio.http'));
        await pluginScope.install(audio('audio.local-dialogue',true));
        await pluginScope.install(builtin({id:'text.utf8',version:'3',name:moteText("UTF-8 文字提取"),stage:'extract',mediaTypes:['text/'],localOnly:true,process:input=>extractUtf8(input.readOriginal(),input.file.sizeBytes,input.signal)}));
        await pluginScope.install(builtin({id:'document.generic',version:'1',name:moteText("文档文字提取"),stage:'extract',mediaTypes:[...DOCUMENT_MIME_TYPES],localOnly:true,process:input=>extractDocument(input.readOriginal(),input.file.sizeBytes,input.file.mimeType,input.signal)}));
        await pluginScope.install(builtin({id:'image.http',version:'1',name:moteText("图片文字提取接口"),stage:'extract',mediaTypes:['image/'],serviceKind:'image',async process(input){
          if(!input.settings.imageEndpoint)throw new StoreError('Image processing service is not configured',409);
          const response=await fetch(input.settings.imageEndpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(input.file.sizeBytes),'X-Mote-Media-Type':input.file.mimeType,...(input.settings.apiKey?{Authorization:`Bearer ${input.settings.apiKey}`}:{})},body:input.readOriginal() as unknown as BodyInit,duplex:'half',signal:input.signal,redirect:'error'} as RequestInit);
          const transcript=transcriptSchema.parse(await readProcessorJson(response));if(transcript.durationMs!==0)throw new StoreError('Image text cannot have audio duration',502);return transcript;
        }}));
        await pluginScope.install(builtin({id:'audio.diarize',version:'1',name:moteText("本地说话人分离"),stage:'diarize',mediaTypes:['audio/'],localOnly:true,async process(input){
          if(!isLoopback(input.settings.endpoint))throw new StoreError('Diarization requires a loopback worker',409);
          const endpoint=new URL(input.settings.endpoint);endpoint.pathname=endpoint.pathname.replace(/\/transcribe\/?$/,'/diarize');
          if(!endpoint.pathname.endsWith('/diarize'))throw new StoreError('Local worker URL must end with /transcribe',409);
          const headers={'Content-Type':'application/octet-stream','Content-Length':String(input.file.sizeBytes),'X-Mote-Offline':'1','X-Mote-Max-Audio-Ms':String(input.maxAudioMs),'X-Mote-Speaker-Count':String(input.settings.speakerCount??0),...(input.settings.apiKey?{Authorization:`Bearer ${input.settings.apiKey}`}:{})};
          return diarizationSchema.parse(await postLocalProcessor(endpoint.toString(),headers,input.readOriginal(),input.signal));
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
