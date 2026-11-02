import {ProviderFailure} from '@mote/shared';
import {ContextToolError} from './tool-errors.js';
import {AgentYieldError} from './host-controls.js';
import {taskTools} from './task-context.js';
import {assembleHostContext,resolveHostOutput,settleHostCleanup} from './host/run-session.js';
import {evaluateHostCandidate,hostOutputPolicy} from './host/output.js';
import type {RuntimeOutcome} from './runtime/contracts.js';
import {randomUUID} from 'node:crypto';
import {startBridge} from './bridge.js';
import {contextToolDefinitions,contextToolSnapshot,pinContextTools,releaseContextTools} from './tool-contributions.js';
import {toolInputSchema,toCodexTool} from './tools/runtime-schema.js';
import {codexImageMetadata,type ImagePayload} from './tools/image-result.js';
import {CodexSession,type CodexTool} from './codex-session.js';
import {bundledSkills} from './skills.js';
import {displayTime} from './time.js';
import {AgentInputError,AgentNotConfiguredError,AgentProviderError,AgentResponseError,AgentTimeoutError,reportProgress,reportTrace,type AgentOptions,type QueryInput,type AgentAnswer} from './types.js';

const toolsFor=(input:QueryInput,snapshot=contextToolSnapshot(input)):CodexTool[]=>{
  const pins=new Map(snapshot.entries.map(entry=>[entry.name,entry]));
  return [...contextToolDefinitions(input).map(([name,description,fields]):CodexTool=>{
    const pin=pins.get(name);
    return pin?toCodexTool(pin):{type:'function',name,description,inputSchema:toolInputSchema(fields)};
  }),{type:'function',name:'skill',description:'Read a bundled Mote procedure by name. Available: '+bundledSkills.filter(s=>s.id!=='document-import').map(s=>s.id).join(', '),inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}];
};
export const codexContextTools=toolsFor({question:''});
const answerSchema={type:'object',properties:{answer:{type:'string'},citationIds:{type:'array',items:{type:'string'}}},required:['answer','citationIds'],additionalProperties:false};

export function createCodexAgent(options:AgentOptions){
  let closed=false;const sessions=new Set<CodexSession>(),pending=new Set<Promise<AgentAnswer>>();
  async function execute(input:QueryInput):Promise<AgentAnswer>{
    input=pinContextTools({...input,...(input.evidenceReadRanges?{evidenceReadRanges:Object.freeze(input.evidenceReadRanges.map(range=>Object.freeze({...range})))}:{}),...(options.contextToolMode?{hostContextToolMode:options.contextToolMode}:{})},options.reader);
    let primaryFailure=false,released=false;
    const releasePinnedTools=()=>{if(released)return;released=true;releaseContextTools(input);};
    try{
    // One pinned snapshot for this run: tool schemas and the later per-call pin
    // checks must read the same registration identities, never a rebuilt one.
    const toolSnapshot=contextToolSnapshot(input);
    const assertToolPins=()=>{
      for(const pin of toolSnapshot.entries)try{toolSnapshot.assertActive(pin);}
      catch{throw new ContextToolError('stale_tool_pin','The registered tool was revoked or replaced.','stop');}
    };
    const runTools=toolsFor(input,toolSnapshot).filter(t=>taskTools(input).includes(t.name)||t.name==='skill');
    input.signal?.throwIfAborted();
    if(closed)throw new AgentProviderError();if(!options.model?.trim())throw new AgentNotConfiguredError();
    // Native capacity failures classify the complete request as processing_limit.
    if(typeof input.question!=='string'||!input.question.trim())throw new AgentInputError();
    displayTime(new Date().toISOString(),input.timeZone);reportProgress(input,{stage:'starting'});
    const runId=randomUUID();
    const trace=(event:Parameters<typeof reportTrace>[1])=>reportTrace(input,{...event,runId});
    trace({type:'run.started',stage:'starting',payload:{model:options.model,provider:options.provider,protocol:options.protocol,skill:input.skill??null,responseMode:input.responseMode??'answer',question:input.question,traceContext:input.traceContext??null}});
    let bridge:Awaited<ReturnType<typeof startBridge>>;
    try{bridge=await startBridge(options.reader,{...input,onTrace:trace},options.maxToolCalls);}catch(error){trace({type:'run.failed',stage:'starting',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError'}});throw error;}
    let session:CodexSession|undefined;
    let reading:Promise<AgentAnswer>|undefined;
    let accepted:AgentAnswer|undefined;
    const abort=()=>{session?.cancel(input.signal?.reason);void session?.close();};
    input.signal?.addEventListener('abort',abort,{once:true});
    try{
      const call=async(name:string,args:unknown)=>{
        assertToolPins();
        trace({type:'tool.started',stage:'tool',phase:'started',tool:name,payload:{arguments:args}});
        if(name==='skill'){
          const skill=bundledSkills.find(s=>s.id!=='document-import'&&s.id===(args as {name?:unknown})?.name);
          if(!skill)throw new Error('Unknown skill');const result={name:skill.name,content:skill.content};trace({type:'tool.completed',stage:'tool',phase:'completed',tool:name,status:'succeeded',payload:{result}});return result;
        }
        if(!taskTools(input).includes(name))throw new Error('Unknown tool');
        const requestTimeoutMs = options.requestTimeoutMs;
        try {
          const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(requestTimeoutMs??120000)});
          if(!response.ok){const body=await response.json() as {toolError?:{code:string;message:string;recovery:'correct_arguments'|'use_existing_evidence'|'stop';details:Record<string,unknown>}};const error=body.toolError;if(error)throw new ContextToolError(error.code,error.message,error.recovery,error.details);throw new Error('Context tool rejected');}
          const result=await response.json();
          assertToolPins();
          // Keep the opaque Host token in the private tool result. The session
          // acknowledges it only after the same-active-turn steer succeeds.
          if(name==='read_image'&&result.imageView)result.imageView.delivery='prepared';
          // The model receives the image, but diagnostics only need its identity
          // and size. Copying base64 into traces duplicates private originals and
          // can overwhelm the log viewer even when the read itself is bounded.
          const traced=name==='read_image'&&result.image?{...codexImageMetadata(result as ImagePayload),image:{mimeType:result.image.mimeType,encodedCharacters:result.image.data.length}}:result;
          trace({type:'tool.completed',stage:'tool',phase:'completed',tool:name,status:'succeeded',payload:{result:traced}});return result;
        } catch(error) {
          trace({type:'tool.completed',stage:'tool',phase:'completed',tool:name,status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError'}});throw error;
        }
      };
      if(closed)throw new AgentProviderError();
      input.signal?.throwIfAborted();
      const {system,prompt,metrics}=assembleHostContext(input,bridge.seedEvidence,options.maxTokens??65536,options.maxToolCalls,runTools);
      trace({type:'instructions.assembled',stage:'starting',payload:{system:system,tools:runTools}});
      trace({type:'context.assembled',stage:'starting',payload:{prompt,metrics,seedEvidence:bridge.seedEvidence}});
      session=new CodexSession(options,call,trace,input.onUsage,async(token,delivered)=>{
        const response=await fetch(bridge.url+'/_image_delivery',{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:JSON.stringify({token,delivered})});
        if(!response.ok)throw new AgentProviderError();
      });sessions.add(session);
      await session.start(system,runTools);
      const assertCurrent=()=>{input.signal?.throwIfAborted();if(closed)throw new AgentProviderError();input.assertContextAuthority?.();assertToolPins();};
      const drive=async(prompt:string,repairAttempt=0):Promise<RuntimeOutcome>=>{
        assertCurrent();reportProgress(input,{stage:'model'});
        const repair=repairAttempt?{repair:true,repairAttempt}:{};
        trace({type:'model.started',stage:'model',phase:'started',payload:{prompt,...repair}});
        const started=performance.now();
        const text=await Promise.race([session!.run(prompt,answerSchema),bridge.failure]);
        assertCurrent();
        trace({type:'model.completed',stage:'model',phase:'completed',durationMs:performance.now()-started,payload:{response:text,...repair}});
        return {terminal:{kind:'completed'},candidate:{text}};
      };
      const answer=await (reading=resolveHostOutput({input,runId,maxTokens:options.maxTokens,
        run:()=>drive(prompt),repair:(prompt,_error,index)=>drive(prompt,index),assertCurrent,
        // CodexSession.start verifies the declared dynamic tool schema and native
        // tool denial; an HTTP bridge /ready notification is DSH-specific.
        toolsReady:()=>true,
        evaluate:text=>evaluateHostCandidate({runId,candidate:{text},policy:hostOutputPolicy(input),evidence:bridge,contextUsage:{...metrics,toolResults:bridge.deliveredCharacters},includeReadRanges:input.evidenceIds!==undefined}),
      }));
      assertCurrent();
      accepted=answer;return answer;
    }catch(error){primaryFailure=true;if(error instanceof AgentYieldError){trace({type:'run.yielded',status:'waiting'});throw error;}trace({type:'run.failed',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError',reason:error instanceof AgentResponseError?error.reason:undefined}});if(error instanceof ContextToolError&&error.recovery==='stop')throw error;if(error instanceof AgentNotConfiguredError||error instanceof AgentTimeoutError||error instanceof AgentResponseError||error instanceof ProviderFailure)throw error;throw new AgentProviderError();}
    finally{
      input.signal?.removeEventListener('abort',abort);
      const cleanupErrors:unknown[]=[];
      await settleHostCleanup([()=>session?.close(),()=>bridge.close()],true,errors=>cleanupErrors.push(...errors));
      await Promise.allSettled(reading?[reading]:[]);
      if(session)sessions.delete(session);
      if(cleanupErrors.length)trace({type:'run.cleanup_failed',status:'failed',payload:{count:cleanupErrors.length}});
      if(!primaryFailure){
        if(cleanupErrors.length)throw new AgentProviderError();
        input.signal?.throwIfAborted();if(closed)throw new AgentProviderError();input.assertContextAuthority?.();assertToolPins();
        if(accepted)trace({type:'run.completed',stage:'validating',phase:'completed',status:'succeeded',payload:{citations:accepted.citations.map(citation=>citation.id),toolCalls:accepted.trace}});
      }
    }
    }catch(error){primaryFailure=true;throw error;}
    finally{
      // The Host run owns the pinned registry. Release only after the final
      // scope/pin check above, and never let a release failure replace the
      // primary error.
      try{releasePinnedTools();}catch(error){if(!primaryFailure)throw error;}
    }
  }
  return {configured:Boolean(options.model?.trim()),query(input:QueryInput){const task=execute(input);pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;},async close(){closed=true;await Promise.allSettled([...sessions].map(s=>s.close()));await Promise.allSettled([...pending]);}};
}
