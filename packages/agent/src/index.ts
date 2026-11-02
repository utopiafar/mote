import {SYSTEM_PROMPT,systemInstructions} from './instructions.js';
import {AgentYieldError} from './host-controls.js';
import {ActiveExecutionBudget,DEFAULT_AGENT_EXECUTION_TIMEOUT_MS} from './active-budget.js';
import {observeModelTransport} from './model-transport-observer.js';
import {contextToolDefinitions,pinContextTools} from './tool-contributions.js';
export {ContextToolRegistry,contextToolDefinitions,type ContextToolContribution} from './tool-contributions.js';
export {buildContextEnvelope,taskTools} from './task-context.js';
import {taskTools} from './task-context.js';
import {assembleHostContext,resolveHostOutput,settleHostCleanup} from './host/run-session.js';
import {evaluateHostCandidate,hostOutputPolicy} from './host/output.js';
import type {RuntimeOutcome} from './runtime/contracts.js';
import {observeHarness} from './usage.js';
import {DEFAULT_MODEL_MAX_TOKENS} from '@mote/shared/models';
import {createCodexAgent} from './codex-agent.js';
import {reportProgress,reportTrace} from './types.js';
import {ProviderFailure} from '@mote/shared';
import { DeepSeekHarness, RequestTimeoutError } from "@deepseek-ai/dsh-sdk-client";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import {readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startBridge } from "./bridge.js";
import { displayTime } from './time.js';
export {parseAnswer} from './answer-parser.js';
import {modelConnection, modelRuntimeEntries, harnessPrivacyEntries, validateModelOptions} from './model-runtime.js';
import {bundledSkills,skillContent} from './skills.js';
export {skillCatalog,SKILL_VERSION} from './skills.js';
export {createImportAgent} from './import-agent.js';
export type {ImportAgentInput} from './import-agent.js';
import {
  AgentInputError,
  AgentNotConfiguredError,
  AgentResponseError,
  AgentTimeoutError,
  AgentProviderError,
  type AgentOptions,
  type AgentAnswer,
  type QueryInput,
} from "./types.js";
export * from "./types.js";
export {AgentYieldError,hostControlDefinitions,hostControlInstructions,type HostControlChannel,type HostControlDefinition,type HostControlResult} from './host-controls.js';
export {ContextToolError} from './tool-errors.js';
export {originalEvidenceReceipt} from './bridge.js';
export {extractionSeedScopeValid} from './extraction-seed-scope.js';
export {validateInlineCitations} from "./citations.js";
export {validateModelOptions} from './model-runtime.js';

class AgentClosedError extends Error {
  constructor() { super('Agent is closed'); }
}

// Freeze the verified tool composition with this loaded module. A development rebuild
// must not change the plugin halfway through a running server's next query.
export const PLUGIN_SOURCE=readFileSync(new URL('./plugin.mjs',import.meta.url),'utf8')
  .replace('from "./context-tools.js"',`from ${JSON.stringify(new URL('./context-tools.js',import.meta.url).href)}`)
        .replace('from "@deepseek-ai/dsh-tools"',`from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tools'))}`)
  .replace('from "@deepseek-ai/dsh-tool-skill"',`from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tool-skill'))}`);
export {SYSTEM_PROMPT,SOURCE_TIME_INSTRUCTIONS,ATTRIBUTION_CONTEXT_INSTRUCTIONS,systemInstructions} from './instructions.js';

export function createRuntimePatch(
  pluginPath: string,
  model: string,
  baseUrl?: string,
  reasoningEffort?: AgentOptions["reasoningEffort"],
  maxTokens = DEFAULT_MODEL_MAX_TOKENS,
  connection: Pick<AgentOptions, 'protocol' | 'provider' | 'requestTimeoutMs'> = {},
  systemPrompt = SYSTEM_PROMPT,
): string {
  // JSON is valid YAML. No executable YAML expressions or untrusted path interpolation.
  return JSON.stringify(
    [
      ...[
        "persistent-bash",
        "persistent-pwsh",
        "terminal-bash",
        "terminal-pwsh",
        "pty",
        "subprocess",
        "mcp-resources",
      ].map((id) => ({ id, disabled: true })),
      ...harnessPrivacyEntries(),
      {
        id: "system-prompt",
        config: {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
          personaPrefix: systemPrompt,
        },
      },
      ...modelRuntimeEntries({...connection, model, baseUrl, reasoningEffort, maxTokens}),
      {
        id: "sdk-jsonrpc-server",
        inject: ["sdkAppStartup", "loader", "moteReady"],
      },
      { insert: [{id:'mote-attachments',name:import.meta.resolve('@deepseek-ai/dsh-attachment-local'),config:{maxImageBytes:8388608,maxMessageImageBytes:33554432}}, {id:'mote-skills',name:import.meta.resolve('@deepseek-ai/dsh-skill')}, { id: "mote-context", name: pluginPath }] },
    ],
    null,
    2,
  );
}


export function createAgent(options: AgentOptions) {
  // Clone the caller's secret-bearing objects. A settings edit must not mutate an
  // already admitted query or its destination part-way through tool retrieval.
  validateModelOptions(options);
  if(options.protocol==='codex-app-server')return createCodexAgent(options);
  options = {...options, headers: options.headers && {...options.headers}, extraBody: options.extraBody && structuredClone(options.extraBody)};
  const connection = modelConnection(options);
  let closed = false;
  const active = new Set<DeepSeekHarness>();
  const pending = new Set<Promise<AgentAnswer>>();
  const localWithoutKey =
    !!options.allowUnauthenticatedLocal &&
    !!options.baseUrl &&
    ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(options.baseUrl).hostname,
    );
  const configured =
    !!options.model?.trim() && (!!options.apiKey?.trim() || localWithoutKey);
  async function execute(input: QueryInput): Promise<AgentAnswer> {
    input=pinContextTools({...input,...(input.evidenceReadRanges?{evidenceReadRanges:Object.freeze(input.evidenceReadRanges.map(range=>Object.freeze({...range})))}:{}),...(options.contextToolMode?{hostContextToolMode:options.contextToolMode}:{})},options.reader);
    input.signal?.throwIfAborted();
    if (closed) throw new AgentClosedError();
    if (!configured) throw new AgentNotConfiguredError();
    // External schemas own user input limits; internal host policies remain complete.
    if (typeof input.question !== 'string' || !input.question.trim())
      throw new AgentInputError();
    // Validate the caller's display zone before creating a Harness process.
    displayTime(new Date().toISOString(), input.timeZone);
    reportProgress(input,{stage:'starting'});
    const modelAdmission=new AbortController();
    const modelSignal=input.signal?AbortSignal.any([input.signal,modelAdmission.signal]):modelAdmission.signal;
    const runId = randomUUID();
    const trace=(event:Parameters<typeof reportTrace>[1])=>reportTrace(input,{...event,runId});
    trace({type:'run.started',stage:'starting',payload:{model:options.model,provider:options.provider,protocol:options.protocol,skill:input.skill??null,responseMode:input.responseMode??'answer',question:input.question,traceContext:input.traceContext??null}});
    const root = await mkdtemp(join(tmpdir(), "mote-agent-"));
    let bridge: Awaited<ReturnType<typeof startBridge>>;
    try {
      bridge = await startBridge(
        options.reader,
        {...input,onTrace:trace},
        options.maxToolCalls,
      );
    } catch (error) {
      trace({type:'run.failed',stage:'starting',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError'}});
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    let harness: DeepSeekHarness | undefined;
    let transportObserver:Awaited<ReturnType<typeof observeModelTransport>>|undefined;
    const budget=new ActiveExecutionBudget(options.agentTimeoutMs===undefined?DEFAULT_AGENT_EXECUTION_TIMEOUT_MS:options.agentTimeoutMs);
    let primaryFailure = false;
    let reading:Promise<AgentAnswer>|undefined;
    let accepted:AgentAnswer|undefined;
    let abortListener: (() => void) | undefined;
    try {
      const {system,prompt,metrics}=assembleHostContext(input,bridge.seedEvidence,options.maxTokens??DEFAULT_MODEL_MAX_TOKENS,options.maxToolCalls);
      trace({type:'instructions.assembled',stage:'starting',payload:{system,tools:taskTools(input).map(name=>contextToolDefinitions(input).find(tool=>tool[0]===name))}});
      trace({type:'context.assembled',stage:'starting',payload:{prompt,metrics,seedEvidence:bridge.seedEvidence}});
      transportObserver=await observeModelTransport(options.authorizeModelRequest);
      await mkdir(join(root, "workspace"));
      const patch = join(root, "mote.patch.json");
      const pluginPath=join(root,"mote-plugin.mjs");
      await writeFile(pluginPath,PLUGIN_SOURCE,{mode:0o600});
      await writeFile(
        patch,
        createRuntimePatch(
          pluginPath,
          options.model!,
          options.baseUrl,
          options.reasoningEffort,
          options.maxTokens,
          options,
          system,
        ),
        { mode: 0o600 },
      );
      // close() may run while the filesystem/bridge setup above is awaiting.
      // No await separates this check, construction, and active registration.
      if (closed) throw new AgentClosedError();
      harness = new DeepSeekHarness({
        profile: "sdk-minimal",
        patches: [patch],
        dshHome: join(root, "home"),
        cwd: join(root, "workspace"),
        processCwd: join(root, "workspace"),
        provider: connection.route,
        model: options.model!,
        maxTokens: options.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
        initializeTimeoutMs: 30_000,
        requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
        env: {
          PATH: process.env.PATH,
          TMPDIR: tmpdir(),
          HOME: join(root, "home"),
          DEEPSEEK_API_KEY: options.apiKey || "mote-local-no-auth",
          DEEPSEEK_BASE_URL: connection.baseUrl,
          MOTE_MODEL_API_KEY: options.apiKey || "mote-local-no-auth",
          MOTE_MODEL_OBSERVER:JSON.stringify(transportObserver.configuration),
          MOTE_MODEL_TRANSPORT: JSON.stringify({
            baseUrl: connection.baseUrl, protocol: connection.protocol, reasoningEffort: connection.effort,
            provider: options.provider, headers: options.headers, extraBody: options.extraBody,
          }),
          MOTE_CONTEXT_BRIDGE: bridge.url,
          MOTE_CONTEXT_BRIDGE_TOKEN: bridge.token,
          MOTE_TASK_TOOLS: JSON.stringify(taskTools(input)),
          MOTE_TOOL_DEFINITIONS: JSON.stringify(contextToolDefinitions(input)),
          MOTE_SKILLS: JSON.stringify(bundledSkills.filter(skill=>skill.id!=='document-import')),
        },
      });
      active.add(harness);
      const checkProviderResult = (result: Awaited<ReturnType<DeepSeekHarness['run']>>) => {
        // The SDK resolves some failed turns instead of throwing. Inspect only
        // the typed terminal event, never classify its free-form provider text.
        const lastEnd = result.events && [...result.events].reverse().find(event => event.type === 'turn/end');
        const reason = (lastEnd?.data as {reason?: {kind?: string}} | undefined)?.reason;
        if (reason?.kind === 'error') throw new AgentProviderError();
      };
      const onNotification = observeHarness(input, runId, connection.protocol !== 'deepseek');
      const assertCurrent=()=>{modelSignal.throwIfAborted();if(closed)throw new AgentClosedError();input.assertContextAuthority?.();};
      const drive = async (prompt:string,repairAttempt=0):Promise<RuntimeOutcome> => {
        assertCurrent();reportProgress(input,{stage:'model'});
        const repair=repairAttempt?{repair:true,repairAttempt}:{};
        trace({type:'model.started',stage:'model',phase:'started',payload:{prompt,...repair}});
        const started=performance.now();
        const result=await (options.runModel??(async (task,_signal?:AbortSignal)=>task()))(()=>budget.run(()=>harness!.run(prompt,{sessionId:runId,onNotification})),modelSignal);
        trace({type:'model.completed',stage:'model',phase:'completed',durationMs:performance.now()-started,payload:{response:result.finalResponse,events:result.events,...repair}});
        checkProviderResult(result);
        const lastEnd=result.events&&[...result.events].reverse().find(event=>event.type==='turn/end');
        const limited=(lastEnd?.data as {reason?:{kind?:string}}|undefined)?.reason?.kind==='max-tokens';
        return limited?{terminal:{kind:'output_limit'},candidate:{text:result.finalResponse}}:{terminal:{kind:'completed'},candidate:{text:result.finalResponse}};
      };
      const readAnswer=()=>resolveHostOutput({input,runId,maxTokens:options.maxTokens,
        run:()=>drive(prompt),repair:(prompt,_error,index)=>drive(prompt,index),assertCurrent,toolsReady:()=>bridge.ready,
        evaluate:text=>evaluateHostCandidate({runId,candidate:{text},policy:hostOutputPolicy(input),evidence:bridge,contextUsage:{...metrics,toolResults:bridge.deliveredCharacters},includeReadRanges:input.evidenceIds!==undefined}),
      });
      input.signal?.throwIfAborted();
      const answer = await Promise.race([
        new Promise<never>((_,reject)=>{
          abortListener=()=>reject(new DOMException('Query cancelled','AbortError'));
          input.signal?.addEventListener('abort',abortListener,{once:true});
        }),
        reading=readAnswer(),
        bridge.failure,
        transportObserver.failure,
      ]);
      assertCurrent();accepted=answer;
      return answer;
    } catch (error) {
      primaryFailure = true;
      if(error instanceof AgentYieldError){trace({type:'run.yielded',status:'waiting'});throw error;}
      trace({type:'run.failed',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError',reason:error instanceof AgentResponseError?error.reason:undefined}});
      // The SDK message may contain child stderr. Class identity establishes the
      // timeout; never inspect or forward provider/runtime message text.
      if (error instanceof RequestTimeoutError) throw new AgentTimeoutError();
      if (error instanceof AgentTimeoutError || error instanceof AgentResponseError || error instanceof AgentClosedError || error instanceof ProviderFailure) throw error;
      throw new AgentProviderError();
    } finally {
      modelAdmission.abort();
      if (abortListener) input.signal?.removeEventListener('abort',abortListener);
      const cleanupErrors:unknown[]=[];
      await settleHostCleanup([
        ()=>harness?.close(),()=>bridge.close(),()=>transportObserver?.close(),
      ],true,errors=>cleanupErrors.push(...errors));
      await Promise.allSettled(reading?[reading]:[]);
      if (harness) active.delete(harness);
      await settleHostCleanup([()=>rm(root,{recursive:true,force:true})],true,errors=>cleanupErrors.push(...errors));
      if(cleanupErrors.length)trace({type:'run.cleanup_failed',status:'failed',payload:{count:cleanupErrors.length}});
      if(!primaryFailure){
        if(cleanupErrors.length)throw new AgentProviderError();
        input.signal?.throwIfAborted();if(closed)throw new AgentClosedError();input.assertContextAuthority?.();
        if(accepted)trace({type:'run.completed',stage:'validating',phase:'completed',status:'succeeded',payload:{citations:accepted.citations.map(citation=>citation.id),toolCalls:accepted.trace}});
      }
    }
  }
  return {
    configured,
    query(input: QueryInput): Promise<AgentAnswer> {
      const task = execute(input);
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    },
    async close() {
      closed = true;
      const shutdown = await Promise.allSettled(
        [...active].map((harness) => harness.close()),
      );
      // Includes queries still preparing their isolated runtime, and drains their cleanup.
      await Promise.allSettled([...pending]);
      active.clear();
      const failure = shutdown.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw new AgentProviderError();
    },
  };
}
export {CodexSession} from './codex-session.js';
