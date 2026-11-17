import type {FastifyInstance} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract,type PluginLifecycle,type StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {CentralDomainPlugin} from '../domain-activation.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialOrganizerRuntime} from '../material-organizers.js';
import type {EvidenceReader} from '../evidence-reader.js';
import {registerOwnerLibraryBrowse} from '../owner-library-browse.js';
import {registerMaterialRoutes} from '../material-routes.js';
import {registerSourceMaterialView} from '../source-material-view.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';

/** Materials parent bridge: the materials feature's HTTP contribution lives with the
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
    /** Mounted once by the transitional feature bridge. Reads survive quiesce; new
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
 * mounts the same contribution through the transitional feature bridge. */
export function createMaterialContextFactory(dependencies:MaterialContextDependencies){
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createMaterialContext(dependencies);
    context.scope.defer(()=>platform.close());
    return {prepare:platform.prepare,start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.dispose};
  };
}

/** Private build input for the selected Material HTTP owner. It lends the one
 * MaterialStore, organizer runtime and EvidenceReader; it constructs nothing. */
export interface MaterialContextInputs extends MaterialContextDependencies {
  readonly onStarted?:(platform:MaterialContext)=>void;
}
export const materialContextInputsContract=serviceContract<MaterialContextInputs>('mote.central.material-context-inputs','1');
export const materialContextInputsContribution={
  id:'material-context-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service' as const,id:materialContextInputsContract.id,apiVersion:materialContextInputsContract.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const materialContextInputsDeclaration={id:materialContextInputsContribution.id,apiVersion:'1'} as const;

/** Selected owner activation: this activation owns the route table and its
 * handler lifetime. It borrows the existing Material/Evidence owners. */
export const materialContextPlugin:CentralDomainPlugin=Object.freeze<CentralDomainPlugin>({
  contribution:materialContextContribution,declaration:materialContextDeclaration,replacement:materialContextReplacement,
  activation:{featureId:'mote.materials',requires:{inputs:{provider:materialContextInputsContribution.id,service:materialContextInputsContract}},
    async create(context,bindings){
      const input=await context.services.acquire(materialContextInputsContract,bindings.inputs!);
      context.scope.defer(()=>input.release());
      const platform=createMaterialContext(input.value);
      context.scope.defer(()=>platform.close());
      return {
        route:{id:'mote.materials',mount(app){platform.routes(app);}},
        prepare:platform.prepare,
        start(){platform.start();input.value.onStarted?.(platform);},
        quiesce:platform.quiesce,stop:platform.stop,dispose:platform.dispose,
      };
    }},
});
