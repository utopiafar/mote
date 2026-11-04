import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import type {FastifyInstance} from 'fastify';
import {AgentNotConfiguredError,createImportAgent} from '@mote/agent';
import type {ModelConnection} from '../background-model-authorization.js';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import {StoreError,sha256,type Store} from '../store.js';
import type {ServerLifecycle} from './lifecycle.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {ProviderAdmission} from '../provider-admission.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import {agentModelConnection} from '../model-authorization-host.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {ArchivedFileStore} from '../archived-files.js';
import type {SourceStore} from '../sources.js';
import type {FileStore} from '../files.js';
import type {AdmittedUsageMeter} from './processing.js';
import type {AgentOptions} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import {requestLocale} from '../i18n.js';
import {prepareImportInput} from '../import-runtime.js';
import {ImportStore,type ImportPreparation,type ImportPreparationResult} from '../imports.js';
import {PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonImportOutput} from '../python-source-pack-executor.js';
import type {FileProcessing} from '../file-processing.js';
import type {FeatureServices} from '../feature-services.js';

export interface ImportsAssemblyDependencies {
  readonly app:FastifyInstance;
  readonly store:Store;
  readonly resources:ServerResources;
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

/** ImportStore, the Python source-pack executors, accepted-import tracking and
 * the onReady recovery that relaunches queued imports — plus their close
 * hooks. */
export function assembleImports(dependencies:ImportsAssemblyDependencies){
  const {app,store,resources,diagnostics,lifecycle,archivedFiles,sources,executor,processing,files,config,agent,modelSettings,modelAuthorization,authorizeModelRequest,runModelFor,codex,admittedUsage,agentGate,modelOperation,providerAdmission,availableModelConnections}=dependencies;
  const importAgents=new Set<ReturnType<typeof createImportAgent>>(),importTasks=new Map<string,Promise<unknown>>();
  resources.defer(async()=>{await Promise.allSettled([...importAgents].map(runtime=>runtime.close()));await Promise.allSettled([...importTasks.values()]);});
  const sourcePacks=new Map((config.importPythonPacks??[]).map(spec=>{
    const executor=new PythonSourcePackExecutor<PythonImportOutput>({...spec,outputSchema:pythonImportOutputSchema});
    return [spec.id,{revision:sha256(JSON.stringify(spec)),prepare:pythonImportPreparation(executor)}] as const;
  }));
  const imports=new ImportStore(store,archivedFiles,sources,{executor,intake:processing.runtime.intake,fileStore:files,
    sourcePacks,
    bindPhaseAuthority:step=>{
      // Only this import's explicit owner action may fill a missing binding.
      // An already-bound step keeps its original durable authority on retries.
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
    // Each original receipt owns its automatic authorization. Ready materials
    // enter the shared rolling queue; import completion must not create a second job.
    onImported:async()=>({}),
  });
  resources.defer(()=>imports.stop());
  const launchOwnerImport=(id:string,task:()=>Promise<unknown>)=>{const work='owner-import:'+randomUUID();modelAuthorization.manual(work,'manual',['import:'+id],availableModelConnections());launchImport(id,()=>modelAuthorization.run(work,task));};
  function launchImport(id:string,task:()=>Promise<unknown>){
    if(lifecycle.isClosing())throw new StoreError('Central node is shutting down',503);
    if(importTasks.has(id))return;
    const promise=Promise.resolve().then(()=>lifecycle.isClosing()?undefined:task());
    importTasks.set(id,promise);
    void promise.finally(()=>importTasks.delete(id)).catch(()=>{diagnostics.record('agent.failed',{category:'internal'},'error');});
  }
  app.addHook('onReady',async()=>{
    for(const row of store.db.prepare("SELECT id FROM import_jobs WHERE json_extract(json,'$.status')='queued'").all() as {id:string}[])launchImport(row.id,()=>imports.prepare(row.id));
  });
  return Object.freeze({imports,importTasks,launchImport,launchOwnerImport,featureServices:Object.freeze({imports,importTasks,launchImport,launchOwnerImport}) satisfies Partial<FeatureServices>});
}
