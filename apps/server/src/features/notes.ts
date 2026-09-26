import { noteCapture,noteSchema,rangeSchema } from '@mote/shared';
import type { FastifyInstance } from 'fastify';
import { assertExternalCaptures } from '../capture-admission.js';
import type { FeatureServices } from '../feature-services.js';
import { StoreError } from '../store.js';

/** notes: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{connections,credential,diagnostics,files,ingress,sources,store}:Pick<FeatureServices,"connections"|"credential"|"diagnostics"|"files"|"ingress"|"sources"|"store">){
app.post('/api/notes',async(req,reply)=>{const input=noteCapture(noteSchema.parse(req.body)),c=credential(req);assertExternalCaptures([input]);if(c)connections.assertCapture(c,input);for(const id of input.metadata?.attachments??[]){const attachment=files.detail(id);if(c&&sources.getSource(attachment.sourceId).deviceId!==c.deviceId)throw new StoreError('Attachment belongs to another device',403);}const result=await diagnostics.measure('ingest','note',()=>ingress.capture(input,c?()=>connections.assertCapture(c,input):undefined),r=>({count:r.duplicate?0:1}));return reply.code(result.duplicate?200:201).send(result);});
app.get('/api/notes',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return diagnostics.measure('source','timeline',()=>store.list({...args,source:'note',cursor:raw.cursor}),page=>({count:page.items.length}));
  });
app.delete('/api/notes/:id',async req=>{const {id}=req.params as {id:string};const record=store.evidence([id])[0];if(record&&record.source!=='note')throw new StoreError('Note not found',404);return store.delete(id);});
}
