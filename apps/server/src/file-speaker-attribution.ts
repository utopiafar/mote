import {fileSpeakerAttributionSchema} from '@mote/shared';
import type {Store} from './store.js';

type ArtifactRow={id:string;kind:string;input:string|null;inputs:string|null};
/** An owner name belongs to the acoustic separation that produced its label.
 * Derived text containers (cleanup, semantic turns, corrections) may change while
 * the same diarization stays current; a new diarization must not inherit a name
 * that was confirmed against another acoustic result. */
function acousticDiarization(store:Store,captureId:string,artifactId:string):string|undefined {
  let frontier=[artifactId];
  const seen=new Set(frontier);
  for(let depth=0;depth<32&&frontier.length;depth++){
    const rows=store.db.prepare(`SELECT id,kind,json_extract(json,'$.inputArtifact') AS input,json_extract(json,'$.inputArtifacts') AS inputs
      FROM file_artifacts WHERE capture_id=? AND id IN (SELECT value FROM json_each(?))`).all(captureId,JSON.stringify(frontier)) as ArtifactRow[];
    for(const row of rows)if(row.kind==='diarization')return row.id;
    const next:string[]=[];
    for(const row of rows){
      if(typeof row.input==='string')next.push(row.input);
      if(typeof row.inputs==='string')for(const value of JSON.parse(row.inputs) as unknown[])if(typeof value==='string')next.push(value);
    }
    frontier=[...new Set(next.filter(id=>!seen.has(id)))];
    for(const id of frontier)seen.add(id);
  }
  return undefined;
}

/** Owner confirmations belong to one acoustic result, never to a global label.
 * A derived view inherits a confirmation only while its lineage still points at
 * the same diarization artifact; editing text or regrouping turns keeps it, and
 * a new diarization drops it. Legacy artifacts without a diarization record keep
 * the original exact-artifact binding. */
export function readFileSpeakerAttributions(store:Store,captureId:string,artifactId:string){
  const row=store.db.prepare("SELECT id,created_at,json FROM file_artifacts WHERE capture_id=? AND kind='speaker-names' AND current=1 ORDER BY rowid DESC LIMIT 1").get(captureId) as {id:string;created_at:string;json:string}|undefined;
  if(!row)return {};
  const data=JSON.parse(String(row.json)) as {confirmed?:unknown;names?:Record<string,string>;attributions?:Record<string,unknown>;inputArtifact?:unknown};
  if(data.confirmed!==true)return {};
  const owner=typeof data.inputArtifact==='string'?data.inputArtifact:undefined;
  if(!owner)return {};
  const targetRoot=acousticDiarization(store,captureId,artifactId),ownerRoot=acousticDiarization(store,captureId,owner);
  if(targetRoot&&ownerRoot){if(targetRoot!==ownerRoot)return {};}
  else if(owner!==artifactId)return {};
  return Object.fromEntries(Object.entries(data.names??{}).map(([label,name])=>[label,fileSpeakerAttributionSchema.parse(data.attributions?.[label]??{name,confirmedBy:'owner',confirmationId:String(row.id),confirmedAt:String(row.created_at)})]));
}
