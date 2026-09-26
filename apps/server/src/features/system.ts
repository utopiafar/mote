import { DEFAULT_MODEL_MAX_TOKENS,modelProvider } from '@mote/shared/models';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeatureServices } from '../feature-services.js';
import { registerUpdateRoutes } from '../updates.js';

/** system: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{agent,config,diagnostics,eventLoop,indexer,lifecycle,maintenanceWorker,modelSettings,serverVersion,softwareUpdate,store,webVersion}:Pick<FeatureServices,"agent"|"config"|"diagnostics"|"eventLoop"|"indexer"|"lifecycle"|"maintenanceWorker"|"modelSettings"|"serverVersion"|"softwareUpdate"|"store"|"webVersion">){
registerUpdateRoutes(app,softwareUpdate);
app.get('/api/health',async()=>({ok:true,version:serverVersion}));
app.get('/api/status',async()=>{const profiles=modelSettings.profiles(),current=modelSettings.current(),unbounded=profiles.some(p=>p.settings.agentTimeoutMs===null),agentTimeouts=profiles.map(p=>p.settings.agentTimeoutMs).filter((value):value is number=>value!==null);return {runtime:{eventLoopP95Ms:eventLoop.percentile(95)/1e6,maintenance:maintenanceWorker?.snapshot()??null},profile:config.profile??'legacy',agent:{configured:agent.configured,provider:modelProvider(config.modelProvider??'deepseek')?.name??config.modelProvider,runtime:config.modelProtocol==='codex-app-server'?'Codex App Server':'DeepSeek Harness',protocol:config.modelProtocol,model:config.model||null,reasoningEffort:config.modelReasoningEffort??'high',maxTokens:config.modelMaxTokens??DEFAULT_MODEL_MAX_TOKENS,modelRequestTimeoutMs:current.modelRequestTimeoutMs,agentTimeoutMs:unbounded?null:agentTimeouts.length?Math.max(...agentTimeouts):null},storage:store.stats(),index:{mode:indexer.configured?'hybrid':'text',model:config.embeddingModel||null},diagnostics:diagnostics.snapshot(),retentionDays:config.retentionDays,insightIntervalHours:lifecycle.settings().insights.enabled?lifecycle.settings().insights.intervalHours:0,serverTime:new Date().toISOString()};});
app.get('/api/updates',async req=>{const {cursor,limit}=z.object({cursor:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(req.query);return store.updates(cursor,limit);});
app.get('/api/build-info',async()=>({serverVersion,webVersion,consistent:webVersion===serverVersion}));
}
