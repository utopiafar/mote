import {gunzipSync} from 'node:zlib';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {captureSchema,rangeSchema,type CaptureInput} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {StoreError} from '../evidence-store.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import {safeError} from '../diagnostics.js';
import {CAPTURE_BATCH_MAX_BYTES} from '../capture-limits.js';
import {centralServices,type CaptureIntake,type CommitAuthority,type RequestAuthority,type SourceIntake,type SourceRepository} from './central-contracts.js';
import type {CaptureC04Port,CapturePort,CapturePageQuery} from '../capture-storage.js';

/** Trusted authorization members the capture transport is allowed to use. They are never
 * published: `withCapture`/`withSource` establish the admission scope that makes
 * `captureCommit()` meaningful, and the trusted owner keeps the single Ingress. */
export type CaptureIntakeAuthority=CaptureC04Port;

/** The package Manifest is host-owned; this is the actual data-contribution fragment. */
export const captureIntakeContribution={
  id:'capture-intake',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'}],
  // `sources` is deliberately not published: SourceStore.register writes owner
  // control-plane state and has no commit-authority parameter, so an ordinary
  // plugin must not receive it. The source-integration parent publishes it with source-route
  // admission; this slice keeps only the authority-bearing intake facades.
  provides:[centralServices.captureIntake,centralServices.sourceIntake].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const captureIntakeDeclaration={id:captureIntakeContribution.id,apiVersion:'1'} as const;
export const captureIntakeReplacement='restart' as const;

export interface CaptureIntakeOptions {
  /** Diagnostics is optional trusted hosting; routes work without metric recording. */
  readonly diagnostics?:Pick<ServerDiagnostics,'measure'>;
}
export interface CaptureIntakeDependencies {
  /** Trusted capture owner; the real Ingress and repositories stay private. */
  readonly port:CapturePort;
}
export interface CaptureRouteContext {
  /** Request pin bound by the host's authorization hook; never caller-supplied. */
  readonly request:(request:FastifyRequest)=>RequestAuthority|undefined;
}
export interface CaptureIntakePorts {
  readonly captureIntake:CaptureIntake;
  readonly sourceIntake:SourceIntake;
  /** Read/control repository over the real SourceStore; no Store or SQL handle. */
  readonly sources:SourceRepository;
}

/** The existing receipt format: recoverable intake, never processing readiness. */
export function parseCaptureBundle(body:unknown):CaptureInput[]{
  if(!Buffer.isBuffer(body))throw new StoreError('Capture bundle body must be gzip bytes');
  let inflated:Buffer;
  try{inflated=gunzipSync(body,{maxOutputLength:CAPTURE_BATCH_MAX_BYTES});}
  catch{throw new StoreError('Invalid capture bundle compression');}
  const text=inflated.toString('utf8');
  const lines=text.endsWith('\n')?text.slice(0,-1).split('\n'):text.split('\n');
  if(lines.length<1||lines.some(line=>line.length===0))throw new StoreError('Capture bundle JSONL is empty or contains empty lines');
  try{return lines.map(line=>captureSchema.parse(JSON.parse(line)));}
  catch(error){if(error instanceof z.ZodError)throw error;throw new StoreError('Invalid capture bundle JSONL');}
}

const unavailable=()=>new StoreError('Capture intake is unavailable',503);

/** Owns the capture write transport and its published intake ports. It borrows
 * the vault, the source/file/material repositories and the single authorization platform;
 * closing it revokes admission and drains nothing it does not own. */
export function createCaptureIntake(options:CaptureIntakeOptions,dependencies:CaptureIntakeDependencies){
  const {port}=dependencies;
  let authorization:CaptureIntakeAuthority|undefined;
  const bound=()=>{if(!authorization)throw new StoreError('Capture intake has no authorization binding',503);return authorization;};
  let phase:'created'|'prepared'|'bound'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let routesInstalled=false,closing:Promise<void>|undefined;
  const current=()=>{if(phase!=='active')throw unavailable();};
  const measure=async <T>(stage:'ingest'|'source',operation:'capture'|'timeline',task:()=>Promise<T>|T,metrics?:(result:T)=>Record<string,unknown>):Promise<T>=>{
    const diagnostics=options.diagnostics;
    if(!diagnostics)return task();
    // Call through the instance: measure() records with this.record(...).
    return diagnostics.measure(stage,operation,task,metrics as never);
  };
  const captureIntake:CaptureIntake=Object.freeze({
    capture:(input:CaptureInput,authority:CommitAuthority)=>{current();return bound().captureIntake.capture(input,authority);},
    captureSettled:(inputs:CaptureInput[],authority:CommitAuthority)=>{current();return bound().captureIntake.captureSettled(inputs,authority);},
  });
  const sourceIntake:SourceIntake=Object.freeze({
    sourceItem:(sourceId:string,input:unknown,authority:CommitAuthority)=>{current();return bound().sourceIntake.sourceItem(sourceId,input,authority);},
    sourceBatch:(sourceId:string,inputs:unknown,authority:CommitAuthority)=>{current();return bound().sourceIntake.sourceBatch(sourceId,inputs,authority);},
  });
  const sourceRepository:SourceRepository=port.sources;
  const ports:CaptureIntakePorts=Object.freeze({captureIntake,sourceIntake,sources:sourceRepository});
  const close=()=>closing??=(async()=>{phase='disposed';})();
  function routes(app:FastifyInstance,context:CaptureRouteContext){
    if(routesInstalled)throw new StoreError('Capture routes are already installed',409);
    if(phase!=='prepared'&&phase!=='bound'&&phase!=='active')throw unavailable();
    routesInstalled=true;
    const pin=(request:FastifyRequest)=>{
      const value=context.request(request);
      if(!value)throw new StoreError('Owner authorization is required',401);
      return value;
    };
    app.post('/api/captures',async(req,reply)=>{
      const input=captureSchema.parse(req.body),request=pin(req);
      const result=await bound().withCapture(request,input,()=>measure('ingest','capture',()=>
        captureIntake.capture(input,bound().captureCommit()),value=>({count:value.duplicate?0:1})));
      return reply.code(result.duplicate?200:201).send(result);
    });
    app.post('/api/captures/bundle',{bodyLimit:12*1024*1024},async req=>{
      const captures=parseCaptureBundle(req.body),request=pin(req);
      if(new Set(captures.map(input=>input.id)).size!==captures.length)throw new StoreError('Duplicate IDs in bundle');
      const committed=await bound().withCapture(request,captures,()=>captureIntake.captureSettled(captures,bound().captureCommit()));
      return {results:committed.map(item=>{if(item.result)return {...item.result,status:item.result.duplicate?200:201};const failure=safeError(item.error);return {id:item.id,status:failure.status,error:failure.category};})};
    });
    app.post('/api/captures/batch',{bodyLimit:12*1024*1024},async req=>{
      const {captures}=z.object({captures:z.array(captureSchema).min(1).max(25)}).strict().parse(req.body),request=pin(req);
      if(new Set(captures.map(input=>input.id)).size!==captures.length)throw new StoreError('Duplicate IDs in batch');
      const committed=await bound().withCapture(request,captures,()=>captureIntake.captureSettled(captures,bound().captureCommit()));
      return {results:committed.map(item=>{if(item.result)return {...item.result,status:item.result.duplicate?200:201};const failure=safeError(item.error);return {id:item.id,status:failure.status,error:failure.category};})};
    });
    app.get('/api/captures',async req=>{
      current();const raw=req.query as Record<string,string>,args=rangeSchema.parse(raw);
      return measure('source','timeline',()=>port.page({...args,cursor:raw.cursor} as CapturePageQuery),page=>({count:page.items.length}));
    });
  }
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw unavailable();
      port.assertRepositories();
      phase='prepared';
    },
    /** Trusted assembly only: the authorization platform supplies the fixed verifier after it bound the
     * same Ingress instance. This is not a published service or caller callback. */
    bindAuthorization(value:CaptureIntakeAuthority){
      if(phase!=='prepared')throw unavailable();
      authorization=value;phase='bound';
    },
    start(){if(phase!=='bound')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    /** Trusted assembly registers these on the feature child app, never globally. */
    routes,
    /** Published intake facades plus the trusted source read/control surface used by
   * trusted assembly only (`sources` is intentionally not a host contribution).
   * Raw Ingress, Store and the commit issuer stay private. */
    ports,
  });
}
export type CaptureIntakePlatform=ReturnType<typeof createCaptureIntake>;

/** Trusted assembly closure: it binds this exact Ingress into the authorization platform, starts it and
 * returns the fixed authority. Never a published service or caller-supplied object. */
export type CaptureAuthorizationBinding=()=>CaptureIntakeAuthority|Promise<CaptureIntakeAuthority>;
/** Trusted assembly registers the owned routes on its feature child app. */
export type CaptureRouteRegistration=(platform:CaptureIntakePlatform)=>void;

/** Compiled trusted host factory. PluginHost runs prepare -> start atomically, so the
 * assembly closure must bind the authorization platform to this ingress inside prepare; the host never
 * infers routes or authority from contributions. */
export function createCaptureIntakeFactory(options:CaptureIntakeOptions,dependencies:CaptureIntakeDependencies,bind:CaptureAuthorizationBinding,registerRoutes?:CaptureRouteRegistration){
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createCaptureIntake(options,dependencies);
    context.scope.defer(()=>platform.close());
    return {
      async prepare(){
        await platform.prepare();
        platform.bindAuthorization(await bind());
        registerRoutes?.(platform);
      },
      start(){platform.start();context.provide(captureIntakeContribution.id,centralServices.captureIntake,platform.ports.captureIntake);
        context.provide(captureIntakeContribution.id,centralServices.sourceIntake,platform.ports.sourceIntake);},
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:()=>platform.close(),
    };
  };
}
