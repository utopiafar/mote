import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PluginResourceScope} from '@mote/plugin-host';
import type {EvidenceReader} from '../evidence-reader.js';
import {AssistantGoals} from '../assistant-goals.js';
import {registerAssistantGoalRoutes} from '../assistant-goal-routes.js';
import {AssistantIdeas,registerAssistantIdeaRoutes} from '../assistant-ideas.js';

export function prepareAssistantGoalAndIdeaRoutes(dependencies:{
  store:ConstructorParameters<typeof AssistantGoals>[0];commitments:ConstructorParameters<typeof AssistantGoals>[1];
  matters:ConstructorParameters<typeof AssistantGoals>[2];routines:ConstructorParameters<typeof AssistantGoals>[3];
  reader:EvidenceReader;actions:ConstructorParameters<typeof AssistantGoals>[5];
  cards:ConstructorParameters<typeof AssistantIdeas>[1]&NonNullable<ConstructorParameters<typeof AssistantGoals>[7]>;
  questions:ConstructorParameters<typeof AssistantIdeas>[2];
  tasks:ConstructorParameters<typeof AssistantIdeas>[3];
}){
  const {store,commitments,matters,routines,reader,actions,cards,questions,tasks}=dependencies;
  const goals=new AssistantGoals(store,commitments,matters,routines,reader,actions,undefined,cards);
  const ideas=new AssistantIdeas(store,cards,questions,tasks,reader);
  return (app:FastifyInstance,owner:(request:FastifyRequest)=>void,scope?:PluginResourceScope)=>{
    registerAssistantGoalRoutes(app,{goals,owner});
    registerAssistantIdeaRoutes(app,ideas,owner,scope);
  };
}
