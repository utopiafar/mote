import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {z} from 'zod';
import type {CaptureRecord,QueryResult,TokenUsage} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import {memorySchema,type Memory} from './memory-schema.js';
import {claimSchema} from './memory.js';
import {memoryProviderRecordSchema,memoryProviderNamespaceSchema,memoryProviderKeySchema,memoryProviderKey,MemoryProviderError,type MemoryProvider,type MemoryProviderNamespace,type MemoryProviderKey,type MemoryProviderRecord,type MemoryProviderWrite,type MemoryProviderRead,type MemoryProviderRemove,type MemoryProviderSearch,type MemoryProviderReceipt,type MemoryProviderHealth,type MemoryProviderHit} from './memory-provider-contract.js';
import {HindsightService,ManagedHindsightRuntime,HINDSIGHT_VERSION,hindsightDigest,type HindsightRuntime,type HindsightModelCallbacks} from './hindsight-runtime.js';

export type HindsightEvidence=CaptureRecord|{record:CaptureRecord;offset:number;length:number};
export type HindsightPrepare={namespace:MemoryProviderNamespace;opId:string;phase:'extract'|'integrate';evidence:HindsightEvidence[];relatedMemories?:Memory[];signal?:AbortSignal};
const entrySchema=z.object({namespace:memoryProviderNamespaceSchema,key:memoryProviderKeySchema,bank:z.string(),digest:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['intent','applied','removed']),operationId:z.string().optional()}).strict();
const projectionSchema=z.object({namespace:memoryProviderNamespaceSchema,bank:z.string(),keys:z.array(memoryProviderKeySchema),state:z.enum(['intent','ready'])}).strict();
const receiptSchema=z.object({opId:z.string(),namespace:memoryProviderNamespaceSchema,key:memoryProviderKeySchema,payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),externalId:z.string().optional(),state:z.enum(['applied','removed','unknown']),currentRemoved:z.boolean().optional(),historyRetained:z.boolean().optional(),eraseVerified:z.boolean(),recordedAt:z.string()}).strict();
const journalSchema=z.object({opId:z.string().min(1),kind:z.enum(['put','remove']),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),receipt:receiptSchema.optional()}).strict();
const preparedSchema=z.object({namespace:memoryProviderNamespaceSchema,bank:z.string(),opId:z.string(),phase:z.enum(['extract','integrate']),keys:z.array(memoryProviderKeySchema).optional(),evidenceIds:z.array(z.string()).optional()}).strict();
const stateSchema=z.object({version:z.literal(1),entries:z.array(entrySchema),operations:z.array(journalSchema).default([]),projections:z.array(projectionSchema),prepared:z.array(preparedSchema),proof:z.object({version:z.literal(HINDSIGHT_VERSION),verifiedAt:z.string(),engine:z.boolean(),physicalErase:z.boolean()}).strict().optional()}).strict();
type State=z.infer<typeof stateSchema>;
const same=(a:unknown,b:unknown)=>hindsightDigest(a)===hindsightDigest(b);
const keyTag=(key:MemoryProviderKey)=>'mote:key:'+hindsightDigest(key);
function operationUuid(value:unknown){const h=hindsightDigest(value);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
function recordMetadata(record:MemoryProviderRecord){return {mote_record:JSON.stringify(record),mote_digest:hindsightDigest(record),mote_key:JSON.stringify(record.key)};}
function fromFact(fact:any):MemoryProviderRecord{
  try{const record=memoryProviderRecordSchema.parse(JSON.parse(fact.metadata.mote_record));if(fact.metadata.mote_digest!==hindsightDigest(record)||fact.text!==record.memory.statement)throw Error();return record;}
  catch{throw new MemoryProviderError('invalid_record','Hindsight canonical record metadata or body is inconsistent');}
}
function document(record:MemoryProviderRecord){
  // Raw expansion can read only reviewed exact excerpts, never the rest of an
  // original source that was not included in this immutable canonical record.
  const quotes=record.memory.evidence.filter(item=>item.quote).map(item=>`[${item.id}] ${item.quote}`).join('\n\n');
  return {id:'mote-'+hindsightDigest(record.key),original_text:quotes,tags:[keyTag(record.key)],created_at:record.memory.createdAt,chunks:[{chunk_index:0,chunk_text:quotes}],facts:[{text:record.memory.statement,fact_type:'world',chunk_index:0,mentioned_at:record.memory.createdAt,metadata:recordMetadata(record),tags:[keyTag(record.key)],entities:[]}]};
}

/** The native engine owns extraction and integration, while Mote still reviews
 * its proposals. Reviewed canonical text is imported verbatim without retain.
 * Immutable key banks and private read banks prevent native expand/reflect
 * from reaching staging, retired versions, or facts outside the host snapshot. */
export class HindsightEngine implements MemoryProvider {
  private state:State={version:1,entries:[],operations:[],projections:[],prepared:[]};
  private loaded?:Promise<void>;
  private tail=Promise.resolve();
  private closed=false;
  private running=new Map<string,AbortController>();
  private probeNamespaces=new Set<string>();
  constructor(private options:{directory:string;runtime:HindsightRuntime;model?:string}){}
  private load(){return this.loaded??=(async()=>{await mkdir(this.options.directory,{recursive:true,mode:0o700});try{this.state=stateSchema.parse(JSON.parse(await readFile(join(this.options.directory,'provider-control.json'),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new MemoryProviderError('unavailable','Hindsight provider metadata requires recovery');}})();}
  private async save(){const path=join(this.options.directory,'provider-control.json');await writeFile(path+'.pending',JSON.stringify(this.state),{mode:0o600});await rename(path+'.pending',path);}
  private async operation(opId:string,kind:'put'|'remove',input:unknown){
    if(!opId)throw new MemoryProviderError('invalid_record','A host-issued operation ID is required');const inputDigest=hindsightDigest(input),prior=this.state.operations.find(item=>item.opId===opId);
    if(prior){if(prior.kind!==kind||prior.inputDigest!==inputDigest)throw new MemoryProviderError('conflict','Hindsight operation ID is already bound to a different request');return prior;}
    const operation={opId,kind,inputDigest};this.state.operations.push(operation);await this.save();return operation as z.infer<typeof journalSchema>;
  }
  private async receipt(operation:z.infer<typeof journalSchema>,receipt:MemoryProviderReceipt){operation.receipt=receiptSchema.parse(receipt);await this.save();return structuredClone(operation.receipt);}
  private work<T>(task:()=>Promise<T>):Promise<T>{if(this.closed)return Promise.reject(new MemoryProviderError('closed','Hindsight provider is closed'));const result=this.tail.then(async()=>{await this.load();return task();});this.tail=result.then(()=>{},()=>{});return result;}
  private async worker<T>(task:(service:HindsightService,signal:AbortSignal)=>Promise<T>,opId:string,banks:string[],externalSignal?:AbortSignal,probe=false):Promise<T>{
    externalSignal?.throwIfAborted();const controller=new AbortController(),abort=()=>controller.abort(externalSignal?.reason);externalSignal?.addEventListener('abort',abort,{once:true});this.running.set(opId,controller);
    try{this.options.runtime.setOperation?.(opId,probe?'capability_probe':'operation');const service=await this.options.runtime.service();await this.options.runtime.startWorker(banks);controller.signal.throwIfAborted();const failure=this.options.runtime.workerFailed?.();return await (failure?Promise.race([task(service,controller.signal),failure]):task(service,controller.signal));}
    catch(error){controller.abort(error);throw error;}
    finally{externalSignal?.removeEventListener('abort',abort);await this.options.runtime.stopWorker(controller.signal.aborted);this.options.runtime.setOperation?.(undefined);this.running.delete(opId);}
  }
  /** Stops only the serialized operation's owned worker. A cancellation receipt
   * is never published as proof of erase or instantaneous native cancellation. */
  stopOperation(opId:string){this.running.get(opId)?.abort(new Error('Hindsight operation stopped'));}
  private bank(namespace:MemoryProviderNamespace,key:MemoryProviderKey){return 'mote-canonical-'+hindsightDigest([namespace,key]).slice(0,40);}
  private async facts(service:HindsightService,bank:string){try{return await service.memories(bank);}catch(error){if(error instanceof MemoryProviderError&&error.code==='unavailable'){const banks=await service.request<any>('GET','/v1/default/banks');if(!(banks.banks??banks).some((item:any)=>item.bank_id===bank||item.id===bank))return [];}throw error;}}
  private async import(service:HindsightService,bank:string,records:MemoryProviderRecord[],signal:AbortSignal,entry?:z.infer<typeof entrySchema>){
    const files:Record<string,Uint8Array>={'manifest.json':strToU8(JSON.stringify({schema_version:1,source_bank_id:bank,archive_type:'documents',document_count:records.length,fact_count:records.length}))};
    records.forEach((record,index)=>files['documents/'+String(index).padStart(6,'0')+'.json']=strToU8(JSON.stringify(document(record))));
    const form=new FormData();form.append('file',new Blob([new Uint8Array(zipSync(files))]),'mote-canonical.zip');
    // Import has no client idempotency UUID. Durable intent and immutable
    // document IDs precede submission; skip-conflict replay is reconciled by
    // reading the exact record digest, never by retrying semantic retain.
    const receipt=await service.request<{operation_id:string}>('POST',service.bankPath(bank)+'/transfer/import?mode=merge&document_conflict=skip',form,signal);
    if(entry){entry.operationId=receipt.operation_id;await this.save();}
    await service.wait(bank,receipt.operation_id,signal);
  }
  async put(input:MemoryProviderWrite):Promise<MemoryProviderReceipt>{return this.work(async()=>{
    const record=memoryProviderRecordSchema.parse({namespace:input.namespace,key:input.key,memory:input.memory}),digest=hindsightDigest(record);
    const operation=await this.operation(input.opId,'put',record);if(operation.receipt)return structuredClone(operation.receipt);
    let entry=this.state.entries.find(entry=>same(entry.namespace,record.namespace)&&same(entry.key,record.key));
    if(entry&&entry.digest!==digest)throw new MemoryProviderError('conflict','Immutable Hindsight key already has different content');
    if(entry?.state==='removed')throw new MemoryProviderError('conflict','Removed immutable Hindsight key cannot be recreated');
    if(!entry){entry={namespace:record.namespace,key:record.key,bank:this.bank(record.namespace,record.key),digest,state:'intent'};this.state.entries.push(entry);await this.save();}
    const owned=entry;
    if(owned.state==='applied'){
      const service=await this.options.runtime.service(),facts=await service.memories(owned.bank);
      if(facts.length!==1||!same(fromFact(facts[0]),record))throw new MemoryProviderError('invalid_record','Hindsight immutable replay differs');
      return this.receipt(operation,{opId:input.opId,namespace:record.namespace,key:record.key,payloadDigest:digest,externalId:owned.bank,state:'applied',eraseVerified:false,recordedAt:new Date().toISOString()});
    }
    await this.worker(async(service,signal)=>{
      await service.bank(owned.bank);
      let facts=await service.memories(owned.bank);
      if(!facts.length){
        // An ACK lost before operationId was saved still leaves an observable
        // import in this one-key bank. Observe it before considering replay.
        for(const op of await service.operations(owned.bank))if(['pending','processing'].includes(op.status))await service.wait(owned.bank,op.id??op.operation_id,signal);
        facts=await service.memories(owned.bank);
        if(!facts.length)await this.import(service,owned.bank,[record],signal,owned);
        facts=await service.memories(owned.bank);
      }
      if(facts.length!==1||!same(fromFact(facts[0]),record))throw new MemoryProviderError('invalid_record','Hindsight did not preserve the exact canonical record');
      owned.state='applied';await this.save();
    },input.opId,[owned.bank],undefined,this.probeNamespaces.has(hindsightDigest(record.namespace)));
    return this.receipt(operation,{opId:input.opId,namespace:record.namespace,key:record.key,payloadDigest:digest,externalId:owned.bank,state:'applied',eraseVerified:false,recordedAt:new Date().toISOString()});
  });}
  async read(input:MemoryProviderRead):Promise<Memory|null>{return this.work(async()=>{
    const entry=this.state.entries.find(entry=>same(entry.namespace,input.namespace)&&same(entry.key,input.key));if(!entry||entry.state==='removed')return null;
    const service=await this.options.runtime.service(),facts=await service.memories(entry.bank);
    if(!facts.length)return null;
    if(facts.length!==1)throw new MemoryProviderError('invalid_record','Hindsight immutable bank has unexpected records');
    const record=fromFact(facts[0]);if(!same(record.namespace,input.namespace)||!same(record.key,input.key)||entry.digest!==hindsightDigest(record))throw new MemoryProviderError('invalid_record','Hindsight record escaped its host namespace');return record.memory;
  });}
  async remove(input:MemoryProviderRemove):Promise<MemoryProviderReceipt>{return this.work(async()=>{
    const request={namespace:memoryProviderNamespaceSchema.parse(input.namespace),key:memoryProviderKeySchema.parse(input.key)},operation=await this.operation(input.opId,'remove',request);if(operation.receipt)return structuredClone(operation.receipt);
    const service=await this.options.runtime.service(),entry=this.state.entries.find(entry=>same(entry.namespace,input.namespace)&&same(entry.key,input.key));
    // Projection revocation is persisted before external deletion. A crashed
    // erase remains pending and cannot make that private read-bank usable.
    const projections=this.state.projections.filter(item=>same(item.namespace,input.namespace)&&item.keys.some(key=>same(key,input.key)));
    const prepared=this.state.prepared.filter(item=>same(item.namespace,input.namespace)&&(!item.keys||item.keys.some(key=>same(key,input.key))));
    for(const item of projections)item.state='intent';if(entry)entry.state='removed';await this.save();
    for(const item of projections)await service.request('DELETE',service.bankPath(item.bank),undefined,undefined,true);
    for(const item of prepared){await service.cancelBank(item.bank);await service.request('DELETE',service.bankPath(item.bank),undefined,undefined,true);}
    this.state.projections=this.state.projections.filter(item=>!projections.includes(item));
    this.state.prepared=this.state.prepared.filter(item=>!prepared.includes(item));
    if(entry)await service.request('DELETE',service.bankPath(entry.bank),undefined,undefined,true);await this.save();
    const banks=await service.request<any>('GET','/v1/default/banks'),exists=(banks.banks??banks).some((bank:any)=>bank.bank_id===entry?.bank||bank.id===entry?.bank||[...projections,...prepared].some(item=>item.bank===bank.bank_id||item.bank===bank.id));
    if(exists)throw new MemoryProviderError('unknown_result','Hindsight erase is still pending');
    return this.receipt(operation,{opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:entry?.digest??hindsightDigest(request),externalId:entry?.bank,state:'removed',currentRemoved:true,historyRetained:this.state.entries.some(item=>same(item.namespace,input.namespace)&&item.key.memoryId===input.key.memoryId&&item.state==='applied'),eraseVerified:false,recordedAt:new Date().toISOString()});
  });}
  private async records(namespace:MemoryProviderNamespace,keys?:MemoryProviderKey[]){
    const service=await this.options.runtime.service(),records:MemoryProviderRecord[]=[];
    for(const entry of this.state.entries.filter(entry=>entry.state==='applied'&&same(entry.namespace,namespace)&&(!keys||keys.some(key=>same(key,entry.key))))){const facts=await service.memories(entry.bank);if(facts.length!==1)throw new MemoryProviderError('invalid_record','Hindsight canonical record is missing');const record=fromFact(facts[0]);if(!same(record.namespace,namespace)||!same(record.key,entry.key)||hindsightDigest(record)!==entry.digest)throw new MemoryProviderError('invalid_record','Hindsight canonical identity differs');records.push(record);}
    return records;
  }
  private async projection(namespace:MemoryProviderNamespace,records:MemoryProviderRecord[],opId:string,signal?:AbortSignal){
    const sorted=records.map(record=>memoryProviderRecordSchema.parse(record)).sort((a,b)=>hindsightDigest(a.key).localeCompare(hindsightDigest(b.key)));
    if(sorted.some(record=>!same(record.namespace,namespace)))throw new MemoryProviderError('invalid_record','Read-bank record is outside the authorized namespace');
    const bank='mote-read-'+hindsightDigest([namespace,sorted.map(record=>[record.key,hindsightDigest(record)])]).slice(0,40);
    let projection=this.state.projections.find(item=>item.bank===bank);
    if(projection?.state==='ready')return bank;
    if(!projection){projection={namespace,bank,keys:sorted.map(record=>record.key),state:'intent'};this.state.projections.push(projection);await this.save();}
    await this.worker(async(service,internalSignal)=>{await service.bank(bank);for(const op of await service.operations(bank))if(['pending','processing'].includes(op.status))await service.wait(bank,op.id??op.operation_id,internalSignal);if((await service.memories(bank)).length!==sorted.length)await this.import(service,bank,sorted,internalSignal);const facts=await service.memories(bank);if(facts.length!==sorted.length||facts.some(fact=>!sorted.some(record=>same(record,fromFact(fact)))))throw new MemoryProviderError('invalid_record','Hindsight read-bank snapshot is inconsistent');projection!.state='ready';await this.save();},opId,[bank],signal,this.probeNamespaces.has(hindsightDigest(namespace)));
    return bank;
  }
  async search(input:MemoryProviderSearch):Promise<MemoryProviderHit[]>{return this.work(async()=>{
    const records=await this.records(input.namespace,input.keys);if(!records.length)return [];
    // Authorization and pinned revisions are selected before native ranking.
    const bank=await this.projection(input.namespace,records,'search:'+randomUUID()),service=await this.options.runtime.service();
    const result=await service.request<any>('POST',service.bankPath(bank)+'/memories/recall',{query:input.query,types:['world'],budget:'high',max_tokens:100_000});
    return (result.results??[]).map((fact:any)=>{const record=fromFact(fact);if(!records.some(item=>same(item,record)))throw new MemoryProviderError('invalid_record','Recall returned a fact outside its frozen read bank');return {...record,...(typeof fact.score==='number'?{score:fact.score}:{})};}).slice(0,input.limit??20);
  });}
  async export(input:{namespace:MemoryProviderNamespace}){return this.work(()=>this.records(input.namespace));}
  async prepare(input:HindsightPrepare):Promise<QueryResult>{return this.work(async()=>{
    input.signal?.throwIfAborted();memoryProviderNamespaceSchema.parse(input.namespace);
    const ranges=input.evidence.map(item=>{const record='record' in item?item.record:item,offset='record' in item?item.offset:0,length='record' in item?item.length:record.ocrText.length,text=record.ocrText.slice(offset,offset+length);if(!Number.isInteger(offset)||offset<0||!Number.isInteger(length)||length<1||offset+length>record.ocrText.length||text.length>12000)throw new MemoryProviderError('invalid_record','Supply a bounded exact original evidence range to Hindsight');return {record,offset,length,text};});
    if(!ranges.length)throw new MemoryProviderError('invalid_record','Engine preparation requires original evidence');
    const parents=(input.relatedMemories??[]).map(memory=>memorySchema.parse(memory));
    if(input.phase==='integrate'&&!parents.length)throw new MemoryProviderError('invalid_record','Integration requires frozen canonical parent memories');
    if(parents.some(memory=>memory.evidenceIds.some(id=>!ranges.some(range=>range.record.id===id))))throw new MemoryProviderError('invalid_record','Integration requires every supplied parent original');
    const bank='mote-stage-'+hindsightDigest([input.namespace,input.opId,input.phase,ranges.map(range=>[range.record.id,range.offset,range.text]),parents.map(memory=>memoryProviderKey(memory))]).slice(0,40);
    if(!this.state.prepared.some(item=>item.bank===bank)){this.state.prepared.push({namespace:input.namespace,bank,opId:input.opId,phase:input.phase,keys:parents.map(memoryProviderKey),evidenceIds:[...new Set(ranges.map(range=>range.record.id))]});await this.save();}
    return this.worker(async(service,signal)=>{
      await service.bank(bank,input.phase==='integrate');
      if(parents.length&&!((await service.memories(bank)).some(fact=>fact.metadata?.mote_record)))await this.import(service,bank,parents.map(memory=>({namespace:input.namespace,key:memoryProviderKey(memory),memory})),signal);
      const operationId=operationUuid([bank,'retain']);
      await service.request('POST',service.bankPath(bank)+'/memories',{async:true,operation_id:operationId,items:ranges.map(range=>({content:range.text,document_id:'source-'+hindsightDigest([range.record.id,range.offset,range.length]),timestamp:range.record.capturedAt,metadata:{mote_source_id:range.record.id,mote_offset:String(range.offset),mote_length:String(range.length)},tags:['mote:stage']}))},signal);
      await service.wait(bank,operationId,signal);
      if(input.phase==='integrate'){
        const completed=(await service.operations(bank)).find(op=>op.task_type==='consolidation'&&op.status==='completed');
        if(!completed){const result=await service.request<{operation_id:string}>('POST',service.bankPath(bank)+'/consolidate',{},signal);await service.wait(bank,result.operation_id,signal);}
      }
      const facts=await service.memories(bank),byId=new Map(facts.map(fact=>[fact.id,fact]));
      const selected=facts.filter(fact=>input.phase==='integrate'?fact.fact_type==='observation':fact.fact_type!=='observation'&&!fact.metadata?.mote_record);
      const candidates=selected.map(fact=>{
        const sources=input.phase==='integrate'?(fact.source_memory_ids??[]).map((id:string)=>byId.get(id)): [fact];
        if(!sources.length||sources.some((source:any)=>!source))throw new MemoryProviderError('invalid_record','Native observation lineage is incomplete');
        const evidence=new Map<string,{id:string;offset:number;length:number;quote:string}>(),related=new Set<string>();
        for(const source of sources){
          if(source.metadata?.mote_record){const parent=fromFact(source).memory;if(!parents.some(memory=>same(memoryProviderKey(memory),memoryProviderKey(parent))))throw new MemoryProviderError('invalid_record','Observation refers to an unsupplied parent');related.add(parent.id);for(const quote of parent.evidence){if(!quote.quote||quote.offset===undefined)throw new MemoryProviderError('invalid_record','Parent needs exact original provenance');const range=ranges.find(range=>range.record.id===quote.id&&range.record.ocrText.slice(quote.offset!,quote.offset!+quote.quote!.length)===quote.quote&&range.offset<=quote.offset!&&range.offset+range.length>=quote.offset!+quote.quote!.length);if(!range)throw new MemoryProviderError('invalid_record','Parent quote is outside the bounded originals');evidence.set(hindsightDigest([quote.id,quote.offset,quote.quote]),{id:quote.id,offset:quote.offset,length:quote.quote.length,quote:quote.quote});}}
          else{const range=ranges.find(range=>range.record.id===source.metadata?.mote_source_id&&String(range.offset)===source.metadata?.mote_offset);if(!range)throw new MemoryProviderError('invalid_record','Native fact has no supplied original provenance');evidence.set(hindsightDigest([range.record.id,range.offset]),{id:range.record.id,offset:range.offset,length:range.length,quote:range.text});for(const parent of parents)if(parent.evidenceIds.includes(range.record.id))related.add(parent.id);}
        }
        const evidenceIds=[...new Set([...evidence.values()].map(quote=>quote.id))];
        if(input.phase==='integrate'&&!related.size)throw new MemoryProviderError('invalid_record','Native observation has no canonical parent lineage');
        return claimSchema.parse({title:fact.text.slice(0,160),statement:fact.text+'\n'+evidenceIds.map(id=>'['+id+']').join(' '),uncertainty:'Unreviewed external-engine proposal. Native date normalization is not evidence of clock precision. Independent Mote review must decide meaning, attribution, admission, completeness and scope.',admission:{layer:input.phase==='integrate'?'memory':'observation',reason:'Stage proposal awaiting independent review',scope:'Only the supplied frozen original evidence and parent memories',attribution:'observed'},evidenceIds,evidence:[...evidence.values()],...(input.phase==='integrate'?{relatedMemoryIds:[...related]}:{})});
      });
      signal.throwIfAborted();
      const citations=[...new Map(ranges.map(range=>[range.record.id,{id:range.record.id,capturedAt:range.record.capturedAt,appName:range.record.appName,excerpt:range.text}])).values()];
      return {answer:JSON.stringify({memories:candidates}),citations,trace:[{tool:'hindsight.'+input.phase,arguments:{bank,operationId,phase:input.phase},count:candidates.length}],runId:input.opId};
    },input.opId,[bank],input.signal,this.probeNamespaces.has(hindsightDigest(input.namespace)));
  });}
  async discardPrepared(input:{namespace:MemoryProviderNamespace;opId:string;phase:'extract'|'integrate'}){return this.work(async()=>{const service=await this.options.runtime.service(),prepared=this.state.prepared.filter(item=>same(item.namespace,input.namespace)&&item.opId===input.opId&&item.phase===input.phase);for(const item of prepared){await service.cancelBank(item.bank);await service.request('DELETE',service.bankPath(item.bank));}this.state.prepared=this.state.prepared.filter(item=>!prepared.includes(item));await this.save();});}
  /** Source revocation is stronger than normal draining. It stops only native
   * operations whose frozen originals were revoked, including manual work
   * that has lost its own evidence authority. The host fences publication
   * immediately and reports this external cleanup as pending until it ACKs. */
  async erasePreparedEvidence(evidenceIds:readonly string[]){
    const affected=(item:z.infer<typeof preparedSchema>)=>!item.evidenceIds||item.evidenceIds.some(id=>evidenceIds.includes(id));
    for(const item of this.state.prepared.filter(affected))this.stopOperation(item.opId);
    return this.work(async()=>{const prepared=this.state.prepared.filter(affected);if(!prepared.length)return;const service=await this.options.runtime.service();for(const item of prepared){await service.cancelBank(item.bank);await service.request('DELETE',service.bankPath(item.bank),undefined,undefined,true);}this.state.prepared=this.state.prepared.filter(item=>!prepared.includes(item));await this.save();});
  }
  async reflectScoped(input:{namespace:MemoryProviderNamespace;opId:string;question:string;records:MemoryProviderRecord[];signal?:AbortSignal}):Promise<QueryResult>{return this.work(async()=>{
    input.signal?.throwIfAborted();if(!input.records.length)return {answer:'No authorized memory is available in this snapshot.',citations:[],trace:[],runId:input.opId};
    const bank=await this.projection(input.namespace,input.records,input.opId,input.signal),service=await this.options.runtime.service();
    const before=await service.memories(bank),operations=await service.operations(bank);
    this.options.runtime.setOperation?.(input.opId,this.probeNamespaces.has(hindsightDigest(input.namespace))?'capability_probe':'operation');
    let result:any;
    try{result=await service.request<any>('POST',service.bankPath(bank)+'/reflect',{query:input.question,budget:'low',include:{facts:{},tool_calls:{output:false}},exclude_mental_models:true,fact_types:['world']},input.signal);}finally{this.options.runtime.setOperation?.(undefined);}
    input.signal?.throwIfAborted();
    const after=await service.memories(bank),later=await service.operations(bank);
    if(!same(before,after)||!same(operations,later)||result.based_on?.mental_models?.length||result.based_on?.directives?.length)throw new MemoryProviderError('invalid_record','Reflect changed its semantic snapshot or used unsupported directives');
    const memories:Memory[]=(result.based_on?.memories??[]).map((fact:any)=>{const record=fromFact(fact);if(!input.records.some(recordInScope=>same(recordInScope,record)))throw new MemoryProviderError('invalid_record','Reflect cited a memory outside its authorized snapshot');return record.memory as Memory;});
    const citations=[...new Map(memories.flatMap((memory:Memory)=>memory.evidence.filter(evidence=>evidence.quote).map(evidence=>[evidence.id,{id:evidence.id,capturedAt:evidence.capturedAt,appName:'Memory',excerpt:evidence.quote!}] as const))).values()];
    return {answer:result.text,citations,trace:[{tool:'hindsight.reflect',arguments:{bank,keys:input.records.map(record=>record.key)},count:memories.length}],runId:input.opId};
  });}
  async health(input:{namespace:MemoryProviderNamespace}):Promise<MemoryProviderHealth>{return this.work(async()=>{
    const verified={persistentCrud:false,scopedRetrieval:false,immutableRecords:false,idempotentReplay:false,history:false,physicalErase:false},problems:string[]=[];
    try{const service=await this.options.runtime.service(),health=await service.request<any>('GET','/health'),version=await service.request<any>('GET','/version');if(health.status!=='healthy'||version.api_version!==HINDSIGHT_VERSION||version.features?.worker!==false)problems.push('Fixed version, database health, or disabled embedded worker could not be verified');
      // Published inventory is checked against immutable external bodies.
      await this.records(input.namespace);
    }catch{problems.push('The actual Hindsight service or immutable records are unavailable');}
    if(!problems.length&&this.state.proof?.engine){verified.persistentCrud=true;verified.scopedRetrieval=true;verified.immutableRecords=true;verified.idempotentReplay=true;verified.history=true;/* Native SQL deletion does not prove old pages or WAL bytes were erased. */}
    // A liveness check is deliberately insufficient to advertise a capability.
    const ready=!problems.length&&Boolean(this.state.proof?.engine);
    return {providerId:'mote.hindsight',version:HINDSIGHT_VERSION,ready,verified,problems:problems.length?problems:ready?[]:['Run the actual managed-engine capability probe before selecting this configuration']};
  });}
  /** Explicit installation verification uses generated evidence and the actual
   * configured service, worker, embedding, reranking, model and native engine.
   * It stores only a versioned proof result in host control metadata. */
  async probe(signal?:AbortSignal):Promise<MemoryProviderHealth>{
    const namespace={ownerId:'mote-generated-capability-probe',instanceId:randomUUID(),bindingRevision:1},now=new Date().toISOString();
    const source=(id:string,text:string,capturedAt:string):CaptureRecord=>({id,deviceId:'mote-generated-fixture',deviceName:'Generated capability fixture',platform:'import',capturedAt,receivedAt:now,source:'note',durationMs:0,appId:'mote.fixture',appName:'Generated fixture',windowTitle:'',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'},blobHash:null,imageMime:null,indexingStatus:'text_ready'});
    const first=source(randomUUID(),'On 2026-10-01, Alice said: "Use amber for the Mote demo because I can distinguish amber." This decision is limited to the Mote demo.','2026-10-01T08:00:00Z'),second=source(randomUUID(),'On 2026-10-06, Alice said: "Replace amber with teal for the Mote demo because the projector makes amber hard for me to distinguish." This decision is limited to the Mote demo.','2026-10-06T08:00:00Z');
    const make=(record:CaptureRecord,version:number,statement:string,id:string=randomUUID()):Memory=>memorySchema.parse({id,version,fingerprint:hindsightDigest([record.id,version,statement]),domain:'personal',tier:'episode',kind:'episodic',admission:{layer:'observation',reason:'Generated capability fixture, not personal data or a semantic review verdict',scope:'Mote generated demo fixture',attribution:'third_party'},title:'Generated Mote demo decision',statement,uncertainty:'This is a synthetic fixture. Alice is not associated with the owner.',evidenceIds:[record.id],evidence:[{id:record.id,capturedAt:record.capturedAt,receivedAt:record.receivedAt,contentHash:hindsightDigest(record.ocrText),offset:0,length:record.ocrText.length,quote:record.ocrText}],createdAt:now,status:'published',model:this.options.model??'configured-profile',runId:'generated-capability-fixture'});
    const one=make(first,1,'Alice chose amber for the Mote demo because she could distinguish it.'),two=make(second,2,'Alice replaced amber with teal for the Mote demo because the projector made amber hard to distinguish.',one.id),other=make(second,1,'A separate synthetic project uses a secret palette and is outside the selected memory snapshot.');
    const put=(memory:Memory,opId:string)=>this.put({namespace,key:memoryProviderKey(memory),memory,opId});
    let success=false;this.probeNamespaces.add(hindsightDigest(namespace));
    try{
      signal?.throwIfAborted();const putId=randomUUID(),initial=await put(one,putId),replay=await put(one,putId);if(!same(initial,replay))throw Error('Exact operation receipt replay differs');
      let conflict=false;try{await put(other,putId);}catch(error){conflict=error instanceof MemoryProviderError&&error.code==='conflict';}if(!conflict)throw Error('Operation ID was reused for different content');
      await put(two,randomUUID());await put(other,randomUUID());
      if(!same(await this.read({namespace,key:memoryProviderKey(one)}),one)||!same(await this.read({namespace,key:memoryProviderKey(two)}),two))throw Error('Revision round trip failed');
      const found=await this.search({namespace,query:'What replaced the earlier color in the demo, and why?',keys:[memoryProviderKey(two)],limit:1});if(found.length!==1||!same(found[0].key,memoryProviderKey(two)))throw Error('Pinned semantic recall failed');
      const draftId=randomUUID(),draft=await this.prepare({namespace,opId:draftId,phase:'extract',evidence:[first,second],signal});if(!JSON.parse(draft.answer).memories.length)throw Error('Native extraction produced no candidates');
      const integrateId=randomUUID(),secondParent=make(second,1,two.statement),integrated=await this.prepare({namespace,opId:integrateId,phase:'integrate',evidence:[first,second],relatedMemories:[one,secondParent],signal});if(!JSON.parse(integrated.answer).memories.some((memory:any)=>memory.relatedMemoryIds?.length===2))throw Error('Native integration lineage failed');
      const reflected=await this.reflectScoped({namespace,opId:randomUUID(),question:'Which accent did Alice choose on October 6 for the Mote demo and why?',records:[{namespace,key:memoryProviderKey(two),memory:two}],signal});if(!reflected.citations.length||reflected.citations.some(citation=>citation.id!==second.id))throw Error('Read-only scoped reflect evidence failed');
      await this.discardPrepared({namespace,opId:draftId,phase:'extract'});await this.discardPrepared({namespace,opId:integrateId,phase:'integrate'});
      const removeId=randomUUID(),removed=await this.remove({namespace,key:memoryProviderKey(two),opId:removeId}),removeReplay=await this.remove({namespace,key:memoryProviderKey(two),opId:removeId});if(!same(removed,removeReplay)||!removed.currentRemoved||removed.eraseVerified||await this.read({namespace,key:memoryProviderKey(two)})!==null||!same(await this.read({namespace,key:memoryProviderKey(one)}),one))throw Error('Logical erase/history/replay verification failed');
      success=true;
    }catch(error){signal?.throwIfAborted();return {providerId:'mote.hindsight',version:HINDSIGHT_VERSION,ready:false,verified:{persistentCrud:false,scopedRetrieval:false,immutableRecords:false,idempotentReplay:false,history:false,physicalErase:false},problems:[error instanceof MemoryProviderError?error.message:'Actual Hindsight engine capability verification failed']};}
    finally{
      // Probe fixture cleanup is part of completion, not a personal-data test.
      // An already aborted probe must not create/restart a service merely to
      // clean generated data, which would authorize a fresh model handshake.
      const existing=this.options.runtime.existingService?.();
      if(!signal?.aborted||existing){
        await this.work(async()=>{const service=existing?await existing:await this.options.runtime.service(),prepared=this.state.prepared.filter(item=>same(item.namespace,namespace));for(const item of prepared){await service.cancelBank(item.bank);await service.request('DELETE',service.bankPath(item.bank));}this.state.prepared=this.state.prepared.filter(item=>!prepared.includes(item));await this.save();}).catch(()=>{});
        if(!signal?.aborted)for(const memory of [one,two,other])await this.remove({namespace,key:memoryProviderKey(memory),opId:randomUUID()}).catch(()=>{});
      }
      this.probeNamespaces.delete(hindsightDigest(namespace));
    }
    if(success)await this.work(async()=>{this.state.proof={version:HINDSIGHT_VERSION,verifiedAt:new Date().toISOString(),engine:true,physicalErase:false};await this.save();});
    return this.health({namespace});
  }
  async recover(input:{namespace:MemoryProviderNamespace}){
    await this.work(async()=>{const service=await this.options.runtime.service();for(const entry of this.state.entries.filter(entry=>same(entry.namespace,input.namespace)&&entry.state==='intent')){const facts=await service.memories(entry.bank);if(facts.length===1&&hindsightDigest(fromFact(facts[0]))===entry.digest)entry.state='applied';}await this.save();});return this.health(input);
  }
  async close(){if(this.closed)return;this.closed=true;for(const operation of this.running.values())operation.abort('Hindsight provider closed');await this.options.runtime.close();await this.tail;}
}

export function createHindsightEngine(options:{directory:string;instanceId:string;configurationIdentity?:string;settings:ModelSettings;codex?:{executable?:string;home?:string}}&HindsightModelCallbacks){
  const runtime=new ManagedHindsightRuntime({...options,directory:join(options.directory,'runtime')});
  return new HindsightEngine({directory:join(options.directory,'provider'),runtime,model:options.settings.model});
}
