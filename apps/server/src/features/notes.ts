import {noteCapture,noteSchema,rangeSchema} from '@mote/shared';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {CaptureIntakeAuthority,CaptureRouteContext} from '../plugins/capture-intake.js';
import type {CaptureIntake} from '../plugins/central-contracts.js';
import type {NotesSourceAssembly} from '../plugins/notes-source.js';
import {StoreError} from '../store.js';
import type {ConnectionCredential,Connections} from '../connections.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {FileStore} from '../files.js';
import type {IngressService} from '../ingress.js';
import type {FeatureRoute} from './index.js';

/** C10A/C10 trusted assembly supplies the same C04 platform, request pin and
 * the lifecycle-guarded published capture port; none is minted here. */
export interface NotesCapture {readonly authority:CaptureIntakeAuthority;readonly route:CaptureRouteContext;readonly intake:CaptureIntake}

export interface NotesFeatureDependencies {
  readonly assertRequestActive:(request:FastifyRequest)=>void;
  readonly connections:Connections;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly diagnostics:ServerDiagnostics;
  readonly files:FileStore;
  readonly ingress:IngressService;
  readonly notesSource:NotesSourceAssembly;
  readonly notesCapture:NotesCapture;
}

/** notes: owns its transport, data and command contributions. Every write goes
 * through the attached C10A intake; no secondary ingress is accepted. */
export function notesFeature(dependencies:NotesFeatureDependencies):FeatureRoute {
  const {diagnostics,notesSource,notesCapture}=dependencies;
  return Object.freeze({id:'mote.notes',mount(app:FastifyInstance){
    app.post('/api/notes',async(req,reply)=>{
      const input=noteCapture(noteSchema.parse(req.body));
      const request=notesCapture.route.request(req);
      if(!request)throw new StoreError('Owner authorization is required',401);
      const result=await diagnostics.measure('ingest','note',()=>notesCapture.authority.withCapture(request,input,()=>notesCapture.intake.capture(input,notesCapture.authority.commits.capture())),r=>({count:r.duplicate?0:1}));
      return reply.code(result.duplicate?200:201).send(result);
    });
    app.get('/api/notes',async req=>{
      const raw=req.query as Record<string,string>;const args=rangeSchema.parse(raw);
      return diagnostics.measure('source','timeline',()=>notesSource.list({...args,cursor:raw.cursor}),page=>({count:page.items.length}));
    });
    app.delete('/api/notes/:id',async req=>notesSource.delete((req.params as {id:string}).id));
  }});
}
