import {randomUUID} from 'node:crypto';
import {formatEvidenceRef} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {AgentImportHost,AgentImportHostDependencies} from '../agent-import-host.js';
import type {ModelConnection,BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerLifecycle} from '../assembly/lifecycle.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {ArchivedFileStore} from '../archived-files.js';
import type {SourceStore} from '../sources.js';
import type {FileStore} from '../files.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {ServerFeatureScope} from '../feature-host.js';
import {navigationScopeSchema} from '../context-navigation.js';
import {ImportInputError,ImportStore,type ImportPreparation,type ImportPreparationResult} from '../imports.js';
import {ImportUploads,registerImportUploads} from '../import-uploads.js';
import {PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonImportOutput} from './python-source-pack-executor.js';
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
  readonly evidenceReader:Pick<EvidenceReader,'evidence'>;
  readonly prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;
}

export interface ImportServices extends PluginLifecycle {
  readonly imports:ImportStore;
  readonly importTasks:Map<string,Promise<unknown>>;
  launchImport(id:string,task:()=>Promise<unknown>):void;
  launchOwnerImport(id:string,task:()=>Promise<unknown>):void;
  routes(app:FastifyInstance,scope?:ServerFeatureScope):void;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Import services are unavailable',503);
const jobId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;

export function createImportServices(dependencies:ImportServicesDependencies,importHost:AgentImportHost):ImportServices {
  const {store,diagnostics,lifecycle,archivedFiles,sources,executor,processing,files,config,modelAuthorization,availableModelConnections,evidenceReader}=dependencies;
  const importTasks=new Map<string,Promise<unknown>>();
  const mounted=new WeakSet<FastifyInstance>();
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let imports:ImportStore|undefined,uploads:ImportUploads|undefined,closing:Promise<void>|undefined;
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
    try{await uploads?.close();}catch(error){errors.push(error);}
    try{await importHost.close();}catch(error){errors.push(error);}
    await Promise.allSettled([...importTasks.values()]);
    imports=undefined;uploads=undefined;phase='disposed';
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
      uploads=new ImportUploads(store,archivedFiles);
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
    routes(app:FastifyInstance,scope?:ServerFeatureScope){
      if(mounted.has(app))throw new StoreError('Import routes are already installed',409);
      if((phase!=='prepared'&&phase!=='active')||!imports||!uploads)throw unavailable();
      const current=imports,currentUploads=uploads;
      mounted.add(app);
      app.addHook('onRequest',async(request,reply)=>{
        const write=request.method!=='GET'&&request.method!=='HEAD';
        if(phase!=='active'&&(phase!=='quiescing'||write))return reply.code(503).send({error:'feature_unavailable'});
      });
      scope?.defer(()=>current.stop());
      registerImportUploads(app,currentUploads);scope?.defer(()=>currentUploads.close());
      app.get('/api/import-capabilities',async()=>current.intake.list());
      app.get('/api/imports',async()=>({items:current.list()}));
      app.get('/api/import-source-packs',async()=>({items:(config.importPythonPacks??[]).map(({id,version,description})=>({id,version,...(description?{description}:{})}))}));
      app.post('/api/imports',{bodyLimit:360*1024*1024},async(req,reply)=>{
        try{const job=await current.create(req.body);if(job.status==='queued')launchOwnerImport(job.id,()=>current.prepare(job.id));return reply.code(202).send(current.get(job.id));}
        catch(error){if(error instanceof ImportInputError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});throw error;}
      });
      app.post('/api/imports/:id/cancel',async req=>current.cancel(jobId(req.params)));
      app.get('/api/imports/:id',async req=>current.get(jobId(req.params)));
      app.delete('/api/imports/:id',async req=>{const id=jobId(req.params);if(importTasks.has(id))throw new StoreError('Import is already processing',409);return current.delete(id);});
      app.post('/api/imports/:id/prepare',async(req,reply)=>{const id=jobId(req.params),body=z.object({instruction:z.string().max(12000).optional()}).strict().parse(req.body??{});if(importTasks.has(id))return reply.code(202).send(current.get(id));if(body.instruction!==undefined)current.updateInstruction(id,body.instruction);current.get(id);launchOwnerImport(id,()=>current.prepare(id));return reply.code(202).send(current.get(id));});
      app.post('/api/imports/:id/confirm',async(req,reply)=>{
        const id=jobId(req.params);let job=current.get(id);
        if(job.status==='completed'||job.status==='importing')return reply.code(202).send(job);
        if(job.status!=='awaiting_confirmation')throw new StoreError('Review an import preview before confirming',409);
        // A preview can be visible before its prepare task finishes orchestration cleanup.
        // Do not acknowledge a confirmation that launchOwnerImport would silently discard.
        const previewIdentity=current.confirmationIdentity(id);
        const finishing=()=>reply.code(409).send({error:'import_finishing',message:'Parsing is finishing. Please confirm again shortly.',requestId:req.id});
        const preparing=importTasks.get(id);
        if(preparing){
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{const finished=await Promise.race([preparing.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);if(!finished)return finishing();}
          finally{if(timer)clearTimeout(timer);}
        }
        job=current.get(id);
        if(current.confirmationIdentity(id)!==previewIdentity)throw new StoreError('The preview changed; review it before confirming',409);
        if(job.status==='completed'||job.status==='importing')return reply.code(202).send(job);
        if(job.status!=='awaiting_confirmation')throw new StoreError('Review an import preview before confirming',409);
        if(current.hasActiveWorker(id))return finishing();
        launchOwnerImport(id,()=>current.confirm(id));return reply.code(202).send(current.get(id));
      });
      app.post('/api/imports/:id/retry',async(req,reply)=>{const id=jobId(req.params);current.get(id);if(importTasks.has(id)||current.hasActiveWorker(id))return reply.code(409).send({error:'import_stopping',message:'Import processing is still stopping. Retry shortly.',requestId:req.id});launchOwnerImport(id,()=>current.retry(id));return reply.code(202).send(current.get(id));});
      app.get('/api/archived-files/:id',async req=>archivedFiles.get(jobId(req.params)));
      app.get('/api/archived-files/:id/content',async(req,reply)=>{const id=jobId(req.params),file=archivedFiles.get(id);return reply.type('application/octet-stream').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`).header('Content-Security-Policy',"default-src 'none'; sandbox").send(archivedFiles.stream(id));});
      app.get('/api/captures/:id/archived-files',async req=>{const record=evidenceReader.evidence([formatEvidenceRef('capture',z.string().uuid().parse((req.params as {id:string}).id))],navigationScopeSchema.parse(req.query))[0];if(!record)throw new StoreError('Capture not found',404);return {items:archivedFiles.listForCapture(record.id)};});
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
