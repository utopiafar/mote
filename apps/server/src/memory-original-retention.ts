import {z} from 'zod';
import type {CaptureRecord} from '@mote/shared';
import {scopeRecord} from './evidence-scope-record.js';
import type {EvidenceStore} from './evidence-store.js';
import type {Memory} from './memory-schema.js';
import {openMemoryDeletions} from './plugins/memory-deletions.js';

/** A release receipt is host scope metadata, never an original or an extraction
 * grant. It lives in the existing evidence-revocation outbox and only names
 * cards already published when the original was still present. */
export type ReleasedMemoryOriginal={version:1;releasedAt:string;restoredArchive?:true;memoryFingerprints:Record<string,string>;record:CaptureRecord;sourceKind:string;sourceRegistered:boolean;representation:'capture'|'material';phase:'pending'|'partial'|'complete';materialId?:string;file?:{sourceId:string;externalId:string};identity:{origins:string[];originKeys:string[];lineageKeys:string[];sourceIds:string[]}};
const table=(store:EvidenceStore,name:string)=>Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
export function releasedMemoryOriginal(store:Pick<EvidenceStore,'db'>,id:string):ReleasedMemoryOriginal|undefined {
 const row=store.db.prepare("SELECT json FROM memory_provider_evidence_revocations WHERE id=?").get(id);
 return row?JSON.parse(String(row.json)).releasedOriginal:undefined;
}

/** Called before invalidation/cascades, inside the actual release transaction.
 * Missing originals cannot acquire a release receipt after the fact. */
export function prepareMemoryOriginalRelease(store:EvidenceStore,id:string):ReleasedMemoryOriginal|undefined {
 if(!store.db.isTransaction)throw Error('Memory original release requires a transaction');
 const existing=releasedMemoryOriginal(store,id);if(existing)return existing;
 const db=store.db,rows=db.prepare("SELECT m.json FROM memories m JOIN memory_dependencies d ON d.memory_id=m.id WHERE d.evidence_id=? AND json_extract(m.json,'$.status')='published'").all(id),cards=rows.map(row=>JSON.parse(String(row.json)) as Memory);
 const rejection=table(store,'memory_deletion_dependencies')&&db.prepare('SELECT 1 FROM memory_deletion_dependencies WHERE evidence_id=? LIMIT 1').get(id);
 if(!cards.length&&!rejection)return;
 const proof=cards.flatMap(card=>card.evidence).find(e=>e.id===id),chunk=db.prepare('SELECT capture_id FROM file_chunks WHERE id=?').get(id),raw=scopeRecord(store,chunk?String(chunk.capture_id):id);
 const formal=table(store,'material_evidence')?db.prepare(`SELECT e.material_id,e.invalidated,h.source_id,h.external_id,h.kind,h.device_id,h.retired,h.min_visible_sequence,r.sequence,r.manifest,r.created_at FROM material_evidence e JOIN material_heads h ON h.id=e.material_id JOIN material_revisions r ON r.material_id=h.id AND r.revision=h.revision WHERE e.id=?`).get(id):undefined;
 if(!raw&&!formal)return;
 if(raw?.privacy.excluded||formal&&(formal.invalidated||formal.retired||Number(formal.sequence)<Number(formal.min_visible_sequence)))return;
 const p=raw?.provenance;
 if(p?.sourceId&&p.externalId){const head=db.prepare('SELECT capture_id,deleted FROM source_heads WHERE source_id=? AND external_id=?').get(p.sourceId,p.externalId);if(head&&(head.deleted||head.capture_id!==raw!.id))return;}
 const manifest=formal?JSON.parse(String(formal.manifest)):undefined;
 const record=(raw?{...raw,id,...(proof?{capturedAt:proof.capturedAt}:{}),privacy:{excluded:raw.privacy.excluded,redacted:raw.privacy.redacted,mode:raw.privacy.mode,...(raw.privacy.collection?{collection:raw.privacy.collection}:{})}}:{
  id,deviceId:String(formal!.device_id??formal!.source_id),source:'message',platform:'import',appId:'mote.material',capturedAt:proof?.capturedAt??String(formal!.created_at),receivedAt:proof?.receivedAt??String(formal!.created_at),durationMs:0,privacy:{excluded:false,redacted:false,mode:'none'},
  provenance:{sourceId:String(formal!.source_id),externalId:String(formal!.external_id),revision:proof?.revision,document:{recordedAt:proof?.recordedAt,occurredAt:proof?.occurredAt,timeBasis:proof?.timeBasis,coding:manifest?.origin?.provider?manifest.origin:undefined}},
 }) as CaptureRecord;
 if(record.provenance?.document?.coding){const value=record.provenance.document.coding;record.provenance.document.coding=Object.fromEntries(['provider','projectKey','repositoryKey','sessionId'].flatMap(key=>typeof value[key as keyof typeof value]==='string'?[[key,value[key as keyof typeof value]]]:[])) as typeof value;}
 if(record.metadata?.memoryCorrection){const value=record.metadata.memoryCorrection;record.metadata.memoryCorrection={memoryId:value.memoryId,domain:value.domain,scopeRefs:value.scopeRefs.map(({provider,projectKey,repositoryKey,sessionId})=>({provider,projectKey,repositoryKey,sessionId}))};}
 const sourceId=record.provenance?.sourceId,source=sourceId?db.prepare("SELECT json_extract(json,'$.kind') kind FROM source_connections WHERE id=?").get(sourceId):undefined;
 const sourceKind=source?String(source.kind):formal?formal.kind==='mote.screen-segment'?'screen':formal.kind==='mote.coding-session'?'coding-agent':'material':record.source==='screen'||record.source==='ui_page'?'screen':record.provenance?.document?.coding?'coding-agent':record.source;
 const file=db.prepare('SELECT source_id,external_id FROM file_versions WHERE capture_id=?').get(chunk?String(chunk.capture_id):id);
 const identity=openMemoryDeletions(store,{records:{read:ids=>store.evidence([...ids])}}).originalIdentity(id);
 if(table(store,'memory_deletion_dependencies'))db.prepare("UPDATE memory_deletions SET json=json_set(json,'$.originalTexts',json('[]')) WHERE id IN (SELECT deletion_id FROM memory_deletion_dependencies WHERE evidence_id=?)").run(id);
 return releasedMemoryOriginalSchema.parse({version:1,releasedAt:new Date().toISOString(),memoryFingerprints:Object.fromEntries(cards.map(card=>[card.id,card.fingerprint])),record,sourceKind,sourceRegistered:Boolean(source),representation:formal?'material':'capture',phase:formal?(manifest.coverage?.state??'pending'):raw?.ocr?.status==='pending'?'pending':raw?.ocr?.status==='failed'?'partial':'complete',...(formal?{materialId:String(formal.material_id)}:{}),...(file?{file:{sourceId:String(file.source_id),externalId:String(file.external_id)}}:{}),identity}) as unknown as ReleasedMemoryOriginal;
}

export function memoryOriginalWasReleased(store:EvidenceStore,id:string,memory:Pick<Memory,'id'|'fingerprint'>){return releasedMemoryOriginal(store,id)?.memoryFingerprints[memory.id]===memory.fingerprint;}

/** Presentation follows current host release facts after provider digest checks.
 * Stored immutable provider records are never rewritten as new originals. */
export function memoryWithOriginalAvailability(store:EvidenceStore,memory:Memory):Memory {
 return {...memory,evidence:memory.evidence.map(reference=>{
  const {originalAvailable:_,...proof}=reference;
  if(!memoryOriginalWasReleased(store,reference.id,memory))return proof;
  const {quote:__,offset:___,length:____,image:_____,fileEvidence:______,fileIndex:_______,...metadata}=proof;
  return {...metadata,originalAvailable:false};
 })};
}

/** Existing explicit source/file/Material forget commands can still find the
 * retained dependencies after their original rows have been reclaimed. */
export function releasedOriginalIdsForScope(store:EvidenceStore,scope:{sourceId?:string;materialId?:string;file?:{sourceId:string;externalId:string}}){
 const fileOrigins=new Set(scope.file?store.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=?').all(scope.file.sourceId,scope.file.externalId).map(row=>String(row.capture_id)):[]);
 return store.db.prepare("SELECT id,json FROM memory_provider_evidence_revocations WHERE json_type(json,'$.releasedOriginal')='object'").all().flatMap(row=>{const value=JSON.parse(String(row.json)).releasedOriginal as ReleasedMemoryOriginal;return scope.sourceId&&value.record.provenance?.sourceId===scope.sourceId||scope.materialId&&value.materialId===scope.materialId||scope.file&&(value.file?.sourceId===scope.file.sourceId&&value.file.externalId===scope.file.externalId||value.identity.origins.some(id=>fileOrigins.has(id)))?[String(row.id)]:[];});
}

const nullableString=z.string().max(4096).nullish(),date=z.string().datetime({offset:true});
const codingScope=z.object({provider:nullableString,projectKey:nullableString,repositoryKey:nullableString,sessionId:nullableString}).strict().nullish();
const scopeSchema=z.object({
 id:z.string().uuid(),deviceId:z.string().max(200),capturedAt:date,receivedAt:date.optional(),deviceName:nullableString,platform:nullableString,durationMs:z.number().nonnegative(),source:z.string().max(100),appId:nullableString,appName:nullableString,
 privacy:z.object({excluded:z.boolean(),redacted:z.boolean(),mode:z.string().max(100),collection:z.enum(['content','activity']).optional()}).strict(),
 ocr:z.object({status:nullableString}).strict().optional(),stateSeries:z.object({samples:z.array(z.object({at:nullableString}).strict()).max(1)}).strict().optional(),
 provenance:z.object({sourceId:nullableString,externalId:nullableString,revision:nullableString,document:z.object({timeBasis:nullableString,occurredAt:date.nullish(),recordedAt:date.nullish(),coding:codingScope}).strict()}).strict().optional(),
 metadata:z.object({memoryCorrection:z.object({memoryId:z.string().uuid(),domain:z.enum(['personal','coding']),scopeRefs:z.array(z.object({provider:nullableString,projectKey:nullableString,projectName:nullableString,projectIdentity:nullableString,repositoryKey:nullableString,sessionId:nullableString}).strict())}).strict().nullish(),media:z.object({sessions:z.array(z.object({appId:nullableString}).strict())}).strict()}).strict().optional(),
}).strict();
export const releasedMemoryOriginalSchema=z.object({version:z.literal(1),releasedAt:date,restoredArchive:z.literal(true).optional(),memoryFingerprints:z.record(z.string().uuid(),z.string().regex(/^[a-f0-9]{64}$/)),record:scopeSchema,sourceKind:z.string().max(200),sourceRegistered:z.boolean(),representation:z.enum(['capture','material']),phase:z.enum(['pending','partial','complete']),materialId:z.string().max(300).optional(),file:z.object({sourceId:z.string().max(200),externalId:z.string().max(4096)}).strict().optional(),identity:z.object({origins:z.array(z.string().uuid()).min(1).max(20000),originKeys:z.array(z.string().regex(/^(bytes|event|source):[a-f0-9]{64}$/)).max(60000),lineageKeys:z.array(z.string().regex(/^source:[a-f0-9]{64}$/)).max(20000),sourceIds:z.array(z.string().max(200)).max(40000)}).strict()}).strict();
export const releasedMemoryOriginalsSchema=z.array(z.object({id:z.string().uuid(),release:releasedMemoryOriginalSchema}).strict());
