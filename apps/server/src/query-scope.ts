import {z} from 'zod';
import type {ConversationTurn} from './conversations.js';
export type QueryScope = {after?:string;before?:string;deviceId?:string;timeZone?:string;evidenceIds?:string[];anchorEvidenceIds?:string[];anchorMaterialRef?:string};
export const scopeFields={after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),deviceId:z.string().min(1).max(200).optional(),timeZone:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},{message:'Unknown time zone'}).optional()};
export const validRange=(v:QueryScope)=>!v.after||!v.before||Date.parse(v.after)<Date.parse(v.before);

/** A saved turn may have used anything its original bounds permitted. Its
 * bounds must therefore be wholly inside the current request, not just overlap
 * it. Time zones affect display only and never enlarge the underlying range. */
export function scopeContainsHistory(scope:QueryScope,history:QueryScope):boolean {
  if(scope.deviceId!==undefined&&history.deviceId!==scope.deviceId)return false;
  if(scope.after!==undefined&&(!Number.isFinite(Date.parse(scope.after))||!history.after||!Number.isFinite(Date.parse(history.after))||Date.parse(history.after)<Date.parse(scope.after)))return false;
  if(scope.before!==undefined&&(!Number.isFinite(Date.parse(scope.before))||!history.before||!Number.isFinite(Date.parse(history.before))||Date.parse(history.before)>Date.parse(scope.before)))return false;
  if(!validRange(scope)||!validRange(history))return false;
  return true;
}

export const hasTimeOrDeviceScope=(scope:QueryScope)=>scope.after!==undefined||scope.before!==undefined||scope.deviceId!==undefined;

/** Apply the same conservative historical scope to prompt context and on-demand reads. */
export function scopedHistoryTurns(turns:readonly ConversationTurn[],scope:QueryScope,attachmentIds:readonly string[]=[]):ConversationTurn[] {
  const allowed=new Set([...(scope.evidenceIds??[]),...attachmentIds]);
  const selected=JSON.stringify([...(scope.evidenceIds??[])].sort()),bounded=hasTimeOrDeviceScope(scope);
  let wider=false;
  return turns.filter(turn=>{
    if(bounded&&turn.result){
      if(!scopeContainsHistory(scope,turn.scope)||(turn.attachments?.length??0)>0||turn.historyEvidenceDependencies?.complete!==true)wider=true;
      if(wider)return false;
    }
    const ids=turn.scope.evidenceIds??(turn.scope.kind==='selection'&&turn.scope.sourceIds?.length===0?[]:undefined);
    return scope.evidenceIds===undefined||ids!==undefined&&JSON.stringify([...ids].sort())===selected&&
      (turn.attachments??[]).every(attachment=>allowed.has(attachment.id))&&
      turn.result?.evidenceDependencies?.complete===true&&turn.result.evidenceDependencies.ids.every(id=>allowed.has(id))&&
      turn.historyEvidenceDependencies?.complete===true&&turn.historyEvidenceDependencies.ids.every(id=>allowed.has(id));
  });
}
