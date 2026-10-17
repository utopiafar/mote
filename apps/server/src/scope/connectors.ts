import {connectorOriginalProcessors} from '../connectors/original-processors.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {rm} from 'node:fs/promises';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {recordingSelectionSchema,sourceIdSchema,type SourceItem,type SourceItemRecord,type SourceConnection} from '@mote/shared';
import {GoogleCalendarConnector,selectedCalendarsSchema} from '../connectors/google.js';
import {GmailAdapter} from '../connectors/gmail-adapter.js';
import {LarkAdapter,larkConfigureSchema,selectionSchema as larkSelectionSchema} from '../connectors/lark-adapter.js';
import {createLarkRunner} from '../connectors/lark-cli.js';
import {ConnectorError} from '../connectors/types.js';
import type {AdapterContext,ConnectorSources,LarkContext} from '../connectors/ports.js';
import {ExecutionFailure} from '../execution-engine.js';
import {EXECUTION_POLICIES} from '../execution-policy.js';
import type {PluginManifest} from '../plugin-release.js';
import type {ScopedRuntime} from './http.js';
import type {TaskExecution,TaskRun} from './task-execution.js';
import type {Configurations} from './configuration.js';
import type {ScopedPluginHost} from './plugins.js';
import type {IngressHost} from './ingress.js';
import type {UserContext} from './context.js';
import type {DomainLifecycle,UserDataSubject,UserExport} from './lifecycle.js';
import {ScopeError} from './baseline.js';
import {PrivateData} from './private-data.js';
import {ConnectorVault,connectorHash as hash} from './connector-vault.js';
import {connectorSettings,connectionSchema,connectorTask,type ConnectorTask,type ConnectionSettings,type ConnectorProvider,type ConnectorTransports,type ConnectorAdapter,type ConnectorDefinition} from './connector-contract.js';
import {ScopedRecordingAdapter} from './connector-recordings.js';

type Row={user_id:string;id:string;generation:number;removed:number;settings:string;sync_authorized:number;storage_generation:number};
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonical(child)])):value;
const DOMAIN='connectors',CONFIG='connectorSettings',TASK='connector.run';
const pluginId=(id:string)=>'connector.'+id;
const definitions=['gmail','google-calendar','lark','feishu-recordings','dingtalk-recordings'] as const;
const publicSettings=(s:ConnectionSettings)=>({...s,googleClientSecret:undefined,googleClientId:s.googleClientId?'configured':undefined,googleRedirectUri:s.googleRedirectUri});
const sourceStatusSchema=z.object({state:z.enum(['idle','syncing','error','permission_required']),code:z.string().max(200).optional(),lastSyncAt:z.string().datetime({offset:true}).optional()}).strict();
export interface ConnectorSourceStatusReader{sourceStatuses(sourceIds:readonly string[]):ReadonlyMap<string,NonNullable<SourceConnection['status']>>}
/** One registrar, one shared executor, and M09's existing user instance lifecycle.
 * Provider factories below use actual adapters with transport-only injection. */
export class ScopedConnectors {
 private readonly sourceStatusReaders=new Set<(context:UserContext,sourceIds:readonly string[])=>ReadonlyMap<string,NonNullable<SourceConnection['status']>>>();
 registerSourceStatusReader(reader:(context:UserContext,sourceIds:readonly string[])=>ReadonlyMap<string,NonNullable<SourceConnection['status']>>){this.sourceStatusReaders.add(reader);return ()=>{this.sourceStatusReaders.delete(reader);};}
 private readonly extensions=new Map<string,ConnectorDefinition>();
 private readonly packages=new Map<ConnectorProvider,string>();
 private readonly active=new Map<string,Set<AbortController>>();
 private readonly dispose:()=>Promise<void>;
 private readonly detachPlugin:()=>void;
 private readonly detachOriginalProcessor:()=>void;
 private readonly activities=new Map<string,{done:Promise<void>}>();
 private readonly lifecycleQueue=new Map<string,Promise<void>>();
 private closed=false;
 private closing?:Promise<void>;
 constructor(private runtime:ScopedRuntime,private options:{db:DatabaseSync;directory:string;configuration:Configurations;execution:TaskExecution;plugins:ScopedPluginHost;ingress:IngressHost;transports?:ConnectorTransports;definitions?:readonly ConnectorDefinition[];processing?:import('./processing.js').ProcessingHost}){
  const {db,configuration,execution,plugins}=options;const detach=options.processing?connectorOriginalProcessors.map(processor=>options.processing!.processors.registry.register(processor)):[];this.detachOriginalProcessor=()=>{for(const dispose of detach)dispose();};
  db.exec(`CREATE TABLE IF NOT EXISTS connector_connections(user_id TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,removed INTEGER NOT NULL,settings TEXT NOT NULL,sync_authorized INTEGER NOT NULL DEFAULT 0,storage_generation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(user_id,id));
   CREATE TABLE IF NOT EXISTS connector_activity(user_id TEXT NOT NULL,id TEXT NOT NULL,instance_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(user_id,id));
   CREATE TABLE IF NOT EXISTS connector_commands(user_id TEXT NOT NULL,instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,input_hash TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(user_id,instance_id,operation_id));
   CREATE TABLE IF NOT EXISTS connector_jobs(user_id TEXT NOT NULL,instance_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(user_id,task_id));
   CREATE TABLE IF NOT EXISTS connector_timers(user_id TEXT NOT NULL,instance_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(user_id,instance_id));
   CREATE TABLE IF NOT EXISTS connector_secrets(user_id TEXT NOT NULL,instance_id TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,instance_id,name));
   CREATE TABLE IF NOT EXISTS connector_sources(user_id TEXT NOT NULL,instance_id TEXT NOT NULL,local_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(user_id,instance_id,local_id),UNIQUE(user_id,source_id));
   CREATE TABLE IF NOT EXISTS connector_ledger(user_id TEXT NOT NULL,instance_id TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,instance_id,scope,key));
   CREATE TABLE IF NOT EXISTS connector_oauth(state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,instance_id TEXT NOT NULL,generation INTEGER NOT NULL,snapshot_id TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL,task_id TEXT);
   CREATE TABLE IF NOT EXISTS connector_domain_state(user_id TEXT PRIMARY KEY,deleted INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS connector_restore(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,json TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,operation_id));`);
  for(const definition of options.definitions??[]){if(definitions.includes(definition.id as any)||this.extensions.has(definition.id)||!definition.version||typeof definition.create!=='function')throw new ConnectorError('connector_definition_invalid');this.extensions.set(definition.id,definition);}
  for(const provider of [...definitions,...this.extensions.keys()]){
   const components=[{id:'connector.'+provider,version:'1',surface:'ingress' as const,capability:'source' as const}],manifest:PluginManifest={schemaVersion:1,id:'mote.connector.'+provider,name:this.extensions.get(provider)?.name??provider,version:this.extensions.get(provider)?.version??'1',runtime:'worker',entry:'bundled.mjs',archive:{asset:'bundled.zip',sha256:hash(['mote-connector',provider,1])},capabilities:['source'],configuration:[],dependencies:['Mote scoped connector adapter@1'],access:['User-selected read-only provider'],components};
   const id=plugins.registerBundledPackage(manifest,()=>({call:async method=>{if(method==='describe')return {components};if(method==='health')return {capabilities:[{id:'source',state:'verified'}],issues:[]};throw new ConnectorError('connector_use_scoped_route',403);},close:async()=>{}}));this.packages.set(provider,id);
  }
  configuration.registerDomain(CONFIG,subject=>({id:CONFIG,schema:connectorSettings.refine(value=>value.connections.every(c=>this.packages.has(c.provider)),'Unknown connector provider'),defaultValue:{connections:[]},fields:[{path:'connections.*.googleClientSecret',sensitive:true}],resolve:raw=>raw,prepare:next=>this.prepare(subject.userId,connectorSettings.parse(next).connections)}));
  runtime.services.registerUser(DOMAIN,{scope:'user',create:context=>this.forUser(context),lifecycle:this.lifecycle});
  this.detachPlugin=plugins.onInstanceChange(async event=>{if(!event.instanceId.startsWith('connector.'))return;const id=event.instanceId.slice('connector.'.length);if(!db.prepare('SELECT 1 FROM connector_connections WHERE user_id=? AND id=? AND removed=0').get(event.userId,id))return;if(!event.action||event.action==='stop')this.abort(event.userId,id);if(event.context&&['resume','enable'].includes(event.action??''))await this.schedule(event.context,id);});
  this.migrateOperationPayloads();
  this.dispose=execution.register({kind:TASK,pool:'connectors',concurrency:()=>4,policy:EXECUTION_POLICIES.networkAcquisition,parseInput:value=>connectorTask.parse(value),
   authorizeInput:(context,input)=>{this.binding(context,connectorTask.parse(input));},
   resources:input=>[{scope:'user',key:'connector:'+String(input.connectionId)}],
   validate:step=>{try{const input=connectorTask.parse(step.input),row=this.row(step.ownership!.userId,input.connectionId);plugins.assertStoredBinding(step.ownership!.userId,input.snapshotId);return !this.closed&&!row.removed&&row.generation===input.generation;}catch{return false;}},
   admit:step=>{const input=connectorTask.parse(step.input);if(input.action==='oauth'){const state=this.oauth(input.state!);if(!state||state.expires<=Date.now())return new ExecutionFailure('blocked','connector_oauth_expired');if(state.status==='pending')return new ExecutionFailure('waiting','connector_oauth_pending',Math.min(1000,state.expires-Date.now()));if(state.status!=='ready')return new ExecutionFailure('blocked','connector_oauth_consumed');}if(input.due>0&&!plugins.storedAdmissionOpen(step.ownership!.userId,pluginId(input.connectionId)))return new ExecutionFailure('blocked','connector_timer_paused');if(input.due>Date.now())return new ExecutionFailure('waiting','connector_timer_wait',input.due-Date.now());return;},
   execute:run=>this.execute(run),classify:error=>error instanceof z.ZodError?new ExecutionFailure('permanent','connector_input_invalid'):error instanceof ExecutionFailure?error:error instanceof ScopeError?new ExecutionFailure('stale','connector_authority_revoked'):new ExecutionFailure('blocked',error instanceof ConnectorError?error.code:'connector_requires_attention'),
  });
 }
 private tx<T>(work:()=>T):T{const db=this.options.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=work();if(own)db.exec('COMMIT');return result;}catch(e){if(own&&db.isTransaction)db.exec('ROLLBACK');throw e;}}
 private assert(context:UserContext){this.runtime.authority.assert(context);if(this.closed||this.options.db.prepare('SELECT 1 FROM connector_domain_state WHERE user_id=? AND deleted=1').get(context.userId))throw new ScopeError('invalid_identity',401);}
 private row(user:string,id:string):Row{const row=this.options.db.prepare('SELECT * FROM connector_connections WHERE user_id=? AND id=?').get(user,id) as Row|undefined;if(!row||row.removed)throw new ConnectorError('connector_not_found',404);return row;}
 private binding(context:UserContext,input:ConnectorTask){this.assert(context);const row=this.row(context.userId,input.connectionId);if(row.generation!==input.generation)throw new ScopeError('invalid_identity',401);const binding=this.options.plugins.binding(context,input.snapshotId);if(binding.instanceId!==pluginId(row.id)||binding.packageId!==this.packages.get(connectionSchema.parse(JSON.parse(row.settings)).provider))throw new ScopeError('invalid_identity',401);return {row,binding};}
 private prepare(user:string,values:ConnectionSettings[]){
  for(const value of values)if(!this.packages.has(value.provider))throw new ConnectorError('connector_provider_unavailable');
  const db=this.options.db,before=db.prepare('SELECT * FROM connector_connections WHERE user_id=?').all(user) as Row[];let published=false;
  return {apply:()=>{},publish:()=>{this.tx(()=>{if(db.prepare('SELECT 1 FROM connector_domain_state WHERE user_id=? AND deleted=1').get(user))throw new ScopeError('invalid_identity',401);for(const old of before)if(!values.some(v=>v.id===old.id))db.prepare('UPDATE connector_connections SET generation=generation+1,removed=1,sync_authorized=0 WHERE user_id=? AND id=?').run(user,old.id);
   for(const value of values){const old=before.find(v=>v.id===value.id),changed=Boolean(old&&(old.removed||old.settings!==JSON.stringify(value))),previous=old?connectionSchema.parse(JSON.parse(old.settings)):undefined,credentialsChanged=Boolean(previous&&(['googleClientId','googleClientSecret','googleRedirectUri'] as const).some(key=>previous[key]!==value[key]));db.prepare('INSERT INTO connector_connections VALUES(?,?,?,0,?,0,?) ON CONFLICT(user_id,id) DO UPDATE SET generation=excluded.generation,removed=0,settings=excluded.settings,storage_generation=excluded.storage_generation,sync_authorized=CASE WHEN ? THEN 0 ELSE connector_connections.sync_authorized END').run(user,value.id,(old?.generation??1)+Number(changed),JSON.stringify(value),(old?.storage_generation??1)+Number(Boolean(old?.removed)||credentialsChanged),Number(changed));}published=true;});},rollback:()=>{if(published)this.tx(()=>{db.prepare('DELETE FROM connector_connections WHERE user_id=?').run(user);for(const row of before)db.prepare('INSERT INTO connector_connections VALUES(?,?,?,?,?,?,?)').run(row.user_id,row.id,row.generation,row.removed,row.settings,row.sync_authorized,row.storage_generation);});},complete:()=>{for(const old of before){const next=values.find(v=>v.id===old.id);if(!next||old.settings!==JSON.stringify(next)){this.abort(user,old.id);this.clearOperationPayloads(user,old.id);}}}};
 }
 private abort(user:string,id:string){for(const controller of this.active.get(hash([user,id]))??[])controller.abort();}
 private oauth(state:string){return this.options.db.prepare('SELECT * FROM connector_oauth WHERE state_hash=?').get(hash(state)) as {user_id:string;instance_id:string;generation:number;snapshot_id:string;expires:number;status:string;task_id?:string}|undefined;}
 private vault(context:UserContext,id:string,assert:()=>void){return new ConnectorVault(this.options.db,this.options.directory,context.deploymentId,context.userId,id+':'+this.row(context.userId,id).storage_generation+':'+context.authorizationEpoch,assert);}
 private ledger(context:UserContext,id:string,assert:()=>void){const db=this.options.db,user=context.userId;return {
  get:<T>(scope:string,key:string):T|undefined=>{assert();const row=db.prepare('SELECT json FROM connector_ledger WHERE user_id=? AND instance_id=? AND scope=? AND key=?').get(user,id,scope,key);return row?JSON.parse(String(row.json)) as T:undefined;},
  set:(scope:string,key:string,value:unknown)=>{assert();db.prepare('INSERT INTO connector_ledger VALUES(?,?,?,?,?) ON CONFLICT(user_id,instance_id,scope,key) DO UPDATE SET json=excluded.json').run(user,id,scope,key,JSON.stringify(value));},
  drop:(scope:string,key:string)=>{assert();db.prepare('DELETE FROM connector_ledger WHERE user_id=? AND instance_id=? AND scope=? AND key=?').run(user,id,scope,key);},
  rows:<T>(scope:string,prefix:string,limit=-1,errorOnly=false)=>{assert();return db.prepare("SELECT key,json FROM connector_ledger WHERE user_id=? AND instance_id=? AND scope=? AND substr(key,1,?)=? ORDER BY key").all(user,id,scope,prefix.length,prefix).map(row=>({key:String(row.key),value:JSON.parse(String(row.json)) as T})).filter(row=>!errorOnly||(row.value as any)?.error).slice(0,limit<0?undefined:limit);},
 };}
 private adapterContext(context:UserContext,row:Row,assert:()=>void,signal:AbortSignal):LarkContext{
  const db=this.options.db,id=row.id,settings=connectionSchema.parse(JSON.parse(row.settings)),vault=this.vault(context,id,assert),ledger=this.ledger(context,id,assert),ingress=this.options.ingress.forUser(context,undefined,assert),data=this.runtime.services.forUser(context).get<PrivateData>('private-data');
  const actual=(raw:string)=>{assert();const mapped=db.prepare('SELECT source_id FROM connector_sources WHERE user_id=? AND instance_id=? AND local_id=?').get(context.userId,id,raw);if(!mapped)throw new ConnectorError('connector_source_missing',404);return String(mapped.source_id);};
  const bound=(raw:string)=>this.options.ingress.bindSource(context,[actual(raw)],assert);
  const all=(raw:string)=>{const items:SourceItemRecord[]=[];let cursor:string|undefined;do{const page=sources.listItems({sourceId:raw,limit:100,cursor});items.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);return items;};
  const sources:ConnectorSources={
   register:value=>this.tx(()=>{assert();const sourceId='connector-'+hash([id,value.id]).slice(0,48),existing=db.prepare('SELECT source_id FROM connector_sources WHERE user_id=? AND instance_id=? AND local_id=?').get(context.userId,id,value.id);if(!existing){ingress.registerSource({...value,id:sourceId,deviceId:'connector-'+hash(id).slice(0,32)});db.prepare('INSERT INTO connector_sources VALUES(?,?,?,?)').run(context.userId,id,value.id,sourceId);}return sources.getSource(value.id);}),
   update:(raw,value)=>{assert();return data.updateSource(actual(raw),Object.fromEntries(Object.entries(value).filter(([key])=>['name','enabled','retention','initialSync','ownerRelation'].includes(key))));},
   getSource:raw=>{assert();return {...data.source(actual(raw)),id:raw,status:ledger.get<SourceConnection['status']>('source-status',raw)};},
   listSources:()=>{assert();return db.prepare('SELECT local_id,source_id FROM connector_sources WHERE user_id=? AND instance_id=? ORDER BY local_id').all(context.userId,id).map(r=>({...data.source(String(r.source_id)),id:String(r.local_id),status:ledger.get<SourceConnection['status']>('source-status',String(r.local_id))}));},
   getItem:(raw,external)=>{assert();const item=data.sourceItem(actual(raw),external);if(!item)return;const saved=vault.read<{captureId:string;item:SourceItem}>('head:'+hash([raw,external]));return {...item,...(saved?.captureId===item.captureId?saved.item:{}),sourceId:raw};},
   listItems:args=>{assert();return data.captures({...args,sourceId:actual(args.sourceId)},true) as {items:SourceItemRecord[];nextCursor:string|null};},
   upsert:async(raw,item,authorize)=>{authorize?.();return sources.upsertBatch(raw,[item],authorize).then(r=>r.receipts[0]);},
   upsertBatch:async(raw,items,authorize)=>this.tx(()=>{assert();authorize?.();const inputs=items.map(item=>sources.getSource(raw).retention!=='reference'&&data.sourceItem(actual(raw),item.externalId)?.revision!==item.revision?{bytes:Buffer.from(JSON.stringify(item)),mime:'application/json',format:'source-item' as const}:undefined),result=ingress.receiveSourceItemsWithOriginals(actual(raw),hash([items,inputs.map(v=>v?hash(v.bytes):null)]),items,inputs);for(const [index,receipt] of result.captures.entries())vault.write('head:'+hash([raw,items[index].externalId]),{captureId:receipt.id,item:items[index]});assert();authorize?.();return {receipts:result.captures};}),
   reportStatus:(raw,status)=>{assert();ledger.set('source-status',raw,status);},
  };
  const pending={set:(state:string,value:{verifier:string;expires:number})=>{assert();vault.write('oauth:'+hash(state),value);},take:(state:string)=>{assert();const value=vault.read<{verifier:string;expires:number}>('oauth:'+hash(state));vault.clear('oauth:'+hash(state));return value;},clear:()=>{assert();db.prepare("UPDATE connector_oauth SET status='revoked' WHERE user_id=? AND instance_id=? AND status IN ('pending','ready')").run(context.userId,id);}};
  const ctx:LarkContext={config:{dataDir:vault.directory,connectors:{...settings,directory:vault.directory}},assertCurrent:assert,automaticTimers:false,state:name=>vault.state(name),pending,sources,
   ledger:{get:(a,s,k)=>ledger.get(hash([a,s]),k),set:(a,s,k,v)=>ledger.set(hash([a,s]),k,v),drop:(a,s,k)=>ledger.drop(hash([a,s]),k),rows:(a,s,p,l,e)=>ledger.rows(hash([a,s]),p,l,e),forgotten:(raw,id)=>{assert();return ledger.rows<boolean>('forgotten:'+raw,id??'').filter(row=>id===undefined||row.key===id).map(row=>row.key);},versionExists:(raw,ext)=>{assert();return Boolean(sources.getItem(raw,ext));},counts:raw=>{assert();const exists=Boolean(db.prepare('SELECT 1 FROM connector_sources WHERE user_id=? AND instance_id=? AND local_id=?').get(context.userId,id,raw));const items=exists?all(raw):[];return {exists,documents:items.filter(i=>i.kind==='file').length,activities:items.filter(i=>i.kind==='event').length};}},
   publishFile:async(raw,item,bytes,authorize,_signal,format)=>this.tx(()=>{assert();authorize();const receipt=ingress.receiveSourceItemsWithOriginals(actual(raw),hash([item,hash(bytes),format??'file']),[item],[{bytes,mime:item.mimeType??'application/octet-stream',format}]).captures[0];vault.write('head:'+hash([raw,item.externalId]),{captureId:receipt.id,item});assert();return receipt;}),
  };
  return ctx;
 }
 private async adapter(context:UserContext,row:Row,assert:()=>void,signal:AbortSignal){
  const ctx=this.adapterContext(context,row,assert,signal),provider=connectionSchema.parse(JSON.parse(row.settings)).provider,scope={userId:context.userId,instanceId:row.id,directory:ctx.config.dataDir},google=this.options.transports?.google?.(scope);
  if(provider==='google-calendar'){const adapter=new GoogleCalendarConnector(ctx,google);await adapter.init();return adapter;}
  if(provider==='gmail'){
   const vault=this.vault(context,row.id,assert),ledger=this.ledger(context,row.id,assert),data=this.runtime.services.forUser(context).get<PrivateData>('private-data'),ingress=this.options.ingress.forUser(context,undefined,assert);
   const real=(raw:string)=>String(this.options.db.prepare('SELECT source_id FROM connector_sources WHERE user_id=? AND instance_id=? AND local_id=?').get(context.userId,row.id,raw)?.source_id??'');
   const parts=(raw:string,id:string)=>{const items:SourceItemRecord[]=[];let cursor:string|undefined;do{const page=ctx.sources.listItems({sourceId:raw,limit:100,cursor});items.push(...page.items);cursor=page.nextCursor??undefined;}while(cursor);return items.filter(i=>i.externalId.startsWith(id+':')).map(i=>i.externalId);};
   // Provider-only envelope updates retain the first original of a semantic revision.
   const adapter=new GmailAdapter(ctx,{parts,stale:(raw,epoch)=>ledger.rows<string>('gmail:'+raw,'').filter(r=>r.value!==epoch).map(r=>r.key),member:(raw,id,epoch)=>epoch?ledger.set('gmail:'+raw,id,epoch):ledger.drop('gmail:'+raw,id),publish:async(raw,_id,message,items,authorize)=>this.tx(()=>{assert();authorize();const bytes=message?Buffer.from(JSON.stringify(message)):undefined;const inputs=items.map(item=>bytes&&data.sourceItem(real(raw),item.externalId)?.revision!==item.revision?{bytes,mime:'application/json',format:'processor:connector.gmail-original' as const}:undefined),receipts=ingress.receiveSourceItemsWithOriginals(real(raw),hash([items,inputs.map(v=>v?hash(v.bytes):null),'processor:connector.gmail-original']),items,inputs,items.map(()=>'processor:connector.gmail-original' as const)).captures;for(const [index,receipt] of receipts.entries())vault.write('head:'+hash([raw,items[index].externalId]),{captureId:receipt.id,item:items[index]});assert();return {receipts};})},google);await adapter.init();return adapter;
  }
  if(provider==='lark'){const runner=this.options.transports?.lark?.(scope)??createLarkRunner(scope.directory,{isolatedHome:true});const adapter=new LarkAdapter(ctx,async(command,options)=>{assert();const result=await runner(command,{...options,signal:AbortSignal.any([signal,...(options?.signal?[options.signal]:[])])});assert();return result;});await adapter.init();return adapter;}
  const extension=this.extensions.get(provider);if(extension){const adapter=await extension.create(ctx,Object.freeze(scope),signal);await adapter.init?.();return adapter;}
  return new ScopedRecordingAdapter(ctx,provider as 'feishu-recordings'|'dingtalk-recordings',scope,this.options.transports,assert,signal,this.ledger(context,row.id,assert));
 }
 private beginActivity(userId:string,instanceId:string){
  const id=randomUUID(),key=hash([userId,id]);let resolve!:()=>void,finished=false;const done=new Promise<void>(value=>resolve=value);this.options.db.prepare("INSERT INTO connector_activity VALUES(?,?,?,'active')").run(userId,id,instanceId);this.activities.set(key,{done});
  return {finish:(confirmed:boolean)=>{if(finished)return;finished=true;try{if(confirmed)this.options.db.prepare('DELETE FROM connector_activity WHERE user_id=? AND id=?').run(userId,id);else this.options.db.prepare("UPDATE connector_activity SET state='unknown' WHERE user_id=? AND id=?").run(userId,id);}catch{/* A closed host leaves its durable record for M16 reconciliation. */}finally{this.activities.delete(key);resolve();}}};
 }
 private erasureSubject(subject:UserDataSubject){this.runtime.services.assertSubject(subject,DOMAIN,'delete');if('credentialId' in subject)throw new ScopeError('invalid_identity',403);if(!this.options.db.prepare('SELECT 1 FROM connector_domain_state WHERE user_id=? AND deleted=1').get(subject.userId))throw new ConnectorError('connector_deletion_not_started',409);}
 pendingErasure(subject:UserDataSubject){this.erasureSubject(subject);return this.options.db.prepare('SELECT id,instance_id,state FROM connector_activity WHERE user_id=? ORDER BY id').all(subject.userId).map(row=>({id:String(row.id),instanceId:String(row.instance_id),state:String(row.state),live:this.activities.has(hash([subject.userId,row.id]))}));}
 settleErasure(subject:UserDataSubject,id:string,outcome:'stopped'){this.erasureSubject(subject);if(outcome!=='stopped'||this.activities.has(hash([subject.userId,id])))throw new ConnectorError('connector_erasure_unconfirmed',409);this.options.db.prepare('DELETE FROM connector_activity WHERE user_id=? AND id=?').run(subject.userId,id);}
 private activity(context:UserContext,row:Row,extra:()=>void=()=>{}){
  this.assert(context);const journal=this.beginActivity(context.userId,row.id),controller=new AbortController(),key=hash([context.userId,row.id]),group=this.active.get(key)??new Set<AbortController>();group.add(controller);this.active.set(key,group);
  let adapter:Awaited<ReturnType<ScopedConnectors['adapter']>>|undefined;
  const assert=()=>{this.assert(context);const current=this.row(context.userId,row.id);if(current.generation!==row.generation||current.storage_generation!==row.storage_generation||controller.signal.aborted)throw new ScopeError('invalid_identity',401);extra();},stop=()=>{void adapter?.close().catch(()=>{});};controller.signal.addEventListener('abort',stop,{once:true});
  return {assert,signal:controller.signal,open:async()=>{assert();adapter=await this.adapter(context,row,assert,controller.signal);assert();return adapter;},finish:async()=>{controller.signal.removeEventListener('abort',stop);let confirmed=false;try{await adapter?.close();confirmed=Boolean(adapter)||!this.extensions.has(connectionSchema.parse(JSON.parse(row.settings)).provider);}finally{journal.finish(confirmed);group.delete(controller);if(!group.size)this.active.delete(key);}}};
 }
 private async serializeLifecycle<T>(userId:string,work:()=>Promise<T>){const previous=this.lifecycleQueue.get(userId)??Promise.resolve(),result=previous.then(work),tail=result.then(()=>{},()=>{});this.lifecycleQueue.set(userId,tail);try{return await result;}finally{if(this.lifecycleQueue.get(userId)===tail)this.lifecycleQueue.delete(userId);}}
 private async execute(run:TaskRun){
  const input=connectorTask.parse(run.task.input),{row,binding}=this.binding(run.context,input),journal=this.beginActivity(run.context.userId,input.connectionId),controller=new AbortController(),key=hash([run.context.userId,row.id]),group=this.active.get(key)??new Set();group.add(controller);this.active.set(key,group);
  const signal=AbortSignal.any([run.signal,controller.signal]),assert=()=>{run.grant.assert();this.binding(run.context,input);binding.assertCurrent();if(signal.aborted)throw new ScopeError('invalid_identity',401);};
  let adapter:Awaited<ReturnType<ScopedConnectors['adapter']>>|undefined;const stop=()=>{void adapter?.close().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
  try{
   assert();this.options.db.prepare('INSERT OR IGNORE INTO connector_jobs VALUES(?,?,?)').run(run.context.userId,row.id,run.task.id);adapter=await this.adapter(run.context,row,assert,signal);assert();let result:unknown;
   if(input.action==='oauth'){
    const state=this.oauth(input.state!);if(!state||state.status!=='ready'||state.expires<=Date.now())throw new ConnectorError('connector_oauth_expired');
    const vault=this.vault(run.context,row.id,assert),code=vault.read<string>('code:'+hash(input.state));if(!code)throw new ConnectorError('connector_oauth_missing');
    this.options.db.prepare("UPDATE connector_oauth SET status='consumed' WHERE state_hash=? AND status='ready'").run(hash(input.state));vault.clear('code:'+hash(input.state));
    const oauth=this.oauthAdapter(adapter);if(!oauth)throw new ConnectorError('connector_oauth_invalid');
    run.external.begin('connector-oauth:'+hash(input.state));await oauth.callback(input.state!,code);assert();run.external.complete();result={connected:true};
   }else if(input.action==='sync'){
    if(adapter instanceof LarkAdapter){adapter.startSync();result=await adapter.wait();}else if(adapter instanceof ScopedRecordingAdapter)result=await adapter.sync(input.due>0);else result=await adapter.sync();assert();
    if(input.recurring&&this.row(run.context.userId,row.id).sync_authorized)await this.schedule(run.context,row.id,run.task.id);
   }else {let timer:ReturnType<typeof setInterval>|undefined;if(adapter instanceof LarkAdapter)timer=setInterval(()=>{try{assert();run.progress({connector:adapter instanceof LarkAdapter?adapter.status().job:undefined});}catch{}},100);try{if(['login','setup'].includes(input.operation!))run.external.begin('connector-authorization:'+run.task.id);result=await this.operation(adapter,input.operation!,this.operationPayload(run,input,row,assert),value=>{assert();run.progress(value);});if(['login','setup'].includes(input.operation!)){run.external.complete();run.progress({authorization:'complete'});}}finally{clearInterval(timer);}}
   assert();
   if(adapter instanceof LarkAdapter&&input.action==='operation'&&input.operation==='calendars'&&result&&typeof result==='object'&&'calendars' in result&&Array.isArray(result.calendars)&&Buffer.byteLength(JSON.stringify(result))>24000){
    // Preserve the complete explicit discovery in the existing encrypted,
    // owner/connection/epoch vault instead of truncating a task receipt.
    this.vault(run.context,row.id,assert).write('calendar-inventory',{taskId:run.task.id,generation:row.generation,items:result.calendars});
    return {calendarInventory:run.task.id,count:result.calendars.length};
   }
   assert();if(input.action==='operation'&&input.operation==='disconnect'){await adapter.close();assert();this.clearOperationPayloads(run.context.userId,row.id);const vault=this.vault(run.context,row.id,assert);await rm(vault.directory,{recursive:true,force:true});assert();this.options.db.prepare('DELETE FROM connector_secrets WHERE user_id=? AND instance_id=?').run(run.context.userId,row.id+':'+row.storage_generation+':'+run.context.authorizationEpoch);this.options.db.prepare('UPDATE connector_connections SET storage_generation=storage_generation+1 WHERE user_id=? AND id=? AND generation=?').run(run.context.userId,row.id,row.generation);}return this.safeResult(adapter instanceof LarkAdapter?this.publicLarkStatus(run.context,row.id,result):result,adapter instanceof LarkAdapter);
  }finally{signal.removeEventListener('abort',stop);let confirmed=false;try{await adapter?.close();confirmed=Boolean(adapter)||!this.extensions.has(connectionSchema.parse(JSON.parse(row.settings)).provider);}finally{journal.finish(confirmed);group.delete(controller);if(!group.size)this.active.delete(key);}}
 }
 private async schedule(context:UserContext,id:string,currentTaskId?:string){
  const row=this.row(context.userId,id),settings=connectionSchema.parse(JSON.parse(row.settings));if(!settings.autoSync||!row.sync_authorized||!this.options.plugins.storedAdmissionOpen(context.userId,pluginId(id)))return;
  const old=this.options.db.prepare('SELECT task_id FROM connector_timers WHERE user_id=? AND instance_id=?').get(context.userId,id),task=old?this.options.execution.engine.get(String(old.task_id)):undefined;
  if(task&&task.id!==currentTaskId&&task.ownership?.authorizationEpoch===context.authorizationEpoch&&['waiting','running'].includes(task.state))return;
  try{await this.submit(context,id,{action:'sync',recurring:true,due:Date.now()+settings.syncIntervalMs},'timer:'+randomUUID(),next=>{
   const prior=this.options.db.prepare('SELECT task_id FROM connector_timers WHERE user_id=? AND instance_id=?').get(context.userId,id),active=prior?this.options.execution.engine.get(String(prior.task_id)):undefined;
   if(active&&active.id!==currentTaskId&&active.id!==next.id&&active.ownership?.authorizationEpoch===context.authorizationEpoch&&['waiting','running'].includes(active.state))throw new ConnectorError('connector_timer_exists',409);
   this.options.db.prepare('INSERT INTO connector_timers VALUES(?,?,?) ON CONFLICT(user_id,instance_id) DO UPDATE SET task_id=excluded.task_id').run(context.userId,id,next.id);
  });}catch(error){if(!(error instanceof ConnectorError&&error.code==='connector_timer_exists'))throw error;}
 }
 private validateOperation(provider:string,operation:string,payload:Record<string,unknown>){
  const empty=z.object({}).strict();let schema:z.ZodType<Record<string,unknown>>|undefined;
  if(operation==='disconnect')schema=empty;
  else if(provider==='lark')schema=({configure:larkConfigureSchema,select:larkSelectionSchema,login:z.object({calendar:z.boolean().optional()}).strict(),'sync-document':z.object({document:z.string().min(1).max(4000)}).strict(),setup:empty,check:empty,calendars:empty,preview:empty} as Record<string,z.ZodType<Record<string,unknown>>>)[operation];
  else if(provider==='google-calendar')schema=operation==='select'?selectedCalendarsSchema:operation==='calendars'?empty:undefined;
  else if(['feishu-recordings','dingtalk-recordings'].includes(provider))schema=operation==='select'?recordingSelectionSchema:['login','connect','retry'].includes(operation)?empty:undefined;
  else schema=this.extensions.get(provider)?.operations?.[operation];
  try{if(!schema)throw Error();return schema.parse(payload);}catch{throw new ConnectorError('connector_operation_invalid',400);}
 }
 private clearOperationPayloads(userId:string,id:string){const prefix=id+':';this.options.db.prepare("DELETE FROM connector_secrets WHERE user_id=? AND substr(instance_id,1,?)=? AND substr(name,1,10)='operation:'").run(userId,prefix.length,prefix);}
 private operationPayload(run:TaskRun,input:ConnectorTask,row:Row,assert:()=>void){
  if(!input.payloadRef)return {};const saved=this.vault(run.context,row.id,assert).read<{taskId:string;operation:string;generation:number;snapshotId:string;payload:Record<string,unknown>}>('operation:'+input.payloadRef);
  if(!saved||saved.taskId!==run.task.id||saved.operation!==input.operation||saved.generation!==input.generation||saved.snapshotId!==input.snapshotId)throw new ConnectorError('connector_operation_credential_revoked',409);
  return this.validateOperation(connectionSchema.parse(JSON.parse(row.settings)).provider,input.operation!,saved.payload);
 }
 /** Upgrade only M10's earlier candidate receipts without dropping task history.
  * Raw operation inputs become owner/instance/epoch encrypted references before
  * the executor starts. Revoked incarnations never regain their old payload. */
 private migrateOperationPayloads(){this.tx(()=>{for(const task of this.options.db.prepare('SELECT t.task_id,t.user_id,t.input FROM user_tasks t JOIN execution_steps e ON e.id=t.task_id AND e.user_id=t.user_id WHERE e.kind=?').all(TASK)){
  const raw=JSON.parse(String(task.input));if(!Object.hasOwn(raw,'payload'))continue;const {payload,...metadata}=raw,step=this.options.execution.engine.get(String(task.task_id)),row=this.options.db.prepare('SELECT * FROM connector_connections WHERE user_id=? AND id=?').get(task.user_id,raw.connectionId) as Row|undefined;
  const active=row&&!row.removed&&row.generation===raw.generation&&step?.ownership&&step.ownership.userId===task.user_id&&!this.options.db.prepare('SELECT 1 FROM connector_domain_state WHERE user_id=? AND deleted=1').get(task.user_id),payloadRef=active&&payload&&Object.keys(payload).length?randomUUID():undefined,input=connectorTask.parse({...metadata,payloadRef});
  if(payloadRef){const vault=new ConnectorVault(this.options.db,this.options.directory,this.runtime.authority.deploymentId,String(task.user_id),row!.id+':'+row!.storage_generation+':'+step!.ownership!.authorizationEpoch,()=>{if(this.closed)throw new ScopeError('invalid_identity',401);});vault.write('operation:'+payloadRef,{taskId:String(task.task_id),operation:input.operation,generation:input.generation,snapshotId:input.snapshotId,payload});}
  const encoded=JSON.stringify(canonical(input));this.options.db.prepare('UPDATE user_tasks SET input=? WHERE user_id=? AND task_id=?').run(encoded,task.user_id,task.task_id);this.options.db.prepare('UPDATE execution_steps SET input=? WHERE user_id=? AND id=?').run(encoded,task.user_id,task.task_id);
 }});}
 private safeResult(value:unknown,lark=false){
  const json=JSON.stringify(value),status=lark&&value&&typeof value==='object'&&'selection' in value;
  if(json&&(status?Buffer.byteLength(json):json.length)<=24000)return value;
  // The owned status reader already exposes the complete durable Lark scope
  // and document journal. Keep the actual CLI probe/job in the task budget.
  if(status){const {selection:_,documentSync:__,...probe}=value as import('@mote/shared').LarkStatus,summary={...probe,statusInConnection:true};if(Buffer.byteLength(JSON.stringify(summary))>24000)throw new ConnectorError('connector_result_too_large',413);return summary;}
  return {completed:true};
 }
 private publicLarkStatus(context:UserContext,id:string,value:unknown){
  const status=value as import('@mote/shared').LarkStatus;if(!status?.documentSync?.sourceId)return value;
  this.assert(context);const row=this.options.db.prepare('SELECT source_id FROM connector_sources WHERE user_id=? AND instance_id=? AND local_id=?').get(context.userId,id,status.documentSync.sourceId);
  if(!row)throw new ConnectorError('connector_source_missing',404);
  return {...status,documentSync:{...status.documentSync,sourceId:String(row.source_id)}};
 }
 private oauthAdapter(adapter:Awaited<ReturnType<ScopedConnectors['adapter']>>){return adapter instanceof GmailAdapter||adapter instanceof GoogleCalendarConnector?adapter:'oauth' in adapter?adapter.oauth:undefined;}
 private async operation(adapter:Awaited<ReturnType<ScopedConnectors['adapter']>>,operation:string,payload:Record<string,unknown>,progress:(value:unknown)=>void=()=>{}){
  if(operation==='disconnect')return adapter.disconnect();
  if('operate' in adapter&&typeof adapter.operate==='function')return adapter.operate(operation,payload);
  if(adapter instanceof GoogleCalendarConnector){if(operation==='calendars')return adapter.calendars();if(operation==='select')return adapter.select(payload);}
  if(adapter instanceof LarkAdapter){
   if(operation==='setup'){adapter.startSetup();return adapter.wait();}if(operation==='check')return adapter.refresh();if(operation==='calendars')return adapter.calendars();if(operation==='select')return adapter.select(payload);if(operation==='configure'){adapter.configure(payload);return adapter.wait();}if(operation==='login'){adapter.login(z.object({calendar:z.boolean().optional()}).strict().parse(payload).calendar);return adapter.wait();}if(operation==='preview'){adapter.startPreview();return adapter.wait();}if(operation==='sync-document'){adapter.startSync(z.object({document:z.string().min(1).max(4000)}).strict().parse(payload).document);return adapter.wait();}
  }
  if(adapter instanceof ScopedRecordingAdapter){if(operation==='retry')return adapter.retry();if(operation==='login')return adapter.login(progress);if(operation==='connect')return adapter.connect();if(operation==='select')return adapter.select(payload);}
  throw new ConnectorError('connector_operation_invalid',400);
 }
 private async submit(context:UserContext,id:string,value:Partial<ConnectorTask>&{payload?:Record<string,unknown>},operationId:string,onAdmitted?:(task:{id:string})=>void){
  this.assert(context);const row=this.row(context.userId,id),created=!value.snapshotId,fingerprint=hash(canonical([row.generation,context.authorizationEpoch,value])),prior=()=>this.options.db.prepare('SELECT input_hash,task_id FROM connector_commands WHERE user_id=? AND instance_id=? AND operation_id=?').get(context.userId,id,operationId);
  const existing=prior();if(existing){if(existing.input_hash!==fingerprint)throw new ConnectorError('connector_command_conflict',409);return this.options.execution.forUser(context).get(String(existing.task_id));}
  let snapshotId=value.snapshotId;if(!snapshotId)snapshotId=(await this.options.plugins.forUser(context).admit(pluginId(id))).id;
  try{const {payload,...publicValue}=value,payloadRef=payload&&Object.keys(payload).length?randomUUID():undefined,input=connectorTask.parse({connectionId:id,generation:row.generation,snapshotId,...publicValue,payloadRef});this.binding(context,input);return await this.options.execution.forUser(context).submit({kind:TASK,operationId:'connector:'+id+':'+operationId,input},task=>{
   const current=prior();if(current)throw new ConnectorError(current.input_hash===fingerprint?'connector_command_exists':'connector_command_conflict',409);onAdmitted?.(task);if(payloadRef)this.vault(context,id,()=>this.binding(context,input)).write('operation:'+payloadRef,{taskId:task.id,operation:input.operation,generation:input.generation,snapshotId:input.snapshotId,payload});this.options.db.prepare('INSERT INTO connector_commands VALUES(?,?,?,?,?)').run(context.userId,id,operationId,fingerprint,task.id);
  });}catch(error){if(created)try{await this.options.plugins.forUser(context).release(snapshotId);}catch{}if(error instanceof ConnectorError&&error.code==='connector_command_exists'){this.assert(context);const current=prior();if(current?.input_hash===fingerprint)return this.options.execution.forUser(context).get(String(current.task_id));}throw error;}
 }
 available(){return [...this.packages.keys()].map(provider=>({provider,packageId:this.packages.get(provider)!}));}
 install(context:UserContext,provider:ConnectorProvider,input:unknown){return this.options.plugins.installBundled(context,this.packages.get(provider)!,input);}
 forUser(context:UserContext){
  this.assert(context);const settings=async()=>{let view=await this.options.configuration.forUser(context).view();this.assert(context);for(const row of this.options.db.prepare('SELECT operation_id,json FROM connector_restore WHERE user_id=? AND applied=0 ORDER BY rowid').all(context.userId)){const restored=connectorSettings.parse(JSON.parse(String(row.json)));view=await this.options.configuration.forUser(context).replace(CONFIG,restored,view.revision);this.assert(context);this.options.db.prepare('UPDATE connector_restore SET applied=1 WHERE user_id=? AND operation_id=?').run(context.userId,row.operation_id);}return {view,connections:(this.options.db.prepare('SELECT settings FROM connector_connections WHERE user_id=? AND removed=0 ORDER BY id').all(context.userId)).map(row=>connectionSchema.parse(JSON.parse(String(row.settings))))};};
  return Object.freeze({
   sourceStatuses:(sourceIds:readonly string[])=>{
    this.assert(context);const requested=new Set(z.array(sourceIdSchema).parse(sourceIds)),data=this.runtime.services.forUser(context).get<PrivateData>('private-data'),owned=data.sources().filter(source=>requested.has(source.id)).map(source=>source.id),result=new Map<string,NonNullable<SourceConnection['status']>>();
    // Read the real adapter ledger without opening an adapter, vault, activity,
    // model, network handle or authorization. Actual source IDs stay owner-bound.
    const rows=this.options.db.prepare("SELECT s.source_id,l.json FROM connector_sources s JOIN connector_connections c ON c.user_id=s.user_id AND c.id=s.instance_id JOIN connector_ledger l ON l.user_id=s.user_id AND l.instance_id=s.instance_id AND l.scope='source-status' AND l.key=s.local_id WHERE s.user_id=? AND c.removed=0 AND s.source_id IN(SELECT value FROM json_each(?)) ORDER BY s.source_id").all(context.userId,JSON.stringify(owned));
    for(const row of rows){const parsed=sourceStatusSchema.safeParse(JSON.parse(String(row.json)));if(!parsed.success)throw new ConnectorError('connector_status_invalid',502);result.set(String(row.source_id),parsed.data);}for(const reader of this.sourceStatusReaders)for(const [id,status] of reader(context,Object.freeze(owned))){if(!owned.includes(id)||result.has(id))throw new ConnectorError('connector_status_invalid',502);result.set(id,sourceStatusSchema.parse(status));}this.assert(context);return result;
   },
   view:async()=>{const {view}=await settings();return {revision:view.revision,providers:this.available(),connections:this.options.db.prepare('SELECT * FROM connector_connections WHERE user_id=? AND removed=0 ORDER BY id').all(context.userId).map(value=>{const row=value as Row;return {...publicSettings(connectionSchema.parse(JSON.parse(row.settings))),generation:row.generation,syncAuthorized:Boolean(row.sync_authorized)};})};},
   configure:async(value:unknown,expectedRevision:number)=>{const input=connectionSchema.parse(value);if(!this.packages.has(input.provider))throw new ConnectorError('connector_provider_unavailable');const {view,connections}=await settings();const existing=connections.find(c=>c.id===input.id);if(existing&&existing.provider!==input.provider)throw new ConnectorError('connector_provider_changed',409);if(view.revision!==expectedRevision)throw new ConnectorError('connector_configuration_changed',409);
    // M09 validates the installed fixed package before any settings enable work.
    const plugin=this.options.plugins.forUser(context),pv=await plugin.view();if(!pv.instances.some(i=>i.id===pluginId(input.id)))await plugin.configure({id:pluginId(input.id),packageId:this.packages.get(input.provider),name:input.provider,configuration:{},desired:false,grants:{capabilities:['source'],sourceIds:[],history:false}},pv.revision);
    const latest=await this.options.configuration.forUser(context).view();await this.options.configuration.forUser(context).replace(CONFIG,{connections:[...connections.filter(c=>c.id!==input.id),input]},latest.revision);return this.forUser(context).view();},
   action:async(id:string,action:'enable'|'pause'|'resume'|'stop',expectedRevision:number)=>{this.row(context.userId,id);const plugin=this.options.plugins.forUser(context),view=await plugin.view();if(view.revision!==expectedRevision)throw new ConnectorError('connector_configuration_changed',409);if(action==='enable'){await plugin.check(pluginId(id));return plugin.action(pluginId(id),'enable',(await plugin.view()).revision);}const result=await plugin.action(pluginId(id),action,expectedRevision);if(action==='stop'){this.abort(context.userId,id);this.options.db.prepare("UPDATE connector_oauth SET status='revoked' WHERE user_id=? AND instance_id=? AND status IN ('pending','ready')").run(context.userId,id);}return result;},
   status:async(id:string)=>{
    const row=this.row(context.userId,id),activity=this.activity(context,row);let result:unknown;
    try{
     const adapter=await activity.open(),value=await adapter.status();result=adapter instanceof LarkAdapter?this.publicLarkStatus(context,id,value):value;
     if(adapter instanceof LarkAdapter){
      const inventory=this.vault(context,id,activity.assert).read<{taskId:string;generation:number;items:unknown[]}>('calendar-inventory');
      if(inventory?.generation===row.generation)result={...result as object,calendarInventory:{taskId:inventory.taskId,items:inventory.items}};
     }
    }finally{await activity.finish();}
    activity.assert();return result;
   },
   start:async(id:string)=>{
    const row=this.row(context.userId,id),snapshot=await this.options.plugins.forUser(context).admit(pluginId(id)),input=connectorTask.parse({connectionId:id,generation:row.generation,snapshotId:snapshot.id,action:'oauth'}),activity=this.activity(context,row,()=>{this.binding(context,input);}),assert=activity.assert;
    try{const adapter=await activity.open(),oauth=this.oauthAdapter(adapter);if(!oauth)throw new ConnectorError('connector_oauth_unsupported');const result=await oauth.start();assert();const state=new URL(result.authorizationUrl).searchParams.get('state')!;this.options.db.prepare("INSERT INTO connector_oauth VALUES(?,?,?,?,?,?,'pending',NULL)").run(hash(state),context.userId,id,row.generation,snapshot.id,Date.now()+result.expiresIn*1000);const task=await this.submit(context,id,{...input,state},'oauth:'+hash(state));this.options.db.prepare('UPDATE connector_oauth SET task_id=? WHERE state_hash=?').run(task.id,hash(state));return {...result,taskId:task.id};}finally{await activity.finish();}
   },
   sync:(id:string,operationId:string)=>this.submit(context,id,{action:'sync',recurring:true},operationId,()=>{this.assert(context);this.options.db.prepare('UPDATE connector_connections SET sync_authorized=1 WHERE user_id=? AND id=?').run(context.userId,id);}),
   operation:(id:string,operation:string,payload:Record<string,unknown>,operationId:string)=>{this.assert(context);const row=this.row(context.userId,id);return this.submit(context,id,{action:'operation',operation,payload:this.validateOperation(connectionSchema.parse(JSON.parse(row.settings)).provider,operation,payload)},operationId);},
   disconnect:async(id:string,operationId:string)=>{this.assert(context);
    // An acknowledged-or-unknown existing command must pass the same input,
    // current-generation and account-epoch checks before any new retirement.
    if(this.options.db.prepare('SELECT 1 FROM connector_commands WHERE user_id=? AND instance_id=? AND operation_id=?').get(context.userId,id,operationId))return this.submit(context,id,{action:'operation',operation:'disconnect'},operationId);
    this.abort(context.userId,id);this.clearOperationPayloads(context.userId,id);this.options.db.prepare('UPDATE connector_connections SET generation=generation+1,sync_authorized=0 WHERE user_id=? AND id=? AND removed=0').run(context.userId,id);this.options.db.prepare("UPDATE connector_oauth SET status='revoked' WHERE user_id=? AND instance_id=? AND status IN ('pending','ready')").run(context.userId,id);return this.submit(context,id,{action:'operation',operation:'disconnect'},operationId);},
   forget:(id:string,sourceId:string,externalId:string,forgotten:boolean)=>{this.row(context.userId,id);const mapped=this.options.db.prepare('SELECT local_id FROM connector_sources WHERE user_id=? AND instance_id=? AND source_id=?').get(context.userId,id,sourceId);if(!mapped)throw new ConnectorError('connector_source_missing',404);const ledger=this.ledger(context,id,()=>this.assert(context));if(forgotten){ledger.set('forgotten:'+mapped.local_id,externalId,true);const data=this.runtime.services.forUser(context).get<PrivateData>('private-data');for(const item of data.sourceHistory(sourceId,externalId))data.deleteCapture(item.captureId);}else ledger.drop('forgotten:'+mapped.local_id,externalId);return {forgotten};},
   remove:async(id:string,expectedRevision:number)=>{this.row(context.userId,id);const {view,connections}=await settings();if(view.revision!==expectedRevision)throw new ConnectorError('connector_configuration_changed',409);const plugin=this.options.plugins.forUser(context);await plugin.action(pluginId(id),'stop',(await plugin.view()).revision);const current=await this.options.configuration.forUser(context).view();await this.options.configuration.forUser(context).replace(CONFIG,{connections:connections.filter(c=>c.id!==id)},current.revision);this.abort(context.userId,id);return {removed:true};},
  });
 }
 /** Callback deliberately ignores browser cookies. State's fixed stored task and
  * account, plus the current M09 generation, are the only completion authority. */
 async callback(state:string,code:string){
  z.string().min(20).max(200).parse(state);z.string().min(1).max(4096).parse(code);
  const saved=this.oauth(state);if(!saved||saved.status!=='pending'||saved.expires<=Date.now())throw new ConnectorError('connector_oauth_invalid',400);
  const row=this.row(saved.user_id,saved.instance_id),assert=()=>{if(this.closed||row.generation!==this.row(saved.user_id,saved.instance_id).generation)throw new ConnectorError('connector_oauth_revoked',400);this.options.plugins.assertStoredBinding(saved.user_id,saved.snapshot_id);};
  assert();if(row.generation!==saved.generation||!saved.task_id)throw new ConnectorError('connector_oauth_invalid',400);
  const vault=new ConnectorVault(this.options.db,this.options.directory,this.runtime.authority.deploymentId,saved.user_id,saved.instance_id+':'+row.storage_generation+':'+this.options.plugins.assertStoredBinding(saved.user_id,saved.snapshot_id),assert);
  this.tx(()=>{assert();const changed=this.options.db.prepare("UPDATE connector_oauth SET status='ready' WHERE state_hash=? AND status='pending' AND expires>?").run(hash(state),Date.now());if(!changed.changes)throw new ConnectorError('connector_oauth_invalid',400);vault.write('code:'+hash(state),code);});void this.options.execution.tick().catch(()=>{});return {accepted:true};
 }
 private readonly lifecycle:DomainLifecycle={
  // Personal archive import preserves live settings and operational authority.
  importUser:false,
  exportUser:async subject=>{this.runtime.services.assertSubject(subject,DOMAIN,'export');const rows=this.options.db.prepare('SELECT settings FROM connector_connections WHERE user_id=? AND removed=0 ORDER BY id').all(subject.userId);return {domain:DOMAIN,version:1,deploymentId:subject.deploymentId,userId:subject.userId,payload:{connections:rows.map(r=>{const {googleClientSecret:_secret,...settings}=connectionSchema.parse(JSON.parse(String(r.settings)));return settings;}),coverage:{settings:true,credentials:false,oauth:false,activeGrants:false,providerData:'ingress/private-data',restoreEnabled:false}}};},
  deleteUser:async(subject,operationId)=>this.serializeLifecycle(subject.userId,async()=>{this.runtime.services.assertSubject(subject,DOMAIN,'delete');this.tx(()=>{this.options.db.prepare('INSERT INTO connector_domain_state VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET deleted=1').run(subject.userId);this.options.db.prepare('UPDATE connector_connections SET generation=generation+1,removed=1,sync_authorized=0 WHERE user_id=? AND removed=0').run(subject.userId);});for(const row of this.options.db.prepare('SELECT id FROM connector_connections WHERE user_id=?').all(subject.userId))this.abort(subject.userId,String(row.id));
   // M05 remains responsible for the durable task records. Do not acknowledge
   // local erasure while a provider operation still retains this user's files.
   const pending=this.options.db.prepare('SELECT id FROM connector_activity WHERE user_id=?').all(subject.userId);if(pending.some(row=>this.activities.has(hash([subject.userId,row.id]))))return {status:'pending',operationId};if(pending.length)return {status:'result_unknown',operationId};
   if(this.options.db.prepare("SELECT 1 FROM connector_jobs o JOIN user_tasks t ON t.task_id=o.task_id AND t.user_id=o.user_id WHERE o.user_id=? AND t.external_state IN ('issued','unknown') LIMIT 1").get(subject.userId))return {status:'result_unknown',operationId};
   this.runtime.services.assertSubject(subject,DOMAIN,'delete');await rm(join(this.options.directory,'connectors',hash([subject.deploymentId,subject.userId])),{recursive:true,force:true});this.runtime.services.assertSubject(subject,DOMAIN,'delete');for(const table of ['connector_connections','connector_activity','connector_commands','connector_jobs','connector_timers','connector_secrets','connector_sources','connector_ledger','connector_oauth','connector_restore'])this.options.db.prepare('DELETE FROM '+table+' WHERE user_id=?').run(subject.userId);return {status:'complete',operationId};}),
  restoreUser:async(subject,archive,operationId)=>this.serializeLifecycle(subject.userId,async()=>{this.runtime.services.assertSubject(subject,DOMAIN,'restore');if(archive.domain!==DOMAIN||archive.version!==1||archive.userId!==subject.userId||archive.deploymentId!==subject.deploymentId)throw new ConnectorError('connector_restore_invalid');const payload=z.object({connections:z.array(connectionSchema.omit({googleClientSecret:true})),coverage:z.object({settings:z.literal(true),credentials:z.literal(false),oauth:z.literal(false),activeGrants:z.literal(false),providerData:z.literal('ingress/private-data'),restoreEnabled:z.literal(false)}).strict()}).strict().parse(archive.payload);connectorSettings.parse({connections:payload.connections});if(payload.connections.some(c=>!this.packages.has(c.provider)))throw new ConnectorError('connector_restore_invalid');this.tx(()=>{this.runtime.services.assertSubject(subject,DOMAIN,'restore');const prior=this.options.db.prepare('SELECT payload_hash FROM connector_restore WHERE user_id=? AND operation_id=?').get(subject.userId,operationId);if(prior){if(prior.payload_hash!==hash(payload))throw new ConnectorError('connector_restore_conflict',409);return;}if(this.options.db.prepare('SELECT 1 FROM connector_activity WHERE user_id=?').get(subject.userId)||this.options.db.prepare('SELECT 1 FROM connector_connections WHERE user_id=? AND removed=0').get(subject.userId))throw new ConnectorError('connector_restore_conflict',409);this.options.db.prepare('INSERT INTO connector_restore VALUES(?,?,?,?,0)').run(subject.userId,operationId,hash(payload),JSON.stringify({connections:payload.connections}));this.options.db.prepare('INSERT INTO connector_domain_state VALUES(?,0) ON CONFLICT(user_id) DO UPDATE SET deleted=0').run(subject.userId);});}),
 };
 close(){if(this.closing)return this.closing;this.closed=true;this.detachPlugin();this.detachOriginalProcessor();return this.closing=(async()=>{for(const group of this.active.values())for(const controller of group)controller.abort();await this.dispose();let deadline:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.allSettled([...this.activities.values()].map(row=>row.done)),new Promise<void>(resolve=>{deadline=setTimeout(resolve,5000);deadline.unref();})]);}finally{clearTimeout(deadline);}})();}
}
export type UserConnectors=ReturnType<ScopedConnectors['forUser']>;
