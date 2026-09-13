import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z,ZodError } from 'zod';
import { captureSchema,noteSchema,noteCapture,heartbeatSchema,rangeSchema,type QueryResult,type CaptureRecord } from '@mote/shared';
import { Store,StoreError } from './store.js';
import { Indexer } from './indexer.js';
import { repositoryRoot,type Config } from './config.js';

export interface QueryAgent {configured:boolean;query(args:{question:string;after?:string;before?:string}):Promise<QueryResult>;close():Promise<void>}
const querySchema=z.object({question:z.string().trim().min(1).max(8000),after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional()}).strict().refine(v=>!v.after||!v.before||Date.parse(v.after)<Date.parse(v.before),{message:'Invalid time range'});
export async function buildApp(config:Config,dependencies?:{store?:Store;agent?:QueryAgent}) {
  const store=dependencies?.store??new Store(config.dataDir,{dataKey:config.dataKey,maxStorageBytes:config.maxStorageBytes,embeddingEnabled:Boolean(config.embeddingModel)});
  const indexer=new Indexer(store,config);
  let agent:QueryAgent;
  if(dependencies?.agent)agent=dependencies.agent;
  else {
    const {createAgent}=await import('@mote/agent');
    const context=(records:CaptureRecord[])=>records.map(record=>({...record,sourceType:record.source}));
    agent=await createAgent({reader:{search:async args=>context(await indexer.search(args)),timeline:async args=>context(store.list(args).items),evidence:async args=>context(store.evidence(args.ids)),activity:async args=>store.activity(args),devices:async()=>store.devices()},baseUrl:config.modelBaseUrl,apiKey:config.apiKey,model:config.model,allowUnauthenticatedLocal:config.allowUnauthenticatedLocal});
  }
  const app=Fastify({logger:{level:process.env.MOTE_LOG_LEVEL||'warn',redact:['req.headers.authorization','req.body','res.body']},bodyLimit:12*1024*1024,requestTimeout:180000});
  await app.register(cors,{origin:config.allowedOrigins,credentials:false});
  await app.register(rateLimit,{max:180,timeWindow:'1 minute'});
  app.addHook('onRequest',async(req,reply)=>{
    const isApi=req.routeOptions.url?.startsWith('/api/')||req.url.startsWith('/api/');
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if(isApi)reply.header('Cache-Control','no-store');
    if(req.method==='OPTIONS'||req.routeOptions.url==='/api/health'||!isApi)return;
    const supplied=Buffer.from(req.headers.authorization??'');const expected=Buffer.from(`Bearer ${config.token}`);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply.code(401).send({error:'unauthorized',message:'请连接中央节点并输入有效访问令牌'});
  });
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof ZodError || (error instanceof Error&&error.name==='ZodError'&&Array.isArray((error as ZodError).issues)))return reply.code(400).send({error:'validation',message:(error as ZodError).issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')});
    const e=error as Error&{statusCode?:number;code?:string};const status=e.statusCode??(e.name==='AgentNotConfiguredError'?503:500);
    if(status>=500)req.log.error({message:e.message,name:e.name},'request failed');
    reply.code(status).send({error:e.code??e.name,message:status===500?'请求未完成，请检查服务日志或模型配置。':e.message});
  });
  app.get('/api/health',async()=>({ok:true,version:'0.2.0'}));
  app.get('/api/status',async()=>({agent:{configured:agent.configured,provider:'DeepSeek Harness',model:config.model||null},storage:store.stats(),index:{mode:indexer.configured?'hybrid':'text',model:config.embeddingModel||null},retentionDays:config.retentionDays,insightIntervalHours:config.insightIntervalHours,serverTime:new Date().toISOString()}));
  app.post('/api/captures',async(req,reply)=>{const result=await store.ingest(captureSchema.parse(req.body));return reply.code(result.duplicate?200:201).send(result);});
  app.get('/api/captures',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return store.list({...args,cursor:raw.cursor});
  });
  app.get('/api/captures/:id/image',async(req,reply)=>{const {bytes,mime}=store.image((req.params as {id:string}).id);return reply.type(mime).send(bytes);});
  app.get('/api/captures/:id',async req=>{const record=store.evidence([(req.params as {id:string}).id])[0];if(!record)throw new StoreError('Capture not found',404);return record;});
  app.delete('/api/captures/:id',async req=>store.delete((req.params as {id:string}).id));
  // Notes share capture IDs, indexing, archive export and deletion tombstones.
  // The convenience route does not rewrite the author's text or infer their mood.
  app.post('/api/notes',async(req,reply)=>{const result=await store.ingest(noteCapture(noteSchema.parse(req.body)));return reply.code(result.duplicate?200:201).send(result);});
  app.get('/api/notes',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return store.list({...args,source:'note',cursor:raw.cursor});
  });
  function noteById(id:string) {const record=store.evidence([id])[0];if(!record||record.source!=='note')throw new StoreError('Note not found',404);return record;}
  app.get('/api/notes/:id',async req=>noteById((req.params as {id:string}).id));
  app.delete('/api/notes/:id',async req=>{const {id}=req.params as {id:string};const record=store.evidence([id])[0];if(record&&record.source!=='note')throw new StoreError('Note not found',404);return store.delete(id);});
  app.post('/api/devices/heartbeat',async req=>store.heartbeat(heartbeatSchema.parse(req.body)));
  app.get('/api/devices',async()=>({items:store.devices()}));
  app.get('/api/updates',async req=>{const {cursor,limit}=z.object({cursor:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(req.query);return store.updates(cursor,limit);});
  app.get('/api/activity',async req=>store.activity(rangeSchema.parse(req.query)));
  let closing=false;
  const activeQueries=new Set<Promise<QueryResult>>();
  function queryAgent(input:{question:string;after?:string;before?:string}) {
    if(closing)throw new StoreError('Central node is shutting down',503);
    if(activeQueries.size>=2)throw new StoreError('Two Agent queries are already running; retry shortly',429);
    const revision=store.deletionRevision();
    const promise=agent.query(input).then(result=>{
      if(store.deletionRevision()!==revision)throw new StoreError('Evidence was deleted during this run; retry against the updated archive',409);
      return result;
    });
    activeQueries.add(promise);void promise.finally(()=>activeQueries.delete(promise)).catch(()=>{});return promise;
  }
  app.post('/api/query',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async req=>{
    if(!agent.configured)throw new StoreError('请在中央节点设置 MOTE_MODEL、MOTE_MODEL_BASE_URL 和 MOTE_MODEL_API_KEY，再重启服务。采集和归档仍可正常使用。',503);
    return queryAgent(querySchema.parse(req.body));
  });
  async function insight(range:{after?:string;before?:string}) {
    if(!agent.configured)throw new StoreError('Agent 未配置；请先配置模型以生成有证据的回顾。',503);
    const result=await queryAgent({question:'请根据这段时间的上下文记录，生成中文个人回顾：我最近做了什么，时间花在哪里，哪些事情可能值得继续关注。自由选择工具检索并解释发现，区分事实、推断与信息缺口，每个具体发现引用原始记录。屏幕采样时间不能等同专注或真实劳动时间，不臆造待办或意图。',...range});
    store.saveInsight(result,result.runId);return result;
  }
  app.post('/api/insights',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{const range=rangeSchema.parse(req.body??{});return insight({after:range.after,before:range.before});});
  app.get('/api/insights',async()=>({items:store.insights()}));
  app.post('/api/index/retry',async()=>{if(!indexer.configured)throw new StoreError('Embedding model is not configured',409);return store.retryIndex();});
  app.get('/api/export',async(_req,reply)=>reply.header('Content-Disposition',`attachment; filename="mote-${new Date().toISOString().slice(0,10)}.json"`).send(store.exportArchive(config.maxExportBytes)));
  app.post('/api/import',{bodyLimit:config.maxExportBytes},async req=>store.importArchive(req.body));
  const web=join(repositoryRoot,'apps/web/dist');
  if(existsSync(web)) {
    await app.register(staticFiles,{root:web,prefix:'/'});
    app.setNotFoundHandler(async(req,reply)=>{
      if(req.url.startsWith('/api/'))return reply.code(404).send({error:'not_found'});
      return reply.type('text/html').sendFile('index.html');
    });
    app.addHook('onSend',async(req,reply,payload)=>{
      if(!req.url.startsWith('/api/'))reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return payload;
    });
  }
  const indexTimer=setInterval(()=>void indexer.tick(),5000);indexTimer.unref();
  const maintenance=()=>{if(config.retentionDays>0)store.prune(new Date(Date.now()-config.retentionDays*86400000).toISOString());};
  maintenance();const retentionTimer=setInterval(maintenance,3600000);retentionTimer.unref();
  let backgroundInsight:Promise<void>|undefined;
  const insightTimer=config.insightIntervalHours>0?setInterval(()=>{
    if(backgroundInsight||!agent.configured||closing)return;
    backgroundInsight=insight({after:new Date(Date.now()-config.insightIntervalHours*3600000).toISOString(),before:new Date().toISOString()}).then(()=>{},e=>{app.log.error({message:e instanceof Error?e.message:'Insight failed'});}).finally(()=>{backgroundInsight=undefined;});
  },config.insightIntervalHours*3600000):undefined;insightTimer?.unref();
  app.addHook('onClose',async()=>{closing=true;clearInterval(indexTimer);clearInterval(retentionTimer);if(insightTimer)clearInterval(insightTimer);await agent.close();await Promise.allSettled([...activeQueries]);await backgroundInsight;await indexer.close();if(!dependencies?.store)store.close();});
  return {app,store,indexer,agent};
}
