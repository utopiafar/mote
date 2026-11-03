import type {FastifyInstance} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {MaterialStore} from '../materials.js';
import type {MaterialOrganizerRuntime} from '../material-organizers.js';
import type {EvidenceReader} from '../evidence-reader.js';
import {registerOwnerLibraryBrowse} from '../owner-library-browse.js';
import {registerMaterialRoutes} from '../material-routes.js';
import {registerSourceMaterialView} from '../source-material-view.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';

/** C19 parent bridge: the materials feature's HTTP contribution lives with the
 * Material domain, not the transitional feature adapter. */
export const materialContextContribution={
  id:'material-context',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.materialRepository.id,version:'1.0.0'},
    {kind:'service',id:centralServices.materialRead.id,version:'1.0.0'},
  ],
  provides:[],
} as const satisfies ManifestContribution;
export const materialContextDeclaration={id:materialContextContribution.id,apiVersion:'1'} as const;
export const materialContextReplacement='hot' as const;

export interface MaterialContextDependencies {
  readonly materials:MaterialStore;
  readonly organizer:MaterialOrganizerRuntime;
  readonly reader:Pick<EvidenceReader,'archivedEvidence'>;
}

const unavailable=()=>new StoreError('Material context is unavailable',503);

/** Owns the materials HTTP table over borrowed domain reads. It never closes the
 * MaterialStore, organizer or EvidenceReader; their own owners retain lifetime. */
export function createMaterialContext(dependencies:MaterialContextDependencies){
  const {materials,organizer,reader}=dependencies;
  if(!materials||!organizer||!reader)throw unavailable();
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  const mounted=new WeakSet<FastifyInstance>();
  const readable=()=>phase==='prepared'||phase==='active'||phase==='quiescing';
  const active=()=>phase==='active';
  const stop=()=>{phase='stopped';};
  return Object.freeze({
    prepare(){if(phase!=='created')throw unavailable();phase='prepared';},
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{stop();},
    dispose:stop,
    close:stop,
    /** Mounted once by the pre-H14 feature bridge. Reads survive quiesce; new
     * writes require an active activation, and a stopped owner returns 503. */
    routes(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Material routes are already installed',409);
      if(!readable())throw unavailable();
      mounted.add(app);
      app.register(async child=>{
        child.addHook('onRequest',async(request,reply)=>{
          if(!readable())return reply.code(503).send({error:'feature_unavailable'});
          if(request.method!=='GET'&&request.method!=='HEAD'&&!active())return reply.code(503).send({error:'feature_unavailable'});
        });
        registerMaterialRoutes(child,materials,organizer);
        registerOwnerLibraryBrowse(child,materials,reader);
        registerSourceMaterialView(child,materials);
      });
    },
  });
}
export type MaterialContext=ReturnType<typeof createMaterialContext>;

/** Native host factory for later route-owning activations. The current app
 * mounts the same contribution through the pre-H14 feature bridge. */
export function createMaterialContextFactory(dependencies:MaterialContextDependencies){
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createMaterialContext(dependencies);
    context.scope.defer(()=>platform.close());
    return {prepare:platform.prepare,start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.dispose};
  };
}
