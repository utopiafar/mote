import type {TokenUsage} from '@mote/shared';
import {CodexSession} from './codex-session.js';
import {IMPORT_CAPABILITY_API_VERSION,defineImportCapabilityDescriptor,importRepairPrompt,importRequestPayload,parseImportPreview,type ImportAgentInput,type ImportAgentLaunch,type ImportAgentObserver,type ImportAgentResult,type ImportCapability} from './runtime/import-capability.js';
import {importSkillDescriptor} from './tasks/import.js';
import {AgentNotConfiguredError,AgentProviderError,AgentResponseError,MAX_OUTPUT_REPAIRS,type AgentOptions} from './types.js';

const importAnswerSchema={
 type:'object',properties:{summary:{type:'string'},recordsPath:{type:['string','null']},warnings:{type:'array',items:{type:'string'}},reviewDecision:{type:['object','null'],properties:{confidence:{type:'string',enum:['high','low','unknown']},ambiguous:{type:'boolean'},reason:{type:'string'}},required:['confidence','ambiguous','reason'],additionalProperties:false}},required:['summary','recordsPath','warnings','reviewDecision'],additionalProperties:false,
};

/** Codex transport for the same writable Import capability. It receives only
 * the import workspace, and returns the shared preview contract instead of
 * archive tools or a model-authored artifact claim. */
export function createCodexImportAgent(options:Omit<AgentOptions,'reader'>):ImportCapability {
  let closed=false;const sessions=new Set<CodexSession>(),pending=new Set<Promise<ImportAgentResult>>();
  async function execute(input:ImportAgentInput,onUsage?:(usage:TokenUsage)=>void):Promise<ImportAgentResult>{
    if(closed)throw new AgentProviderError();if(!options.model?.trim())throw new AgentNotConfiguredError();
    const session=new CodexSession(options,async()=>{throw new AgentProviderError();},undefined,onUsage);sessions.add(session);
    try{
      await session.start(importSkillDescriptor.content,[],input.workspace);
      let text=await session.run(importRequestPayload(input),importAnswerSchema);
      for(let repair=0;;repair++){
        try{return parseImportPreview(text,input.workspace);}
        catch(error){
          if(!(error instanceof AgentResponseError)||repair>=MAX_OUTPUT_REPAIRS)throw error;
          text=await session.run(importRepairPrompt(error.message),importAnswerSchema);
        }
      }
    }finally{await session.close();sessions.delete(session);}
  }
  return {prepare(input:ImportAgentInput,_observer?:ImportAgentObserver,onUsage?:(usage:TokenUsage)=>void){const task=execute(input,onUsage);pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;},async close(){closed=true;await Promise.allSettled([...sessions].map(s=>s.close()));await Promise.allSettled([...pending]);}};
}

export const codexImportCapabilityDescriptor=defineImportCapabilityDescriptor({
  apiVersion:IMPORT_CAPABILITY_API_VERSION,
  id:'codex-import',
  version:'1.0.0',
  protocols:['codex-app-server'],
  create:(options:Omit<AgentOptions,'reader'>,_prepareLaunch?:ImportAgentLaunch)=>createCodexImportAgent(options),
});
