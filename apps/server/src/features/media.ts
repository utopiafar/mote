import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {mediaRoleSchema,mediaModelStatusSchema,mediaModelsViewSchema,type MediaRole,type MediaModelStatus} from '@mote/shared';
import {ConnectionError} from '../connections.js';
import {moteText} from '../i18n.js';
import type {MediaAssets} from '../media-assets.js';
import {mediaRuntimeSettings,type MediaRuntimeSettings} from '../media-configuration.js';
import {FUNASR_PROTOCOL} from '../funasr-contract.js';
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
  /** CORE-02/03 may supply actual lifecycle health, including the optional
   * image worker, without teaching the installer how to start a process. */
  readonly runtimeStatus?:(role:MediaRole)=>Promise<Pick<MediaModelStatus,'runtimeReady'|'missingDependencies'>>;
}

/** C18A managed-model transport stays independent of image/readiness activation. */
export function mediaModelsFeature(dependencies:MediaModelsFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.media',mount(app:FastifyInstance){
    const media=mediaRuntimeSettings(dependencies.media),mediaAssets=dependencies.mediaAssets;
    app.get('/api/media-models',async()=>{
      const status=mediaAssets.statuses(),token=media.workerToken;
      const probe=async(url:string)=>{if(!token)return null;try{const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(1200)});return response.ok?await response.json():null;}catch{return null;}};
      const ocrHealth=new URL(media.ocrEndpoint),asrHealth=new URL(media.asrEndpoint);ocrHealth.pathname='/health';asrHealth.pathname='/health';
      const [ocr,dialogue]=dependencies.runtimeStatus?[null,null]:await Promise.all([status.ocr.state==='ready'?probe(ocrHealth.toString()):null,status.dialogue.state==='ready'?probe(asrHealth.toString()):null]);
      // A still-running old Whisper worker cannot describe this FunASR
      // installation. Keep it unavailable instead of advertising its old
      // faster_whisper/sherpa dependencies as requirements of the new model.
      const parsed=z.object({protocol:z.literal(FUNASR_PROTOCOL),asr:z.boolean(),diarization:z.boolean(),wespeaker:z.boolean().optional(),missingDependencies:mediaModelStatusSchema.shape.missingDependencies}).passthrough().safeParse(dialogue);
      const asr=parsed.success?parsed.data:undefined;
      const dialogueReady=asr?.asr===true&&asr.diarization===true&&!(asr.missingDependencies?.length);
      const runtime:Record<MediaRole,Pick<MediaModelStatus,'runtimeReady'|'missingDependencies'>>={
        ocr:{runtimeReady:(ocr as {ocr?:unknown}|null)?.ocr===true},
        dialogue:{runtimeReady:dialogueReady,missingDependencies:asr?.missingDependencies??[]},
        'speaker-wespeaker':{runtimeReady:dialogueReady&&asr?.wespeaker===true},
        'local-image':{runtimeReady:false},
      };
      if(dependencies.runtimeStatus)await Promise.all(mediaRoleSchema.options.map(async role=>{
        if(status[role].state!=='ready'){runtime[role]={runtimeReady:false};return;}
        try{
          const parsed=z.object({runtimeReady:z.boolean(),missingDependencies:mediaModelStatusSchema.shape.missingDependencies}).strict().safeParse(await dependencies.runtimeStatus!(role));
          runtime[role]=parsed.success?parsed.data:{runtimeReady:false};
        }catch{runtime[role]={runtimeReady:false};}
      }));
      return mediaModelsViewSchema.parse(Object.fromEntries(mediaRoleSchema.options.map(role=>[role,{...mediaAssets.status(role),...runtime[role],runtimeReady:mediaAssets.ready(role)&&runtime[role].runtimeReady===true&&!(runtime[role].missingDependencies?.length)}])));
    });
    app.post('/api/media-models/:role/install',async(req,reply)=>{const {role}=z.object({role:mediaRoleSchema}).strict().parse(req.params);const {source}=z.object({source:z.enum(['auto','official','mirror']).default('auto')}).strict().parse(req.body??{});return reply.code(202).send(mediaAssets.install(role,source));});
    app.post('/api/media-models/:role/cancel',async(req)=>{const {role}=z.object({role:mediaRoleSchema}).strict().parse(req.params);z.object({}).strict().parse(req.body??{});return mediaAssets.cancel(role);});
  }});
}
