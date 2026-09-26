import {recoverableMemoryJobs} from '../lifecycle-extensions.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerMemoryRoutes } from '../memory-routes.js';

/** memory: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{materialMemoryWork,sourcePipelines,agent,evidenceReader,files,lifecycle,memories,memoryPipeline,modelSettings,queryAgent,reviewExtraction,store}:Pick<FeatureServices,"materialMemoryWork"|"sourcePipelines"|"agent"|"evidenceReader"|"files"|"lifecycle"|"memories"|"memoryPipeline"|"modelSettings"|"queryAgent"|"reviewExtraction"|"store">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>{const enabled=agent.configured&&lifecycle.settings().extraction.enabled;sourcePipelines.drainMemory(memoryPipeline,enabled);materialMemoryWork.drain(memoryPipeline,enabled,1);});
 scope?.every(60000,()=>lifecycle.tick());scope?.defer(()=>memoryPipeline.close());scope?.defer(()=>lifecycle.close());
app.addHook('onReady',async()=>{for(const id of recoverableMemoryJobs(store,lifecycle))void scope?.run(()=>memoryPipeline.run(id));});
registerMemoryRoutes(app,{store,files,evidenceReader,memories,memoryPipeline,lifecycle,modelSettings,query:input=>queryAgent(input,'query','memories'),reviewExtraction});
}
