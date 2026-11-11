import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {join} from 'node:path';
import {z} from 'zod';
import {moteText} from './i18n.js';
import {PrivateFile} from './connectors/private-file.js';
import type {Store} from './store.js';
import type {Connections,ConnectionCredential} from './connections.js';
import type {MaterialPublicationEvent} from './materials.js';

export const developerEventType='material.archived' as const;
const sensitiveMaterialKinds=new Set(['mote.screen-segment','mote.coding-session','mote.capture-event']);
const sensitiveSourceKinds=new Set(['screen','coding-agent']);
const allowedEventKinds=new Set([developerEventType]);
const maxEventRows=5_000;
const maxDeliveryRows=20_000;

const label=z.string().trim().min(1).max(120);
const sourceId=z.string().trim().min(1).max(128).regex(/^[^\0\r\n]+$/);
const sourceIdsSchema=z.array(sourceId).min(1).max(500);
const eventKindsSchema=z.array(z.literal(developerEventType)).min(1).max(20);
const timestamp=z.string().datetime();
const endpointSchema=z.object({
  id:z.string().uuid(),label,url:z.string().min(1).max(2048),sourceIds:sourceIdsSchema,eventKinds:eventKindsSchema,
  enabled:z.boolean(),secret:z.string().regex(/^[A-Za-z0-9_-]{43}$/),maxAttempts:z.number().int().min(1).max(10),
  createdAt:timestamp,updatedAt:timestamp,
}).strict();
const savedSchema=z.object({version:z.literal(1),endpoints:z.array(endpointSchema)}).strict();
type WebhookEndpoint=z.infer<typeof endpointSchema>;
type Saved=z.infer<typeof savedSchema>;
type DeliveryRow={id:string;event_id:string;event_sequence:number;endpoint_id:string;status:'pending'|'success'|'failed';
  attempts:number;next_attempt_at:number;http_status:number|null;last_error:string|null;created_at:string;updated_at:string;
  event_type:string|null;material_id:string|null;source_id:string|null;body:string|null};

export class DeveloperAccessError extends Error {
  constructor(readonly code:string,readonly statusCode:number,readonly publicMessage:string){super(code);this.name='DeveloperAccessError';}
}

export interface DeveloperEventPayload {
  readonly id:string;readonly type:typeof developerEventType;readonly version:1;readonly occurredAt:string;
  readonly sourceId:string;readonly material:{readonly id:string;readonly revision:string;readonly kind:string;readonly deviceId?:string};
}
export interface DeveloperWebhookView {
  readonly id:string;readonly label:string;readonly url:string;readonly sourceIds:string[];readonly eventKinds:string[];
  readonly enabled:boolean;readonly maxAttempts:number;readonly hasSecret:true;readonly createdAt:string;readonly updatedAt:string;
}
export interface DeveloperDeliveryView {
  readonly id:string;readonly endpointId:string;readonly endpointLabel:string;readonly eventId:string;readonly eventType:string;
  readonly materialId?:string;readonly sourceId?:string;readonly status:'pending'|'success'|'failed';readonly attempts:number;
  readonly nextAttemptAt:string;readonly httpStatus?:number;readonly lastError?:string;readonly createdAt:string;readonly updatedAt:string;
}
export interface DeveloperAccessInventory {
  readonly credentials:readonly ReturnType<Connections['publicCredential']>[];
  readonly endpoints:readonly DeveloperWebhookView[];readonly deliveries:readonly DeveloperDeliveryView[];
}

const denied=(message:string)=>new DeveloperAccessError('developer_target_denied',400,message);
const invalid=(code:string,message:string)=>new DeveloperAccessError(code,400,message);

function metadataHost(hostname:string){
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(['metadata.google.internal','metadata','instance-data','169.254.169.254','169.254.170.2','100.100.100.200','fd00:ec2::254'].includes(host))return true;
  if(host.startsWith('::ffff:')){
    const tail=host.slice(7);
    if(isIP(tail)===4)return metadataHost(tail);
    const mapped=/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if(mapped){const high=Number.parseInt(mapped[1]!,16),low=Number.parseInt(mapped[2]!,16);return metadataHost([high>>8,high&255,low>>8,low&255].join('.'));}
  }
  const version=isIP(host);
  if(version===4)return host.startsWith('169.254.');
  if(version===6)return host.startsWith('fe80:')||host.startsWith('fd00:ec2::254');
  return false;
}

function targetUrl(raw:unknown){
  if(typeof raw!=='string')throw invalid('developer_target_invalid',moteText("Webhook 目标必须是完整的 http(s) 地址。"));
  const value=raw.trim();
  if(!value||value.length>2048||/[\0\r\n]/.test(value))throw invalid('developer_target_invalid',moteText("Webhook 目标必须是完整的 http(s) 地址。"));
  let url:URL;
  try{url=new URL(value);}catch{throw invalid('developer_target_invalid',moteText("Webhook 目标必须是完整的 http(s) 地址。"));}
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw invalid('developer_target_scheme',moteText("Webhook 目标只允许 http 或 https。"));
  if(url.username||url.password)throw denied(moteText("Webhook 目标不能包含用户名或密码。"));
  if(url.hash)throw invalid('developer_target_fragment',moteText("Webhook 目标不能包含片段。"));
  if(!url.hostname||metadataHost(url.hostname))throw denied(moteText("Webhook 目标不能是云元数据地址。"));
  return url.toString();
}

function explicitSources(raw:unknown){
  const values=sourceIdsSchema.parse(raw),ids=[...new Set(values)];
  if(ids.includes('*'))throw invalid('developer_scope_wildcard',moteText("来源范围必须明确列出，不能使用 * 通配整个资料库。"));
  return ids;
}

function explicitKinds(raw:unknown){
  const values=eventKindsSchema.parse(raw??[developerEventType]),kinds=[...new Set(values)];
  return kinds.filter(kind=>allowedEventKinds.has(kind));
}

/** Host-owned event journal and outbound webhook delivery for AI access.
 * Developer credentials live in Connections; this service owns the stable
 * event envelope, explicit source scope, endpoint secrets, retry budget and
 * delivery status. It is not a plugin package and cannot be installed. */
export class DeveloperAccessHost {
  private endpoints:WebhookEndpoint[]=[];
  private readonly file:PrivateFile<Saved>;
  private sequence:Promise<unknown>=Promise.resolve();
  private closed=false;
  private timer?:NodeJS.Timeout;
  private wakeQueued=false;
  private savepoint=0;
  private recorded=0;
  private readonly inFlight=new Set<Promise<unknown>>();
  private readonly endpointInFlight=new Set<string>();
  private readonly limits=new Map<string,{window:number;count:number}>();
  private readonly clock:()=>number;
  private readonly requestTimeoutMs:number;

  constructor(private readonly options:{store:Store;connections:Connections;clock?:()=>number;requestTimeoutMs?:number;file?:PrivateFile<Saved>}){
    this.clock=options.clock??Date.now;this.requestTimeoutMs=options.requestTimeoutMs??5000;
    this.file=options.file??new PrivateFile<Saved>(join(options.store.directory,'connectors'),'developer-webhooks.json');
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS developer_events(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event TEXT NOT NULL,source_id TEXT NOT NULL,
      material_id TEXT NOT NULL,revision TEXT NOT NULL,material_kind TEXT NOT NULL,device_id TEXT,
      occurred_at TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS developer_events_source ON developer_events(source_id,sequence);
      CREATE INDEX IF NOT EXISTS developer_events_type ON developer_events(event,sequence);
      CREATE TABLE IF NOT EXISTS developer_deliveries(
      id TEXT PRIMARY KEY,event_id TEXT NOT NULL,event_sequence INTEGER NOT NULL,endpoint_id TEXT NOT NULL,
      status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,http_status INTEGER,
      last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(event_id,endpoint_id));
      CREATE INDEX IF NOT EXISTS developer_deliveries_pending ON developer_deliveries(status,next_attempt_at,created_at);
      CREATE INDEX IF NOT EXISTS developer_deliveries_endpoint ON developer_deliveries(endpoint_id,created_at DESC);`);
    options.store.registerStorage('developer-access',{
      developer_events:"length(CAST(id AS BLOB))+length(CAST(event AS BLOB))+length(CAST(source_id AS BLOB))+length(CAST(material_id AS BLOB))+length(CAST(revision AS BLOB))+length(CAST(material_kind AS BLOB))+length(CAST(COALESCE(device_id,'') AS BLOB))+length(CAST(occurred_at AS BLOB))+length(CAST(created_at AS BLOB))+length(CAST(payload AS BLOB))+256",
      developer_deliveries:"length(CAST(id AS BLOB))+length(CAST(event_id AS BLOB))+length(CAST(endpoint_id AS BLOB))+length(CAST(status AS BLOB))+length(CAST(COALESCE(last_error,'') AS BLOB))+length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB))+160",
    });
  }

  async init(){
    if(this.closed)throw new DeveloperAccessError('developer_unavailable',503,moteText("Webhook 与 Developer API 暂不可用。"));
    try{
      const raw=await this.file.read();
      if(raw!==undefined){
        const saved=savedSchema.parse(raw),ids=new Set<string>();
        for(const endpoint of saved.endpoints){
          if(ids.has(endpoint.id))throw Error('duplicate endpoint');
          targetUrl(endpoint.url);explicitSources(endpoint.sourceIds);explicitKinds(endpoint.eventKinds);ids.add(endpoint.id);
        }
        this.endpoints=saved.endpoints;
      }
    }catch(error){
      if(error instanceof DeveloperAccessError)throw error;
      throw new DeveloperAccessError('developer_storage_invalid',503,moteText("Webhook 配置文件无法读取。保留数据并检查中央文件权限。"));
    }
    for(const endpoint of this.endpoints)if(!endpoint.enabled)this.failPending(endpoint.id);
    for(const row of this.options.store.db.prepare("SELECT DISTINCT endpoint_id FROM developer_deliveries WHERE status='pending'").all() as {endpoint_id:string}[])
      if(!this.endpoints.some(endpoint=>endpoint.id===row.endpoint_id))this.failPending(row.endpoint_id);
    this.prune();
    this.ensureTimer();
  }

  inventory():DeveloperAccessInventory {
    const credentials=this.options.connections.inventory().items.filter(item=>item.scope==='developer');
    return {credentials,endpoints:this.endpoints.map(endpoint=>this.publicEndpoint(endpoint)),deliveries:this.deliveries(50)};
  }

  mintCredential(raw:unknown){
    return this.options.connections.mintDeveloper(raw);
  }

  revokeCredential(id:string){
    z.string().uuid().parse(id);
    const found=this.options.connections.inventory().items.find(item=>item.id===id&&item.scope==='developer');
    if(!found)throw new DeveloperAccessError('developer_credential_not_found',404,moteText("未找到此开发者凭据。"));
    return this.options.connections.revoke(id);
  }

  createWebhook(raw:unknown){
    const input=z.object({label,url:z.string().max(2048),sourceIds:z.unknown(),eventKinds:z.unknown().optional(),
      enabled:z.boolean().optional(),maxAttempts:z.number().int().min(1).max(10).optional()}).strict().parse(raw);
    return this.serialize(async()=>{
      const now=new Date(this.clock()).toISOString(),secret=randomBytes(32).toString('base64url');
      const endpoint:WebhookEndpoint={id:randomUUID(),label:input.label,url:targetUrl(input.url),sourceIds:explicitSources(input.sourceIds),
        eventKinds:explicitKinds(input.eventKinds),enabled:input.enabled??true,secret,maxAttempts:input.maxAttempts??5,createdAt:now,updatedAt:now};
      await this.persist([...this.endpoints,endpoint]);
      return {endpoint:this.publicEndpoint(endpoint),secret};
    });
  }

  updateWebhook(id:string,raw:unknown){
    z.string().uuid().parse(id);
    const input=z.object({label:label.optional(),url:z.string().max(2048).optional(),sourceIds:z.unknown().optional(),
      eventKinds:z.unknown().optional(),enabled:z.boolean().optional(),maxAttempts:z.number().int().min(1).max(10).optional(),
      rotateSecret:z.boolean().optional()}).strict().parse(raw);
    return this.serialize(async()=>{
      const found=this.endpoints.find(endpoint=>endpoint.id===id);
      if(!found)throw new DeveloperAccessError('developer_webhook_not_found',404,moteText("未找到此 Webhook 端点。"));
      const secret=input.rotateSecret?randomBytes(32).toString('base64url'):found.secret;
      const endpoint:WebhookEndpoint={...found,...(input.label!==undefined?{label:input.label}:{}),
        ...(input.url!==undefined?{url:targetUrl(input.url)}:{}),...(input.sourceIds!==undefined?{sourceIds:explicitSources(input.sourceIds)}:{}),
        ...(input.eventKinds!==undefined?{eventKinds:explicitKinds(input.eventKinds)}:{}),...(input.enabled!==undefined?{enabled:input.enabled}:{}),
        ...(input.maxAttempts!==undefined?{maxAttempts:input.maxAttempts}:{}),secret,updatedAt:new Date(this.clock()).toISOString()};
      await this.persist(this.endpoints.map(value=>value.id===id?endpoint:value));
      if(!endpoint.enabled)this.failPending(id);
      return {endpoint:this.publicEndpoint(endpoint),...(input.rotateSecret?{secret}:{})};
    });
  }

  /** Disabling is durable and immediate: pending deliveries to this endpoint
   * fail closed instead of being sent after the owner turned it off. */
  disableWebhook(id:string){
    z.string().uuid().parse(id);
    return this.serialize(async()=>{
      const found=this.endpoints.find(endpoint=>endpoint.id===id);
      if(!found)throw new DeveloperAccessError('developer_webhook_not_found',404,moteText("未找到此 Webhook 端点。"));
      const endpoint={...found,enabled:false,updatedAt:new Date(this.clock()).toISOString()};
      await this.persist(this.endpoints.map(value=>value.id===id?endpoint:value));
      this.failPending(id);
      return {endpoint:this.publicEndpoint(endpoint)};
    });
  }

  deliveries(limit=50){
    const rows=this.options.store.db.prepare(`SELECT d.*,e.event event_type,e.material_id,e.source_id
      FROM developer_deliveries d LEFT JOIN developer_events e ON e.id=d.event_id
      ORDER BY d.created_at DESC LIMIT ?`).all(limit) as DeliveryRow[];
    const labels=new Map(this.endpoints.map(endpoint=>[endpoint.id,endpoint.label]));
    return rows.map(row=>({id:row.id,endpointId:row.endpoint_id,endpointLabel:labels.get(row.endpoint_id)??moteText('已停用端点'),
      eventId:row.event_id,eventType:row.event_type??developerEventType,...(row.material_id?{materialId:row.material_id}:{}),
      ...(row.source_id?{sourceId:row.source_id}:{}),status:row.status,attempts:row.attempts,
      nextAttemptAt:new Date(row.next_attempt_at).toISOString(),...(row.http_status!==null?{httpStatus:row.http_status}:{}),
      ...(row.last_error?{lastError:row.last_error}:{}),createdAt:row.created_at,updatedAt:row.updated_at})) satisfies DeveloperDeliveryView[];
  }

  /** The same journal backs the Developer API. A credential can only read the
   * event types and explicit source IDs frozen at issue time. */
  events(credential:ConnectionCredential,query:{after?:string;limit?:string}){
    if(credential.scope!=='developer')throw new DeveloperAccessError('developer_credential_required',403,moteText("此读取需要独立的开发者凭据。"));
    this.options.connections.assertActive(credential);
    if(!this.allow(credential))throw new DeveloperAccessError('developer_rate_limited',429,moteText("Developer API 请求过于频繁，请稍后重试。"));
    const sourceIds=credential.eventSourceIds??[],kinds=credential.eventKinds??[];
    if(!sourceIds.length||!kinds.length)return {events:[],nextCursor:null,hasMore:false};
    const after=Math.max(0,Number.parseInt(query.after??'0',10)||0);
    const limit=Math.min(100,Math.max(1,Number.parseInt(query.limit??'50',10)||50));
    const rows=this.options.store.db.prepare(`SELECT sequence,payload FROM developer_events
      WHERE sequence>? AND event IN (${kinds.map(()=>'?').join(',')}) AND source_id IN (${sourceIds.map(()=>'?').join(',')})
      ORDER BY sequence LIMIT ?`).all(after,...kinds,...sourceIds,limit+1) as {sequence:number;payload:string}[];
    const events=rows.slice(0,limit).map(row=>({cursor:Number(row.sequence),...JSON.parse(String(row.payload)) as DeveloperEventPayload}));
    return {events,nextCursor:events.length?events[events.length-1]!.cursor:null,hasMore:rows.length>limit};
  }

  /** Called from the Material publication transaction. The journal row and its
   * deliveries commit or roll back with the material itself. Network work is
   * never performed here. */
  recordPublication(event:MaterialPublicationEvent){
    if(this.closed||sensitiveMaterialKinds.has(event.kind))return;
    if(!this.hasConsumers())return;
    const sourceKind=this.sourceKind(event.sourceId);
    if(sourceKind&&sensitiveSourceKinds.has(sourceKind))return;
    try{this.recordUnsafe(event);}catch{/* Event delivery must not block archival. */}
  }

  async flush(force=true){
    const deadline=this.clock()+15_000;
    while(!this.closed&&this.clock()<deadline){
      const worked=await this.deliverDue(force?Number.MAX_SAFE_INTEGER:this.clock());
      if(!worked)break;
    }
    await Promise.allSettled([...this.inFlight]);
  }

  async close(){
    if(this.closed)return;this.closed=true;this.stopTimer();
    await this.sequence.catch(()=>{});await Promise.allSettled([...this.inFlight]);this.endpoints=[];
  }

  private hasConsumers(){
    return this.endpoints.some(endpoint=>endpoint.enabled)||this.options.connections.hasActiveDeveloper();
  }

  private sourceKind(sourceId:string){
    const row=this.options.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId) as {json:string}|undefined;
    if(!row)return undefined;
    try{return String((JSON.parse(String(row.json)) as {kind?:unknown}).kind??'');}catch{return undefined;}
  }

  private recordUnsafe(event:MaterialPublicationEvent){
    const db=this.options.store.db,payload:DeveloperEventPayload={id:`evt_${randomUUID()}`,type:developerEventType,version:1,
      occurredAt:event.occurredAt,sourceId:event.sourceId,material:{id:event.id,revision:event.revision,kind:event.kind,
        ...(event.deviceId?{deviceId:event.deviceId}:{})}};
    const body=JSON.stringify(payload),now=this.clock(),deliveries=this.endpoints.filter(endpoint=>endpoint.enabled&&
      endpoint.eventKinds.includes(developerEventType)&&endpoint.sourceIds.includes(event.sourceId));
    const nested=db.isTransaction,name=`developer_event_${++this.savepoint}`;
    if(nested)db.exec(`SAVEPOINT ${name}`);else db.exec('BEGIN IMMEDIATE');
    try{
      this.options.store.reserveMetadata(Buffer.byteLength(body)+deliveries.length*512+512);
      const inserted=db.prepare('INSERT INTO developer_events(id,event,source_id,material_id,revision,material_kind,device_id,occurred_at,created_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(payload.id,payload.type,event.sourceId,event.id,event.revision,event.kind,event.deviceId??null,event.occurredAt,new Date(now).toISOString(),body);
      const sequence=Number(inserted.lastInsertRowid),created=new Date(now).toISOString();
      for(const endpoint of deliveries)db.prepare(`INSERT INTO developer_deliveries(id,event_id,event_sequence,endpoint_id,status,attempts,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,'pending',0,?,?,?)`).run(randomUUID(),payload.id,sequence,endpoint.id,now,created,created);
      if(nested)db.exec(`RELEASE ${name}`);else db.exec('COMMIT');
      if(deliveries.length)this.wake();
      if(++this.recorded%100===0)this.prune();
    }catch(error){
      try{if(nested)db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);else db.exec('ROLLBACK');}catch{}
      throw error;
    }
  }

  private wake(){
    if(this.closed||this.wakeQueued)return;this.wakeQueued=true;
    queueMicrotask(()=>{this.wakeQueued=false;if(!this.closed)void this.deliverDue(this.clock()).catch(()=>{});});
  }

  private schedule(){
    if(this.closed||this.timer)return;
    this.timer=setInterval(()=>void this.deliverDue(this.clock()).catch(()=>{}),1000);this.timer.unref?.();
  }

  private ensureTimer(){if(this.endpoints.some(endpoint=>endpoint.enabled))this.schedule();else this.stopTimer();}
  private stopTimer(){if(this.timer){clearInterval(this.timer);this.timer=undefined;}}

  private async deliverDue(at:number){
    if(this.closed)return 0;
    const rows=this.options.store.db.prepare(`SELECT d.*,e.event event_type,e.material_id,e.source_id,e.payload body
      FROM developer_deliveries d LEFT JOIN developer_events e ON e.id=d.event_id
      WHERE d.status='pending' AND d.next_attempt_at<=? ORDER BY d.created_at LIMIT 20`).all(at) as DeliveryRow[];
    let worked=0;
    for(const row of rows){
      if(this.closed)break;
      const endpoint=this.endpoints.find(value=>value.id===row.endpoint_id);
      if(!endpoint||!endpoint.enabled){this.failDelivery(row,'endpoint_disabled',undefined);worked++;continue;}
      if(this.endpointInFlight.has(endpoint.id))continue;
      if(!row.body||!row.event_type){this.failDelivery(row,'event_unavailable',undefined);worked++;continue;}
      this.endpointInFlight.add(endpoint.id);worked++;
      const work=this.attempt(row,endpoint).finally(()=>this.endpointInFlight.delete(endpoint.id));
      this.inFlight.add(work);void work.finally(()=>this.inFlight.delete(work)).catch(()=>{});
    }
    if(worked)await Promise.allSettled([...this.inFlight]);
    return worked;
  }

  private async attempt(row:DeliveryRow,endpoint:WebhookEndpoint){
    const deliveryId=row.id,timestamp=new Date(this.clock()).toISOString(),body=row.body!;
    const signature=createHmac('sha256',endpoint.secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex');
    let httpStatus:number|undefined,error:string|undefined;
    try{
      await this.assertResolvedTarget(endpoint.url);
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),this.requestTimeoutMs);
      try{
        const response=await fetch(endpoint.url,{method:'POST',redirect:'manual',signal:controller.signal,
          headers:{'content-type':'application/json','user-agent':'mote-webhook/1','x-mote-delivery-id':deliveryId,
            'x-mote-event':developerEventType,'x-mote-timestamp':timestamp,'x-mote-signature':`sha256=${signature}`},body});
        httpStatus=response.status;
        try{await response.body?.cancel();}catch{}
        if(response.status<200||response.status>=300)error=`http_${response.status}`;
      }finally{clearTimeout(timeout);}
    }catch(cause){
      error=cause instanceof DeveloperAccessError?cause.code:cause instanceof Error&&cause.name==='AbortError'?'timeout':'transport_error';
    }
    const success=error===undefined,attempts=row.attempts+1,failed=!success&&attempts>=endpoint.maxAttempts;
    const status=success?'success':failed?'failed':'pending';
    const next=success||failed?row.next_attempt_at:this.clock()+Math.min(60_000,1000*2**(attempts-1));
    this.options.store.db.prepare('UPDATE developer_deliveries SET status=?,attempts=?,next_attempt_at=?,http_status=?,last_error=?,updated_at=? WHERE id=?')
      .run(status,attempts,next,httpStatus??null,error?.slice(0,200)??null,new Date(this.clock()).toISOString(),deliveryId);
  }

  private failDelivery(row:DeliveryRow,error:string,httpStatus:number|undefined){
    this.options.store.db.prepare('UPDATE developer_deliveries SET status=\'failed\',attempts=attempts+1,http_status=?,last_error=?,updated_at=? WHERE id=?')
      .run(httpStatus??null,error,new Date(this.clock()).toISOString(),row.id);
  }

  private failPending(endpointId:string){
    this.options.store.db.prepare("UPDATE developer_deliveries SET status='failed',last_error='endpoint_disabled',updated_at=? WHERE endpoint_id=? AND status='pending'")
      .run(new Date(this.clock()).toISOString(),endpointId);
  }

  private async assertResolvedTarget(raw:string){
    const host=new URL(raw).hostname.replace(/^\[|\]$/g,'');
    const addresses=await lookup(host,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(value=>metadataHost(value.address)))throw denied(moteText("Webhook 目标解析到云元数据地址，已拒绝投递。"));
  }

  private allow(credential:ConnectionCredential){
    const limit=credential.rateLimitPerMinute??60,now=this.clock(),bucket=this.limits.get(credential.id);
    if(!bucket||now-bucket.window>=60_000){this.limits.set(credential.id,{window:now,count:1});return true;}
    if(bucket.count>=limit)return false;
    bucket.count++;return true;
  }

  private prune(){
    try{
      this.options.store.db.prepare(`DELETE FROM developer_events WHERE sequence IN
        (SELECT sequence FROM developer_events e WHERE e.sequence<=? AND NOT EXISTS
          (SELECT 1 FROM developer_deliveries d WHERE d.event_id=e.id AND d.status='pending') ORDER BY sequence LIMIT 200)`).run(
        Number((this.options.store.db.prepare('SELECT COALESCE(MAX(sequence),0) value FROM developer_events').get() as {value:number}).value)-maxEventRows);
      this.options.store.db.prepare(`DELETE FROM developer_deliveries WHERE id IN
        (SELECT id FROM developer_deliveries ORDER BY created_at DESC LIMIT -1 OFFSET ?)`).run(maxDeliveryRows);
    }catch{/* Retention is best effort; the event and delivery caps still bound growth. */}
  }

  private publicEndpoint(endpoint:WebhookEndpoint):DeveloperWebhookView{
    const {secret:_,...visible}=endpoint;return {...visible,hasSecret:true};
  }

  private async persist(endpoints:WebhookEndpoint[]){
    if(this.closed)throw new DeveloperAccessError('developer_unavailable',503,moteText("Webhook 与 Developer API 暂不可用。"));
    if(Buffer.byteLength(JSON.stringify({version:1,endpoints}))>2*1024*1024)
      throw new DeveloperAccessError('developer_storage_limit',409,moteText("Webhook 配置已达到存储上限。"));
    try{await this.file.write({version:1,endpoints});}catch{throw new DeveloperAccessError('developer_storage_failed',503,moteText("Webhook 配置未保存，操作未生效。"));}
    this.endpoints=endpoints;this.ensureTimer();
  }

  private serialize<T>(run:()=>Promise<T>):Promise<T>{
    const work=this.sequence.catch(()=>{}).then(()=>{
      if(this.closed)throw new DeveloperAccessError('developer_unavailable',503,moteText("Webhook 与 Developer API 暂不可用。"));
      return run();
    });this.sequence=work;return work;
  }
}
