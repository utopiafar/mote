import { DEFAULT_MODEL_MAX_TOKENS,modelProvider } from '@mote/shared/models';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeatureServices } from '../feature-services.js';
import { registerUpdateRoutes } from '../updates.js';
import { MOTE_PROTOCOL_RANGE } from '@mote/shared';

type HealthServices = Pick<FeatureServices,"serverVersion">;
type ViewServices = Pick<FeatureServices,"agent"|"config"|"diagnostics"|"eventLoop"|"indexer"|"lifecycle"|"maintenanceWorker"|"modelSettings"|"serverVersion"|"store"|"webVersion">;
type UpdateServices = Pick<FeatureServices,"softwareUpdate">;

/** Minimal bootstrap health remains a host primitive (H), not a business contribution.
 * It exposes only liveness, protocol and version; it never reads services or storage. */
export function registerBootstrapHealth(app:FastifyInstance,{serverVersion}:HealthServices){
  app.get('/api/health',async()=>({ok:true,version:serverVersion,protocol:MOTE_PROTOCOL_RANGE}));
}
/** Composition read view: status, stored update events and build identity. It owns no
 * updater process and no business object lifecycle. */
export function registerSystemView(app:FastifyInstance,{agent,config,diagnostics,eventLoop,indexer,lifecycle,maintenanceWorker,modelSettings,serverVersion,store,webVersion}:ViewServices){
  app.get('/api/status',async()=>{const profiles=modelSettings.profiles(),current=modelSettings.current(),unbounded=profiles.some(p=>p.settings.agentTimeoutMs===null),agentTimeouts=profiles.map(p=>p.settings.agentTimeoutMs).filter((value):value is number=>value!==null);return {runtime:{eventLoopP95Ms:eventLoop.percentile(95)/1e6,maintenance:maintenanceWorker?.snapshot()??null},profile:config.profile??'default',agent:{configured:agent.configured,provider:modelProvider(config.modelProvider??'deepseek')?.name??config.modelProvider,runtime:config.modelProtocol==='codex-app-server'?'Codex App Server':'DeepSeek Harness',protocol:config.modelProtocol,model:config.model||null,reasoningEffort:config.modelReasoningEffort??'high',maxTokens:config.modelMaxTokens??DEFAULT_MODEL_MAX_TOKENS,modelRequestTimeoutMs:current.modelRequestTimeoutMs,agentTimeoutMs:unbounded?null:agentTimeouts.length?Math.max(...agentTimeouts):null},storage:store.stats(),index:{mode:indexer.configured?'hybrid':'text',model:config.embeddingModel||null},diagnostics:diagnostics.snapshot(),retentionDays:config.retentionDays,insightIntervalHours:lifecycle.settings().insights.enabled?lifecycle.settings().insights.intervalHours:0,serverTime:new Date().toISOString()};});
  app.get('/api/updates',async req=>{const {cursor,limit}=z.object({cursor:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(req.query);return store.updates(cursor,limit);});
  app.get('/api/build-info',async()=>({serverVersion,webVersion,consistent:webVersion===serverVersion}));
}
/** Update-service contribution owned by C06 observability; the route surface never
 * selects a repository, path, command or signing key. */
export function registerSystemUpdate(app:FastifyInstance,{softwareUpdate}:UpdateServices){registerUpdateRoutes(app,softwareUpdate);}

/** Current assembly bridge. H05 replaces this composition with the host health entry
 * plus observability/system contributions; until then it preserves the existing routes. */
export function register(app:FastifyInstance,services:HealthServices&ViewServices&UpdateServices){
  registerBootstrapHealth(app,services);
  registerSystemView(app,services);
  registerSystemUpdate(app,services);
}
