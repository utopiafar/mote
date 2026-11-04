import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import {AgentNotConfiguredError,createImportAgent,type AgentOptions,type ImportAgentInput,type ImportCapability} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import type {AgentRuntimeRegistry} from './agent-runtime-registry.js';
import type {AdmittedUsageMeter} from './assembly/processing.js';
import type {BackgroundModelAuthorization,ModelConnection} from './background-model-authorization.js';
import type {ConcurrencyGate} from './concurrency.js';
import {requestLocale} from './i18n.js';
import {prepareImportInput} from './import-runtime.js';
import type {ImportPreparation,ImportPreparationResult} from './imports.js';
import type {ModelSettingsStore} from './model-settings.js';
import {agentModelConnection} from './model-authorization-host.js';
import type {ProviderAdmission} from './provider-admission.js';
import {StoreError} from './store.js';

export type {ImportCapability};
export type ImportCapabilityFactory=(options:Omit<AgentOptions,'reader'>)=>ImportCapability;

export interface AgentImportHostDependencies {
  readonly agent:Pick<AgentRuntimeRegistry,'configured'|'configuredFor'>;
  readonly modelSettings:Pick<ModelSettingsStore,'select'>;
  readonly modelAuthorization:Pick<BackgroundModelAuthorization,'capture'>;
  readonly authorizeModelRequest:NonNullable<AgentOptions['authorizeModelRequest']>;
  readonly runModelFor:(settings:ModelSettings,connection?:ModelConnection)=>NonNullable<AgentOptions['runModel']>;
  readonly codex:AgentOptions['codex'];
  readonly admittedUsage:AdmittedUsageMeter;
  readonly agentGate:Pick<ConcurrencyGate,'run'>;
  readonly modelOperation:Pick<AsyncLocalStorage<string>,'run'>;
  readonly providerAdmission:Pick<ProviderAdmission,'run'>;
  readonly observeImport?:(workspace:string,event:unknown)=>void;
  /** Trusted build adapter only; the product capability is never selected by input. */
  readonly capability?:ImportCapabilityFactory;
}

export interface AgentImportHost {
  prepare(input:ImportPreparation):Promise<ImportPreparationResult>;
  close():Promise<void>;
}

/** Host boundary for the writable import capability. A preparation runs under
 * the exact model-authorization lease captured at its start; every provider
 * send and the accepted result are fenced by that lease. The capability can
 * only write its private workspace and return a preview for Host validation. */
export function createAgentImportHost(dependencies:AgentImportHostDependencies):AgentImportHost {
  const createCapability=dependencies.capability??createImportAgent;
  const active=new Set<ImportCapability>(),pending=new Set<Promise<unknown>>();
  let closed=false,closing:Promise<void>|undefined;

  async function execute(input:ImportPreparation):Promise<ImportPreparationResult> {
    if(closed)throw new StoreError('Import host is closed',503);
    if(!dependencies.agent.configured)throw new AgentNotConfiguredError();
    const selected=dependencies.modelSettings.select('import');
    if(!dependencies.agent.configuredFor(selected.id))throw new AgentNotConfiguredError();
    const settings=selected.settings,connection=agentModelConnection({kind:'profile',id:selected.id},settings);
    const prepared=await prepareImportInput(input);
    if(closed)throw new StoreError('Import host is closed',503);
    input.signal?.throwIfAborted();
    const lease=dependencies.modelAuthorization.capture(connection);
    lease();
    const operationId=input.operationId??'import:'+randomUUID();
    const meter=dependencies.admittedUsage(settings.provider,settings.model,'document-import',{agentId:'document-import',moduleId:'imports',skillId:'document-import',operationId});
    let runtime:ImportCapability|undefined;
    const abort=()=>{void runtime?.close();};
    input.signal?.addEventListener('abort',abort,{once:true});
    try{
      runtime=createCapability({...settings,codex:dependencies.codex,runModel:dependencies.runModelFor(settings,connection),
        authorizeModelRequest:()=>{lease();dependencies.authorizeModelRequest();}});
      active.add(runtime);
      const {signal:_signal,operationId:_operationId,...request}=prepared;
      const result=await meter.run(()=>dependencies.agentGate.run(()=>dependencies.modelOperation.run(operationId,
        ()=>dependencies.providerAdmission.run(settings,()=>runtime!.prepare({...request,language:requestLocale.getStore()??'zh-CN'},
          dependencies.observeImport?event=>dependencies.observeImport!(input.workspace,event):undefined,usage=>meter.update(usage)))),
      input.signal,input.operationId));
      // A late preview from a cancelled or revoked preparation cannot become
      // the next Host-validated candidate.
      input.signal?.throwIfAborted();lease();meter.completed();
      return result;
    }catch(error){meter.failed(error);throw error;}
    finally{
      input.signal?.removeEventListener('abort',abort);
      try{await runtime?.close();}finally{if(runtime)active.delete(runtime);}
    }
  }

  return Object.freeze({
    prepare(input:ImportPreparation){const task=execute(input);pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;},
    close(){return closing??=(async()=>{
      closed=true;
      const cleanup=await Promise.allSettled([...active].map(runtime=>runtime.close()));
      await Promise.allSettled([...pending]);
      if(cleanup.some(result=>result.status==='rejected'))throw new AggregateError(cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'Import host cleanup failed');
    })();},
  });
}
