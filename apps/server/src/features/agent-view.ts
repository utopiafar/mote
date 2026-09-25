import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { navigationScopeSchema } from '../context-navigation.js';
import type { FeatureServices } from '../feature-services.js';
const scope={...navigationScopeSchema.shape,limit:z.coerce.number().int().min(1).max(20).default(12),cursor:z.string().max(4096).optional()};
export function register(app:FastifyInstance,{archiveReader,diagnostics}:Pick<FeatureServices,'archiveReader'|'diagnostics'>){
  app.get('/api/agent-view/catalog',async req=>archiveReader.catalog!(z.object({...scope,path:z.string().max(100).optional()}).strict().parse(req.query)));
  app.get('/api/agent-view/materials',async req=>archiveReader.materialCatalog!(z.object({...scope,kind:z.string().max(128).optional()}).strict().parse(req.query)));
  app.get('/api/agent-view/material-read',async req=>archiveReader.materialRead!(z.object({...navigationScopeSchema.shape,ref:z.string().min(1).max(1600),offset:z.coerce.number().int().min(0).default(0),length:z.coerce.number().int().min(1).max(4000).default(4000)}).strict().parse(req.query)));
  app.get('/api/agent-view/memories',async req=>archiveReader.memories!(z.object({...scope,id:z.string().max(128).optional()}).strict().parse(req.query)));
  app.get('/api/agent-view/source-items',async req=>archiveReader.sourceItems!(z.object({...scope,sourceId:z.string().max(128)}).strict().parse(req.query)));
  app.get('/api/agent-view/segments',async req=>archiveReader.segments!(z.object({...scope,id:z.string().max(1600).optional()}).strict().parse(req.query)));
  app.post('/api/agent-view/read',{bodyLimit:8192},async req=>{
    const {ref,offset,length,...range}=z.object({...navigationScopeSchema.shape,ref:z.string().min(1).max(1600),offset:z.number().int().min(0).default(0),length:z.number().int().min(1).max(4000).default(4000)}).strict().parse(req.body);
    return archiveReader.materialRead!({...range,ref,offset,length});
  });
  // Only previously recorded events; never reconstruct a historical prompt from current data.
  app.get('/api/agent-view/events',async req=>{
    const {afterSeq,runId}=z.object({afterSeq:z.coerce.number().int().min(0).default(0),runId:z.string().max(200).optional()}).strict().parse(req.query);
    const page=diagnostics.events(afterSeq,100);
    const items:typeof page.items=[];let characters=0,nextSeq=afterSeq;
    for(const event of page.items){
      if(event.event!=='agent.trace'||runId&&event.trace?.runId!==runId){nextSeq=event.seq;continue;}
      const payload=JSON.stringify(event.trace?.payload??null),bounded=payload.length>12000?{...event,trace:{...event.trace,truncated:true,payload:{preview:payload.slice(0,12000)}}}:event;
      const size=JSON.stringify(bounded).length;if(characters+size>60000)break;
      items.push(bounded);characters+=size;nextSeq=event.seq;
    }
    return {items,nextSeq,oldestSeq:page.oldestSeq,recording:diagnostics.snapshot().agentTrace};
  });
}
