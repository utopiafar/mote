import {createHash} from 'node:crypto';
import {z} from 'zod';
import {codingMessageSpanSchema,type CaptureRecord,type CodingMessageSpan,type SourceItem} from '@mote/shared';

const nativeRef=z.string().regex(/^coding-session:[a-f0-9]{64}$/);
export const codingSessionRelationsSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('identity'),ref:nativeRef}).strict(),
  z.object({kind:z.literal('child'),ref:nativeRef}).strict(),
  z.object({kind:z.literal('parent'),ref:nativeRef,beforeEntry:z.number().int().nonnegative().safe().optional()}).strict(),
  z.object({kind:z.literal('launch'),ref:nativeRef,turnId:z.string().uuid(),entry:z.number().int().nonnegative().safe().optional()}).strict(),
]).array();
export type CodingSessionRelation=z.infer<typeof codingSessionRelationsSchema>[number];

function digest(input:unknown){return createHash('sha256').update(JSON.stringify(input)).digest('hex');}

export function codingSessionRef(sourceId:string,provider:string,sessionId:string){
  return 'coding-session:'+digest([sourceId,provider,sessionId]);
}

export function codingSessionRelations(sourceId:string,provider:string,sessionId:string,items:readonly SourceItem[],prior:readonly CodingSessionRelation[]=[]):CodingSessionRelation[]{
  const ref=codingSessionRef(sourceId,provider,sessionId);
  const relations=new Map<string,CodingSessionRelation>(prior.filter(item=>item.kind!=='identity').map(item=>[digest(item),item]));
  for(const item of items){
    const coding=item.document?.coding;
    if(!coding||coding.provider!==provider||coding.sessionId!==sessionId||item.deleted||item.layer==='reference')continue;
    if(coding.childSession){
      const relation={kind:'child' as const,ref};
      relations.set(digest(relation),relation);
    }
    if(coding.parentSessionId&&coding.parentSessionId!==sessionId){
      const relation={kind:'parent' as const,ref:codingSessionRef(sourceId,provider,coding.parentSessionId),
        ...(coding.parentBeforeEntry===undefined?{}:{beforeEntry:coding.parentBeforeEntry})};
      relations.set(digest(relation),relation);
    }
    if(coding.launch){
      const child=codingSessionRef(sourceId,provider,coding.launch.childSessionId);
      const relation={kind:'launch' as const,ref:child,turnId:coding.launch.turnId,...(coding.order?{entry:coding.order.entry}:{})};
      relations.set(digest(relation),relation);
    }
  }
  const relationsWithOffsets=new Set([...relations.values()].flatMap(item=>item.kind==='parent'&&item.beforeEntry!==undefined?[item.ref]:[]));
  return [{kind:'identity',ref},...[...relations].sort(([a],[b])=>a.localeCompare(b)).map(([,item])=>item)
    .filter(item=>item.kind!=='parent'||item.beforeEntry!==undefined||!relationsWithOffsets.has(item.ref))];
}

const messageSpans=codingMessageSpanSchema.array().max(256);
export function codingMessages(locator:Record<string,unknown>|undefined):CodingMessageSpan[] {
  const parsed=messageSpans.safeParse(locator?.codingMessages);
  return parsed.success?parsed.data:[];
}

export function codingMessageProof(record:CaptureRecord|undefined,range:{offset?:number;quote:string}) {
  if(range.offset===undefined||!record?.provenance?.document?.coding)return;
  const start=range.offset,end=start+range.quote.length;
  return record.provenance.document.codingMessages?.find(span=>span.start<=start&&end<=span.end);
}
