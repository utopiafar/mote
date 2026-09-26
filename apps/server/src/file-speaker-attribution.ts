import {fileSpeakerAttributionSchema} from '@mote/shared';
import type {Store} from './store.js';

/** Owner confirmations belong to one acoustic artifact, never to a global label. */
export function readFileSpeakerAttributions(store:Store,captureId:string,artifactId:string){
  const row=store.db.prepare("SELECT id,created_at,json FROM file_artifacts WHERE capture_id=? AND kind='speaker-names' AND current=1 AND json_extract(json,'$.inputArtifact')=? ORDER BY rowid DESC LIMIT 1").get(captureId,artifactId);
  if(!row)return {};
  const data=JSON.parse(String(row.json));if(data.confirmed!==true)return {};
  return Object.fromEntries(Object.entries(data.names??{}).map(([label,name])=>[label,fileSpeakerAttributionSchema.parse(data.attributions?.[label]??{name,confirmedBy:'owner',confirmationId:String(row.id),confirmedAt:String(row.created_at)})]));
}
