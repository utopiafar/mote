import {rm} from 'node:fs/promises';
import {sourceStatePatch,type StatePatch} from './source-state-store';
import { moteText } from '@mote/shared/i18n';
import { createHash } from 'node:crypto';
import { sourceWork } from './background';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { LocalFileCheckpoint, SourceCheckpoint, SourceDefinition, SourceItem, SourceRequest, SourceScan, ScannedItem } from './source-types';
import { PriorityScheduler } from './priority-scheduler';
import {UploadSlice,UploadSliceYield,requestBytes} from './upload-slice';

export const sourceHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function atomicSourceJson(path: string, value: unknown): Promise<void> { await sourceWork.run({ kind: 'json-write', path, value }); }

type QueueName = 'realtime' | 'history';
function isFileCheckpoint(value: SourceCheckpoint | undefined): value is LocalFileCheckpoint {
  return Boolean(value && value.version === 1 && typeof (value as LocalFileCheckpoint).root === 'string');
}
interface Known { contentHash: string; revision: string; item: ScannedItem }
interface RejectedItem { item: SourceItem; status: number }
interface BatchResult { acks: Record<string, unknown>[]; rejected?: RejectedItem[] }
interface State {
  version: 2;
  predecessors?: Record<string, string | null>;
  delivered?: Record<string, string>;
  quarantined?: Record<string, RejectedItem>;
  collectedItems?: number;
  checkpoint?: SourceCheckpoint;
  initialized?: boolean;
  baseline?: string[];
  policy?: string;
  adapterVersion?: number;
  known: Record<string, Known>;
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
  private sourceBatch?:boolean;
  private knownItems=0;
  private data: State = { version: 2, known: {}, pendingRealtime: [], pendingHistory: [] };
  private readonly limits: { maxEvents: number; maxBytes: number; batchSize: number; concurrency: number };
  constructor(private readonly path: string, limits?: Partial<{ maxEvents: number; maxBytes: number; batchSize: number; concurrency: number }>) { this.limits = { maxEvents: 4000, maxBytes: 32 * 1024 * 1024, batchSize: 100, concurrency: 4, ...limits }; }

  async initialize(): Promise<void> {
    try {
      const value = await sourceWork.run<Record<string, unknown> | undefined>({ kind: 'source-state', path: this.path });
      if (value === undefined) {await sourceWork.run({kind:'source-state',path:this.path,patches:sourceStatePatch({},this.data as unknown as Record<string,unknown>)});return;}
      if (value.version === 1) {
        const old = value as unknown as { known?: Record<string, Known>; pending?: SourceItem[]; [key: string]: unknown };
        if (!Array.isArray(old.pending) || old.pending.length > this.limits.maxEvents) throw new Error(moteText("来源同步状态超过本地队列上限，请恢复网络后重试"));
        this.data = { ...old, version: 2, known: old.known ?? {}, pendingRealtime: old.pending ?? [], pendingHistory: [] } as State;
        delete (this.data as State & { pending?: SourceItem[] }).pending;
        this.knownItems=Object.values(this.data.known).filter(value=>!value.item.deleted).length;
        return;
      }
      const next = value as unknown as State;
      if (next.version !== 2 || !next.known || !Array.isArray(next.pendingRealtime) || !Array.isArray(next.pendingHistory)) throw new Error(moteText("来源同步状态无法读取，请保留文件后修复"));
      if (next.pendingRealtime.length + next.pendingHistory.length + Object.keys(next.quarantined??{}).length > this.limits.maxEvents) throw new Error(moteText("来源同步状态超过本地队列上限，请恢复网络后重试"));
      this.data = next;
      this.knownItems=Object.values(next.known).filter(value=>!value.item.deleted).length;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  checkpoint(): SourceCheckpoint | undefined { return structuredClone(this.data.checkpoint); }
  /** Scanner borrows immutable catalog rows and records changes in its own draft. */
  fileCheckpoint(): LocalFileCheckpoint | undefined {
    const checkpoint=this.data.checkpoint;
    return isFileCheckpoint(checkpoint)?{...structuredClone({...checkpoint,catalog:undefined}),catalog:checkpoint.catalog}:undefined;
  }
  initialized() { return Boolean(this.data.initialized); }
  private pendingItems(): SourceItem[] { return [...this.data.pendingRealtime, ...this.data.pendingHistory]; }
  status(): { blocked: number; failures: {externalId:string;title:string;status:number}[]; pending: number; realtimePending: number; historyPending: number; items: number; lastSyncAt?: string; lastAcknowledgedAt?: string; oldestPendingAt?: string } {
    const pending = this.pendingItems();
    const rejected=Object.values(this.data.quarantined??{});
    return { blocked:rejected.length,failures:rejected.slice(0,100).map(({item,status})=>({externalId:item.externalId,title:item.title,status})),oldestPendingAt: pending.reduce<string | undefined>((oldest, item) => !oldest || item.observedAt < oldest ? item.observedAt : oldest, undefined), pending: pending.length, realtimePending: this.data.pendingRealtime.length, historyPending: this.data.pendingHistory.length, items: this.data.collectedItems ?? this.knownItems, lastSyncAt: this.data.lastSyncAt, lastAcknowledgedAt:this.data.lastAcknowledgedAt };
  }
  async checkpointTo(path: string): Promise<void> { const previous=await sourceWork.run<Record<string,unknown>|undefined>({kind:'source-state',path});await sourceWork.run({kind:'source-state',path,patches:sourceStatePatch(previous??{},this.data as unknown as Record<string,unknown>)}); }

  async ensurePolicy(policy:string):Promise<void>{return this.mutate(()=>this.ensurePolicyInternal(policy));}
  private async ensurePolicyInternal(policy: string): Promise<void> {
    if (this.data.policy === policy) return;
    const next = { ...this.data, checkpoint: undefined, delivered: undefined, predecessors: undefined, quarantined: undefined, policy, known: Object.fromEntries(Object.entries(this.data.known).map(([k, v]) => [k, { ...v, contentHash: '' }])), pendingRealtime: [], pendingHistory: [] } as State;
    const retired = [...this.pendingItems(),...Object.values(this.data.quarantined??{}).map(value=>value.item)];
    await this.commit(next);
    await this.discardUnqueuedOriginals(retired);
  }

  /** Adapter upgrades rescan from a fresh checkpoint while retaining every
   * unacknowledged revision and its local original until the server ACKs it. */
  async ensureAdapterVersion(version:number):Promise<void>{
    if(!Number.isSafeInteger(version)||version<1)throw Error('Invalid source adapter version');
    return this.mutate(async()=>{
      if((this.data.adapterVersion??1)===version){
        if(this.data.adapterVersion===undefined)await this.commit({...this.data,adapterVersion:version});
        return;
      }
      await this.commit({...this.data,adapterVersion:version,checkpoint:undefined});
    });
  }

  async stage(scan: SourceScan, trackDeletions: boolean, observedAt = new Date().toISOString(), initialSync: 'all' | 'new_only' = 'all', defaultQueue: QueueName = scan.queue ?? 'realtime'): Promise<number> {
    try { return await this.mutate(()=>this.stageInternal(scan, trackDeletions, observedAt, initialSync, defaultQueue)); }
    finally { await this.discardUnqueuedOriginals(scan.items); }
  }

  async discardUnqueuedOriginals(items: ScannedItem[]): Promise<void> {
    const retained = new Set([...this.pendingItems(),...Object.values(this.data.quarantined??{}).map(value=>value.item)].flatMap(item => item.localOriginal ? [item.localOriginal.directory] : []));
    for (const item of items) if (item.localOriginal && !retained.has(item.localOriginal.directory)) await rm(item.localOriginal.directory, {force:true, recursive:true}).catch(() => {});
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
      const { syncQueue, ...item } = raw;
      const {localOriginal, ...identity} = item;
      const key = sourceHash(item.externalId), previous = knownChanges.get(key)??next.known[key], contentHash = sourceHash(JSON.stringify({...identity, ...(localOriginal ? {originalSha256:localOriginal.sha256} : {})}));
      if (previous?.contentHash === contentHash) return;
      const revision = sourceHash(contentHash + ':' + (previous?.revision ?? '')), queued: SourceItem = { ...item, revision, observedAt };
      if ((syncQueue ?? defaultQueue) === 'history') next.pendingHistory.push(queued); else next.pendingRealtime.push(queued);
      // Coding checkpoints own their append cursor and do not need a second
      // content index. A local directory catalog only skips discovery work;
      // SourceSync still needs its durable known map for revision deduplication.
      const localCatalog = scan.checkpoint && 'root' in scan.checkpoint && 'catalog' in scan.checkpoint;
      if (!scan.checkpoint || localCatalog) knownChanges.set(key,{ contentHash, revision, item: { ...item, text: '', localOriginalBase64: undefined, localOriginal:undefined } });
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
    if([...next.pendingRealtime,...next.pendingHistory].reduce((n,item)=>n+(item.localOriginal?.sizeBytes??(item.localOriginalBase64?Math.floor(item.localOriginalBase64.length*3/4):0)),0)>512*1024*1024)throw Error('Original outbox exceeds 512 MiB; upload pending files before scanning more');
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

  async flush(source: SourceDefinition, request: SourceRequest, signal?: AbortSignal): Promise<'ready' | 'paused'> {
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
      const outcomes = await Promise.all(batches.map(async batch => { try { return { batch, result: await this.sendBatch(source, batch, measured, signal) }; } catch (error) { return { batch, error }; } }));
      let failure: unknown;
      for (const outcome of outcomes) {
        if ('error' in outcome) { if(!failure||failure instanceof UploadSliceYield)failure=outcome.error;continue; }
        const {acks,rejected=[]}=outcome.result;
        const accepted=new Set(acks.map(ack=>itemKey({externalId:String(ack.externalId),revision:String(ack.revision)})));
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

  async flushSlice(source:SourceDefinition,request:SourceRequest,signal?:AbortSignal){
    const slice=new UploadSlice();
    const bounded:SourceRequest=(path,body,method,requestSignal)=>{signal?.throwIfAborted();slice.admit(body);return request(path,body,method,requestSignal);};
    try{return {state:await this.flush(source,bounded,signal),bytes:slice.bytes,requests:slice.requests};}
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

  private async sendBatch(source: SourceDefinition, batch: SourceItem[], request: SourceRequest, signal?: AbortSignal): Promise<BatchResult> {
    const first = batch[0]!;
    if (first.kind === 'file' && first.document?.fileIndex) {
      if(first.localOriginalBase64||first.localOriginal)return {acks:[await this.sendFile(source,first,request,signal)]};
      if(this.manifestBatch===undefined){try{const cap=await request('/api/file-sync/v1/capabilities',undefined,'GET',signal) as {manifestBatch?:number};this.manifestBatch=typeof cap.manifestBatch==='number'&&cap.manifestBatch>=this.limits.batchSize;}catch(error){const status=(error as {httpStatus?:number;statusCode?:number}).httpStatus??(error as {statusCode?:number}).statusCode;if(status!==404&&status!==405)throw error;this.manifestBatch=false;}}
      if(!this.manifestBatch){const acks=[];for(const item of batch)acks.push(await this.sendFile(source,item,request,signal));return {acks};}
      const manifests=batch.map(({localOriginalBase64:_,localOriginal:__,...item})=>({sourceId:source.id,item,sizeBytes:item.metadata?.file?.sizeBytes??0,...(this.data.delivered?.[sourceHash(item.externalId)]?{previousRevision:this.data.delivered[sourceHash(item.externalId)]}: {})}));
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
        }else if(result.state==='accepted'||result.state==='existing'||result.state===undefined&&result.ack){acks.push(this.validateAck(source,result.ack,item));}
        else throw Error('Invalid manifest acknowledgement');
      }
      return {acks,rejected};
    }
    const wire = batch.map(({ localOriginalBase64: _, localOriginal:__, ...item }) => item);
    // Keep the single-item route as a compatibility path for older central
    // nodes; only a real multi-item batch requires the new endpoint.
    if (wire.length === 1) return {acks:[this.validateAck(source, await request(`/api/sources/${encodeURIComponent(source.id)}/items`, wire[0], 'PUT', signal), wire[0])]};
    let result: { receipts?: unknown } | undefined;
    if (this.sourceBatch !== false) {
      try {
        result = await request(`/api/sources/${encodeURIComponent(source.id)}/items/batch`, { items: wire }, 'POST', signal) as { receipts?: unknown };
        this.sourceBatch = true;
      } catch (error) {
        const status = (error as { httpStatus?: number; statusCode?: number }).httpStatus ?? (error as { statusCode?: number }).statusCode;
        if (status !== 404 && status !== 405) throw error;
        this.sourceBatch = false;
      }
    }
    if (this.sourceBatch === false) {
      // Only explicit route absence permits the older single-item protocol.
      // A malformed ACK, authorization failure or lost response is not an ACK.
      const receipts: Record<string, unknown>[] = [];
      for (const item of wire) receipts.push(this.validateAck(source, await request(`/api/sources/${encodeURIComponent(source.id)}/items`, item, 'PUT', signal), item));
      return {acks:receipts};
    }
    if (!result || !Array.isArray(result.receipts) || result.receipts.length !== batch.length) throw new Error(moteText("中央批量来源确认不完整，已保留待重试版本"));
    return {acks:result.receipts.map((receipt, index) => this.validateAck(source, receipt, wire[index]))};
  }

  private async sendFile(source: SourceDefinition, item: SourceItem, request: SourceRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { localOriginalBase64,localOriginal, ...wire } = item, key = sourceHash(item.externalId);
    let previousRevision = Object.hasOwn(this.data.predecessors ?? {}, item.revision) ? this.data.predecessors![item.revision] ?? '' : this.data.delivered?.[key];
    if (previousRevision === undefined) { const head = await request('/api/file-sync/v1/head?sourceId=' + encodeURIComponent(source.id) + '&externalId=' + encodeURIComponent(item.externalId), undefined, 'GET', signal) as { revision: string | null }; previousRevision = head.revision ?? ''; }
    await this.mutate(async()=>{if (!Object.hasOwn(this.data.predecessors ?? {}, item.revision)) await this.commit({ ...this.data, predecessors: { ...this.data.predecessors, [item.revision]: previousRevision || null } });});
    const original = localOriginalBase64 ? Buffer.from(localOriginalBase64, 'base64') : undefined, manifest = { sourceId: source.id, previousRevision: previousRevision || null, item: wire, sizeBytes: item.metadata?.file?.sizeBytes ?? 0, ...(localOriginal?{sha256:localOriginal.sha256}:original ? { sha256: sourceHash(original) } : {}) };
    let ack: Record<string, unknown>;
    if (original||localOriginal) {
      const upload = await request('/api/file-sync/v1/uploads', manifest, 'POST', signal) as { uploadId: string; ack?: Record<string, unknown>; partBytes: number; parts: { part: number }[] };
      if (upload.ack) ack = upload.ack;
      else { if (upload.partBytes !== 4194304) throw Error('Unsupported file part size'); for (let offset = 0; offset < (localOriginal?.sizeBytes??original!.length); offset += upload.partBytes) { const part = offset / upload.partBytes; if (!upload.parts.some(p => p.part === part)) await request('/api/file-sync/v1/uploads/' + upload.uploadId + '/parts/' + part, localOriginal?Buffer.from(await sourceWork.run<Uint8Array>({kind:'original-part',spool:localOriginal,part})):original!.subarray(offset, offset + upload.partBytes), 'PUT', signal); } ack = await request('/api/file-sync/v1/uploads/' + upload.uploadId + '/commit', {}, 'POST', signal) as Record<string, unknown>; }
    } else ack = await request('/api/file-sync/v1/revisions', manifest, 'PUT', signal) as Record<string, unknown>;
    return this.validateAck(source, ack, item);
  }

  private validateAck(source: SourceDefinition, ack: unknown, expected?: Pick<SourceItem, 'externalId' | 'revision'>): Record<string, unknown> {
    if (!ack || typeof ack !== 'object') throw new Error(moteText("中央来源条目确认不匹配，已保留待重试版本"));
    const value = ack as Record<string, unknown>;
    if (value.sourceId !== source.id || typeof value.externalId !== 'string' || typeof value.revision !== 'string' || typeof value.duplicate !== 'boolean' || typeof value.id !== 'string' || !receiptId.test(value.id) || expected && (value.externalId !== expected.externalId || value.revision !== expected.revision)) throw new Error(moteText("中央来源条目确认不匹配，已保留待重试版本"));
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

  private async commit(next: State, maximum?: number, patches=sourceStatePatch(this.data as unknown as Record<string,unknown>,next as unknown as Record<string,unknown>)): Promise<void> { await sourceWork.run({ kind: 'source-state', path: this.path, patches:[...patches,{section:'state',key:'version',value:2}], maximum }); this.data = next; }
}
