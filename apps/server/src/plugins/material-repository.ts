import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract,type PluginLifecycle,type ServiceBinding} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {MaterialStore} from '../materials.js';
import {MaterialNoteDeletion} from '../material-note-deletion.js';
import {StoreError} from '../evidence-store.js';
import type {CentralDomainPlugin} from '../domain-activation.js';
import {centralServices,type CommitAuthority,type CommitAuthorization,type MaterialPublication} from './central-contracts.js';

export const materialRepositoryContribution={
  id:'material-repository',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'}],
  provides:[centralServices.materialRepository,centralServices.materialPublication].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const materialRepositoryDeclaration={id:materialRepositoryContribution.id,apiVersion:'1'} as const;
export const materialRepositoryReplacement='hot' as const;

export interface MaterialRepositoryBindings {
  readonly repository:ServiceBinding;
  readonly publication:ServiceBinding;
}

const unavailable=()=>new StoreError('Material repository is unavailable',503);

/** Trusted assembly seam only: Note deletion resolution stays part of the
 * Material owner rather than a root-constructed business object. */
export function openMaterialNoteDeletion(store:MaterialStore['store'],materials:MaterialStore){return new MaterialNoteDeletion(store,materials);}

/** Owns the canonical MaterialStore. Other domains borrow its repository through
 * the host lease; only the publication facade accepts an external commit grant. */
export function createMaterialRepository(store:MaterialStore['store'],authorization:CommitAuthorization){
  if(!authorization||typeof authorization.assertCurrent!=='function')throw unavailable();
  // PluginHost orders lifecycle calls. This one-way publication latch is local
  // policy: prepared/quiescing resources remain readable, but cannot publish.
  // Undefined means never started; a withdrawn owner needs a fresh activation.
  let publicationOpen:boolean|undefined;
  let materials:MaterialStore|undefined,closing:Promise<void>|undefined,transactionId=0;
  const verify=authorization.assertCurrent.bind(authorization);
  const active=()=>{if(publicationOpen!==true)throw unavailable();};
  const close=()=>{
    publicationOpen=false;
    // Publish the terminal owner promise before invoking a resource, including
    // a resource which synchronously reenters close or throws.
    return closing??=Promise.resolve().then(()=>materials?.index?.close());
  };
  const publication:MaterialPublication=Object.freeze({
    publish(draft:Parameters<MaterialStore['publish']>[0],options:Parameters<MaterialStore['publish']>[1],authority:CommitAuthority){
      active();verify(authority);
      const db=store.db,nested=db.isTransaction,name=`material_${++transactionId}`;
      db.exec(nested?`SAVEPOINT ${name}`:'BEGIN IMMEDIATE');
      try{
        verify(authority);const result=materials!.publish(draft,options);verify(authority);
        db.exec(nested?`RELEASE ${name}`:'COMMIT');return result;
      }catch(error){
        try{db.exec(nested?`ROLLBACK TO ${name}; RELEASE ${name}`:'ROLLBACK');}
        catch(cleanup){throw new AggregateError([error,cleanup],'Material publication and rollback failed',{cause:error});}
        throw error;
      }
    },
  });
  return Object.freeze({
    async prepare(){
      if(materials||closing)throw unavailable();
      materials=new MaterialStore(store);
    },
    start(){if(!materials||closing||publicationOpen!==undefined)throw unavailable();publicationOpen=true;},
    quiesce(){if(publicationOpen)publicationOpen=false;},
    close,
    /** Trusted composition bridge until the remaining Material consumers migrate. */
    get storeForAssembly(){if(!materials||closing)throw unavailable();return materials;},
    publication,
  });
}
export type MaterialRepository=ReturnType<typeof createMaterialRepository>;

/** The single lifecycle adapter. Host startup unwind also runs the deferred
 * resource close when preparation or service publication fails. */
export function createMaterialRepositoryFactory(platform:MaterialRepository,onStarted?:(bindings:MaterialRepositoryBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(platform.close);
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        // Trusted composition still borrows the complete MaterialStore while
        // remaining Material consumers migrate. Ordinary consumers see only
        // the MaterialRepositoryRead contract.
        const repository=context.provide(materialRepositoryContribution.id,centralServices.materialRepository,platform.storeForAssembly);
        const publication=context.provide(materialRepositoryContribution.id,centralServices.materialPublication,platform.publication);
        onStarted?.({repository,publication});
      },
      quiesce:platform.quiesce,stop:platform.close,dispose:platform.close,
    };
  };
}

/** Private build input for the selected Material owner. It carries the actual
 * borrowed store and authorization boundary; it is never a public repository. */
export interface MaterialRepositoryInputs {
  readonly store:MaterialStore['store'];
  readonly authorization:CommitAuthorization;
  readonly onStarted?:(platform:MaterialRepository,bindings:MaterialRepositoryBindings)=>void;
}
export const materialRepositoryInputsContract=serviceContract<MaterialRepositoryInputs>('mote.central.material-repository-inputs','1');
export const materialRepositoryInputsContribution={
  id:'material-repository-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service' as const,id:materialRepositoryInputsContract.id,apiVersion:materialRepositoryInputsContract.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const materialRepositoryInputsDeclaration={id:materialRepositoryInputsContribution.id,apiVersion:'1'} as const;

/** Selected owner activation: the repository, publication latch and store are
 * constructed only inside this activation. Callers acquire the published
 * bindings; the private input only supplies borrowed trusted roots. */
export const materialRepositoryPlugin:CentralDomainPlugin=Object.freeze<CentralDomainPlugin>({
  contribution:materialRepositoryContribution,declaration:materialRepositoryDeclaration,replacement:materialRepositoryReplacement,
  activation:{featureId:'mote.materials',requires:{inputs:{provider:materialRepositoryInputsContribution.id,service:materialRepositoryInputsContract}},
    async create(context,bindings){
      const input=await context.services.acquire(materialRepositoryInputsContract,bindings.inputs!);
      context.scope.defer(()=>input.release());
      const platform=createMaterialRepository(input.value.store,input.value.authorization);
      context.scope.defer(()=>platform.close());
      return {
        route:{id:'mote.materials',mount(){}},
        prepare:()=>platform.prepare(),
        start(){
          platform.start();
          const repository=context.provide(materialRepositoryContribution.id,centralServices.materialRepository,platform.storeForAssembly);
          const publication=context.provide(materialRepositoryContribution.id,centralServices.materialPublication,platform.publication);
          input.value.onStarted?.(platform,{repository,publication});
        },
        quiesce:platform.quiesce,
        stop:platform.close,
        dispose:platform.close,
      };
    }},
});
