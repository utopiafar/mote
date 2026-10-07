import type {SourceUploadObserver} from './sync-history';
import {DESKTOP_STORAGE_VERSION,RESET_REQUIRED} from './storage-format';
import {rm} from 'node:fs/promises';
import {sourceStatePatch,type StatePatch} from './source-state-store';
import { moteText } from '@mote/shared/i18n';
import { createHash } from 'node:crypto';
import { sourceWork } from './background';
import type { LegacyLocalFileInput as LocalFileInput } from './source-types';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { LocalFileCheckpoint, SourceCheckpoint, SourceDefinition, SourceItem, SourceRequest, SourceScan, ScannedItem } from './source-types';
import { PriorityScheduler } from './priority-scheduler';
import {UploadSlice,UploadSliceYield,requestBytes} from './upload-slice';
import {requireIngressReceipt} from './ingress-protocol';

export const sourceHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function atomicSourceJson(path: string, value: unknown): Promise<void> { await sourceWork.run({ kind: 'json-write', path, value }); }

type QueueName = 'realtime' | 'history';
function isFileCheckpoint(value: SourceCheckpoint | undefined): value is LocalFileCheckpoint {
  return Boolean(value && value.version === 1 && typeof (value as LocalFileCheckpoint).root === 'string');
}
/** Opaque recovery binds the already acknowledged file metadata, without local transport fields. */
function snapshotMetadataIdentity(raw:ScannedItem):string{
  const {localOriginal:_,localOriginalBase64:__,snapshotRecovery:___,revision:____,observedAt:_____,...item}=raw as SourceItem;
  return sourceHash(JSON.stringify(item));
}
interface Known { policy?:string; contentHash: string; discoveryHash?: string; revision: string; item: ScannedItem }
interface ProcessingJob { input: LocalFileInput; item: ScannedItem; discoveryHash: string; policy?: string; nextAttemptAt: number }
interface RejectedItem { item: SourceItem; status: number }
interface BatchResult { acks: Record<string, unknown>[]; rejected?: RejectedItem[] }
export interface SnapshotRecovery {captureId:string;externalId:string;revision:string;sha256:string;sizeBytes:number;observedAt:string}
interface State {
  version: 3;
  /** Distinct from the local outbox schema version; old server receipts cannot be replayed. */
  ingressVersion: 2;
  predecessors?: Record<string, string | null>;
  delivered?: Record<string, string>;
  quarantined?: Record<string, RejectedItem>;
  collectedItems?: number;
  checkpoint?: SourceCheckpoint;
  initialized?: boolean;
  baseline?: string[];
  policy?: string;
  adapterVersion: number;
  known: Record<string, Known>;
  localProcessing?: Record<string, ProcessingJob>;
  snapshotRecoveries?: Record<string,SnapshotRecovery&{identityHash:string}>;
  pendingRealtime: SourceItem[];
  pendingHistory: SourceItem[];
  lastSyncAt?: string;
  lastAcknowledgedAt?: string;
}

const receiptId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemKey = (item: Pick<SourceItem, 'externalId' | 'revision'>) => `${item.externalId}\u0000${item.revision}`;

/** Durable outbox with a latency-sensitive queue and a resumable backfill queue. */
export class SourceSync {
  private writes:Promise<unknown>=Promise.resolve();
  private mutate<T>(operation:()=>Promise<T>):Promise<T>{const next=this.writes.then(operation,operation);this.writes=next.catch(()=>undefined);return next;}
  private scheduler=new PriorityScheduler(16*1024*1024);
  private manifestBatch?:boolean;
  private knownItems=0;
  private data: State = { version: 3, ingressVersion:2, adapterVersion:1, known: {}, pendingRealtime: [], pendingHistory: [] };
  private readonly limits: { maxEvents: number; maxBytes: number; batchSize: number; concurrency: number };
  constructor(private readonly path: string, limits?: Partial<{ maxEvents: number; maxBytes: number; batchSize: number; concurrency: number }>) { this.limits = { maxEvents: 4000, maxBytes: 32 * 1024 * 1024, batchSize: 100, concurrency: 4, ...limits }; }

  async initialize(): Promise<void> {
    try {
      const value = await sourceWork.run<Record<string, unknown> | undefined>({ kind: 'source-state', path: this.path });
      if (value === undefined) {await sourceWork.run({kind:'source-state',path:this.path,patches:sourceStatePatch({},this.data as unknown as Record<string,unknown>)});return;}
      const next = value as unknown as State;
      if (next.version !== DESKTOP_STORAGE_VERSION || next.ingressVersion!==2 || !Number.isSafeInteger(next.adapterVersion) || next.adapterVersion<1 || !next.known || !Array.isArray(next.pendingRealtime) || !Array.isArray(next.pendingHistory)) throw Error(RESET_REQUIRED);
      if (next.pendingRealtime.length + next.pendingHistory.length + Object.keys(next.quarantined??{}).length > this.limits.maxEvents) throw new Error(moteText("来源同步状态超过本地队列上限，请恢复网络后重试"));
      this.data = next;
      this.knownItems=Object.values(next.known).filter(value=>!value.item.deleted).length;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  pendingForHistory(versionKey: string): SourceItem | undefined { const item = [...this.pendingItems(), ...Object.values(this.data.quarantined ?? {}).map(value => value.item)].find(item => sourceHash(`${item.externalId}\0${item.revision}`) === versionKey); return item ? structuredClone(item) : undefined; }
  checkpoint(): SourceCheckpoint | undefined { return structuredClone(this.data.checkpoint); }
  /** Scanner borrows immutable catalog rows and records changes in its own draft. */
  fileCheckpoint(): LocalFileCheckpoint | undefined {
    const checkpoint=this.data.checkpoint;
    return isFileCheckpoint(checkpoint)?{...structuredClone({...checkpoint,catalog:undefined}),catalog:checkpoint.catalog}:undefined;
  }
  initialized() { return Boolean(this.data.initialized); }
  private pendingItems(): SourceItem[] { return [...this.data.pendingRealtime, ...this.data.pendingHistory]; }
  status(): { processingPending: number; blocked: number; failures: {externalId:string;title:string;status:number}[]; pending: number; realtimePending: number; historyPending: number; items: number; lastSyncAt?: string; lastAcknowledgedAt?: string; oldestPendingAt?: string } {
    const pending = this.pendingItems();
    const rejected=Object.values(this.data.quarantined??{});
    return { processingPending:Object.keys(this.data.localProcessing??{}).length, blocked:rejected.length,failures:rejected.slice(0,100).map(({item,status})=>({externalId:item.externalId,title:item.title,status})),oldestPendingAt: pending.reduce<string | undefined>((oldest, item) => !oldest || item.observedAt < oldest ? item.observedAt : oldest, undefined), pending: pending.length, realtimePending: this.data.pendingRealtime.length, historyPending: this.data.pendingHistory.length, items: this.data.collectedItems ?? this.knownItems, lastSyncAt: this.data.lastSyncAt, lastAcknowledgedAt:this.data.lastAcknowledgedAt };
  }
  async checkpointTo(path: string): Promise<void> { const previous=await sourceWork.run<Record<string,unknown>|undefined>({kind:'source-state',path});await sourceWork.run({kind:'source-state',path,patches:sourceStatePatch(previous??{},this.data as unknown as Record<string,unknown>)}); }

  async ensurePolicy(policy:string):Promise<void>{return this.mutate(()=>this.ensurePolicyInternal(policy));}
  private async ensurePolicyInternal(policy: string): Promise<void> {
    if (this.data.policy === policy) return;
    const next = { ...this.data, checkpoint: undefined, localProcessing: undefined, delivered: undefined, predecessors: undefined, quarantined: undefined, snapshotRecoveries:undefined, policy, known: Object.fromEntries(Object.entries(this.data.known).map(([k, v]) => [k, { ...v, contentHash: '', discoveryHash: undefined }])), pendingRealtime: [], pendingHistory: [] } as State;
    const retired = [...Object.values(this.data.localProcessing??{}).map(job=>({...job.item,localProcessing:job.input})),...this.pendingItems(),...Object.values(this.data.quarantined??{}).map(value=>value.item)];
    await this.commit(next);
    await this.discardUnqueuedOriginals(retired);
  }

  /** Adapter upgrades rescan from a fresh checkpoint while retaining every
   * unacknowledged revision and its local original until the server ACKs it. */
  async ensureAdapterVersion(version:number):Promise<void>{
    if(!Number.isSafeInteger(version)||version<1)throw Error('Invalid source adapter version');
    return this.mutate(async()=>{
      if(this.data.adapterVersion===version&&!Object.keys(this.data.localProcessing??{}).length)return;
      const retired=Object.values(this.data.localProcessing??{}).map(job=>({...job.item,localProcessing:job.input}));
      const known=Object.fromEntries(Object.entries(this.data.known).map(([key,value])=>[key,this.data.localProcessing?.[key]?{...value,contentHash:'',discoveryHash:undefined}:value]));
      await this.commit({...this.data,known,localProcessing:undefined,adapterVersion:version,checkpoint:undefined});
      await this.discardUnqueuedOriginals(retired);
    });
  }

  async requestSnapshotRecovery(items:SnapshotRecovery[]):Promise<number>{
    return this.mutate(async()=>{
      const pending=new Set([...this.pendingItems(),...Object.values(this.data.quarantined??{}).map(value=>value.item)].map(item=>item.externalId));
      const matches=items.filter(item=>receiptId.test(item.captureId)&&/^[a-f0-9]{64}$/.test(item.sha256)&&Number.isSafeInteger(item.sizeBytes)&&item.sizeBytes>=0&&item.sizeBytes<=512*1024*1024&&Number.isFinite(Date.parse(item.observedAt))&&!pending.has(item.externalId)&&this.data.known[sourceHash(item.externalId)]?.revision===item.revision&&this.data.known[sourceHash(item.externalId)]?.policy===this.data.policy);
      if(!matches.length)return 0;
      const known={...this.data.known};for(const item of matches){const key=sourceHash(item.externalId);known[key]={...known[key],contentHash:'',discoveryHash:undefined};}
      // Re-enumerate authorized files instead of trusting a remote filesystem path.
      await this.commit({...this.data,known,checkpoint:undefined,snapshotRecoveries:{...this.data.snapshotRecoveries,...Object.fromEntries(matches.map(item=>[sourceHash(item.externalId),{...item,identityHash:snapshotMetadataIdentity(this.data.known[sourceHash(item.externalId)].item)}]))}});return matches.length;
    });
  }

  async stage(scan: SourceScan, trackDeletions: boolean, observedAt = new Date().toISOString(), initialSync: 'all' | 'new_only' = 'all', defaultQueue: QueueName = scan.queue ?? 'realtime'): Promise<number> {
    const retired = Object.values(this.data.localProcessing??{}).map(job=>({...job.item,localProcessing:job.input}));
    try { return await this.mutate(()=>this.stageInternal(scan, trackDeletions, observedAt, initialSync, defaultQueue)); }
    finally { await this.discardUnqueuedOriginals([...scan.items,...retired]); }
  }

  async discardUnqueuedOriginals(items: ScannedItem[]): Promise<void> {
    const inputs = Object.values(this.data.localProcessing??{}).map(job=>({...job.item,localProcessing:job.input}));
    const directories = (item: ScannedItem) => [item.localOriginal?.directory,item.localProcessing?.spool?.directory].filter((value): value is string=>Boolean(value));
    const retained = new Set([...this.pendingItems(),...Object.values(this.data.quarantined??{}).map(value=>value.item),...inputs].flatMap(directories));
    for (const directory of items.flatMap(directories)) if (!retained.has(directory)) await rm(directory, {force:true, recursive:true}).catch(() => {});
  }

  private async stageInternal(scan: SourceScan, trackDeletions: boolean, observedAt: string, initialSync: 'all' | 'new_only', defaultQueue: QueueName): Promise<number> {
    const knownChanges=new Map<string,Known>();
    const next: State = { ...this.data, pendingRealtime: [...this.data.pendingRealtime], pendingHistory: [...this.data.pendingHistory] };
    let changes = 0;
    if (!scan.checkpoint && initialSync === 'new_only' && !next.initialized && Object.keys(next.known).length === 0) {
      next.baseline = [...new Set([...(next.baseline ?? []), ...scan.seen])]; next.initialized = scan.complete; await this.commit(next, this.limits.maxBytes); return 0;
    }
    if (initialSync === 'all') next.baseline = [];
    if (scan.complete) next.initialized = true;
    const baseline = new Set(next.baseline ?? []);
    const stage = (raw: ScannedItem) => {
      const { syncQueue, localProcessing, ...item } = raw;
      if(localProcessing)throw Error('Local file interpretation is retired; upload immutable input for central processing');
      const {localOriginal, ...identity} = item;
      const key = sourceHash(item.externalId), previous = knownChanges.get(key)??next.known[key], contentHash = sourceHash(JSON.stringify({...identity, ...(localOriginal ? {originalSha256:localOriginal.sha256} : {})}));
      if (previous?.contentHash === contentHash) return;
      if (next.localProcessing?.[key]) { next.localProcessing = { ...next.localProcessing }; delete next.localProcessing[key]; }
      const recovery=next.snapshotRecoveries?.[key],bytes=localOriginal?undefined:item.localOriginalBase64?Buffer.from(item.localOriginalBase64,'base64'):undefined;
      const recoveryMatches=recovery&&recovery.identityHash===snapshotMetadataIdentity(item)&&previous?.policy===next.policy&&item.layer==='snapshot'&&!item.deleted&&recovery.revision===previous?.revision&&(localOriginal?.sha256??(bytes?sourceHash(bytes):undefined))===recovery.sha256&&(localOriginal?.sizeBytes??bytes?.length)===recovery.sizeBytes;
      const revision = recoveryMatches?recovery.revision:sourceHash(contentHash + ':' + (previous?.revision ?? '')), queued: SourceItem = { ...item, revision, observedAt:recoveryMatches?recovery.observedAt:observedAt,...(recoveryMatches?{snapshotRecovery:{captureId:recovery.captureId,sha256:recovery.sha256,sizeBytes:recovery.sizeBytes}}:{}) };
      if(recovery){next.snapshotRecoveries={...next.snapshotRecoveries};delete next.snapshotRecoveries[key];}
      if ((syncQueue ?? defaultQueue) === 'history') next.pendingHistory.push(queued); else next.pendingRealtime.push(queued);
      // Coding checkpoints own their append cursor and do not need a second
      // content index. A local directory catalog only skips discovery work;
      // SourceSync still needs its durable known map for revision deduplication.
      const localCatalog = scan.checkpoint && 'root' in scan.checkpoint && 'catalog' in scan.checkpoint;
      if (!scan.checkpoint || localCatalog) knownChanges.set(key,{ policy:next.policy,contentHash, revision, item: { ...item, text: '', localOriginalBase64: undefined, localOriginal:undefined } });
      changes++;
    };
    for (const [index, item] of scan.items.entries()) { if (index % 16 === 0) await yieldTurn(); if (!baseline.has(item.externalId)) stage(item); }
    if (trackDeletions && scan.complete) {
      const seen = new Set(scan.seen);
      for (const previous of Object.values(this.data.known)) {
        const item = previous.item;
        if (!previous.contentHash || item.deleted || seen.has(item.externalId)) continue;
        if (scan.scope && (!item.calendar || item.calendar.start >= scan.scope.end || item.calendar.end < scan.scope.start)) continue;
        stage({ ...item, localOriginalBase64: undefined, localOriginal:undefined, text: '', deleted: true, syncQueue: 'realtime', ...(item.kind === 'file' ? { metadata: { ...item.metadata, version: 1, file: { ...item.metadata?.file, deletionObservedAt: observedAt } } } : {}) });
      }
    }
    if (next.pendingRealtime.length + next.pendingHistory.length + Object.keys(next.quarantined??{}).length > this.limits.maxEvents) throw new Error(moteText("来源待同步队列已满（4000 项 / 32 MiB），请恢复网络后重试"));
    if (scan.catalogChanges && !isFileCheckpoint(scan.checkpoint)) throw new Error('File catalog changes require a file checkpoint');
    if (scan.checkpoint) { next.checkpoint = scan.catalogChanges&&isFileCheckpoint(scan.checkpoint)?{...scan.checkpoint,catalog:isFileCheckpoint(this.data.checkpoint)?this.data.checkpoint.catalog:{}}:scan.checkpoint; next.collectedItems = (next.collectedItems ?? 0) + changes; }
    if(Object.values(next.localProcessing??{}).reduce((sum,job)=>sum+(job.input.spool?.sizeBytes??0),0)+[...next.pendingRealtime,...next.pendingHistory].reduce((n,item)=>n+(item.localOriginal?.sizeBytes??(item.localOriginalBase64?Math.floor(item.localOriginalBase64.length*3/4):0)),0)>512*1024*1024)throw Error('Original outbox exceeds 512 MiB; upload pending files before scanning more');
    await this.commit(next, this.limits.maxBytes,[...sourceStatePatch(this.data as unknown as Record<string,unknown>,next as unknown as Record<string,unknown>),...Array.from(knownChanges,([key,value])=>({section:'known',key,value})),...(scan.catalogChanges??[]).map(change=>({section:'catalog',...change}))]);
    for(const [key,value] of knownChanges){const previous=this.data.known[key];this.knownItems+=Number(!value.item.deleted)-Number(Boolean(previous&&!previous.item.deleted));this.data.known[key]=value;}
    if(scan.catalogChanges&&isFileCheckpoint(this.data.checkpoint))for(const {key,value} of scan.catalogChanges){if(value)this.data.checkpoint.catalog[key]=value;else delete this.data.checkpoint.catalog[key];}
    return changes;
  }

  async syncScan(scan: SourceScan, trackDeletions: boolean, source: SourceDefinition, request: SourceRequest, signal?: AbortSignal, prepare?: () => Promise<void>): Promise<{ changes: number; state: 'ready' | 'paused' }> {
    let precedingError: unknown;
    if (this.status().pending) {
      try { await prepare?.(); if (await this.flush(source, request, signal) === 'paused') return { changes: 0, state: 'paused' }; } catch (error) { precedingError = error; }
    }
    signal?.throwIfAborted();
    const changes = await this.stage(scan, trackDeletions, undefined, source.initialSync, scan.queue ?? 'realtime');
    if (precedingError) throw precedingError;
    await prepare?.(); return { changes, state: await this.flush(source, request, signal) };
  }

  async flush(source: SourceDefinition, request: SourceRequest, signal?: AbortSignal, observer?: SourceUploadObserver): Promise<'ready' | 'paused'> {
    signal?.throwIfAborted();
    const registered = await request('/api/sources', source, 'POST', signal) as { id?: unknown; enabled?: unknown };
    if (!registered || registered.id !== source.id || typeof registered.enabled !== 'boolean') throw new Error(moteText("中央来源注册确认无效"));
    if (!registered.enabled) return 'paused';
    const scheduler = this.scheduler;
    const deferred=new Set<string>();let rejectedStatus:number|undefined;
    while (this.status().pending) {
      signal?.throwIfAborted();
      const eligible=(items:SourceItem[])=>items.filter(item=>!deferred.has(itemKey(item)));
      const queue = scheduler.next(eligible(this.data.pendingRealtime).length, eligible(this.data.pendingHistory).length);
      if(!queue)break;
      const batches = this.takeBatches(queue,deferred);
      let bytes=0;
      const measured:SourceRequest=(path,body,method,signal)=>{const pending=request(path,body,method,signal);bytes+=requestBytes(body);return pending;};
      const outcomes = await Promise.all(batches.map(async batch => { try { observer?.attempt(source,batch); return { batch, result: await this.sendBatch(source, batch, measured, signal, observer) }; } catch (error) { observer?.failed(source,batch,error); return { batch, error }; } }));
      let failure: unknown;
      for (const outcome of outcomes) {
        if ('error' in outcome) { if(!failure||failure instanceof UploadSliceYield)failure=outcome.error;continue; }
        const {acks,rejected=[]}=outcome.result;
        const accepted=new Set(acks.map(ack=>itemKey({externalId:String(ack.externalId),revision:String(ack.revision)})));
        observer?.settle(source,outcome.batch,acks,rejected);
        const permanent=rejected.filter(value=>[400,409,410,413,422].includes(value.status));
        await this.acknowledge(source,outcome.batch.filter(item=>accepted.has(itemKey(item))),acks,permanent);
        for(const value of rejected)if(!permanent.includes(value)){deferred.add(itemKey(value.item));rejectedStatus??=value.status;}
      }
      scheduler.committed(queue,bytes);
      if (failure) throw failure;
    }
    if(rejectedStatus!==undefined)throw Object.assign(new Error(moteText("部分记录未确认，已保留等待重试")),{httpStatus:rejectedStatus});
    await this.mutate(()=>this.commit({ ...this.data, lastSyncAt: new Date().toISOString() })); return 'ready';
  }

  async flushSlice(source:SourceDefinition,request:SourceRequest,signal?:AbortSignal,observer?:SourceUploadObserver){
    const slice=new UploadSlice();
    const bounded:SourceRequest=(path,body,method,requestSignal)=>{signal?.throwIfAborted();slice.admit(body);return request(path,body,method,requestSignal);};
    try{return {state:await this.flush(source,bounded,signal,observer),bytes:slice.bytes,requests:slice.requests};}
    catch(error){if(!(error instanceof UploadSliceYield))throw error;return {state:'yielded' as const,bytes:slice.bytes,requests:slice.requests};}
  }

  private takeBatches(queue: QueueName, deferred=new Set<string>()): SourceItem[][] {
    const items = (queue === 'realtime' ? this.data.pendingRealtime : this.data.pendingHistory).filter(item=>!deferred.has(itemKey(item)));
    if (!items.length) return [];
    if (items[0]!.kind === 'file' && items[0]!.document?.fileIndex) {
      if(items[0]!.localOriginalBase64||items[0]!.localOriginal)return [[items[0]!]];
      const seen=new Set<string>(),batch:SourceItem[]=[];
      for(const item of items){if(item.kind!=='file'||!item.document?.fileIndex||item.localOriginalBase64||item.localOriginal)break;if(seen.has(item.externalId))continue;seen.add(item.externalId);batch.push(item);if(batch.length>=this.limits.batchSize)break;}
      return [batch];
    }
    const count = Math.min(this.limits.concurrency, Math.ceil(items.length / this.limits.batchSize)), batches: SourceItem[][] = [];
    for (let i = 0; i < count; i++) { const start = Math.floor(i * items.length / count), end = Math.floor((i + 1) * items.length / count); if (end > start) batches.push(items.slice(start, Math.min(end, start + this.limits.batchSize))); }
    return batches;
  }

  private async sendBatch(source: SourceDefinition, batch: SourceItem[], request: SourceRequest, signal?: AbortSignal, observer?: SourceUploadObserver): Promise<BatchResult> {
    const first = batch[0]!;
    if (first.kind === 'file' && first.document?.fileIndex) {
      if(first.localOriginalBase64||first.localOriginal)return {acks:[await this.sendFile(source,first,request,signal)]};
      if(this.manifestBatch===undefined){const cap=await request('/api/file-sync/v1/capabilities',undefined,'GET',signal) as {manifestBatch?:number};this.manifestBatch=typeof cap.manifestBatch==='number'&&cap.manifestBatch>=this.limits.batchSize;}
      if (!this.manifestBatch) {
        const acks = [];
        for (const item of batch) {
          const ack = await this.sendFile(source, item, request, signal);
          // Preserve each validated receipt even if a later individual request fails.
          observer?.settle(source, [item], [ack]);
          acks.push(ack);
        }
        return { acks };
      }
      const manifests=batch.map(({localOriginalBase64:_,localOriginal:__,snapshotRecovery:___,...item})=>({sourceId:source.id,item,sizeBytes:item.metadata?.file?.sizeBytes??0,...(this.data.delivered?.[sourceHash(item.externalId)]?{previousRevision:this.data.delivered[sourceHash(item.externalId)]}: {})}));
      const response=await request('/api/file-sync/v1/manifests',{items:manifests},'POST',signal) as {results?:{externalId:string;revision:string;state?:string;status?:number;ack?:unknown}[]};
      if(!Array.isArray(response?.results)||response.results.length!==batch.length)throw Error('Invalid manifest acknowledgement');
      const acks:Record<string,unknown>[]=[],rejected:RejectedItem[]=[];
      // Validate the entire response before settling any item in a local transaction.
      for(const [index,result] of response.results.entries()){
        const item=batch[index]!;
        if(!result||result.externalId!==item.externalId||result.revision!==item.revision)throw Error('Invalid manifest acknowledgement');
        if(result.state==='rejected'){
          if(!Number.isInteger(result.status)||result.status!<400||result.status!>599||result.ack!==undefined)throw Error('Invalid manifest acknowledgement');
          rejected.push({item,status:result.status!});
        }else if(result.state==='missing_original'){
          // Originals with a durable local spool use sendFile before batching.
          // A metadata-only manifest cannot manufacture the missing original.
          rejected.push({item,status:422});
        }else if(result.state==='accepted'||result.state==='existing'){acks.push(this.validateAck(source,result.ack,item));}
        else throw Error('Invalid manifest acknowledgement');
      }
      return {acks,rejected};
    }
    const wire = batch.map(({localOriginalBase64:_,localOriginal:__,snapshotRecovery:___,...item})=>item);
    // A single item uses the dedicated v2 endpoint; multi-item writes require
    // the v2 batch endpoint and never retry through an older route.
    if (wire.length === 1) return {acks:[this.validateAck(source, await request(`/api/sources/${encodeURIComponent(source.id)}/items`, wire[0], 'PUT', signal), wire[0])]};
    const result=await request(`/api/sources/${encodeURIComponent(source.id)}/items/batch`, { items: wire }, 'POST', signal) as { receipts?: unknown };
    if (!result || !Array.isArray(result.receipts) || result.receipts.length !== batch.length) throw new Error(moteText("中央批量来源确认不完整，已保留待重试版本"));
    return {acks:result.receipts.map((receipt, index) => this.validateAck(source, receipt, wire[index]))};
  }

  private async sendFile(source: SourceDefinition, item: SourceItem, request: SourceRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { localOriginalBase64,localOriginal,snapshotRecovery, ...wire } = item, key = sourceHash(item.externalId);
    let previousRevision = Object.hasOwn(this.data.predecessors ?? {}, item.revision) ? this.data.predecessors![item.revision] ?? '' : this.data.delivered?.[key];
    if (previousRevision === undefined) { const head = await request('/api/file-sync/v1/head?sourceId=' + encodeURIComponent(source.id) + '&externalId=' + encodeURIComponent(item.externalId), undefined, 'GET', signal) as { revision: string | null }; previousRevision = head.revision ?? ''; }
    await this.mutate(async()=>{if (!Object.hasOwn(this.data.predecessors ?? {}, item.revision)) await this.commit({ ...this.data, predecessors: { ...this.data.predecessors, [item.revision]: previousRevision || null } });});
    const original = localOriginalBase64 ? Buffer.from(localOriginalBase64, 'base64') : undefined, manifest = { sourceId: source.id, previousRevision: previousRevision || null, item: wire, sizeBytes: localOriginal?.sizeBytes??original?.length??item.metadata?.file?.sizeBytes??0, ...(localOriginal?{sha256:localOriginal.sha256}:original ? { sha256: sourceHash(original) } : {}) };
    let ack: Record<string, unknown>;
    if (original||localOriginal) {
      const upload = await request(snapshotRecovery?'/api/file-sync/v1/recovery/'+encodeURIComponent(snapshotRecovery.captureId)+'/uploads':'/api/file-sync/v1/uploads', snapshotRecovery?{}:manifest, 'POST', signal) as { uploadId: string; ack?: Record<string, unknown>; partBytes: number; parts: { part: number; hash: string; bytes: number }[] };
      if (upload.ack) ack = upload.ack;
      else {
        if (upload.partBytes !== 4194304 || !Array.isArray(upload.parts) || typeof upload.uploadId !== 'string' || !upload.uploadId) throw Error('Unsupported file upload session');
        for (let offset = 0; offset < (localOriginal?.sizeBytes??original!.length); offset += upload.partBytes) {
          const part = offset / upload.partBytes, bytes = localOriginal?Buffer.from(await sourceWork.run<Uint8Array>({kind:'original-part',spool:localOriginal,part})):original!.subarray(offset, offset + upload.partBytes), hash = sourceHash(bytes);
          const existing = upload.parts.find(value=>value.part===part);
          if (existing?.hash === hash && existing.bytes === bytes.length) continue;
          const receipt = await request('/api/file-sync/v1/uploads/' + encodeURIComponent(upload.uploadId) + '/parts/' + part, bytes, 'PUT', signal) as {part?:number;hash?:string;bytes?:number};
          if (receipt?.part !== part || receipt.hash !== hash || receipt.bytes !== bytes.length) throw Error('File part acknowledgement does not match the queued original');
        }
        ack = await request('/api/file-sync/v1/uploads/' + encodeURIComponent(upload.uploadId) + '/commit', {}, 'POST', signal) as Record<string, unknown>;
      }
      if (ack.sha256 !== manifest.sha256 || ack.sizeBytes !== (localOriginal?.sizeBytes??original!.length)) throw Error('File archive acknowledgement does not match the queued original');
    } else ack = await request('/api/file-sync/v1/revisions', manifest, 'PUT', signal) as Record<string, unknown>;
    return this.validateAck(source, ack, item);
  }

  private validateAck(source: SourceDefinition, ack: unknown, expected: SourceItem): Record<string, unknown> {
    if (!ack || typeof ack !== 'object') throw new Error(moteText("中央来源条目确认不匹配，已保留待重试版本"));
    const value = ack as Record<string, unknown>;
    if (value.sourceId !== source.id || typeof value.externalId !== 'string' || typeof value.revision !== 'string' || typeof value.duplicate !== 'boolean' || typeof value.id !== 'string' || !receiptId.test(value.id) || value.externalId !== expected.externalId || value.revision !== expected.revision) throw new Error(moteText("中央来源条目确认不匹配，已保留待重试版本"));
    try{requireIngressReceipt(value,{kind:expected.kind==='file'&&expected.document?.fileIndex?'file-revision':'source-item',sourceId:source.id,externalId:expected.externalId,revision:expected.revision});}
    catch{throw new Error(moteText("中央来源条目确认不匹配，已保留待重试版本"));}
    return value;
  }

  private async acknowledge(source: SourceDefinition, batch: SourceItem[], acks: Record<string, unknown>[],rejected:RejectedItem[]=[]): Promise<void> {return this.mutate(()=>this.acknowledgeInternal(source,batch,acks,rejected));}
  private async acknowledgeInternal(_source: SourceDefinition, batch: SourceItem[], acks: Record<string, unknown>[],rejected:RejectedItem[]): Promise<void> {
    const acked = new Set(acks.map(ack => itemKey({ externalId: String(ack.externalId), revision: String(ack.revision) })));
    const expected = new Set(batch.map(itemKey));
    if (acked.size !== batch.length || [...expected].some(key => !acked.has(key))) throw new Error(moteText("中央批量来源确认不完整，已保留待重试版本"));
    const remove = new Set([...batch,...rejected.map(value=>value.item)].map(itemKey)), filter = (items: SourceItem[]) => items.filter(item => !remove.has(itemKey(item)));
    const next={...this.data,lastAcknowledgedAt:batch.length?new Date().toISOString():this.data.lastAcknowledgedAt,pendingRealtime:filter(this.data.pendingRealtime),pendingHistory:filter(this.data.pendingHistory)};
    const patches:StatePatch[]=sourceStatePatch(this.data as unknown as Record<string,unknown>,next as unknown as Record<string,unknown>);
    for(const item of batch)patches.push({section:'predecessors',key:item.revision},{section:'delivered',key:sourceHash(item.externalId),value:item.revision});
    for(const value of rejected)patches.push({section:'quarantined',key:itemKey(value.item),value});
    await this.commit(next,undefined,patches);
    // Apply only touched map entries after the SQLite transaction is durable.
    // A one-item ACK never clones or scans the full historical catalog.
    for(const item of batch){delete this.data.predecessors?.[item.revision];(this.data.delivered??={})[sourceHash(item.externalId)]=item.revision;}
    for(const value of rejected)(this.data.quarantined??={})[itemKey(value.item)]=value;
    for(const item of batch)if(item.localOriginal)await rm(item.localOriginal.directory,{force:true,recursive:true}).catch(()=>{});
  }

  private async commit(next: State, maximum?: number, patches=sourceStatePatch(this.data as unknown as Record<string,unknown>,next as unknown as Record<string,unknown>)): Promise<void> { await sourceWork.run({ kind: 'source-state', path: this.path, patches:[...patches,{section:'state',key:'version',value:DESKTOP_STORAGE_VERSION}], maximum }); this.data = next; }
}
