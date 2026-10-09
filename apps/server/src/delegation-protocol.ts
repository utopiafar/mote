import type {DelegationCapability,DelegationProduct,DelegationScope,DelegationUnit} from './delegation-runtime.js';

/** Protocol adapter boundary, deliberately separate from internal execution
 * records. No remote Agent is enabled by registration or model-supplied URLs.
 * A future A2A adapter maps its task/events/artifacts here after host approval;
 * it must preserve the same disclosure checks, cancellation and idempotency. */
export type DelegationAdapterTask={id:string;state:'submitted'|'working'|'input-required'|'completed'|'failed'|'cancelled';artifact?:DelegationProduct;errorCode?:string};
export interface DelegationAdapter {
 readonly kind:'local'|'a2a';
 readonly version:string;
 /** The host pins a trusted descriptor, never a card retrieved from evidence. */
 discover(signal:AbortSignal):Promise<readonly Pick<DelegationCapability,'id'|'version'|'description'|'inputSchema'>[]>;
 submit(unit:Readonly<DelegationUnit>,context:{idempotencyKey:string;scope:Readonly<DelegationScope>;signal:AbortSignal}):Promise<DelegationAdapterTask>;
 read(taskId:string,context:{scope:Readonly<DelegationScope>;signal:AbortSignal}):Promise<DelegationAdapterTask>;
 cancel(taskId:string,signal:AbortSignal):Promise<void>;
}

export const DELEGATION_PROTOCOL_VERSION=1;
export const DELEGATION_TRANSPORT_POLICY=Object.freeze({default:'local',remoteEnabled:false,maxDepth:1,artifactIsOriginalEvidence:false});

/** Private model-authored research checkpoint. These locators record historical
 * inspection, never authorization or current-fragment citation delivery. */
export type QueryWorkspace={version:1;revision:number;unresolved:string[];supported:{statement:string;evidenceIds:string[]}[];inspected:{id:string;start:number;end:number;fingerprint?:string}[];searches:{tool:string;query?:string;cursor?:string}[];workerIds:string[]};
export function queryWorkspace(value:unknown,context:{revision:number;evidenceIds:readonly string[];workerIds:readonly string[]}):QueryWorkspace {
 const invalid=()=>{throw new Error('Invalid query research workspace');};
 if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>12000)invalid();
 const data=value as Record<string,unknown>;
 if(Object.keys(data).some(key=>!['unresolved','supported','inspected','searches','workerIds'].includes(key)))invalid();
 const list=(key:string,max:number)=>{const values=data[key]??[];if(!Array.isArray(values)||values.length>max)invalid();return values as unknown[];};
 const text=(v:unknown,max:number)=>{if(typeof v!=='string'||v.length>max)invalid();return v as string;};
 const row=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(key=>!keys.includes(key)))invalid();return v as Record<string,unknown>;};
 const evidence=(v:unknown)=>{const id=text(v,300);if(!context.evidenceIds.includes(id))invalid();return id;};
 const unresolved=list('unresolved',32).map(v=>text(v,1000));
 const supported=list('supported',32).map(v=>{const r=row(v,['statement','evidenceIds']);if(!Array.isArray(r.evidenceIds)||r.evidenceIds.length>30)invalid();return {statement:text(r.statement,1000),evidenceIds:(r.evidenceIds as unknown[]).map(evidence)};});
 const inspected=list('inspected',64).map(v=>{const r=row(v,['id','start','end','fingerprint']);if(!Number.isSafeInteger(r.start)||Number(r.start)<0||!Number.isSafeInteger(r.end)||Number(r.end)<Number(r.start))invalid();return {id:evidence(r.id),start:Number(r.start),end:Number(r.end),...(r.fingerprint===undefined?{}:{fingerprint:text(r.fingerprint,256)})};});
 const searches=list('searches',32).map(v=>{const r=row(v,['tool','query','cursor']);return {tool:text(r.tool,64),...(r.query===undefined?{}:{query:text(r.query,500)}),...(r.cursor===undefined?{}:{cursor:text(r.cursor,4096)})};});
 const workerIds=list('workerIds',128).map(v=>{const id=text(v,300);if(!context.workerIds.includes(id))invalid();return id;});
 return {version:1,revision:context.revision+1,unresolved,supported,inspected,searches,workerIds};
}
