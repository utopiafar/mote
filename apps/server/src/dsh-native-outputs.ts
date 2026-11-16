import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import type {SourceStore} from './sources.js';
import type {ArchivedFileStore} from './archived-files.js';
import {StoreError} from './store.js';
import type {PublishNativeOutputs} from './dsh-application.js';

/** A trusted producer adapter over the same repositories used by SourceIntake.
 * Native code receives only its declared workspace, never this port or SQL.
 * Authorization is the exact current native profile/output issuer carried by
 * the Host, and is rechecked by the real queued SourceStore commit. */
export function nativeOutputPublisher(sources:SourceStore,archivedFiles:ArchivedFileStore):PublishNativeOutputs {
  return async publication=>{
    const db=sources.store.db;
    publication.assertCurrent();
    if(!publication.outputs.length){
      db.exec('BEGIN IMMEDIATE');
      try{publication.assertCurrent();publication.acceptCheckpoint();publication.assertCurrent();db.exec('COMMIT');}
      catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      return;
    }
    const sourceId='dsh-app:'+publication.sourceKey;
    sources.register({id:sourceId,name:'Native application · '+publication.profileId,kind:'custom',deviceId:sourceId,platform:'import',retention:'archive'},()=>publication.assertCurrent());
    const authorize=()=>{
      publication.assertCurrent();const source=sources.getSource(sourceId);
      if(!source.enabled||source.retention==='reference')throw new StoreError('Native application output source is unavailable',409);
    };
    authorize();
    const parents=[...new Set(publication.receipts.flatMap(receipt=>receipt.evidenceDependencies.ids))].sort();
    const observedAt=new Date().toISOString();
    const prepared=publication.outputs.map(output=>{
      authorize();
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(output.bytes);}catch{throw new StoreError('Native application text output is not valid UTF-8',400);}
      const file=archivedFiles.putParts({name:output.path,mimeType:output.mimeType},[output.bytes],output.bytes.length,authorize);
      const revision=createHash('sha256').update(JSON.stringify([file.hash,output.mimeType,parents])).digest('hex');
      return {file,item:{externalId:output.path,revision,observedAt,title:basename(output.path),text,kind:'file' as const,layer:'derived' as const,mimeType:output.mimeType,document:{bodyCoverage:{state:'complete' as const}}}};
    });
    await sources.upsertBatch(sourceId,prepared.map(value=>value.item),authorize,(receipt,index)=>{
      authorize();
      archivedFiles.attach(receipt.id,[prepared[index]!.file.id]);
      // This is the existing derived-capture lineage graph. Material anchors,
      // model disclosure and deletion traversal retain these original parents.
      for(const parent of parents)db.prepare('INSERT OR IGNORE INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(parent,receipt.id);
      if(index===prepared.length-1)publication.acceptCheckpoint();
      authorize();
    });
    authorize();
  };
}
