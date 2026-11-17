import {createHash} from 'node:crypto';
import type {EvidenceStore as Store} from './evidence-store.js';
import {materialId,type MaterialStore} from './materials.js';

/** Only the host's complete authored-note body is another identity of the
 * existing original. A dependency, excerpt or Material title is not authority
 * to delete a whole record. No target from this resolver is sent to clients. */
export class MaterialNoteDeletion {
 constructor(private store:Store,private materials:MaterialStore){}
 resolve(id:string):{virtual:boolean;captureId?:string}{
  const db=this.store.db,anchor=db.prepare('SELECT material_id FROM material_evidence WHERE id=?').get(id);
  if(!anchor)return {virtual:false};
  const denied={virtual:true};
  if(!this.materials.isCurrentEvidence(id))return denied;
  const material=this.materials.get(String(anchor.material_id));
  if(!material||material.kind!=='mote.note'||material.schemaVersion!==2||material.memberCount!==1)return denied;
  // Anchors may survive an unchanged block across context revisions. Validate
  // the current head's block, not only the revision that first minted the ID.
  const block=db.prepare(`SELECT b.block_id,b.kind,b.format,b.member_ids,b.locator,p.text FROM material_blocks b
   JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.revision=? AND b.anchor_id=?`).get(material.id,material.revision,id);
  if(!block||block.block_id!=='record'||block.kind!=='text'||block.format!=='plain'||block.locator!==null)return denied;
  const members=JSON.parse(String(block.member_ids)) as unknown;
  if(!Array.isArray(members)||members.length!==1||typeof members[0]!=='string')return denied;
  const captureId=members[0],record=this.store.evidence([captureId])[0];
  if(!record||!this.store.isCurrentEvidence(captureId)||record.source!=='note'||record.provenance||record.ocrText!==block.text)return denied;
  const member=db.prepare('SELECT kind,ref,source_revision FROM material_members WHERE material_id=? AND revision=? AND id=?').get(material.id,material.revision,captureId);
  if(!member||member.kind!=='capture'||member.ref!=='capture:'+captureId||member.source_revision!==null)return denied;
  const dependencies=db.prepare('SELECT evidence_id FROM material_evidence_dependencies WHERE anchor_id=?').all(id);
  if(dependencies.length!==1||dependencies[0].evidence_id!==captureId)return denied;
  // The current authored producer pins native notes by immutable capture ID;
  // those members have no provider revision. Do not invent a version for them.
  const sourceId='authored:'+createHash('sha256').update(JSON.stringify(record.deviceId)).digest('hex');
  if(material.origin.sourceId!==sourceId||material.origin.externalId!==captureId||material.origin.deviceId!==record.deviceId||material.id!==materialId(sourceId,captureId))return denied;
  const groups=db.prepare("SELECT group_json FROM material_organizer_groups WHERE material_id=? AND organizer_id='mote.authored-record' AND version='4' AND active=1").all(material.id);
  if(groups.length!==1)return denied;
  const group=JSON.parse(String(groups[0].group_json)) as Record<string,unknown>;
  if(Object.keys(group).length!==2||group.captureId!==captureId||group.deviceId!==record.deviceId)return denied;
  const input=db.prepare("SELECT material_id FROM material_organizer_inputs WHERE capture_id=? AND organizer_id='mote.authored-record' AND group_json=?").get(captureId,groups[0].group_json);
  if(input?.material_id!==material.id)return denied;
  const context=db.prepare('SELECT json FROM material_evidence_context WHERE anchor_id=?').get(id);
  if(!context||JSON.parse(String(context.json)).document?.contentRole!=='authored')return denied;
  return {virtual:true,captureId};
 }
}
