import {randomUUID} from 'node:crypto';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {AgentImportHost,AgentImportHostDependencies} from '../agent-import-host.js';
import type {ModelConnection,BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerLifecycle} from '../assembly/lifecycle.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {ArchivedFileStore} from '../archived-files.js';
import type {SourceStore} from '../sources.js';
import type {FileStore} from '../files.js';
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

export interface ImportServicesDependencies extends AgentImportHostDependencies {
  readonly store:ConstructorParameters<typeof ImportStore>[0];
  readonly diagnostics:ServerDiagnostics;
  readonly lifecycle:ServerLifecycle;
  readonly archivedFiles:ArchivedFileStore;
  readonly sources:SourceStore;
  readonly executor:ExecutionEngine;
  readonly processing:Pick<FileProcessing,'runtime'>;
  readonly files:FileStore;
  readonly config:Pick<Config,'importPythonPacks'>;
  readonly modelAuthorization:BackgroundModelAuthorization;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;
}

export interface ImportServices extends PluginLifecycle {
  readonly imports:ImportStore;
  readonly importTasks:Map<string,Promise<unknown>>;
  launchImport(id:string,task:()=>Promise<unknown>):void;
  launchOwnerImport(id:string,task:()=>Promise<unknown>):void;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Import services are unavailable',503);

export function createImportServices(dependencies:ImportServicesDependencies,importHost:AgentImportHost):ImportServices {
  const {store,diagnostics,lifecycle,archivedFiles,sources,executor,processing,files,config,modelAuthorization,availableModelConnections}=dependencies;
  const importTasks=new Map<string,Promise<unknown>>();
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
    await Promise.allSettled([...importTasks.values()]);
    imports=undefined;phase='disposed';
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
        prepare:dependencies.prepareImport??(input=>importHost.prepare(input)),
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
