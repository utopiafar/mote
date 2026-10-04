import {createHash} from 'node:crypto';
import type {FileStore} from './files.js';
import type {Store} from './store.js';

/** A summary depends on the complete preferred transcript and owner-confirmed
 * speaker attribution, including inputs it did not happen to cite. */
export function fileSummaryInputFingerprint(files:FileStore,id:string){
  const hash=createHash('sha256');
  for(let offset=0;;offset+=200){
    const records=files.chunks(id,offset,200);if(!records.length)break;
    for(const record of records)hash.update(JSON.stringify([record.id,record.ocrText,record.fileEvidence]));
  }
  return hash.digest('hex');
}

/** Called in the same transaction as a transcript/attribution mutation. The
 * engine separately checks the pinned fingerprint before accepting late work. */
export function invalidateFileSummary(store:Store,id:string){
  store.db.prepare("UPDATE file_artifacts SET current=0 WHERE capture_id=? AND kind='summary' AND current=1").run(id);
  store.db.prepare("UPDATE file_jobs SET summary_state='waiting',available_at=0,error=NULL WHERE capture_id=? AND summary_state!='cancelled'").run(id);
}
