import type {TokenUsage} from '@mote/shared';
import {observeHarness} from './usage.js';
import {DEFAULT_MODEL_MAX_TOKENS} from '@mote/shared/models';
import {createCodexImportAgent} from './codex-import.js';
import {DeepSeekHarness,RequestTimeoutError,type HarnessNotification} from '@deepseek-ai/dsh-sdk-client';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {bundledSkills,skillContent} from './skills.js';
import {modelConnection,modelRuntimeEntries,validateModelOptions} from './model-runtime.js';
import {AgentNotConfiguredError,AgentProviderError,AgentResponseError,AgentTimeoutError,type AgentOptions} from './types.js';

export type ImportAgentInput={language?:"zh-CN"|"en";workspace:string;inputPaths:string[];instruction:string;helperPath:string;manifestSchema:unknown;schemaPath?:string;previous?:{summary:string;error?:string}};
export type ImportAgentResult={summary:string;recordsPath?:string;warnings?:string[]};
export type ImportAgentObserver=(notification:HarnessNotification)=>void;
export type ImportAgentLaunch=(input:{workspace:string;runtimeRoot:string})=>Promise<{dshBin:string}>;

/** Dedicated import runtime. Native shell/file capabilities never enter query sessions. */
export function createImportAgent(options:Omit<AgentOptions,'reader'>,prepareLaunch?:ImportAgentLaunch){
  validateModelOptions(options);
  if(options.protocol==='codex-app-server')return createCodexImportAgent(options);
  options={...options,headers:options.headers&&{...options.headers},extraBody:options.extraBody&&structuredClone(options.extraBody)};
  const connection=modelConnection(options),active=new Set<DeepSeekHarness>(),pending=new Set<Promise<ImportAgentResult>>();
  let closed=false;
  async function execute(input:ImportAgentInput,observer?:ImportAgentObserver,onUsage?:(usage:TokenUsage)=>void):Promise<ImportAgentResult>{
    const local=options.allowUnauthenticatedLocal&&options.baseUrl&&['localhost','127.0.0.1','[::1]'].includes(new URL(options.baseUrl).hostname);
    if(!options.model||(!options.apiKey&&!local))throw new AgentNotConfiguredError();
    if(closed)throw new AgentProviderError();
    const root=await mkdtemp(join(tmpdir(),'mote-import-agent-')),runId=randomUUID();
    let harness:DeepSeekHarness|undefined,timeout:ReturnType<typeof setTimeout>|undefined,primaryFailure=false;
    try{
      const transportPath=join(root,'transport.mjs');
      await writeFile(transportPath,readFileSync(new URL('./plugin.mjs',import.meta.url),'utf8')
        .replace('from "./context-tools.js"',`from ${JSON.stringify(new URL('./context-tools.js',import.meta.url).href)}`)
        .replace('from "@deepseek-ai/dsh-tools"',`from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tools'))}`)
        .replace('from "@deepseek-ai/dsh-tool-skill"',`from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tool-skill'))}`),{mode:0o600});
      const plugin=join(root,'import-plugin.mjs');
      await writeFile(plugin,`import {boundedModelFetch} from ${JSON.stringify(transportPath)};
import {apply as applySkillTool} from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tool-skill'))};
export const name='mote-import'; export const inject=['tools','skills','agents'];
export function apply(ctx){
 const transport=JSON.parse(process.env.MOTE_MODEL_TRANSPORT); globalThis.fetch=boundedModelFetch(globalThis.fetch.bind(globalThis),'mote-no-context-bridge',32*1024*1024,transport);
 for(const skill of JSON.parse(process.env.MOTE_SKILLS))ctx.skills.register({name:skill.name,description:skill.description,content:skill.content,source:'bundled',metadata:{version:skill.version}});
 applySkillTool(ctx);ctx.provide('moteImportReady',true);
}`,{mode:0o600});
      const patch=join(root,'import.patch.json');
      await writeFile(patch,JSON.stringify([
        {id:'system-prompt',config:{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:skillContent('document-import')}},
        ...modelRuntimeEntries({...options,model:options.model}),
        {id:'sdk-jsonrpc-server',inject:['sdkAppStartup','loader','moteImportReady']},
        {insert:[{id:'mote-skills',name:import.meta.resolve('@deepseek-ai/dsh-skill')},{id:'mote-fs-provider',name:import.meta.resolve('@deepseek-ai/dsh-fs-local')},{id:'mote-files',name:import.meta.resolve('@deepseek-ai/dsh-tool-fs')},{id:'mote-import',name:plugin}]},
      ]),{mode:0o600});
      const launch=await prepareLaunch?.({workspace:input.workspace,runtimeRoot:root});
      if(closed)throw new AgentProviderError();
      const timeoutMs=Math.max(options.timeoutMs??120000,300000);
      harness=new DeepSeekHarness({...launch?{dshBin:launch.dshBin}:{},profile:'sdk-minimal',patches:[patch],dshHome:join(root,'home'),cwd:input.workspace,processCwd:input.workspace,provider:connection.route,model:options.model,maxTokens:options.maxTokens??DEFAULT_MODEL_MAX_TOKENS,initializeTimeoutMs:30000,requestTimeoutMs:timeoutMs,
        env:{PATH:process.env.PATH,TMPDIR:tmpdir(),HOME:join(root,'home'),DEEPSEEK_API_KEY:options.apiKey||'mote-local-no-auth',DEEPSEEK_BASE_URL:connection.baseUrl,MOTE_MODEL_API_KEY:options.apiKey||'mote-local-no-auth',
          MOTE_MODEL_TRANSPORT:JSON.stringify({baseUrl:connection.baseUrl,protocol:connection.protocol,reasoningEffort:connection.effort,provider:options.provider,headers:options.headers,extraBody:options.extraBody}),
          MOTE_SKILLS:JSON.stringify(bundledSkills.filter(s=>s.id==='document-import'))}});
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
      const parseResult=(text:string):ImportAgentResult=>{
        if(text.length>64000)throw new AgentResponseError('Import analysis response exceeds its limit');
        let value:unknown;try{value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new AgentResponseError('Import analysis did not return valid JSON');}
        if(!value||typeof value!=='object'||typeof (value as ImportAgentResult).summary!=='string')throw new AgentResponseError('Import analysis is missing its preview summary');
        return value as ImportAgentResult;
      };
      const readAnswer=async()=>{
        let result=await harness!.run(JSON.stringify({...input,language:input.language??'zh-CN',languageInstruction:'Use the selected language for summaries, warnings and generated prose; preserve original quotes and field keys.',requiredSkill:'document-import',importedAt:new Date().toISOString(),nodeExecutable:process.execPath}),runOptions);
        checkResult(result);
        try{return parseResult(result.finalResponse);}catch(error){
          if(!(error instanceof AgentResponseError))throw error;
          // One correction in the same session, inside the original total deadline.
          result=await harness!.run(JSON.stringify({instruction:'Your final import response could not be accepted. Using only the analysis already completed in this session, return ONLY one JSON object with summary (a string in the selected language), optional recordsPath (a string), and optional warnings (an array of strings). Do not include Markdown fences or any text outside JSON. Do not repeat analysis, run tools, rewrite files, or claim an artifact exists unless it was actually produced. Preserve any reported limitations. The host will still independently validate the manifest and require review before import.',validationError:error.message}),runOptions);
          checkResult(result);return parseResult(result.finalResponse);
        }
      };
      return await Promise.race([readAnswer(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new AgentTimeoutError()),timeoutMs);})]);
    }catch(error){primaryFailure=true;if(error instanceof RequestTimeoutError)throw new AgentTimeoutError();if(error instanceof AgentNotConfiguredError||error instanceof AgentResponseError||error instanceof AgentTimeoutError)throw error;throw new AgentProviderError();}
    finally{
      if(timeout)clearTimeout(timeout);
      const cleanup=await Promise.allSettled([Promise.resolve().then(()=>harness?.close())]);
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
