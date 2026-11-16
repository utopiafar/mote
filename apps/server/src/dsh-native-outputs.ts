import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import type {SourceStore} from './sources.js';
import {materialId,type MaterialStore} from './materials.js';
import type {MaterialDerivation} from './material-derivation.js';
import {StoreError} from './store.js';
import type {PublishNativeOutputs} from './dsh-application.js';

/** Trusted producer over the same SourceIntake repositories. The source row is
 * metadata only; all accepted text and its read authority belong to Material.
 * Native code receives neither this port nor a source/SQL capability. */
export function nativeOutputPublisher(sources:SourceStore,materials:MaterialStore):PublishNativeOutputs {
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
    const publish=materials.bindDerivedPublisher(sourceId,authorize);
    authorize();
    // Product privacy is independent of the SDK session/activation/conversation
    // lifecycle. Copy only actual evidence/Memory/source disclosure roles.
    const groups:MaterialDerivation['groups']=publication.receipts.map(receipt=>({evidenceDependencies:structuredClone(receipt.evidenceDependencies),originalEvidenceIds:[...receipt.originalEvidenceIds],sourceContextDependencies:structuredClone([...receipt.sourceContextDependencies]),memoryPins:structuredClone([...receipt.memoryPins])}));
    const uniqueGroups=[...new Map(groups.map(group=>[JSON.stringify(group),group])).values()];
    const observedAt=new Date().toISOString();
    const prepared=publication.outputs.map(output=>{
      authorize();
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(output.bytes);}catch{throw new StoreError('Native application text output is not valid UTF-8',400);}
      if(!Buffer.from(text,'utf8').equals(output.bytes))throw new StoreError('Native application text output cannot be represented losslessly',400);
      const revision=createHash('sha256').update(output.bytes).update(JSON.stringify([output.mimeType,uniqueGroups])).digest('hex');
      return {text,output,item:{externalId:output.path,revision,observedAt,title:basename(output.path),text:'',kind:'file' as const,layer:'reference' as const,mimeType:output.mimeType}};
    });
    await sources.upsertBatch(sourceId,prepared.map(value=>value.item),authorize,(receipt,index)=>{
      authorize();const value=prepared[index]!,id=materialId(sourceId,value.output.path),member='output';
      publish({id,kind:'mote.native-application-output',schemaVersion:1,title:basename(value.output.path),origin:{sourceId,externalId:value.output.path,deviceId:sourceId,firstAt:observedAt,lastAt:observedAt},
        members:[{id:member,kind:'archive',ref:'source-item:'+receipt.id,revision:value.item.revision}],
        blocks:[{id:'body',kind:'text',format:value.output.mimeType==='application/json'?'json':value.output.mimeType==='text/markdown'?'markdown':'plain',text:value.text,memberIds:[member]}],
        coverage:{state:'complete'},artifacts:[{key:'source-body',state:'ready',blockIds:['body']}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},
      {version:1,sourceItem:{captureId:receipt.id,revision:value.item.revision},groups:uniqueGroups});
      if(index===prepared.length-1)publication.acceptCheckpoint();authorize();
    });
    authorize();
  };
}
