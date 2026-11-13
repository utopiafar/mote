import {observeModelTransport} from './models/http-transport.js';
import {ActiveExecutionBudget,DEFAULT_AGENT_EXECUTION_TIMEOUT_MS} from './active-budget.js';
import {ProviderFailure,type TokenUsage} from '@mote/shared';
import {observeHarness} from './usage.js';
import {codexImportCapabilityDescriptor} from './codex-import.js';
import {DeepSeekHarness,RequestTimeoutError,type HarnessNotification} from '@deepseek-ai/dsh-sdk-client';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {IMPORT_CAPABILITY_API_VERSION,ImportCapabilityRegistry,defineImportCapabilityDescriptor,importRepairPrompt,importRequestPayload,parseImportPreview,type ImportAgentInput,type ImportAgentLaunch,type ImportAgentObserver,type ImportAgentResult,type ImportCapability} from './runtime/import-capability.js';
import {importSkillDescriptor} from './tasks/import.js';
import {modelConnection,modelRuntimeEntries,harnessPrivacyEntries,resolveModelCapabilities,validateModelOptions} from './models/provider-registry.js';
import {AgentNotConfiguredError,AgentProviderError,AgentResponseError,AgentTimeoutError,MAX_OUTPUT_REPAIRS,type AgentOptions} from './types.js';

export type {ImportAgentInput,ImportAgentLaunch,ImportAgentObserver,ImportAgentResult,ImportCapability} from './runtime/import-capability.js';

/** HTTP transports execute the same writable Import capability as Codex. */
function createDshImportAgent(options:Omit<AgentOptions,'reader'>,prepareLaunch?:ImportAgentLaunch):ImportCapability {
  options={...options,headers:options.headers&&{...options.headers},extraBody:options.extraBody&&structuredClone(options.extraBody)};
  const connection=modelConnection(options),capacity=resolveModelCapabilities(options),active=new Set<DeepSeekHarness>(),pending=new Set<Promise<ImportAgentResult>>();
  let closed=false;
  async function execute(input:ImportAgentInput,observer?:ImportAgentObserver,onUsage?:(usage:TokenUsage)=>void):Promise<ImportAgentResult>{
    const local=options.allowUnauthenticatedLocal&&options.baseUrl&&['localhost','127.0.0.1','[::1]'].includes(new URL(options.baseUrl).hostname);
    if(!options.model||(!options.apiKey&&!local))throw new AgentNotConfiguredError();
    if(closed)throw new AgentProviderError();
    const modelAdmission=new AbortController();
    const root=await mkdtemp(join(tmpdir(),'mote-import-agent-')),runId=randomUUID();
    let transportObserver:Awaited<ReturnType<typeof observeModelTransport>>|undefined;
    let harness:DeepSeekHarness|undefined,primaryFailure=false;
    const budget=new ActiveExecutionBudget(options.agentTimeoutMs===undefined?DEFAULT_AGENT_EXECUTION_TIMEOUT_MS:options.agentTimeoutMs);
    try{
      transportObserver=await observeModelTransport(options.authorizeModelRequest);
      const transportPath=new URL('./models/http-transport.js',import.meta.url).href;
      const plugin=join(root,'import-plugin.mjs');
      await writeFile(plugin,`import {boundedModelFetch,modelFailureReporter,modelRequestAuthorization} from ${JSON.stringify(transportPath)};
import {apply as applySkillTool} from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tool-skill'))};
export const name='mote-import'; export const inject=['tools','skills','agents'];
export function apply(ctx){
 const transport=JSON.parse(process.env.MOTE_MODEL_TRANSPORT),raw=globalThis.fetch.bind(globalThis); globalThis.fetch=boundedModelFetch(raw,'mote-no-context-bridge',32*1024*1024,transport,modelFailureReporter(raw),modelRequestAuthorization(raw));
 for(const skill of JSON.parse(process.env.MOTE_SKILLS))ctx.skills.register({name:skill.name,description:skill.description,content:skill.content,source:'bundled',metadata:{version:skill.version}});
 applySkillTool(ctx);ctx.provide('moteImportReady',true);
}`,{mode:0o600});
      const patch=join(root,'import.patch.json');
      await writeFile(patch,JSON.stringify([
        ...harnessPrivacyEntries(),
        {id:'mcp-resources',disabled:true},
        {id:'system-prompt',config:{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:importSkillDescriptor.content}},
        ...modelRuntimeEntries({...options,model:options.model}),
        {id:'sdk-jsonrpc-server',inject:['sdkAppStartup','loader','moteImportReady']},
        {insert:[{id:'mote-skills',name:import.meta.resolve('@deepseek-ai/dsh-skill')},{id:'mote-fs-provider',name:import.meta.resolve('@deepseek-ai/dsh-fs-local')},{id:'mote-files',name:import.meta.resolve('@deepseek-ai/dsh-tool-fs')},{id:'mote-import',name:plugin}]},
      ]),{mode:0o600});
      const launch=await prepareLaunch?.({workspace:input.workspace,runtimeRoot:root});
      if(closed)throw new AgentProviderError();
      const requestTimeoutMs = options.requestTimeoutMs ?? 120000;
      harness=new DeepSeekHarness({...launch?{dshBin:launch.dshBin}:{},profile:'sdk-minimal',patches:[patch],dshHome:join(root,'home'),cwd:input.workspace,processCwd:input.workspace,provider:connection.route,model:options.model,maxTokens:capacity.maxOutputTokens,initializeTimeoutMs:30000,requestTimeoutMs:Math.max(requestTimeoutMs??120000,300000),
        env:{PATH:process.env.PATH,TMPDIR:tmpdir(),HOME:join(root,'home'),DEEPSEEK_API_KEY:options.apiKey||'mote-local-no-auth',DEEPSEEK_BASE_URL:connection.baseUrl,MOTE_MODEL_API_KEY:options.apiKey||'mote-local-no-auth',
          MOTE_MODEL_OBSERVER:JSON.stringify(transportObserver.configuration),
          MOTE_MODEL_TRANSPORT:JSON.stringify({baseUrl:connection.baseUrl,protocol:connection.protocol,reasoningEffort:connection.effort,provider:options.provider,headers:options.headers,extraBody:options.extraBody,contextWindow:capacity.contextWindow,maxTokens:capacity.maxOutputTokens}),
          MOTE_SKILLS:JSON.stringify([importSkillDescriptor])}});
      active.add(harness);
      const observeUsage=observeHarness({question:'',onUsage},runId,connection.protocol!=='deepseek');
      const runOptions={sessionId:runId,onNotification:(notification:HarnessNotification)=>{
        observeUsage(notification);
        try{if(observer)void Promise.resolve(observer(structuredClone(notification))).catch(()=>{});}catch{/* Optional observation must not change import execution. */}
      }};
      const checkResult=(result:Awaited<ReturnType<DeepSeekHarness['run']>>)=>{
        const end=[...result.events].reverse().find(e=>e.type==='turn/end');
        if((end?.data as {reason?:{kind?:string}})?.reason?.kind==='error')throw new AgentProviderError();
      };
      const parseResult=(text:string):ImportAgentResult=>parseImportPreview(text,input.workspace);
      const readAnswer=async()=>{
        let result=await (options.runModel??(async (task,_signal?:AbortSignal)=>task()))(()=>budget.run(()=>harness!.run(importRequestPayload(input),runOptions)),modelAdmission.signal);
        checkResult(result);
        for(let repair=0;;repair++){
          try{return parseResult(result.finalResponse);}catch(error){
            if(!(error instanceof AgentResponseError)||repair>=MAX_OUTPUT_REPAIRS)throw error;
            // Bounded corrections in the same session, inside the original total deadline.
            result=await (options.runModel??(async (task,_signal?:AbortSignal)=>task()))(()=>budget.run(()=>harness!.run(importRepairPrompt(error.message),runOptions)),modelAdmission.signal);
            checkResult(result);
          }
        }
      };
      return await Promise.race([readAnswer(),transportObserver.failure]);
    }catch(error){primaryFailure=true;if(error instanceof RequestTimeoutError)throw new AgentTimeoutError();if(error instanceof AgentNotConfiguredError||error instanceof AgentResponseError||error instanceof AgentTimeoutError||error instanceof ProviderFailure)throw error;throw new AgentProviderError();}
    finally{
      modelAdmission.abort();
      const cleanup=await Promise.allSettled([Promise.resolve().then(()=>harness?.close()),Promise.resolve().then(()=>transportObserver?.close())]);
      if(harness)active.delete(harness);
      const removal=await Promise.allSettled([rm(root,{recursive:true,force:true})]);
      if(!primaryFailure&&[...cleanup,...removal].some(result=>result.status==='rejected'))throw new AgentProviderError();
    }
  }
  return {
    prepare(input:ImportAgentInput,observer?:ImportAgentObserver,onUsage?:(usage:TokenUsage)=>void){const task=execute(input,observer,onUsage);pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;},
    async close(){
      closed=true;
      const cleanup=await Promise.allSettled([...active].map(h=>h.close()));
      // Includes preparations still writing their isolated runtime files.
      await Promise.allSettled([...pending]);active.clear();
      if(cleanup.some(result=>result.status==='rejected'))throw new AgentProviderError();
    },
  };
}

export const dshImportCapabilityDescriptor=defineImportCapabilityDescriptor({
  apiVersion:IMPORT_CAPABILITY_API_VERSION,
  id:'dsh-import',
  version:'1.0.0',
  protocols:['deepseek','openai-completions','openai-responses','anthropic-messages','google-generative-ai'],
  create:(options:Omit<AgentOptions,'reader'>,prepareLaunch?:ImportAgentLaunch)=>createDshImportAgent(options,prepareLaunch),
});

export const defaultImportCapabilities=new ImportCapabilityRegistry();
defaultImportCapabilities.register(dshImportCapabilityDescriptor);
defaultImportCapabilities.register(codexImportCapabilityDescriptor);

/** Fixed-settings facade. Host transport configuration selects the registered
 * implementation; captured content and model output never choose a capability. */
export function createImportAgent(options:Omit<AgentOptions,'reader'>,prepareLaunch?:ImportAgentLaunch):ImportCapability {
  validateModelOptions(options);
  return defaultImportCapabilities.create(options,prepareLaunch);
}
