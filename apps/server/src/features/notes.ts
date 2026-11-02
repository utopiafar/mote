import { noteCapture,noteSchema,rangeSchema } from '@mote/shared';
import type { FastifyInstance } from 'fastify';
import { assertExternalCaptures,assertCaptureAttachments } from '../capture-admission.js';
import type { FeatureServices } from '../feature-services.js';
import type { CaptureIntakeAuthority,CaptureRouteContext } from '../plugins/capture-intake.js';
import type { NotesSourceAssembly } from '../plugins/notes-source.js';
import { StoreError } from '../store.js';

/** C10A/C10 trusted assembly supplies the same C04 platform and request pin;
 * neither is a published service and this feature never mints authority. */
export interface NotesCapture {readonly authority:CaptureIntakeAuthority;readonly route:CaptureRouteContext}

/** notes: owns its transport, data and command contributions. The attached
 * C10A intake is authoritative when wired; the legacy ingress remains only as
 * the current fallback until the production assembly passes NotesCapture. */
export function register(app:FastifyInstance,{assertRequestActive,connections,credential,diagnostics,files,ingress,materials,sources,store,notesSource,notesCapture}:Pick<FeatureServices,"assertRequestActive"|"connections"|"credential"|"diagnostics"|"files"|"ingress"|"materials"|"sources"|"store">&{notesSource?:NotesSourceAssembly;notesCapture?:NotesCapture}){
app.post('/api/notes',async(req,reply)=>{
  const input=noteCapture(noteSchema.parse(req.body));
  if(notesCapture){
    const request=notesCapture.route.request(req);
    if(!request)throw new StoreError('Owner authorization is required',401);
    const result=await diagnostics.measure('ingest','note',()=>notesCapture.authority.withCapture(request,input,()=>notesCapture.authority.captureIntake.capture(input,notesCapture.authority.commits.capture())),r=>({count:r.duplicate?0:1}));
    return reply.code(result.duplicate?200:201).send(result);
  }
  const c=credential(req);assertExternalCaptures([input],!c);if(c)connections.assertCapture(c,input);assertCaptureAttachments([input],files,c);const result=await diagnostics.measure('ingest','note',()=>ingress.capture(input,()=>{assertRequestActive(req);assertCaptureAttachments([input],files,c);if(c)connections.assertCapture(c,input);}),r=>({count:r.duplicate?0:1}));return reply.code(result.duplicate?200:201).send(result);
});
app.get('/api/notes',async req=>{
    const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
    return diagnostics.measure('source','timeline',()=>notesSource?notesSource.list({...args,cursor:raw.cursor}):(()=>{const page=store.list({...args,source:'note',cursor:raw.cursor});return {...page,items:page.items.map(record=>({...record,attributionContext:materials.contextForEvidence(record)}))};})(),page=>({count:page.items.length}));
  });
app.delete('/api/notes/:id',async req=>{const {id}=req.params as {id:string};if(notesSource)return notesSource.delete(id);const record=store.evidence([id])[0];if(record&&record.source!=='note')throw new StoreError('Note not found',404);return store.delete(id);});
}
