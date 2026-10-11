import {createHash,randomUUID} from 'node:crypto';
import {mkdir,chmod,open,readFile,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {memorySchema,type Memory} from './memory-schema.js';
import {MemoryProviderError,memoryProviderRecordSchema,memoryProviderNamespaceSchema,memoryProviderKeySchema,memoryProviderKey,type MemoryProvider,type MemoryProviderWrite,type MemoryProviderRead,type MemoryProviderRemove,type MemoryProviderSearch,type MemoryProviderRecord,type MemoryProviderHit,type MemoryProviderReceipt,type MemoryProviderHealth,type MemoryProviderNamespace} from './memory-provider-contract.js';

export const MEM0_OSS_RELEASE={version:'3.3.1',integrity:'sha512-R+T0rB8WNU4Eh8ClfZnD2BKjk7Q4MDx3XdLZMoUZ+S7dItpkpg3xkcGrKqk0COV0dyRrul/EYzkDWTr2D6YTag=='} as const;
export const mem0RuntimeConfigSchema=z.object({directory:z.string().refine(isAbsolute,'Provider directory must be absolute'),embedding:z.object({baseUrl:z.string().url(),apiKey:z.string().min(1),model:z.string().min(1),dimension:z.number().int().positive()}).strict()}).strict();
export type Mem0RuntimeConfig=z.infer<typeof mem0RuntimeConfigSchema>;
type SdkMemory=import('mem0ai/oss').Memory;
type SdkItem=import('mem0ai/oss').MemoryItem;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nsKey=(ns:MemoryProviderNamespace)=>JSON.stringify(memoryProviderNamespaceSchema.parse(ns));
const scope=(ns:MemoryProviderNamespace)=>({user_id:`mote-owner-${digest(ns.ownerId)}`,agent_id:`mote-instance-${digest(ns.instanceId)}`,run_id:`mote-binding-${digest(memoryProviderNamespaceSchema.parse(ns))}`});
const unavailable=()=>new MemoryProviderError('unavailable','Memory provider is unavailable');
const stamp=()=>new Date().toISOString();

/** Executes only in the owned worker. Mem0 stores reviewed literal text and
 * complete records; the journal stores identities and receipts, never a text mirror. */
export class Mem0MemoryRuntime implements MemoryProvider {
  private sdk?:SdkMemory;private journal?:DatabaseSync;private starting?:Promise<void>;private serial=Promise.resolve();private closed=false;private lockToken=randomUUID();private healthCache=new Map<string,MemoryProviderHealth>();
  constructor(private readonly config:Mem0RuntimeConfig){mem0RuntimeConfigSchema.parse(config);const url=new URL(config.embedding.baseUrl);if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new MemoryProviderError('invalid_record','Embedding transport requires loopback HTTP or HTTPS');}
  private async lock(){
    const path=join(this.config.directory,'provider.lock');
    for(let attempt=0;attempt<2;attempt++){
      try{const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify({pid:process.pid,token:this.lockToken}));}finally{await file.close();}return;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;let owner:{pid:number};try{owner=JSON.parse(await readFile(path,'utf8'));if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw unavailable();}catch{throw unavailable();}
        try{process.kill(owner.pid,0);throw unavailable();}catch(probe){if((probe as NodeJS.ErrnoException).code!=='ESRCH')throw unavailable();await unlink(path);}
      }
    }throw unavailable();
  }
  private async start(){
    if(this.closed)throw new MemoryProviderError('closed','Memory provider is closed');
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      await mkdir(this.config.directory,{recursive:true,mode:0o700});await chmod(this.config.directory,0o700);await this.lock();
      process.env.MEM0_TELEMETRY='false';process.env.MEM0_DIR=join(this.config.directory,'sdk-state');
      const {Memory:Sdk}=await import('mem0ai/oss');
      this.journal=new DatabaseSync(join(this.config.directory,'operations.db'));
      this.journal.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS provider_operations(namespace TEXT NOT NULL,op_id TEXT NOT NULL,digest TEXT NOT NULL,kind TEXT NOT NULL,key_json TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,PRIMARY KEY(namespace,op_id)); CREATE TABLE IF NOT EXISTS provider_records(namespace TEXT NOT NULL,memory_id TEXT NOT NULL,version INTEGER NOT NULL,fingerprint TEXT NOT NULL,external_id TEXT NOT NULL,digest TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(namespace,memory_id,version));');
      this.sdk=new Sdk({embedder:{provider:'openai',config:{apiKey:this.config.embedding.apiKey,baseURL:this.config.embedding.baseUrl,model:this.config.embedding.model,embeddingDims:this.config.embedding.dimension}},vectorStore:{provider:'memory',config:{collectionName:'mote_immutable_memories',dimension:this.config.embedding.dimension,dbPath:join(this.config.directory,'vectors.db')}},historyDbPath:join(this.config.directory,'history.db'),llm:{provider:'openai',config:{apiKey:'unused-in-literal-memory-adapter',baseURL:'http://127.0.0.1:1/v1',model:'unused-in-literal-memory-adapter'}}});
      for(const file of ['operations.db','vectors.db','history.db'])await chmod(join(this.config.directory,file),0o600);
    })();return this.starting;
  }
  private run<T>(operation:()=>Promise<T>):Promise<T>{const next=this.serial.then(async()=>{await this.start();return operation();});this.serial=next.then(()=>undefined,()=>undefined);return next;}
  private decode(item:SdkItem,ns:MemoryProviderNamespace):MemoryProviderRecord {
    const value=item.metadata?.mote_record;const parsed=memoryProviderRecordSchema.safeParse(value);
    if(!parsed.success||nsKey(parsed.data.namespace)!==nsKey(ns)||item.metadata?.mote_digest!==digest(parsed.data)||item.memory!==this.text(parsed.data.memory))throw new MemoryProviderError('invalid_record','Memory provider returned a record outside the declared immutable scope');
    return parsed.data;
  }
  private text(memory:Memory){return `${memory.title}\n${memory.statement}`;}
  private row(input:MemoryProviderRead){return this.journal!.prepare('SELECT * FROM provider_records WHERE namespace=? AND memory_id=? AND version=?').get(nsKey(input.namespace),input.key.memoryId,input.key.version);}
  private remember(record:MemoryProviderRecord,externalId:string){const prior=this.row(record);if(prior&&(prior.fingerprint!==record.key.fingerprint||prior.digest!==digest(record)||prior.removed))throw new MemoryProviderError('conflict','Immutable memory version already exists or was removed');this.journal!.prepare('INSERT INTO provider_records(namespace,memory_id,version,fingerprint,external_id,digest) VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,memory_id,version) DO UPDATE SET external_id=excluded.external_id').run(nsKey(record.namespace),record.key.memoryId,record.key.version,record.key.fingerprint,externalId,digest(record));}
  private intent(input:MemoryProviderRead&{opId:string},kind:'put'|'remove',requestDigest:string){
    if(!input.opId)throw new MemoryProviderError('invalid_record','Operation identity is required');
    const prior=this.journal!.prepare('SELECT digest,kind,receipt FROM provider_operations WHERE namespace=? AND op_id=?').get(nsKey(input.namespace),input.opId);
    if(prior){if(prior.digest!==requestDigest||prior.kind!==kind)throw new MemoryProviderError('conflict','Operation identity already names another request');if(prior.receipt)return JSON.parse(String(prior.receipt)) as MemoryProviderReceipt;}
    else this.journal!.prepare("INSERT INTO provider_operations(namespace,op_id,digest,kind,key_json,state) VALUES(?,?,?,?,?,'intent')").run(nsKey(input.namespace),input.opId,requestDigest,kind,JSON.stringify(input.key));
    return undefined;
  }
  private receipt(value:MemoryProviderReceipt){this.journal!.prepare('UPDATE provider_operations SET state=?,receipt=? WHERE namespace=? AND op_id=?').run(value.state,JSON.stringify(value),nsKey(value.namespace),value.opId);return value;}
  private async all(ns:MemoryProviderNamespace,extra:Record<string,string>={}){const filters={...scope(ns),mote_namespace:nsKey(ns),...extra};const total=this.journal!.prepare('SELECT count(*) total FROM provider_records WHERE namespace=?').get(nsKey(ns));const vectorDb=new DatabaseSync(join(this.config.directory,'vectors.db'),{readOnly:true});let count:number;try{count=Number(vectorDb.prepare('SELECT count(*) total FROM vectors').get()!.total);}finally{vectorDb.close();}return (await this.sdk!.getAll({filters,topK:Math.max(1,count,Number(total?.total??0)),showExpired:true})).results;}
  private async doPut(input:MemoryProviderWrite):Promise<MemoryProviderReceipt>{
    const record=memoryProviderRecordSchema.parse({namespace:input.namespace,key:input.key,memory:input.memory}),requestDigest=digest(record),done=this.intent({...record,opId:input.opId},'put',requestDigest);if(done)return done;
    const row=this.row(record);if(row&&(row.fingerprint!==record.key.fingerprint||row.digest!==requestDigest||row.removed))throw new MemoryProviderError('conflict','Immutable memory version already exists or was removed');
    const reconciled=await this.all(record.namespace,{mote_operation_id:input.opId});let externalId:string;
    if(reconciled.length){if(reconciled.length!==1||digest(this.decode(reconciled[0],record.namespace))!==requestDigest)throw new MemoryProviderError('unknown_result','External operation requires reconciliation');externalId=reconciled[0].id;}
    else if(row){const existing=await this.sdk!.get(String(row.external_id));if(!existing||digest(this.decode(existing,record.namespace))!==requestDigest)throw new MemoryProviderError('unknown_result','External record no longer matches the receipt');externalId=existing.id;}
    else {
      try{const ids=scope(record.namespace);const result=await this.sdk!.add(this.text(record.memory),{userId:ids.user_id,agentId:ids.agent_id,runId:ids.run_id,infer:false,metadata:{mote_namespace:nsKey(record.namespace),mote_operation_id:input.opId,mote_digest:requestDigest,mote_key:JSON.stringify(record.key),mote_record:record}});if(result.results.length!==1)throw unavailable();externalId=result.results[0].id;}
      catch{throw new MemoryProviderError('unknown_result','External write receipt is unknown; retry the same operation identity to reconcile');}
    }
    const written=await this.sdk!.get(externalId);if(!written||digest(this.decode(written,record.namespace))!==requestDigest)throw new MemoryProviderError('unknown_result','External write could not be verified');
    this.journal!.exec('BEGIN IMMEDIATE');try{this.remember(record,externalId);const value=this.receipt({opId:input.opId,namespace:record.namespace,key:record.key,payloadDigest:requestDigest,externalId,state:'applied',eraseVerified:false,recordedAt:stamp()});this.journal!.exec('COMMIT');return value;}catch(error){this.journal!.exec('ROLLBACK');throw error;}
  }
  put(input:MemoryProviderWrite){return this.run(()=>this.doPut(input));}
  read(input:MemoryProviderRead){return this.run(async()=>{memoryProviderNamespaceSchema.parse(input.namespace);const key=memoryProviderKeySchema.parse(input.key);const row=this.row(input);if(!row||row.removed)return null;if(row.fingerprint!==key.fingerprint)throw new MemoryProviderError('conflict','Memory fingerprint does not match its immutable version');const item=await this.sdk!.get(String(row.external_id));if(!item)throw new MemoryProviderError('unknown_result','Published external memory is missing');const record=this.decode(item,input.namespace);if(JSON.stringify(record.key)!==JSON.stringify(key)||digest(record)!==row.digest)throw new MemoryProviderError('invalid_record','External memory key does not match the host receipt');return record.memory;});}
  private async doRemove(input:MemoryProviderRemove):Promise<MemoryProviderReceipt>{
    input={...input,namespace:memoryProviderNamespaceSchema.parse(input.namespace),key:memoryProviderKeySchema.parse(input.key)};const requestDigest=digest({namespace:input.namespace,key:input.key,remove:true}),done=this.intent(input,'remove',requestDigest);if(done)return done;const row=this.row(input);if(row&&row.fingerprint!==input.key.fingerprint)throw new MemoryProviderError('conflict','Memory fingerprint does not match its immutable version');
    const externalId=row?.external_id?String(row.external_id):undefined;if(externalId){const before=await this.sdk!.get(externalId);if(before){const record=this.decode(before,input.namespace);if(record.key.memoryId!==input.key.memoryId||record.key.version!==input.key.version||record.key.fingerprint!==input.key.fingerprint||digest(record)!==row!.digest)throw new MemoryProviderError('invalid_record','Removal target does not match the host receipt');}try{if(before)await this.sdk!.delete(externalId);}catch{throw new MemoryProviderError('unknown_result','External removal receipt is unknown; retry the same operation identity');}if(await this.sdk!.get(externalId))throw new MemoryProviderError('unknown_result','External current memory removal could not be verified');}
    this.journal!.exec('BEGIN IMMEDIATE');try{if(row)this.journal!.prepare('UPDATE provider_records SET removed=1 WHERE namespace=? AND memory_id=? AND version=?').run(nsKey(input.namespace),input.key.memoryId,input.key.version);else this.journal!.prepare('INSERT INTO provider_records(namespace,memory_id,version,fingerprint,external_id,digest,removed) VALUES(?,?,?,?,?,?,1)').run(nsKey(input.namespace),input.key.memoryId,input.key.version,input.key.fingerprint,'','');const value=this.receipt({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:requestDigest,externalId,state:'removed',currentRemoved:true,historyRetained:Boolean(externalId),eraseVerified:false,recordedAt:stamp()});this.journal!.exec('COMMIT');return value;}catch(error){this.journal!.exec('ROLLBACK');throw error;}
  }
  remove(input:MemoryProviderRemove){return this.run(()=>this.doRemove(input));}
  search(input:MemoryProviderSearch){return this.run(async()=>{memoryProviderNamespaceSchema.parse(input.namespace);if(!input.query.trim()||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||input.limit<1))throw new MemoryProviderError('invalid_record','Invalid memory search');const keys=input.keys?.map(key=>JSON.stringify(memoryProviderKeySchema.parse(key)));if(keys?.length===0)return [];const found=await this.sdk!.search(input.query,{filters:{...scope(input.namespace),mote_namespace:nsKey(input.namespace),...(keys?{mote_key:{in:keys}}:{})},...(input.limit===undefined?{}:{topK:input.limit}),showExpired:true});const hits:MemoryProviderHit[]=[];for(const item of found.results){const record=this.decode(item,input.namespace),row=this.row(record);if(!row||row.removed||row.external_id!==item.id||row.digest!==digest(record)||keys&&!keys.includes(JSON.stringify(record.key)))continue;hits.push({...record,...(item.score===undefined?{}:{score:item.score})});}return hits;});}
  export(input:{namespace:MemoryProviderNamespace}){return this.run(async()=>{memoryProviderNamespaceSchema.parse(input.namespace);const records:MemoryProviderRecord[]=[];for(const item of await this.all(input.namespace)){const record=this.decode(item,input.namespace),row=this.row(record);if(row&&!row.removed&&row.external_id===item.id&&row.digest===digest(record))records.push(record);}return records;});}
  health(input:{namespace:MemoryProviderNamespace}){return this.run(async()=>this.healthCache.get(nsKey(input.namespace))??{providerId:'mem0-oss',version:MEM0_OSS_RELEASE.version,ready:false,verified:{persistentCrud:false,scopedRetrieval:false,immutableRecords:false,idempotentReplay:false,history:false,physicalErase:false},problems:['Capability probe has not run; call recover during explicit configuration validation']});}
  recover(input:{namespace:MemoryProviderNamespace}){return this.run(async()=>{
    const ns=memoryProviderNamespaceSchema.parse(input.namespace),problems:string[]=[];
    for(const operation of this.journal!.prepare("SELECT op_id,kind,key_json,digest FROM provider_operations WHERE namespace=? AND state='intent'").all(nsKey(ns))){
      if(operation.kind==='put'){const found=await this.all(ns,{mote_operation_id:String(operation.op_id)});if(found.length===1){const record=this.decode(found[0],ns);if(digest(record)===operation.digest){this.remember(record,found[0].id);this.receipt({opId:String(operation.op_id),namespace:ns,key:record.key,payloadDigest:String(operation.digest),externalId:found[0].id,state:'applied',eraseVerified:false,recordedAt:stamp()});}else problems.push('Pending write has a mismatched external digest');}else if(found.length>1)problems.push('Pending write has multiple external matches');else problems.push('Pending write has no external receipt; retry its original request');}
      else await this.doRemove({namespace:ns,key:memoryProviderKeySchema.parse(JSON.parse(String(operation.key_json))),opId:String(operation.op_id)});
    }
    const probeNs={...ns,instanceId:`${ns.instanceId}:health:${randomUUID()}`},id=randomUUID(),evidenceId=randomUUID(),now=stamp();
    const memory:Memory=memorySchema.parse({id,version:1,domain:'personal',tier:'episode',kind:'episodic',title:'Generated capability fixture',statement:'A violet telescope is reserved for the synthetic observatory.',uncertainty:'Generated test evidence only',evidenceIds:[evidenceId],evidence:[],createdAt:now,status:'proposed',model:'fixture',runId:'fixture',fingerprint:digest(id),admission:{layer:'memory',reason:'Generated capability probe',scope:'Generated capability probe only',attribution:'observed'}});
    const record={namespace:probeNs,key:memoryProviderKey(memory),memory},opId=randomUUID();let verified={persistentCrud:false,scopedRetrieval:false,immutableRecords:false,idempotentReplay:false,history:false,physicalErase:false};
    try{const receipt=await this.doPut({...record,opId}),again=await this.doPut({...record,opId});const stored=await this.sdk!.get(receipt.externalId!);verified.persistentCrud=Boolean(stored)&&digest(this.decode(stored!,probeNs))===digest(record);verified.idempotentReplay=receipt.externalId===again.externalId;let rejects=false;try{await this.doPut({...record,opId,memory:{...memory,statement:'Changed immutable fixture'}});}catch(error){rejects=error instanceof MemoryProviderError&&error.code==='conflict';}verified.immutableRecords=rejects;const found=await this.sdk!.search('Which instrument observes stars?',{filters:{...scope(probeNs),mote_namespace:nsKey(probeNs)},topK:1});const absent=await this.sdk!.getAll({filters:{...scope({...probeNs,bindingRevision:probeNs.bindingRevision+1}),mote_namespace:nsKey(probeNs)},topK:1});verified.scopedRetrieval=found.results.some(x=>x.id===receipt.externalId)&&absent.results.length===0;await this.doRemove({namespace:probeNs,key:record.key,opId:randomUUID()});verified.persistentCrud=verified.persistentCrud&&(await this.sdk!.get(receipt.externalId!))===null;verified.history=(await this.sdk!.history(receipt.externalId!)).some(x=>x.action==='DELETE');}
    catch{problems.push('Generated capability probe failed');}
    const ready=problems.length===0&&verified.persistentCrud&&verified.scopedRetrieval&&verified.immutableRecords&&verified.idempotentReplay&&verified.history;
    const result={providerId:'mem0-oss',version:MEM0_OSS_RELEASE.version,ready,verified,problems};this.healthCache.set(nsKey(ns),result);return result;
  });}
  async close(){await this.serial;if(this.closed)return;this.closed=true;this.journal?.close();this.journal=undefined;try{const path=join(this.config.directory,'provider.lock'),owner=JSON.parse(await readFile(path,'utf8'));if(owner.token===this.lockToken)await unlink(path);}catch{} }
}
