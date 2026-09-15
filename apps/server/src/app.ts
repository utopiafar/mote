import Fastify,{type FastifyReply,type FastifyRequest} from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { timingSafeEqual,randomUUID } from 'node:crypto';
import { existsSync,readFileSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { z } from 'zod';
import { captureSchema,noteSchema,noteCapture,heartbeatSchema,rangeSchema,type QueryResult,type CaptureRecord } from '@mote/shared';
import { AgentNotConfiguredError,type ContextReader } from '@mote/agent';
import { modelProvider } from '@mote/shared/models';
import { ModelSettingsStore,ModelSettingsError } from './model-settings.js';
import { ReloadableAgent,modelSettingsFromConfig,applyModelSettings,createModelAgent,testModelConnection,type ModelAgentFactory } from './model-agent.js';
import { Store,StoreError } from './store.js';
import { Indexer } from './indexer.js';
import { repositoryRoot,type Config } from './config.js';
import { ServerDiagnostics,safeError } from './diagnostics.js';
import { serverConfiguration } from './configuration.js';
import { SourceStore } from './sources.js';
import {registerConnectors} from './connectors/index.js';
import { MemoryStore,MEMORY_EXTRACTION_PROMPT } from './memory.js';
import {createUpdateService,registerUpdateRoutes} from './updates.js';
import {Connections,ConnectionError,type ConnectionCredential} from './connections.js';
import {registerCaptureBrowser} from './capture-browser.js';

type QueryScope = {after?:string;before?:string;deviceId?:string;timeZone?:string};
export interface QueryAgent {configured:boolean;query(args:QueryScope&{question:string}):Promise<QueryResult>;close():Promise<void>}
const scopeFields={after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),deviceId:z.string().min(1).max(200).optional(),timeZone:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},{message:'Unknown time zone'}).optional()};
const validRange=(v:QueryScope)=>!v.after||!v.before||Date.parse(v.after)<Date.parse(v.before);
const querySchema=z.object({question:z.string().trim().min(1).max(8000),...scopeFields}).strict().refine(validRange,{message:'Invalid time range'});
const insightSchema=z.object(scopeFields).strict().refine(validRange,{message:'Invalid time range'});
const serverVersion=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
export async function buildApp(config:Config,dependencies?:{store?:Store;agent?:QueryAgent;connections?:Connections;createModelAgent?:ModelAgentFactory}) {
  config={...config};
  const store=dependencies?.store??new Store(config.dataDir,{dataKey:config.dataKey,maxStorageBytes:config.maxStorageBytes,embeddingEnabled:Boolean(config.embeddingModel)});
  const diagnostics=new ServerDiagnostics({enabled:config.diagnosticsEnabled,debug:config.diagnosticsDebug,level:config.logLevel,directory:config.logDirectory??join(config.dataDir,'logs'),maxBytes:config.logMaxBytes,maxFiles:config.logMaxFiles,maxEntries:config.logMaxEntries});
  await diagnostics.init();
  const indexer=new Indexer(store,config,diagnostics);
  const sources=new SourceStore(store),memories=new MemoryStore(store);
  const connections=dependencies?.connections??new Connections(store,sources);await connections.init();
  const identities=new WeakMap<FastifyRequest,ConnectionCredential>();
  const credential=(req:FastifyRequest)=>identities.get(req);
  const sourceOwner=(req:FastifyRequest,id:string)=>{const c=credential(req);if(c)connections.assertOwnSource(c,id);};
  const context=(records:CaptureRecord[])=>records.map(record=>({...record,sourceType:record.source,...(record.provenance?{revisionState:sources.getItem(record.provenance.sourceId,record.provenance.externalId)?.captureId===record.id?'current':'historical'}:{})}));
  const reader:ContextReader={
      mediaActivity:async args=>diagnostics.measure('source','activity',()=>store.mediaActivity(args),result=>({count:result.observations})),
      sourceHistory:async args=>{const record=store.evidence([args.id])[0];if(!record?.provenance)return [];return context(store.evidence(sources.history(record.provenance.sourceId,record.provenance.externalId).filter(i=>(!args.after||Date.parse(i.calendar?.end??i.observedAt)>=Date.parse(args.after))&&(!args.before||Date.parse(i.calendar?.start??i.observedAt)<Date.parse(args.before))).map(i=>i.captureId)).filter(r=>!args.deviceId||r.deviceId===args.deviceId));},
      sources:async args=>sources.listSources().filter(s=>!args.deviceId||s.deviceId===args.deviceId).map(s=>({id:s.id,name:s.name,kind:s.kind,retention:s.retention,enabled:s.enabled,status:s.status})),
      sourceItems:async args=>{const page=sources.listItems(args);return {...page,items:context(store.evidence(page.items.map(i=>i.captureId)))};},
      memories:async args=>{if(!args.id)return {items:memories.list({...args,level:'overview'})};const items=memories.list({...args,level:'detail',limit:100}).filter(m=>m.id===args.id);return {items,evidence:context(store.evidence(items.flatMap(m=>'evidenceIds' in m?m.evidenceIds:[])))};},
      search:async args=>diagnostics.measure('source','search',async()=>context(await indexer.search(args)),rows=>({count:rows.length})),timeline:async args=>diagnostics.measure('source','timeline',()=>{const page=store.list(args);return {...page,items:context(page.items)};},page=>({count:page.items.length})),evidence:async args=>diagnostics.measure('source','evidence',()=>context(store.evidence(args.ids)),rows=>({count:rows.length})),activity:async args=>diagnostics.measure('source','activity',()=>store.activity(args),result=>({count:result.captures})),devices:async()=>diagnostics.measure('source','devices',()=>store.devices(),rows=>({count:rows.length}))};
  const agent=new ReloadableAgent(()=>diagnostics.record('agent.failed',{category:'internal'},'error'));
  const factory=dependencies?.createModelAgent??createModelAgent;
  let initialAgent=dependencies?.agent;
  const modelSettings=new ModelSettingsStore({
    directory:config.dataDir,environment:modelSettingsFromConfig(config),
    prepare:async settings=>{
      const candidate=initialAgent??await factory(settings,reader);initialAgent=undefined;
      return agent.prepare(candidate,()=>applyModelSettings(config,settings));
    },
    probe:settings=>testModelConnection(settings,factory),
  });
  try{await modelSettings.initialize();}catch(error){await agent.close();await connections.close();await indexer.close();if(!dependencies?.store)store.close();await diagnostics.close();throw error;}
  // Fastify/Pino request and Error serializers may contain raw URLs, bodies or SDK text.
  // Emit only our fixed-schema events, never serialize arbitrary request/error objects.
  const app=Fastify({logger:false,genReqId:()=>randomUUID(),requestIdHeader:false,bodyLimit:12*1024*1024,requestTimeout:180000,frameworkErrors:(_error,_req,reply)=>{const requestId=randomUUID();diagnostics.record('request.failed',{requestId,route:'unknown',category:'validation',statusCode:400},'warn');(reply as FastifyReply).header('X-Request-Id',requestId).code(400).send({error:'validation',message:'请求格式无效。',requestId});}});
  const routeName=(url:string|undefined)=>{
    if(!url)return 'unknown';if(!url.startsWith('/api/'))return 'web';if(url.endsWith('/image'))return 'image';
    const root=url.split('/')[2];return ({health:'health',status:'status',configuration:'configuration','model-settings':'configuration',captures:'captures',notes:'notes',devices:'devices',connections:'connections',sources:'sources',memories:'memories',layers:'layers',connectors:'connectors',updates:'updates',activity:'activity',query:'query',insights:'insights',index:'index',export:'export',import:'import',diagnostics:'diagnostics','support-bundle':'support'} as Record<string,string>)[root]??'unknown';
  };
  app.addHook('onRequest',(req,reply,done)=>diagnostics.run(req.id,()=>{reply.header('X-Request-Id',req.id);diagnostics.record('request.started',{requestId:req.id,route:routeName(req.routeOptions.url)},'debug');done();}));
  app.addHook('onResponse',async(req,reply)=>{diagnostics.record('request.completed',{requestId:req.id,route:routeName(req.routeOptions.url),statusCode:reply.statusCode,durationMs:reply.elapsedTime},reply.statusCode>=500?'error':reply.statusCode>=400?'warn':'info');});
  await app.register(cors,{origin:config.allowedOrigins,credentials:false});
  const expectedBearer=Buffer.from(`Bearer ${config.token}`);
  const validBearer=(req:{headers:{authorization?:string}})=>{if(typeof req.headers.authorization!=='string')return false;const supplied=Buffer.from(req.headers.authorization);return supplied.length===expectedBearer.length&&timingSafeEqual(supplied,expectedBearer);};
  await app.register(rateLimit,{max:180,timeWindow:'1 minute',keyGenerator:req=>validBearer(req)?'authenticated-owner':connections.authenticate(req.headers.authorization)?.id??`unauthenticated:${req.ip}`,errorResponseBuilder:(req,context)=>({statusCode:context.statusCode,error:'rate_limited',message:'请求过于频繁，请稍后重试。',requestId:req.id})});
  app.addHook('onRequest',async(req,reply)=>{
    const isApi=req.routeOptions.url?.startsWith('/api/')||req.url.startsWith('/api/');
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if(isApi)reply.header('Cache-Control','no-store');
    if(req.method==='OPTIONS'||req.routeOptions.url==='/api/health'||!isApi||(req.method==='POST'&&req.routeOptions.url==='/api/connections/redeem'))return;
    if(validBearer(req))return;
    const c=connections.authenticate(req.headers.authorization);
    if(!c)return reply.code(401).send({error:'unauthorized',message:'请提供有效访问令牌；管理网页请重新登录',requestId:req.id});
    identities.set(req,c);connections.assertCollectorRoute(c,req.method,req.routeOptions.url??'');
  });
  app.setErrorHandler((error,req,reply)=>{
    const failure=safeError(error);
    diagnostics.record('request.failed',{requestId:req.id,route:routeName(req.routeOptions.url),category:failure.category,statusCode:failure.status},failure.status>=500?'error':'warn');
    if(error instanceof ConnectionError)return reply.code(error.statusCode).send({error:error.code,message:error.publicMessage,requestId:req.id});
    if(error instanceof ModelSettingsError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});
    reply.code(failure.status).send({error:failure.category,message:failure.message,requestId:req.id});
  });
  const connectors=await registerConnectors(app,{sources,store,config,mcpAuthorization:header=>connections.mcpAuthorization(header,config.connectors)});
  const connectionRate={rateLimit:{max:20,timeWindow:'1 minute'}};
  app.post('/api/connections/invitations',{bodyLimit:8192,config:connectionRate},async req=>connections.invite(req.body));
  app.post('/api/connections/invitations/revoke',{bodyLimit:8192,config:connectionRate},async req=>connections.cancelInvitation(req.body));
  app.post('/api/connections/redeem',{bodyLimit:8192,config:{rateLimit:{max:12,timeWindow:'1 minute',keyGenerator:(req:FastifyRequest)=>`redeem:${req.ip}`}}},async req=>connections.redeem(req.body));
  app.get('/api/connections',async()=>connections.inventory(config.connectors));
  app.delete('/api/connections/:id',{config:connectionRate},async req=>connections.revoke((req.params as {id:string}).id));
  app.post('/api/connections/mcp',{bodyLimit:8192,config:connectionRate},async req=>connections.mintMcp(req.body,config.connectors));
  app.get('/api/connections/self',async req=>{
    const c=credential(req);if(c)connections.assertActive(c);
    const owner=!c,collector=c?.scope==='collector';
    return {credential:c?{id:c.id,scope:c.scope,label:c.label,serverUrl:c.serverUrl,...(c.deviceId?{deviceId:c.deviceId,deviceName:c.deviceName,platform:c.platform}:{})}:{id:'owner',scope:'owner',label:'节点所有者'},node:{version:serverVersion,profile:config.profile??'legacy'},capabilities:{ingest:owner||collector,ownSources:owner||collector,archiveRead:owner||c?.scope==='mcp-read'}};
  });
  const softwareUpdate=createUpdateService({currentVersion:serverVersion,profile:config.profile,runtime:config.configuration?.runtime,profileHome:config.configuration?.hostConfigFile?dirname(dirname(config.configuration.hostConfigFile)):undefined,repository:config.updateRepository,channel:config.updateChannel});
  registerUpdateRoutes(app,softwareUpdate);
  registerCaptureBrowser(app,{store,connections,credential});
  app.get('/api/health',async()=>({ok:true,version:serverVersion}));
  app.get('/api/status',async()=>({profile:config.profile??'legacy',agent:{configured:agent.configured,provider:modelProvider(config.modelProvider??'deepseek')?.name??config.modelProvider,runtime:'DeepSeek Harness',protocol:config.modelProtocol,model:config.model||null,reasoningEffort:config.modelReasoningEffort??'high',maxTokens:config.modelMaxTokens??8192,timeoutMs:config.modelTimeoutMs??120000},storage:store.stats(),index:{mode:indexer.configured?'hybrid':'text',model:config.embeddingModel||null},diagnostics:diagnostics.snapshot(),retentionDays:config.retentionDays,insightIntervalHours:config.insightIntervalHours,serverTime:new Date().toISOString()}));
  app.get('/api/configuration',async()=>serverConfiguration(config,{modelSource:modelSettings.view().source}));
  app.get('/api/model-settings',async()=>modelSettings.view());
  app.put('/api/model-settings',{bodyLimit:65536,config:connectionRate},async req=>modelSettings.update(req.body));
  app.delete('/api/model-settings',{bodyLimit:8192,config:connectionRate},async req=>modelSettings.reset(req.body));
  app.post('/api/model-settings/test',{bodyLimit:65536,config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async req=>modelSettings.test(req.body));
  app.get('/api/sources',async req=>{const c=credential(req);if(c)connections.assertActive(c);return {items:sources.listSources().filter(s=>!c||s.deviceId===c.deviceId)};});
  app.post('/api/sources',async req=>{const c=credential(req);if(c){connections.assertOwnDevice(c,req.body);const id=(req.body as {id?:unknown}).id;if(typeof id==='string'&&sources.listSources().some(s=>s.id===id))connections.assertOwnSource(c,id);}return sources.register(req.body);});
  app.patch('/api/sources/:id',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return sources.update(id,z.object({name:z.string().min(1).max(200).optional(),enabled:z.boolean().optional(),retention:z.enum(['snapshot','reference','archive']).optional()}).strict().parse(req.body));});
  const sourceRange=z.object({sourceId:z.string().max(128).optional(),deviceId:z.string().max(128).optional(),kind:z.string().max(40).optional(),after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(200).default(50),cursor:z.string().max(100).optional(),includeDeleted:z.enum(['true','false']).optional()}).strict();
  function scopedSourceRange(req:FastifyRequest){const q=sourceRange.parse(req.query),c=credential(req);if(c){connections.assertActive(c);if(q.deviceId&&q.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,'只能读取本设备来源。');if(q.sourceId)sourceOwner(req,q.sourceId);q.deviceId=c.deviceId;}return {...q,includeDeleted:q.includeDeleted==='true'};}
  app.get('/api/source-items',async req=>sources.listItems(scopedSourceRange(req)));
  app.get('/api/sources/:id/items',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return sources.listItems({...scopedSourceRange(req),sourceId:id});});
  app.put('/api/sources/:id/items',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return sources.upsert(id,req.body,credential(req)?()=>sourceOwner(req,id):undefined);});
  app.get('/api/sources/:id/item',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const {externalId}=z.object({externalId:z.string().min(1).max(1000)}).strict().parse(req.query);return {item:sources.getItem(id,externalId)??null};});
  app.get('/api/sources/:id/history',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const {externalId}=z.object({externalId:z.string().min(1).max(1000)}).strict().parse(req.query);return {items:sources.history(id,externalId)};});
  app.get('/api/layers',async()=>({...sources.summary(),memories:Number((store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as {n:number}).n)}));
  app.get('/api/memories',async req=>{const q=z.object({level:z.enum(['overview','detail']).default('overview'),includeStale:z.enum(['true','false']).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).strict().parse(req.query);return {items:memories.list({...q,includeStale:q.includeStale==='true'})};});
  app.get('/api/memories/:id',async req=>memories.get((req.params as {id:string}).id));
  app.get('/api/memories/:id/evidence',async req=>{const m=memories.get((req.params as {id:string}).id);return {items:store.evidence(m.evidenceIds),status:m.status};});
  app.post('/api/memories/:id/publish',async req=>memories.publish((req.params as {id:string}).id));
  app.delete('/api/memories/:id',async req=>memories.delete((req.params as {id:string}).id));
  app.post('/api/captures',async(req,reply)=>{const input=captureSchema.parse(req.body),c=credential(req);if(c)connections.assertCapture(c,input);const result=await diagnostics.measure('ingest','capture',()=>store.ingest(input,c?()=>connections.assertCapture(c,input):undefined),r=>({count:r.duplicate?0:1}));return reply.code(result.duplicate?200:201).send(result);});
  app.get('/api/captures',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return diagnostics.measure('source','timeline',()=>store.list({...args,cursor:raw.cursor}),page=>({count:page.items.length}));
  });
  app.get('/api/captures/:id/image',async(req,reply)=>{const {bytes,mime}=store.image((req.params as {id:string}).id);return reply.type(mime).send(bytes);});
  app.get('/api/captures/:id',async req=>{const record=store.evidence([(req.params as {id:string}).id])[0];if(!record)throw new StoreError('Capture not found',404);return record;});
  app.delete('/api/captures/:id',async req=>store.delete((req.params as {id:string}).id));
  // Notes share capture IDs, indexing, archive export and deletion tombstones.
  // The convenience route does not rewrite the author's text or infer their mood.
  app.post('/api/notes',async(req,reply)=>{const input=noteCapture(noteSchema.parse(req.body)),c=credential(req);if(c)connections.assertCapture(c,input);const result=await diagnostics.measure('ingest','note',()=>store.ingest(input,c?()=>connections.assertCapture(c,input):undefined),r=>({count:r.duplicate?0:1}));return reply.code(result.duplicate?200:201).send(result);});
  app.get('/api/notes',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return diagnostics.measure('source','timeline',()=>store.list({...args,source:'note',cursor:raw.cursor}),page=>({count:page.items.length}));
  });
  function noteById(id:string) {const record=store.evidence([id])[0];if(!record||record.source!=='note')throw new StoreError('Note not found',404);return record;}
  app.get('/api/notes/:id',async req=>noteById((req.params as {id:string}).id));
  app.delete('/api/notes/:id',async req=>{const {id}=req.params as {id:string};const record=store.evidence([id])[0];if(record&&record.source!=='note')throw new StoreError('Note not found',404);return store.delete(id);});
  app.post('/api/devices/heartbeat',async req=>{const beat=heartbeatSchema.parse(req.body),c=credential(req);if(c){connections.assertOwnDevice(c,beat);connections.assertPlatform(c,beat.platform);}const result=store.heartbeat(beat);diagnostics.record('queue.snapshot',{queueDepth:beat.queueDepth});return result;});
  app.get('/api/devices',async()=>({items:store.devices()}));
  app.get('/api/updates',async req=>{const {cursor,limit}=z.object({cursor:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(req.query);return store.updates(cursor,limit);});
  app.get('/api/activity',async req=>store.activity(rangeSchema.parse(req.query)));
  const mediaRange=z.object({
    after:z.string().max(64).datetime({offset:true}).optional(),before:z.string().max(64).datetime({offset:true}).optional(),
    deviceId:z.string().min(1).max(128).optional(),appId:z.string().min(1).max(300).optional(),collection:z.enum(['content','activity']).optional(),
    appVisibility:z.enum(['foreground','background','unknown']).optional(),
    screenLocked:z.enum(['true','false']).transform(value=>value==='true').optional(),playbackType:z.enum(['local','remote','unknown']).optional(),
  }).strict().refine(value=>!value.after||!value.before||Date.parse(value.after)<Date.parse(value.before),{message:'Invalid time range'});
  app.get('/api/media-activity',async req=>{
    const query=mediaRange.parse(req.query),c=credential(req);
    if(c){connections.assertActive(c);if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,'只能读取本设备的媒体采集统计。');query.deviceId=c.deviceId;}
    return store.mediaActivity(query);
  });
  let closing=false;
  const activeQueries=new Set<Promise<QueryResult>>();
  function queryAgent(input:QueryScope&{question:string},operation:'query'|'insight'='query') {
    if(closing)throw new StoreError('Central node is shutting down',503);
    if(activeQueries.size>=2)throw new StoreError('Two Agent queries are already running; retry shortly',429);
    const revision=store.deletionRevision();
    const promise=diagnostics.measure('agent',operation,()=>agent.query(input).then(result=>{
      if(store.deletionRevision()!==revision)throw new StoreError('Evidence was deleted during this run; retry against the updated archive',409);
      return result;
    }),result=>({citations:result.citations.length,toolCalls:result.trace.length,activeQueries:activeQueries.size}));
    activeQueries.add(promise);void promise.finally(()=>activeQueries.delete(promise)).catch(()=>{});return promise;
  }
  app.post('/api/memories/extract',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{if(!agent.configured)throw new AgentNotConfiguredError();const scope=insightSchema.parse(req.body??{}),model=config.model;return memories.extract(await queryAgent({...scope,question:MEMORY_EXTRACTION_PROMPT}),model);});
  app.post('/api/query',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async req=>{
    if(!agent.configured)throw new AgentNotConfiguredError();
    return queryAgent(querySchema.parse(req.body));
  });
  async function insight(range:QueryScope) {
    if(!agent.configured)throw new AgentNotConfiguredError();
    const result=await queryAgent({question:'请根据这段时间的上下文记录，生成中文个人回顾：我最近做了什么，时间花在哪里，哪些事情可能值得继续关注。自由选择工具检索并解释发现，区分事实、推断与信息缺口，每个具体发现引用原始记录。可用 media_activity 查看锁屏和后台的媒体播放采样；媒体播放与屏幕时长独立，不能相加为专注或真实劳动时间。音乐、有声书等内容类型依据原始媒体证据判断，播放状态不证明听完或投入注意力，权限缺失不证明未播放，不臆造待办或意图。',...range},'insight');
    store.saveInsight(result,result.runId);return result;
  }
  app.post('/api/insights',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{return insight(insightSchema.parse(req.body??{}));});
  app.get('/api/insights',async()=>({items:store.insights()}));
  app.post('/api/index/retry',async()=>{if(!indexer.configured)throw new StoreError('Embedding model is not configured',409);const result=store.retryIndex();diagnostics.record('queue.snapshot',{pending:result.queued});return result;});
  app.get('/api/export',async(_req,reply)=>reply.header('Content-Disposition',`attachment; filename="mote-${new Date().toISOString().slice(0,10)}.json"`).send(store.exportArchive(config.maxExportBytes)));
  app.post('/api/import',{bodyLimit:config.maxExportBytes},async req=>diagnostics.measure('ingest','import',()=>store.importArchive(req.body),r=>({count:r.imported})));
  function diagnosticSnapshot() {
    const counts=store.indexCounts(),devices=store.devices(),storage=store.stats();
    return {version:1,scope:'central-safe-diagnostics',...diagnostics.snapshot(),services:{agentConfigured:agent.configured,embeddingConfigured:indexer.configured,activeQueries:activeQueries.size,closing},queue:{index:counts,devices:devices.length,reportedPending:devices.reduce((n,d)=>n+d.queueDepth,0)},storage:{captures:storage.captures,imageCaptures:storage.imageCaptures,blobs:storage.blobs,bytes:storage.bytes,logicalBytes:storage.logicalBytes,maxBytes:storage.maxBytes,imagesEncrypted:storage.imagesEncrypted}};
  }
  app.get('/api/diagnostics',async()=>diagnosticSnapshot());
  app.get('/api/diagnostics/logs',async(req,reply)=>{const {file}=z.object({file:z.coerce.number().int().min(0).max(9).default(0)}).strict().parse(req.query);return reply.type('text/plain; charset=utf-8').send(await diagnostics.readRaw(file));});
  app.get('/api/diagnostics/events',async req=>{const args=z.object({afterSeq:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.coerce.number().int().min(1).max(500).default(200)}).strict().parse(req.query);return diagnostics.events(args.afterSeq,args.limit);});
  app.get('/api/support-bundle',async(req,reply)=>{diagnostics.record('support.exported',{requestId:req.id});await diagnostics.flush();return reply.header('Content-Disposition','attachment; filename="mote-support.json"').type('application/json').send({version:1,scope:'central-safe-support',createdAt:new Date().toISOString(),snapshot:diagnosticSnapshot(),events:diagnostics.recent(500)});});
  const web=join(repositoryRoot,'apps/web/dist');
  if(existsSync(web)) {
    await app.register(staticFiles,{root:web,prefix:'/'});
    app.setNotFoundHandler(async(req,reply)=>{
      if(req.url.startsWith('/api/'))return reply.code(404).send({error:'not_found',requestId:req.id});
      return reply.type('text/html').sendFile('index.html');
    });
    app.addHook('onSend',async(req,reply,payload)=>{
      if(!req.url.startsWith('/api/'))reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return payload;
    });
  } else app.setNotFoundHandler((req,reply)=>reply.code(404).send({error:'not_found',message:'未找到所请求的资料。',requestId:req.id}));
  const indexTimer=setInterval(()=>void indexer.tick().catch(()=>{diagnostics.record('index.failed',{category:'internal'},'error');}),5000);indexTimer.unref();
  const maintenance=()=>{if(config.retentionDays>0)void diagnostics.run(randomUUID(),()=>diagnostics.measure('maintenance','retention',()=>store.prune(new Date(Date.now()-config.retentionDays*86400000).toISOString()),deleted=>({deleted}))).catch(()=>{});};
  maintenance();const retentionTimer=setInterval(maintenance,3600000);retentionTimer.unref();
  let backgroundInsight:Promise<void>|undefined;
  const insightTimer=config.insightIntervalHours>0?setInterval(()=>{
    if(backgroundInsight||!agent.configured||closing)return;
    backgroundInsight=diagnostics.run(randomUUID(),()=>insight({after:new Date(Date.now()-config.insightIntervalHours*3600000).toISOString(),before:new Date().toISOString()})).then(()=>{},()=>{}).finally(()=>{backgroundInsight=undefined;});
  },config.insightIntervalHours*3600000):undefined;insightTimer?.unref();
  diagnostics.record('server.started');
  app.addHook('onClose',async()=>{
    closing=true;clearInterval(indexTimer);clearInterval(retentionTimer);if(insightTimer)clearInterval(insightTimer);
    await modelSettings.close();
    try{await agent.close();}catch(error){diagnostics.record('agent.failed',{category:safeError(error).category},'error');}
    await Promise.allSettled([...activeQueries]);await backgroundInsight;await connectors.close();await softwareUpdate.close();await connections.close();
    try{await indexer.close();}finally{try{if(!dependencies?.store)store.close();}finally{diagnostics.record('server.stopping');await diagnostics.close();}}
  });
  return {app,store,sources,memories,indexer,agent,diagnostics,connections,modelSettings};
}
