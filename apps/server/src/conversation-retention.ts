import type {EvidenceStore} from './evidence-store.js';
import type {EvidenceExposureContext} from './evidence-exposure.js';
import {imageViewSchema,type QueryResult} from '@mote/shared';

/** Identity and exposure metadata only. No body, description, tool arguments or
 * owner declaration is retained here, and this table is never a retrieval source. */
export type RetiredConversationRoot={version:1;scope:EvidenceExposureContext;sourceRegistered:boolean;materialId?:string;externalId?:string;file?:{sourceId:string;externalId:string}};
const table=(store:EvidenceStore,name:string)=>Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Retain the turn's tool count and exact evidence identities without keeping
 * free-form queries, declaration text, unexpected payloads or original bodies. */
export function retainedConversationResult(result:QueryResult):QueryResult {
 const ids=new Set(result.evidenceDependencies?.ids??[]),identity=(value:unknown):value is string=>typeof value==='string'&&ids.has(value);
 const argumentsOnly=(value:unknown)=>{
  const out:Record<string,unknown>={};if(!value||typeof value!=='object'||Array.isArray(value))return out;
  const args=value as Record<string,unknown>;
  for(const key of ['id','attachmentId'])if(identity(args[key]))out[key]=args[key];
  if(Array.isArray(args.ids))out.ids=args.ids.filter(identity);
  if(typeof args.ref==='string'&&args.ref.startsWith('capture:')&&identity(args.ref.slice(8)))out.ref=args.ref;
  for(const key of ['offset','length','returnedLength','limit'])if(Number.isSafeInteger(args[key])&&Number(args[key])>=0)out[key]=args[key];
  return out;
 };
 const trace=result.trace.map(step=>{
  const raw=step.imageView,view=raw?imageViewSchema.safeParse((({id:_id,attachmentId:_attachment,delivery:_delivery,...metadata})=>metadata)(raw)):undefined;
  const imageView=raw&&identity(raw.id)&&view?.success?{...view.data,id:raw.id,...(identity(raw.attachmentId)?{attachmentId:raw.attachmentId}:{}),delivery:raw.delivery}:undefined;
  return {tool:step.tool,arguments:argumentsOnly(step.arguments),count:step.count,...(imageView?{imageView}:{})};
 });
 const imageReadReceipts=result.imageReadReceipts?.flatMap(receipt=>{const parsed=imageViewSchema.safeParse(receipt.imageView);return identity(receipt.id)&&parsed.success?[{id:receipt.id,imageView:parsed.data}]:[];});
 return {...result,trace,...(imageReadReceipts?{imageReadReceipts}:{})};
}

function identity(store:EvidenceStore,id:string):{root:RetiredConversationRoot;expiresAt:string|null}|undefined {
 const db=store.db,record=store.evidenceMetadata([id])[0],hasMaterials=table(store,'material_heads');
 const sourceKind=(sourceId:string|undefined,fallback:string)=>{
  const source=sourceId?db.prepare("SELECT json_extract(json,'$.kind') kind FROM source_connections WHERE id=?").get(sourceId):undefined;
  return {kind:source?String(source.kind):fallback,registered:Boolean(source)};
 };
 const formal=hasMaterials?(record?.provenance?.sourceId&&record.provenance.externalId?
  db.prepare('SELECT h.id,h.source_id,h.external_id,h.device_id,h.kind,r.manifest FROM material_heads h JOIN material_revisions r ON r.material_id=h.id AND r.revision=h.revision WHERE h.source_id=? AND h.external_id=? AND h.retired=0').get(record.provenance.sourceId,record.provenance.externalId):
  db.prepare('SELECT h.id,h.source_id,h.external_id,h.device_id,h.kind,r.manifest FROM material_evidence e JOIN material_heads h ON h.id=e.material_id JOIN material_revisions r ON r.material_id=h.id AND r.revision=h.revision WHERE e.id=? AND h.retired=0').get(id)):undefined;
 const file=db.prepare('SELECT source_id,external_id FROM file_versions WHERE capture_id=?').get(id);
 const expiresAt=record&&!file?String(db.prepare('SELECT context_end FROM captures WHERE id=?').get(id)!.context_end):null;
 if(formal){
  const manifest=JSON.parse(String(formal.manifest)),sourceId=String(formal.source_id),source=sourceKind(sourceId,formal.kind==='mote.screen-segment'?'screen':formal.kind==='mote.coding-session'?'coding-agent':'material');
  if(!['pending','partial','complete'].includes(manifest.coverage?.state))return;
  return {expiresAt,root:{version:1,sourceRegistered:source.registered,materialId:String(formal.id),externalId:String(formal.external_id),scope:{sourceKind:source.kind,sourceId,...(formal.device_id?{deviceId:String(formal.device_id)}:{}),representation:'material',operation:'expand',phase:manifest.coverage.state},...(file?{file:{sourceId:String(file.source_id),externalId:String(file.external_id)}}:{})}};
 }
 if(!record)return;
 const p=record.provenance,source=sourceKind(p?.sourceId,record.source==='screen'||record.source==='ui_page'?'screen':p?.document?.coding?'coding-agent':record.source);
 return {expiresAt,root:{version:1,sourceRegistered:source.registered,scope:{sourceKind:source.kind,sourceId:p?.sourceId,deviceId:record.deviceId,representation:'capture',operation:'expand',phase:record.ocr?.status==='pending'?'pending':record.ocr?.status==='failed'?'partial':'complete'},...(p?.externalId?{externalId:p.externalId}:{}),...(file?{file:{sourceId:String(file.source_id),externalId:String(file.external_id)}}:{})}};
}

/** Only ordinary retirement, inside the original mutation transaction, may
 * mint proof. Missing or previously erased originals are never reconstructed. */
export function retainConversationRoots(store:EvidenceStore,ids:readonly string[]){
 if(!store.db.isTransaction)throw Error('Conversation retirement requires the original transaction');
 if(!table(store,'conversation_turns'))return;
 const db=store.db;
 for(const id of new Set(ids)){
  const turns=db.prepare(`SELECT t.id,t.conversation_id,json_extract(t.json,'$.result.runId') run_id FROM conversation_turns t
   WHERE coalesce(json_extract(t.json,'$.evidenceDeleted'),0)!=1 AND json_extract(t.json,'$.status')='completed'
    AND json_extract(t.json,'$.historyEvidenceDependencies.complete')=1
    AND EXISTS(SELECT 1 FROM json_each(t.json,'$.historyEvidenceDependencies.ids') d WHERE d.value=?)`).all(id);
  if(!turns.length)continue;
  if(!db.prepare('SELECT 1 FROM conversation_retired_roots WHERE id=?').get(id)){
   const value=identity(store,id);if(!value)continue;
   const json=JSON.stringify(value.root);store.reserveMetadata(Buffer.byteLength(json)+id.length+128);
   db.prepare('INSERT INTO conversation_retired_roots VALUES(?,?,?)').run(id,json,value.expiresAt);
  }
  for(const turn of turns){
   if(typeof turn.run_id!=='string'||!turn.run_id||db.prepare('SELECT 1 FROM conversation_retired_turn_roots WHERE turn_id=? AND evidence_id=?').get(turn.id,id))continue;
   store.reserveMetadata(String(turn.id).length+String(turn.conversation_id).length+id.length+turn.run_id.length+128);
   db.prepare('INSERT INTO conversation_retired_turn_roots VALUES(?,?,?,?)').run(turn.conversation_id,turn.id,id,turn.run_id);
  }
 }
}

export function retiredConversationRoot(store:EvidenceStore,id:string):RetiredConversationRoot|undefined {
 const row=store.db.prepare('SELECT json FROM conversation_retired_roots WHERE id=?').get(id);
 return row?JSON.parse(String(row.json)) as RetiredConversationRoot:undefined;
}

/** Presentation-only availability of saved citation/scope identities. This does
 * not change the owner's separate immutable-archive routes or grant model reads. */
export function unavailableHistoryEvidence(store:EvidenceStore,ids:readonly string[]):string[]{
 const db=store.db,materials=table(store,'material_evidence');
 return [...new Set(ids)].filter(id=>{
  if(retiredConversationRoot(store,id))return true;
  const chunk=db.prepare('SELECT capture_id FROM file_chunks WHERE id=?').get(id),captureId=chunk?String(chunk.capture_id):id;
  const capture=store.evidenceMetadata([captureId])[0];
  if(capture){const p=capture.provenance;return Boolean(capture.privacy.excluded||p?.deleted||p?.sourceId&&p.externalId&&db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(p.sourceId,p.externalId)?.deleted);}
  const anchor=materials?db.prepare('SELECT h.retired FROM material_evidence e JOIN material_heads h ON h.id=e.material_id WHERE e.id=?').get(id):undefined;
  return !anchor||Boolean(anchor.retired);
 });
}

/** New answers may inherit proof only from retained turns in the same dialogue.
 * Their full privacy lineage remains intact for a later forget or revocation. */
export function inheritRetiredConversationRoots(store:EvidenceStore,conversationId:string,turn:{id:string;result?:{runId:string};historyEvidenceDependencies?:{complete:boolean;ids:string[]}}){
 if(!turn.result||!turn.historyEvidenceDependencies?.complete)return;
 const rows=store.db.prepare(`SELECT DISTINCT r.evidence_id FROM conversation_retired_turn_roots r JOIN conversation_turns t ON t.id=r.turn_id
  WHERE r.conversation_id=? AND r.evidence_id IN (SELECT value FROM json_each(?))
   AND r.result_run_id=json_extract(t.json,'$.result.runId') AND coalesce(json_extract(t.json,'$.evidenceDeleted'),0)!=1`).all(conversationId,JSON.stringify(turn.historyEvidenceDependencies.ids));
 for(const row of rows){store.reserveMetadata(conversationId.length+turn.id.length+String(row.evidence_id).length+turn.result.runId.length+128);store.db.prepare('INSERT INTO conversation_retired_turn_roots VALUES(?,?,?,?)').run(conversationId,turn.id,row.evidence_id,turn.result.runId);}
}

export function forgetRetiredConversationRoots(store:EvidenceStore,scope:{sourceId?:string;materialId?:string;file?:{sourceId:string;externalId:string}}){
 const predicates:string[]=[],values:string[]=[];
 if(scope.sourceId){predicates.push("json_extract(json,'$.scope.sourceId')=?");values.push(scope.sourceId);}
 if(scope.materialId){predicates.push("json_extract(json,'$.materialId')=?");values.push(scope.materialId);}
 if(scope.file){predicates.push("(json_extract(json,'$.file.sourceId')=? AND json_extract(json,'$.file.externalId')=?)");values.push(scope.file.sourceId,scope.file.externalId);}
 if(!predicates.length)return;
 const ids=store.db.prepare('SELECT id FROM conversation_retired_roots WHERE '+predicates.join(' OR ')).all(...values).map(row=>String(row.id));
 if(ids.length)store.invalidateConversationAnswers(ids,true);
}
