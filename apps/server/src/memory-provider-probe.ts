import {createHash,randomUUID} from 'node:crypto';
import {memorySchema,type Memory} from './memory-schema.js';
import {memoryProviderKey,memoryProviderNamespaceSchema,memoryProviderRecordSchema,type MemoryProvider,type MemoryProviderHealth,type MemoryProviderNamespace,type MemoryProviderRecord,type MemoryProviderReceipt} from './memory-provider-contract.js';

const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const demand=(condition:unknown)=>{if(!condition)throw Error('host_probe_mismatch');};
const record=(namespace:MemoryProviderNamespace,memory:Memory):MemoryProviderRecord=>({namespace,key:memoryProviderKey(memory),memory});
function receipt(value:MemoryProviderReceipt,input:MemoryProviderRecord,opId:string,state:'applied'|'removed'){
 demand(value.opId===opId&&same(value.namespace,input.namespace)&&same(value.key,input.key)&&value.state===state);
 if(state==='applied')demand(value.payloadDigest===digest(input));
 else demand(value.currentRemoved===true);
}

/** Host-owned generated canary for trusted third-party workers. A health claim
 * from the worker is never evidence. Restart must close the old process and
 * return a new provider; reopening an in-memory facade does not prove persistence.
 * Generated data never enters the owner's binding or Mote evidence catalog.
 * Physical erasure and whole-engine behavior require provider-specific proofs. */
export async function probeMemoryProvider(options:{provider:MemoryProvider;restart:()=>Promise<MemoryProvider>;namespace:MemoryProviderNamespace;providerId:string;version:string;signal?:AbortSignal}):Promise<MemoryProviderHealth>{
 const namespace=memoryProviderNamespaceSchema.parse({...options.namespace,ownerId:'mote-host-probe-'+randomUUID()}),at=new Date().toISOString(),id=randomUUID(),evidenceId=randomUUID();
 const first=memorySchema.parse({id,version:1,title:'Generated host probe observatory',statement:'The generated observatory uses a violet telescope.',uncertainty:'Generated capability probe only',domain:'personal',tier:'episode',kind:'episodic',createdAt:at,status:'published',evidenceIds:[evidenceId],evidence:[{id:evidenceId,capturedAt:at,receivedAt:at,quote:'Generated host capability probe',contentHash:digest('generated-probe-evidence')}],model:'generated-host-probe',runId:randomUUID(),fingerprint:digest({id,version:1}),admission:{layer:'memory',reason:'Generated capability probe',scope:'Isolated probe namespace',attribution:'observed'}});
 const second=memorySchema.parse({...first,version:2,statement:'The generated observatory uses an amber telescope.',fingerprint:digest({id,version:2})});
 const main=record(namespace,first),next=record(namespace,second),foreign=[{...namespace,ownerId:namespace.ownerId+'-other'},{...namespace,bindingRevision:namespace.bindingRevision+1},{...namespace,instanceId:namespace.instanceId+'-probe-other'}].map((ns,index)=>record(ns,memorySchema.parse({...first,statement:'Generated foreign scope '+index})));
 const attempted:MemoryProviderRecord[]=[],problems:string[]=[],verified={persistentCrud:false,scopedRetrieval:false,immutableRecords:false,idempotentReplay:false,history:false,physicalErase:false};
 let provider=options.provider,phase='initial_write',mainRemoved=false;
 const checkpoint=()=>options.signal?.throwIfAborted();
 const wait=<T>(operation:Promise<T>):Promise<T>=>{
  const signal=options.signal;if(!signal)return operation;
  return new Promise<T>((resolve,reject)=>{const abort=()=>{reject(Error('host_probe_revoked'));void provider.close().catch(()=>{});};
   if(signal.aborted){abort();operation.catch(()=>{});return;}signal.addEventListener('abort',abort,{once:true});
   operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
 };
 const restart=()=>wait(options.restart().then(async next=>{if(options.signal?.aborted){await next.close();throw Error('host_probe_revoked');}return next;}));
 const put=async(input:MemoryProviderRecord,opId=randomUUID())=>{checkpoint();attempted.push(input);const result=await wait(provider.put({...input,opId}));checkpoint();receipt(result,input,opId,'applied');return result;};
 const read=async(input:MemoryProviderRecord)=>{checkpoint();const result=await wait(provider.read({namespace:input.namespace,key:input.key}));checkpoint();demand(same(result===null?null:memorySchema.parse(result),input.memory));};
 const exported=async(ns:MemoryProviderNamespace,expected:MemoryProviderRecord[])=>{checkpoint();const result=(await wait(provider.export({namespace:ns}))).map(value=>memoryProviderRecordSchema.parse(value));checkpoint();demand(result.length===expected.length&&result.every(value=>expected.some(target=>same(value,target))));};
 const searched=async(keys:MemoryProviderRecord['key'][],limit:number,expected:MemoryProviderRecord[])=>{checkpoint();const result=(await wait(provider.search({namespace,query:'What color is the telescope in the generated observatory?',keys,limit}))).map(value=>memoryProviderRecordSchema.parse({namespace:value.namespace,key:value.key,memory:value.memory}));checkpoint();demand(result.length===expected.length&&result.every(value=>expected.some(target=>same(value,target))));};
 try{
  const opId=randomUUID(),firstReceipt=await put(main,opId);await read(main);
  phase='namespace_isolation';for(const item of foreign){demand(await wait(provider.read({namespace:item.namespace,key:main.key}))===null);await put(item);await read(item);}
  phase='immutable_replay';const replay=await put(main,opId);demand(same(replay,firstReceipt));
  let conflict=false;try{await wait(provider.put({...main,memory:{...first,statement:'Generated conflicting body'},opId}));}catch{conflict=true;}checkpoint();demand(conflict);await read(main);
  let namespaceConflict=false;try{await wait(provider.put({...foreign[0],opId}));}catch{namespaceConflict=true;}checkpoint();demand(namespaceConflict);
  let immutableConflict=false;try{await wait(provider.put({...main,memory:{...first,statement:'Generated immutable-key substitution'},opId:randomUUID()}));}catch{immutableConflict=true;}checkpoint();demand(immutableConflict);await read(main);await put(next);
  phase='scoped_search_export';
  await searched([next.key],1,[next]);await searched([],1,[]);await exported(namespace,[main,next]);for(const item of foreign)await exported(item.namespace,[item]);
  phase='worker_restart';checkpoint();provider=await restart();checkpoint();await read(main);await read(next);for(const item of foreign)await read(item);await exported(namespace,[main,next]);await searched([next.key],1,[next]);
  const restartedReplay=await put(main,opId);demand(same(restartedReplay,firstReceipt));
  verified.immutableRecords=true;verified.idempotentReplay=true;verified.history=true;verified.scopedRetrieval=true;
  phase='delete_restart';const deleteId=randomUUID(),removed=await wait(provider.remove({namespace,key:main.key,opId:deleteId}));checkpoint();receipt(removed,main,deleteId,'removed');demand(await wait(provider.read({namespace,key:main.key}))===null);checkpoint();provider=await restart();checkpoint();
  demand(await wait(provider.read({namespace,key:main.key}))===null);await read(next);for(const item of foreign)await read(item);await exported(namespace,[next]);await searched([main.key,next.key],2,[next]);
  const removedReplay=await wait(provider.remove({namespace,key:main.key,opId:deleteId}));checkpoint();demand(same(removedReplay,removed));mainRemoved=true;verified.persistentCrud=true;
 }catch{problems.push(options.signal?.aborted?'host_probe_revoked':'host_probe_failed:'+phase);}
 finally{
  // Revocation stops further admission. If transport results are unknown, the
  // isolated canary can be retained for reconciliation without claiming erase.
  if(!options.signal?.aborted){let failed=false;const unique=new Map(attempted.map(value=>[digest({namespace:value.namespace,key:value.key}),value]));for(const input of unique.values()){
   if(options.signal?.aborted){failed=true;break;}
   if(mainRemoved&&same(input,main))continue;
   try{const opId=randomUUID(),result=await wait(provider.remove({namespace:input.namespace,key:input.key,opId}));receipt(result,input,opId,'removed');if(await wait(provider.read({namespace:input.namespace,key:input.key}))!==null)failed=true;}catch{failed=true;}
  }if(failed)problems.push('host_probe_cleanup_requires_reconciliation');}
 }
 return {providerId:options.providerId,version:options.version,ready:problems.length===0&&verified.persistentCrud&&verified.scopedRetrieval&&verified.immutableRecords&&verified.idempotentReplay,verified,problems};
}
