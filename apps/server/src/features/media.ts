import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ConnectionError} from '../connections.js';
import {moteText} from '../i18n.js';
import type {MediaAssets} from '../media-assets.js';
import {mediaRuntimeSettings,type MediaRuntimeSettings} from '../media-configuration.js';
import type {MediaReadinessPort} from '../plugins/ocr-asr-readiness.js';
import type {ConnectionCredential,Connections} from '../connections.js';
import type {Store} from '../store.js';
import type {FeatureRoute} from './index.js';

export interface MediaPreparationFeatureDependencies {
  readonly connections:Connections;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly mediaRange:{parse(input:unknown):NonNullable<Parameters<Store['mediaActivity']>[0]>};
  readonly store:Store;
  readonly mediaPreparation:()=>MediaReadinessPort;
}

/** C18B's activation-gated media transport. */
export function mediaPreparationFeature(dependencies:MediaPreparationFeatureDependencies):FeatureRoute {
  const {connections,credential,mediaRange,store}=dependencies;
  return Object.freeze({id:'mote.media',mount(app:FastifyInstance){
    app.addHook('onRequest',async()=>{dependencies.mediaPreparation().assertCurrent();});
    const roleOf=(params:unknown)=>z.object({role:z.enum(['ocr','dialogue','speaker-wespeaker'])}).strict().parse(params).role;
    app.get('/api/media-preparation',async()=>dependencies.mediaPreparation().statuses());
    app.post('/api/media-preparation/:role',async(req,reply)=>{z.object({}).strict().parse(req.body??{});return reply.code(202).send(await dependencies.mediaPreparation().start(roleOf(req.params)));});
    app.post('/api/media-preparation/:role/cancel',async(req)=>{z.object({}).strict().parse(req.body??{});return dependencies.mediaPreparation().cancel(roleOf(req.params));});
    app.get('/api/media-activity',async req=>{
      const query=mediaRange.parse(req.query),c=credential(req);
      if(c){connections.assertActive(c);if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText('只能读取本设备的媒体采集统计。'));query.deviceId=c.deviceId;}
      return store.mediaActivity(query);
    });
  }});
}

export interface MediaModelsFeatureDependencies {
  readonly mediaAssets:MediaAssets;
  readonly media?:Partial<MediaRuntimeSettings>;
}

/** C18A managed-model transport stays independent of image/readiness activation. */
export function mediaModelsFeature(dependencies:MediaModelsFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.media',mount(app:FastifyInstance){
    const media=mediaRuntimeSettings(dependencies.media),mediaAssets=dependencies.mediaAssets;
    app.get('/api/media-models',async()=>{
      const status=mediaAssets.statuses(),token=media.workerToken;
      const probe=async(url:string)=>{if(!token)return null;try{const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1200)});return response.ok?await response.json():null;}catch{return null;}};
      const ocrHealth=new URL(media.ocrEndpoint),asrHealth=new URL(media.asrEndpoint);ocrHealth.pathname='/health';asrHealth.pathname='/health';
      const [ocr,dialogue]=await Promise.all([status.ocr.state==='ready'?probe(ocrHealth.toString()):null,status.dialogue.state==='ready'?probe(asrHealth.toString()):null]);
      const missing=z.array(z.enum(['ffmpeg','faster_whisper','sherpa_onnx'])).safeParse((dialogue as {missingDependencies?:unknown}|null)?.missingDependencies);
      return {'speaker-wespeaker':{...status['speaker-wespeaker'],runtimeReady:Boolean((dialogue as {wespeaker?:boolean}|null)?.wespeaker)},ocr:{...status.ocr,runtimeReady:Boolean((ocr as {ocr?:boolean}|null)?.ocr)},dialogue:{...status.dialogue,missingDependencies:missing.success?missing.data:[],runtimeReady:Boolean((dialogue as {asr?:boolean;diarization?:boolean}|null)?.asr&&(dialogue as {diarization?:boolean}|null)?.diarization)}};
    });
    app.post('/api/media-models/:role/install',async(req,reply)=>{const {role}=z.object({role:z.enum(['ocr','dialogue','speaker-wespeaker'])}).parse(req.params);const {source}=z.object({source:z.enum(['auto','official','mirror']).default('auto')}).strict().parse(req.body??{});return reply.code(202).send(mediaAssets.install(role,source));});
  }});
}
