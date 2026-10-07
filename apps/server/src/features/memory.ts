import {recoverableMemoryJobs} from '../lifecycle-extensions.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerMemoryRoutes } from '../memory-routes.js';

/** memory: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{automaticMemoryScheduling,memoryDelegation,memoryIntegrationSettings,memoryRecipeSettings,sourcePipelines,agent,evidenceReader,files,lifecycle,memories,memoryPipeline,modelSettings,queryAgent,reviewExtraction,store}:Pick<FeatureServices,"automaticMemoryScheduling"|"memoryDelegation"|"memoryIntegrationSettings"|"memoryRecipeSettings"|"sourcePipelines"|"agent"|"evidenceReader"|"files"|"lifecycle"|"memories"|"memoryPipeline"|"modelSettings"|"queryAgent"|"reviewExtraction"|"store">,scope?:ServerFeatureScope){
 if(automaticMemoryScheduling)scope?.every(5000,async()=>{await sourcePipelines.drainMemory(memoryPipeline,agent.configured);
   await memoryPipeline.tickInputs();
   for(const id of recoverableMemoryJobs(store,lifecycle))void scope.run(()=>memoryPipeline.run(id));
 });
 if(automaticMemoryScheduling)scope?.every(60000,()=>lifecycle.tick());scope?.defer(()=>memoryDelegation.close());scope?.defer(()=>memoryPipeline.close());scope?.defer(()=>lifecycle.close());
app.addHook('onReady',async()=>{for(const id of recoverableMemoryJobs(store,lifecycle))void scope?.run(()=>memoryPipeline.run(id));});
registerMemoryRoutes(app,{memoryIntegrationSettings,memoryRecipeSettings,store,files,evidenceReader,memories,memoryPipeline,lifecycle,modelSettings,query:input=>queryAgent(input,'query','memories'),reviewExtraction});
}
