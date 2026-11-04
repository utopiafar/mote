import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import {AgentNotConfiguredError,createImportAgent} from '@mote/agent';
import type {AgentOptions} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {ModelConnection,BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerLifecycle} from '../assembly/lifecycle.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {ProviderAdmission} from '../provider-admission.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import {agentModelConnection} from '../model-authorization-host.js';
import type {ArchivedFileStore} from '../archived-files.js';
import type {SourceStore} from '../sources.js';
import type {FileStore} from '../files.js';
import type {AdmittedUsageMeter} from '../assembly/processing.js';
import {requestLocale} from '../i18n.js';
import {prepareImportInput} from '../import-runtime.js';
import {ImportStore,type ImportPreparation,type ImportPreparationResult} from '../imports.js';
import {PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonImportOutput} from '../python-source-pack-executor.js';
import type {FileProcessing} from '../file-processing.js';
import {StoreError,sha256} from '../store.js';
import {centralServices} from './central-contracts.js';

export const importServicesContribution={
  id:'import-services',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'host',id:'mote.owner-authorization',version:'1.0.0'},
    {kind:'service',id:centralServices.execution.id,version:'1.0.0'},
  ],
  provides:[],
} as const satisfies ManifestContribution;
export const importServicesDeclaration={id:importServicesContribution.id,apiVersion:'1'} as const;
export const importServicesReplacement='hot' as const;

export interface ImportServicesDependencies {
  readonly store:ConstructorParameters<typeof ImportStore>[0];
  readonly diagnostics:ServerDiagnostics;
  readonly lifecycle:ServerLifecycle;
  readonly archivedFiles:ArchivedFileStore;
  readonly sources:SourceStore;
  readonly executor:ExecutionEngine;
  readonly processing:Pick<FileProcessing,'runtime'>;
  readonly files:FileStore;
  readonly config:Pick<Config,'importPythonPacks'>;
  readonly agent:AgentRuntimeRegistry;
  readonly modelSettings:ModelSettingsStore;
  readonly modelAuthorization:BackgroundModelAuthorization;
  readonly authorizeModelRequest:NonNullable<AgentOptions['authorizeModelRequest']>;
  readonly runModelFor:(settings:ModelSettings,connection?:ModelConnection)=>NonNullable<AgentOptions['runModel']>;
  readonly codex:AgentOptions['codex'];
  readonly admittedUsage:AdmittedUsageMeter;
  readonly agentGate:Pick<ConcurrencyGate,'run'>;
  readonly modelOperation:Pick<AsyncLocalStorage<string>,'run'>;
  readonly providerAdmission:Pick<ProviderAdmission,'run'>;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;
  readonly observeImport?:(workspace:string,event:unknown)=>void;
}

export interface ImportServices extends PluginLifecycle {
  readonly imports:ImportStore;
  readonly importTasks:Map<string,Promise<unknown>>;
  launchImport(id:string,task:()=>Promise<unknown>):void;
  launchOwnerImport(id:string,task:()=>Promise<unknown>):void;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Import services are unavailable',503);

export function createImportServices(dependencies:ImportServicesDependencies):ImportServices {
  const {store,diagnostics,lifecycle,archivedFiles,sources,executor,processing,files,config,agent,modelSettings,modelAuthorization,authorizeModelRequest,runModelFor,codex,admittedUsage,agentGate,modelOperation,providerAdmission,availableModelConnections}=dependencies;
  const importAgents=new Set<ReturnType<typeof createImportAgent>>(),importTasks=new Map<string,Promise<unknown>>();
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let imports:ImportStore|undefined,closing:Promise<void>|undefined;
  const launchOwnerImport=(id:string,task:()=>Promise<unknown>)=>{
    if(phase!=='active')throw unavailable();
    const work='owner-import:'+randomUUID();modelAuthorization.manual(work,'manual',['import:'+id],availableModelConnections());launchImport(id,()=>modelAuthorization.run(work,task));
  };
  function launchImport(id:string,task:()=>Promise<unknown>){
    if(phase!=='active'||lifecycle.isClosing())throw phase==='active'?new StoreError('Central node is shutting down',503):unavailable();
    if(importTasks.has(id))return;
    const promise=Promise.resolve().then(()=>phase==='active'&&!lifecycle.isClosing()?task():undefined);
    importTasks.set(id,promise);
    void promise.finally(()=>importTasks.delete(id)).catch(()=>{diagnostics.record('agent.failed',{category:'internal'},'error');});
  }
  const close=()=>closing??=(async()=>{
    phase='quiescing';
    const errors:unknown[]=[];
    try{await imports?.stop();}catch(error){errors.push(error);}
    const agents=await Promise.allSettled([...importAgents].map(runtime=>runtime.close()));
    errors.push(...agents.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
    await Promise.allSettled([...importTasks.values()]);
    importAgents.clear();imports=undefined;phase='disposed';
    if(errors.length)throw new AggregateError(errors,'Import services disposal failed');
  })();
  return Object.freeze({
    get imports(){if(!imports||phase==='created'||phase==='disposed')throw unavailable();return imports;},
    importTasks,
    launchImport,
    launchOwnerImport,
    prepare(){
      if(phase!=='created')throw unavailable();
      const sourcePacks=new Map((config.importPythonPacks??[]).map(spec=>{
        const executor=new PythonSourcePackExecutor<PythonImportOutput>({...spec,outputSchema:pythonImportOutputSchema});
        return [spec.id,{revision:sha256(JSON.stringify(spec)),prepare:pythonImportPreparation(executor)}] as const;
      }));
      imports=new ImportStore(store,archivedFiles,sources,{executor,intake:processing.runtime.intake,fileStore:files,
        sourcePacks,
        bindPhaseAuthority:step=>{
          if(modelAuthorization.ownerIntent(step.operationId)&&!modelAuthorization.stepAuthority(step.id))modelAuthorization.bindCurrentStep(step);
        },
        prepare:dependencies.prepareImport??(async input=>{
          if(!agent.configured)throw new AgentNotConfiguredError();
          const selected=modelSettings.select('import');if(!agent.configuredFor(selected.id))throw new AgentNotConfiguredError();
          const settings=selected.settings,connection=agentModelConnection({kind:'profile',id:selected.id},settings),prepared=await prepareImportInput(input);modelAuthorization.assertCurrent(connection);
          const meter=admittedUsage(settings.provider,settings.model,'document-import',{agentId:'document-import',moduleId:'imports',skillId:'document-import',operationId:input.operationId});
          const operationId=input.operationId??'import:'+randomUUID();
          let runtime:ReturnType<typeof createImportAgent>|undefined;const abort=()=>{void runtime?.close();};input.signal?.addEventListener('abort',abort,{once:true});
          try{runtime=createImportAgent({...settings,codex,runModel:runModelFor(settings,connection),authorizeModelRequest:()=>{modelAuthorization.assertCurrent(connection);authorizeModelRequest();}});importAgents.add(runtime);const {signal:_signal,operationId:_operationId,...request}=prepared;const result=await meter.run(()=>agentGate.run(()=>modelOperation.run(operationId,()=>providerAdmission.run(settings,()=>runtime!.prepare({...request,language:requestLocale.getStore()??'zh-CN'},dependencies.observeImport?event=>dependencies.observeImport!(input.workspace,event):undefined,usage=>meter.update(usage)))),input.signal,input.operationId));input.signal?.throwIfAborted();modelAuthorization.assertCurrent(connection);meter.completed();return result;}
          catch(error){meter.failed(error);throw error;}finally{input.signal?.removeEventListener('abort',abort);try{await runtime?.close();}finally{if(runtime)importAgents.delete(runtime);}}
        }),
        onImported:async()=>({}),
      });
      phase='prepared';
    },
    start(){
      if(phase==='active')return;
      if(phase!=='prepared'&&phase!=='stopped')throw unavailable();
      phase='active';
      for(const row of store.db.prepare("SELECT id FROM import_jobs WHERE json_extract(json,'$.status')='queued'").all() as {id:string}[])launchImport(row.id,()=>imports!.prepare(row.id));
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    async stop(_reason?:StopReason){
      if(phase==='stopped'||phase==='disposed')return;
      if(phase==='created'){phase='stopped';return;}
      phase='quiescing';await Promise.allSettled([...importTasks.values()]);phase='stopped';
    },
    dispose:close,
    close,
  });
}

export function createImportServicesFactory(platform:ImportServices){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {prepare:platform.prepare,start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.dispose};
  };
}
