import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {MaterialStore} from '../materials.js';
import {MaterialNoteDeletion} from '../material-note-deletion.js';
import {StoreError} from '../store.js';
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
  let phase:'created'|'prepared'|'active'|'quiescing'|'disposed'='created';
  let materials:MaterialStore|undefined,closing:Promise<void>|undefined,transactionId=0;
  const verify=authorization.assertCurrent.bind(authorization);
  const active=()=>{if(phase!=='active')throw unavailable();};
  const close=()=>closing??=(async()=>{phase='disposed';await materials?.index?.close();})();
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
      if(phase!=='created')throw unavailable();
      try{materials=new MaterialStore(store);phase='prepared';}
      catch(error){
        try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Material repository preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    /** Trusted composition bridge until the remaining Material consumers migrate. */
    get storeForAssembly(){if(!materials||phase==='created'||phase==='disposed')throw unavailable();return materials;},
    publication,
  });
}
export type MaterialRepository=ReturnType<typeof createMaterialRepository>;

export function createMaterialRepositoryFactory(platform:MaterialRepository,onStarted?:(bindings:MaterialRepositoryBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
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
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
