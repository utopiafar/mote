import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Store} from './store.js';
import type {ProcessingRuntime} from './processing-runtime.js';
import type {ImageProcessing} from './image-processing.js';
import type {MediaAssets} from './media-assets.js';
import {mediaRuntimeSettings,type MediaRuntimeSettings} from './media-configuration.js';
/** Routes admit work; the shared execution engine remains the only executor. */
export function registerProcessingRoutes(app:FastifyInstance,{store,workflows,perception,mediaAssets,media:mediaInput,semanticFingerprint,withOwnerIntent=async(_id,task)=>task(),withOwnerBatch=async(_ids,task)=>task()}:{store:Store;workflows:ProcessingRuntime;perception:ImageProcessing;mediaAssets:MediaAssets;media?:Partial<MediaRuntimeSettings>;semanticFingerprint:()=>string;withOwnerBatch?:<T>(ids:readonly string[],task:()=>T|Promise<T>)=>Promise<T>;withOwnerIntent?:<T>(id:string,task:()=>T|Promise<T>)=>Promise<T>}){
  const media=mediaRuntimeSettings(mediaInput);
  app.get('/api/processing',async req=>{const q=z.object({state:z.enum(['waiting','running','blocked','failed','cancelled','succeeded','stale']).optional(),cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query);return {archive:store.archive.stats(),...workflows.view(q)};});
  app.put('/api/processing/settings',async req=>workflows.save(req.body));
  app.post('/api/processing/workflows',async(req,reply)=>{const {steps}=z.object({steps:z.array(z.any()).min(1).max(32)}).strict().parse(req.body);return reply.code(202).send(workflows.enqueue(steps.map(step=>step.processor==='mote.segment-understanding'?{...step,artifactInputs:[{id:step.config?.artifactId,revision:store.archive.get(step.config?.artifactId)?.revision}],config:{...step.config,modelFingerprint:semanticFingerprint()}}:step)));});
  app.post('/api/processing/:id/retry',async req=>{workflows.retry((req.params as {id:string}).id);return {queued:true};});
  app.post('/api/processing/:id/cancel',async req=>{workflows.cancel((req.params as {id:string}).id);return {cancelled:true};});
  app.get('/api/perception',async()=>perception.view());
  app.get('/api/images/:id',async req=>perception.detail(z.object({id:z.string().uuid()}).parse(req.params).id));
  app.post('/api/images/:id/cancel',async req=>perception.cancel(z.object({id:z.string().uuid()}).parse(req.params).id));
  app.post('/api/images/:id/retry',async req=>{const {mode,confirmUnknown}=z.object({mode:z.enum(['complete','recompute']).default('complete'),confirmUnknown:z.boolean().default(false)}).strict().parse(req.body??{});const id=z.object({id:z.string().uuid()}).parse(req.params).id;return withOwnerIntent(id,()=>perception.retry(id,mode==='recompute',confirmUnknown));});
  app.put('/api/perception',async req=>perception.save(req.body));
  app.post('/api/perception/:id/retry',async req=>{const {id}=z.object({id:z.string().uuid()}).parse(req.params);z.object({kind:z.literal('ocr')}).strict().parse(req.body);return withOwnerIntent(id,()=>perception.retry(id));});
  app.post('/api/perception/ocr/historical-preview',async req=>perception.previewHistoricalOcr(req.body??{}));
  app.post('/api/perception/ocr/historical-process',async req=>withOwnerBatch(perception.historicalOcrTargets(req.body),()=>perception.processHistoricalOcr(req.body)));
  app.get('/api/media-models',async()=>{
    const status=mediaAssets.statuses(),token=media.workerToken;
    const probe=async(url:string)=>{if(!token)return null;try{const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1200)});return response.ok?await response.json():null;}catch{return null;}};
    const ocrHealth=new URL(media.ocrEndpoint),asrHealth=new URL(media.asrEndpoint);ocrHealth.pathname='/health';asrHealth.pathname='/health';
    const [ocr,dialogue]=await Promise.all([status.ocr.state==='ready'?probe(ocrHealth.toString()):null,status.dialogue.state==='ready'?probe(asrHealth.toString()):null]);
    const missing=z.array(z.enum(['ffmpeg','faster_whisper','sherpa_onnx'])).safeParse((dialogue as {missingDependencies?:unknown}|null)?.missingDependencies);
    return {'speaker-wespeaker':{...status['speaker-wespeaker'],runtimeReady:Boolean((dialogue as {wespeaker?:boolean}|null)?.wespeaker)},ocr:{...status.ocr,runtimeReady:Boolean((ocr as {ocr?:boolean}|null)?.ocr)},dialogue:{...status.dialogue,missingDependencies:missing.success?missing.data:[],runtimeReady:Boolean((dialogue as {asr?:boolean;diarization?:boolean}|null)?.asr&&(dialogue as {diarization?:boolean}|null)?.diarization)}};
  });
  app.post('/api/media-models/:role/install',async(req,reply)=>{const {role}=z.object({role:z.enum(['ocr','dialogue','speaker-wespeaker'])}).parse(req.params);const {source}=z.object({source:z.enum(['auto','official','mirror']).default('auto')}).strict().parse(req.body??{});return reply.code(202).send(mediaAssets.install(role,source));});
}
