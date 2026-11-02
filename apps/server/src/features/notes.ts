import { noteCapture,noteSchema,rangeSchema } from '@mote/shared';
import type { FastifyInstance } from 'fastify';
import { assertExternalCaptures,assertCaptureAttachments } from '../capture-admission.js';
import type { FeatureServices } from '../feature-services.js';
import type { NotesSourceAssembly } from '../plugins/notes-source.js';
import { StoreError } from '../store.js';

/** notes: owns its transport, data and command contributions. C10B's first
 * slice consumes trusted note page/attribution/delete functions; the write
 * receipt stays on the current ingress until C10A freezes its intake port. */
export function register(app:FastifyInstance,{assertRequestActive,connections,credential,diagnostics,files,ingress,materials,sources,store,notesSource}:Pick<FeatureServices,"assertRequestActive"|"connections"|"credential"|"diagnostics"|"files"|"ingress"|"materials"|"sources"|"store">&{notesSource?:NotesSourceAssembly}){
app.post('/api/notes',async(req,reply)=>{const input=noteCapture(noteSchema.parse(req.body)),c=credential(req);assertExternalCaptures([input],!c);if(c)connections.assertCapture(c,input);assertCaptureAttachments([input],files,c);const result=await diagnostics.measure('ingest','note',()=>ingress.capture(input,()=>{assertRequestActive(req);assertCaptureAttachments([input],files,c);if(c)connections.assertCapture(c,input);}),r=>({count:r.duplicate?0:1}));return reply.code(result.duplicate?200:201).send(result);});
app.get('/api/notes',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return diagnostics.measure('source','timeline',()=>notesSource?notesSource.list({...args,cursor:raw.cursor}):(()=>{const page=store.list({...args,source:'note',cursor:raw.cursor});return {...page,items:page.items.map(record=>({...record,attributionContext:materials.contextForEvidence(record)}))};})(),page=>({count:page.items.length}));
  });
app.delete('/api/notes/:id',async req=>{const {id}=req.params as {id:string};if(notesSource)return notesSource.delete(id);const record=store.evidence([id])[0];if(record&&record.source!=='note')throw new StoreError('Note not found',404);return store.delete(id);});
}
