import {z} from 'zod';
import {fileSpeakerAttributionSchema,imageLocationSchema} from './files.js';
import {documentSchema,sourceItemKinds} from './sources.js';

/** These are organizer-owned serializations, not JSON guessed from captured prose. */
export type SourceTextFormat='source-record-json-v1'|'speech-json-v1';
const speech=z.object({speaker:z.string().max(100).optional(),speakerAttribution:fileSpeakerAttributionSchema.optional(),imageLocation:imageLocationSchema.optional(),text:z.string().max(250000)}).strict().refine(value=>value.speaker!==undefined||value.imageLocation!==undefined);
const source=z.object({captureId:z.string().uuid(),capturedAt:z.string().datetime({offset:true}),source:z.enum(sourceItemKinds),appName:z.string().max(300).optional(),text:z.string().max(250000).optional(),documentTime:documentSchema.pick({recordedAt:true,occurredAt:true,timeBasis:true,contentRole:true}).strict().optional()}).passthrough();
export function sourceTextFormat(block:{id:string;format?:string;locator?:Record<string,unknown>}):SourceTextFormat|undefined {
  if(block.format!=='json')return;
  if(block.id==='source-record')return 'source-record-json-v1';
  if(typeof block.locator?.chunkId==='string')return 'speech-json-v1';
}
export function decodeSourceText(format:SourceTextFormat,text:string){
  let json:unknown;try{json=JSON.parse(text);}catch{return;}
  if(format==='source-record-json-v1'){const value=source.safeParse(json);if(value.success)return {...value.data,kind:'source' as const,text:value.data.text??''};}
  if(format==='speech-json-v1'){const value=speech.safeParse(json);if(value.success)return {kind:'speech' as const,...value.data};}
}

/** Raw UTF-16 boundaries of complete code points in the top-level text string.
 * Only coordinates survive; no unread decoded text is retained in this plan. */
export function sourceTextBoundaries(format:SourceTextFormat,raw:string):number[]|undefined {
  const decoded=decodeSourceText(format,raw);if(!decoded)return;
  let depth=0,tokenStart=-1,tokenEnd=-1,matches=0;
  for(let i=0;i<raw.length;i++){
    const ch=raw[i];
    if(ch==='"'){
      const start=i;for(i++;i<raw.length;i++){if(raw[i]==='\\'){i++;continue;}if(raw[i]==='"')break;}
      if(depth!==1||JSON.parse(raw.slice(start,i+1))!=='text')continue;
      let colon=i+1;while(/\s/.test(raw[colon]??'')&&colon<raw.length)colon++;
      if(raw[colon]!==':')continue;
      let value=colon+1;while(/\s/.test(raw[value]??'')&&value<raw.length)value++;
      if(raw[value]!=='"')return;
      tokenStart=value+1;
      for(value++;value<raw.length;value++){if(raw[value]==='\\'){value++;continue;}if(raw[value]==='"')break;}
      tokenEnd=value;matches++;
    }else if(ch==='{'||ch==='[')depth++;
    else if(ch==='}'||ch===']')depth--;
  }
  if(matches===0&&decoded.text==='')return [0];
  if(matches!==1||tokenStart<0||JSON.parse('"'+raw.slice(tokenStart,tokenEnd)+'"')!==decoded.text)return;
  const boundaries=[tokenStart];
  const unit=(at:number)=>{
    if(raw[at]!=='\\')return {end:at+1,code:raw.charCodeAt(at)};
    const end=at+(raw[at+1]==='u'?6:2);
    return {end,code:JSON.parse('"'+raw.slice(at,end)+'"').charCodeAt(0) as number};
  };
  for(let at=tokenStart;at<tokenEnd;){
    let {end,code}=unit(at);
    if(code>=0xd800&&code<=0xdbff&&end<tokenEnd){const next=unit(end);if(next.code>=0xdc00&&next.code<=0xdfff)end=next.end;}
    boundaries.push(end);at=end;
  }
  return boundaries;
}
