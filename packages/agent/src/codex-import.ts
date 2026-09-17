import {CodexSession} from './codex-session.js';
import {skillContent} from './skills.js';
import {AgentNotConfiguredError,AgentProviderError,AgentResponseError,type AgentOptions} from './types.js';
import type {ImportAgentInput,ImportAgentResult,ImportAgentObserver} from './import-agent.js';

/** Import has a dedicated writable staging workspace. It never receives archive tools. */
export function createCodexImportAgent(options:Omit<AgentOptions,'reader'>){
  let closed=false;const sessions=new Set<CodexSession>(),pending=new Set<Promise<ImportAgentResult>>();
  async function execute(input:ImportAgentInput):Promise<ImportAgentResult>{
    if(closed)throw new AgentProviderError();if(!options.model?.trim())throw new AgentNotConfiguredError();
    const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : options.timeoutMs ?? 120000;
    const session=new CodexSession({...options,agentTimeoutMs},async()=>{throw new AgentProviderError();});sessions.add(session);
    try{
      await session.start(skillContent('document-import'),[],input.workspace);
      const text=await session.run(JSON.stringify({...input,language:input.language??'zh-CN',languageInstruction:'Use the selected language for summaries and warnings; preserve original quotes and schema keys.',requiredSkill:'document-import',importedAt:new Date().toISOString(),nodeExecutable:process.execPath}),{
        type:'object',properties:{summary:{type:'string'},recordsPath:{type:['string','null']},warnings:{type:'array',items:{type:'string'}}},required:['summary','recordsPath','warnings'],additionalProperties:false,
      });
      if(text.length>64000)throw new AgentResponseError('Import response exceeds its limit');
      let result:ImportAgentResult;try{result=JSON.parse(text);}catch{throw new AgentResponseError('Import response is not valid JSON');}
      if(!result||typeof result.summary!=='string'||(result.recordsPath!=null&&typeof result.recordsPath!=='string')||(result.warnings!==undefined&&(!Array.isArray(result.warnings)||result.warnings.some(w=>typeof w!=='string'))))throw new AgentResponseError('Import response has an invalid shape');
      return {...result,recordsPath:result.recordsPath??undefined};
    }finally{await session.close();sessions.delete(session);}
  }
  return {prepare(input:ImportAgentInput,_observer?:ImportAgentObserver){const task=execute(input);pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;},async close(){closed=true;await Promise.allSettled([...sessions].map(s=>s.close()));await Promise.allSettled([...pending]);}};
}
