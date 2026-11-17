import type {AutomaticMemoryGrant} from './memory-input-authorization.js';
import type {MemoryJob} from './memory-pipeline.js';
import type {EvidenceStore as Store} from './evidence-store.js';

/** Host lookup only. Model authorization still validates and consumes grants;
 * observing Memory metadata never grants execution or disclosure. */
export type MemoryModelAuthorityJob={id:string;automaticGrants:AutomaticMemoryGrant[];evidenceIds:string[]};
export interface MemoryModelAuthorityJobReader {
  modelAuthorityJob(jobId:string):MemoryModelAuthorityJob|undefined;
}
export function createMemoryModelAuthorityJobReader(store:Pick<Store,'db'>):MemoryModelAuthorityJobReader {
  const {db}=store;
  return {modelAuthorityJob:jobId=>{
    const row=db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(jobId);
    if(!row)return undefined;
    const job=JSON.parse(String(row.json)) as MemoryJob;
    return {id:job.id,automaticGrants:job.automaticGrants??(job.automaticGrant?[job.automaticGrant]:[]),evidenceIds:job.evidenceIds};
  }};
}
