import { moteText } from './i18n.js';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import {pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';
import {transcriptSchema,diarizationSchema,type Transcript,type FileProcessingSettings,processorParameterSchema,type ProcessorParameter} from '@mote/shared';
import {StoreError} from './store.js';

export interface TranscriptionProvider {
  transcribe(input:{body:AsyncIterable<Buffer>;sizeBytes:number;mimeType:string;settings:FileProcessingSettings;maxAudioMs:number;signal:AbortSignal}):Promise<Transcript>;
}
export function isLoopback(endpoint:string){try{return ['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname);}catch{return false;}}
export async function readProcessorJson(response:Response,limit=32*1024*1024){
  if(!response.ok){await response.body?.cancel();throw new StoreError(response.status===413?'Processing limit exceeded':'Processing service failed',response.status===413?413:502);}
  const reader=response.body?.getReader();if(!reader)throw new StoreError('Empty processing response',502);
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new StoreError('Processing response exceeds limit',502);chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export class HttpTranscriptionProvider implements TranscriptionProvider {
  async transcribe(input:Parameters<TranscriptionProvider['transcribe']>[0]){
    const {settings,signal}=input,localOnly=settings.audioProcessor==='audio.local-dialogue';
    if(localOnly&&!isLoopback(settings.endpoint))throw new StoreError('Local dialogue requires a loopback worker',409);
    const response=await fetch(settings.endpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(input.sizeBytes),'X-Mote-Max-Audio-Ms':String(input.maxAudioMs),...(localOnly?{'X-Mote-Offline':'1'}:{}),...(settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{})},body:input.body as unknown as BodyInit,duplex:'half',redirect:'error',signal} as RequestInit);
    if(response.ok&&localOnly&&response.headers.get('x-mote-execution')!=='local'){await response.body?.cancel();throw new StoreError('Local worker did not confirm offline execution',502);}
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
/** A persistent Cordis context, independent from short-lived query-agent runtimes. */
export class FileProcessorRuntime {
  readonly context=new Context();readonly registry=new ProcessorRegistry();readonly ready:Promise<void>;
  constructor(provider:TranscriptionProvider=new HttpTranscriptionProvider(),plugins:Plugin[]=[],modules:string[]=[],contextProcessors?:import('./processing-runtime.js').ContextProcessorRegistry){
    this.context.provide('moteFileProcessors',this.registry);
    if(contextProcessors)this.context.provide('moteContextProcessors',contextProcessors);
    const audio=(id:string,localOnly=false)=>builtin({id,version:'1',name:localOnly?moteText("本地多人录音"):moteText("转写接口"),stage:'extract',mediaTypes:['audio/'],localOnly,serviceKind:'asr',parameters:localOnly?[{key:'speakerCount',label:moteText("预期说话人数"),type:'number',nullable:true,default:null,min:1,max:16,integer:true,description:moteText("留空由模型自动识别")},{key:'semanticTurns',label:moteText("使用本地语言模型合并自然发言轮次"),type:'boolean',default:false}]:[],
      process:input=>provider.transcribe({body:input.readOriginal(),sizeBytes:input.file.sizeBytes,mimeType:input.file.mimeType,settings:input.settings,maxAudioMs:input.maxAudioMs,signal:input.signal})});
    this.ready=(async()=>{
      try{
        await this.context.plugin(audio('audio.http'));
        await this.context.plugin(audio('audio.local-dialogue',true));
        await this.context.plugin(builtin({id:'text.utf8',version:'1',name:moteText("UTF-8 文字提取"),stage:'extract',mediaTypes:['text/'],localOnly:true,async process(input){
          if(input.file.sizeBytes>2*1024*1024)throw new StoreError('Text exceeds extraction limit',413);
          const buffers:Buffer[]=[];for await(const part of input.readOriginal())buffers.push(part);
          const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(buffers));
          return {durationMs:0,segments:Array.from({length:Math.ceil(text.length/4000)},(_,i)=>({startMs:0,endMs:0,text:text.slice(i*4000,(i+1)*4000)}))};
        }}));
        await this.context.plugin(builtin({id:'image.http',version:'1',name:moteText("图片文字提取接口"),stage:'extract',mediaTypes:['image/'],serviceKind:'image',async process(input){
          if(!input.settings.imageEndpoint)throw new StoreError('Image processing service is not configured',409);
          const response=await fetch(input.settings.imageEndpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(input.file.sizeBytes),'X-Mote-Media-Type':input.file.mimeType,...(input.settings.apiKey?{Authorization:`Bearer ${input.settings.apiKey}`}:{})},body:input.readOriginal() as unknown as BodyInit,duplex:'half',signal:input.signal,redirect:'error'} as RequestInit);
          const transcript=transcriptSchema.parse(await readProcessorJson(response));if(transcript.durationMs!==0)throw new StoreError('Image text cannot have audio duration',502);return transcript;
        }}));
        await this.context.plugin(builtin({id:'audio.diarize',version:'1',name:moteText("本地说话人分离"),stage:'diarize',mediaTypes:['audio/'],localOnly:true,async process(input){
          if(!isLoopback(input.settings.endpoint))throw new StoreError('Diarization requires a loopback worker',409);
          const endpoint=new URL(input.settings.endpoint);endpoint.pathname=endpoint.pathname.replace(/\/transcribe\/?$/,'/diarize');
          if(!endpoint.pathname.endsWith('/diarize'))throw new StoreError('Local worker URL must end with /transcribe',409);
          const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(input.file.sizeBytes),'X-Mote-Offline':'1','X-Mote-Max-Audio-Ms':String(input.maxAudioMs),'X-Mote-Speaker-Count':String(input.settings.speakerCount??0),...(input.settings.apiKey?{Authorization:`Bearer ${input.settings.apiKey}`}:{})},body:input.readOriginal() as unknown as BodyInit,duplex:'half',signal:input.signal,redirect:'error'} as RequestInit);
          if(response.ok&&response.headers.get('x-mote-execution')!=='local'){await response.body?.cancel();throw new StoreError('Worker did not confirm offline execution',502);}
          return diarizationSchema.parse(await readProcessorJson(response));
        }}));
        for(const plugin of plugins)await this.context.plugin(plugin);
        for(const specifier of modules){
          // Only deployment configuration selects executable plugin modules. HTTP callers cannot install code.
          const loaded=await import(isAbsolute(specifier)?pathToFileURL(specifier).href:specifier);
          await this.context.plugin(loaded.default??loaded);
        }
      }catch(error){await this.context.fiber.dispose();throw error;}
    })();
    // Initialization is explicitly awaited by the central app and by tick().
    void this.ready.catch(()=>{});
  }
  async close(){await this.ready.catch(()=>{});await this.context.fiber.dispose();}
}
