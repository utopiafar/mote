import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ConnectionError} from '../connections.js';
import type {FeatureServices} from '../feature-services.js';
import {moteText} from '../i18n.js';
import type {MediaReadinessPort} from '../plugins/ocr-asr-readiness.js';

/** C18B's activation-gated media transport. The preparation routes moved here
 * from mote.processing; media statistics retain their collector device fence. */
export function register(app:FastifyInstance,{connections,credential,mediaRange,store,mediaPreparation}:Pick<FeatureServices,'connections'|'credential'|'mediaRange'|'store'>&{mediaPreparation:()=>MediaReadinessPort}){
  app.addHook('onRequest',async()=>{mediaPreparation().assertCurrent();});
  const roleOf=(params:unknown)=>z.object({role:z.enum(['ocr','dialogue','speaker-wespeaker'])}).strict().parse(params).role;
  app.get('/api/media-preparation',async()=>mediaPreparation().statuses());
  app.post('/api/media-preparation/:role',async(req,reply)=>{z.object({}).strict().parse(req.body??{});return reply.code(202).send(await mediaPreparation().start(roleOf(req.params)));});
  app.post('/api/media-preparation/:role/cancel',async(req)=>{z.object({}).strict().parse(req.body??{});return mediaPreparation().cancel(roleOf(req.params));});
  app.get('/api/media-activity',async req=>{
    const query=mediaRange.parse(req.query),c=credential(req);
    if(c){connections.assertActive(c);if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText('只能读取本设备的媒体采集统计。'));query.deviceId=c.deviceId;}
    return store.mediaActivity(query);
  });
}

/** The remaining bridge owns only Agent-tool lifetime; every HTTP handler is
 * supplied by the C18B domain route contribution. */
export const adapter:import('./index.js').ServerFeatureAdapter={
  descriptor:{id:'mote.media',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services,host)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.media'));
    host.mountDomainRoutes('mote.media',app,services);
  },
};
