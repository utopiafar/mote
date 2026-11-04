import {installMemoryOwnerQuestions} from '../memory-owner-questions.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerMemoryRoutes } from '../memory-routes.js';
import type {ServerFeatureAdapter} from './index.js';

/** memory: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{modelAuthorizationHost,availableModelConnections,ownerQuestions,materials,automaticMemoryScheduling,memoryDelegation,memoryStrategySettings,sourcePipelines,agent,evidenceReader,files,lifecycle,memories,memoryPipeline,modelSettings,queryAgent,reviewExtraction,store}:Pick<FeatureServices,'modelAuthorizationHost'|'availableModelConnections'|"ownerQuestions"|"materials"|"automaticMemoryScheduling"|"memoryDelegation"|"memoryStrategySettings"|"sourcePipelines"|"agent"|"evidenceReader"|"files"|"lifecycle"|"memories"|"memoryPipeline"|"modelSettings"|"queryAgent"|"reviewExtraction"|"store">,scope?:ServerFeatureScope){
 const disposeQuestions=installMemoryOwnerQuestions({questions:ownerQuestions,continuations:memoryPipeline.ownerContinuations,materials,store,query:input=>queryAgent(input,'query','memories')});scope?.defer(disposeQuestions);
 if(automaticMemoryScheduling)scope?.every(5000,async()=>{await sourcePipelines.drainMemory(memoryPipeline,agent.configured);
   await memoryPipeline.tickInputs();
 });
 // C22B owns the lifecycle poll and explicit job recovery; closing it first
 // still stops that work before the pipeline's own scope is released.
 scope?.defer(()=>memoryDelegation.close());scope?.defer(()=>memoryPipeline.close());scope?.defer(()=>lifecycle.close());
registerMemoryRoutes(app,{modelAuthorizationHost,availableModelConnections,memoryIntegrationSettings:memoryStrategySettings.integration,memoryRecipeSettings:memoryStrategySettings.recipes,store,files,evidenceReader,memories,memoryPipeline,lifecycle,modelSettings,query:input=>queryAgent(input,'query','memories'),reviewExtraction});
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.memory',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.memory'));
    register(app,services,scope);
  },
};
