import type {EvidenceStore} from '../../src/evidence-store.js';

/** Strict deletion of one generated original. Ordinary release keeps private Memory receipts. */
export function forgetFixtureOriginal(store:EvidenceStore,id:string){
  store.db.exec('BEGIN IMMEDIATE');
  try{
    store.deleteInTransaction(id);
    store.db.exec('COMMIT');
  }catch(error){
    if(store.db.isTransaction)store.db.exec('ROLLBACK');
    throw error;
  }
  store.collectDeletedEvidence();
}
