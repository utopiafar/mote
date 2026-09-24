import type {Context} from '@deepseek-ai/cordis';
import type {SourceItem} from '@mote/shared';
import {materialId,type MaterialDraft} from './materials.js';
import {archiveHash} from './source-archive.js';
import {StoreError} from './store.js';

const group=(item:SourceItem)=>{
  const coding=item.document?.coding;
  if(!coding)throw new StoreError('Coding source requires explicit session identity');
  return JSON.stringify([coding.provider,coding.projectKey,coding.sessionId]);
};
/** An installable complete source workflow. It owns representation, not storage,
 * SQL, retries, model clients or search implementation. */
export function codingSourcePlugin(ctx:Context){
  ctx.effect(()=>ctx.moteSourcePipelines.register({
    id:'mote.coding',version:'2',sourceKinds:['coding-agent'],storage:'archive',index:'material',modelInput:'material',memory:true,group,
    organize({source,items,group:identity}){
      const [provider,projectKey,sessionId]=JSON.parse(identity) as string[];
      const records=items.filter(item=>!item.deleted).sort((a,b)=>{
        const at=a.document?.recordedAt??a.observedAt,bt=b.document?.recordedAt??b.observedAt;
        return Date.parse(at)-Date.parse(bt)||(a.document?.coding?.eventId===b.document?.coding?.eventId?(a.document?.coding?.part??0)-(b.document?.coding?.part??0):0);
      });
      // Keep the logical document complete. Physical blocks are bounded reads,
      // not event records; a block may contain many messages or part of one.
      const blocks:MaterialDraft['blocks']=[];let buffer='';
      const flush=()=>{if(buffer){blocks.push({id:'section-'+blocks.length,kind:'text',format:'markdown-fragment',text:buffer,memberIds:['archive']});buffer='';}};
      const append=(text:string)=>{
        while(text){let take=Math.min(12000-buffer.length,text.length);if(take<text.length&&/[\uD800-\uDBFF]/.test(text[take-1])&&/[\uDC00-\uDFFF]/.test(text[take]))take--;
          if(!take){flush();continue;}buffer+=text.slice(0,take);text=text.slice(take);if(buffer.length>=11999)flush();}
      };
      append(`# Coding conversation\n\nProvider: ${provider}\nSession: ${sessionId}\n\n`);
      for(const item of records){const c=item.document!.coding!;append(`## ${c.role} · ${item.document?.recordedAt?'Recorded: '+item.document.recordedAt:'Observed: '+item.observedAt}\n\nEvent: ${c.eventId} · Part: ${c.part}/${c.parts}${c.callId?' · Call: '+c.callId:''}\n\n${item.layer==='reference'?'[Body not collected]':item.text}\n\n`);}
      flush();const times=records.map(item=>new Date(item.document?.recordedAt??item.observedAt).toISOString()).sort();
      const events=new Map<string,{parts:number;seen:Set<number>}>();for(const item of records){const c=item.document!.coding!;const event=events.get(c.eventId)??{parts:c.parts,seen:new Set<number>()};event.parts=Math.max(event.parts,c.parts);event.seen.add(c.part);events.set(c.eventId,event);}
      const missingParts=[...events.values()].some(event=>event.seen.size!==event.parts||[...event.seen].some(part=>part>=event.parts));
      const partial=records.some(item=>item.layer==='reference')?'original_body_not_collected':missingParts?'missing_event_parts':undefined;
      return {id:materialId(source.id,identity),kind:'mote.coding-session',schemaVersion:2,
        title:records[0]?.document?.coding?.projectName??sessionId,
        origin:{sourceId:source.id,externalId:identity,deviceId:source.deviceId,provider,projectKey,sessionId,...(times.length?{firstAt:times[0],lastAt:times.at(-1)!}:{})},blocks,
        members:[{id:'archive',kind:'archive',ref:'archive:'+archiveHash([source.id,identity])}],
        coverage:partial?{state:'partial',reason:partial}:{state:'complete'},fidelity:{state:'derived',limitations:['metadata_projected']},retention:{original:'retained',policy:'keep'}};
    },
  }));
}
