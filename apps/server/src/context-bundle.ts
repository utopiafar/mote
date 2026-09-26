import {createHash} from 'node:crypto';
import type {ContextReader} from '@mote/agent';
import {StoreError} from './store.js';
import {cardFromMemory,contextCard,type ContextCard,type ContextQueryInput} from './context-query.js';
import type {EvidenceReader} from './evidence-reader.js';
import type {Memory} from './memory.js';
import type {MaterialRecord} from './materials.js';

/** Each channel owns a resumable position; only delivered cards advance it.
 * A phase cursor keeps exhausted channels exhausted without storing private text. */
export async function contextBundle(reader:EvidenceReader,query:ContextReader,args:ContextQueryInput){
  const {cursor,limit=30,maxCharacters=12000,...scope}=args;
  const h=createHash('sha256').update(JSON.stringify(scope)).digest('base64url');
  type Position={v:1;h:string;p:number;c?:unknown};
  let position:Position={v:1,h,p:0};
  if(cursor){try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString());
    if(value.v!==1||value.h!==h||!Number.isInteger(value.p)||value.p<0||value.p>2)throw Error();position=value;
  }catch{throw new StoreError('Invalid context cursor',400);}}
  const encode=(p:Position)=>p.p>=3?null:Buffer.from(JSON.stringify(p)).toString('base64url');
  const unpack=(value:string|null)=>value?JSON.parse(Buffer.from(value,'base64url').toString()):undefined;
  const pack=(value:unknown)=>value===undefined?undefined:Buffer.from(JSON.stringify(value)).toString('base64url');
  const result={stableMemories:[] as ContextCard[],recentSessions:[] as ContextCard[],recentRecords:[] as ContextCard[],coverage:{recordsReturned:0,memoriesReturned:0,sessionsReturned:0},nextCursor:encode(position),truncated:true};
  const maximum=Math.min(24000,Math.max(1000,maxCharacters));
  let returned=0;
  for(let scanned=0;scanned<300&&position.p<3&&returned<limit;scanned++){
    if(position.p===0&&args.includeMemories===false||position.p===1&&args.includeRecentSessions===false){position={v:1,h,p:position.p+1};continue;}
    const inner=pack(position.c),channel=position.p;let card:ContextCard|undefined,next:string|null=null;
    if(channel===0){const page=await query.memories?.({...scope,cursor:inner,limit:1,status:'published',layer:'memory'});
      card=page?.items[0]?cardFromMemory(page.items[0] as Memory):undefined;next=page?.nextCursor??null;
    }else if(channel===1){const page=await query.materialCatalog?.({...scope,cursor:inner,limit:1,kind:'mote.coding-session'});
      const m=page?.items[0] as MaterialRecord|undefined;next=page?.nextCursor??null;
      if(m&&['sourceId','provider','projectKey','repositoryKey','sessionId'].every(key=>scope[key as keyof typeof scope]===undefined||m.origin[key as keyof typeof m.origin]===scope[key as keyof typeof scope]))card={id:m.id,ref:m.ref,revision:m.revision,kind:'session',title:m.title,snippet:'',matchReasons:['formal session material'],origin:{source:'coding-agent',sourceId:m.origin.sourceId,deviceId:m.origin.deviceId??'',appName:m.title,capturedAt:m.origin.firstAt??m.createdAt,receivedAt:m.updatedAt,provider:m.origin.provider as 'codex'|'claude'|'kimi'|undefined,projectKey:m.origin.projectKey,repositoryKey:m.origin.repositoryKey,sessionId:m.origin.sessionId},evidenceRefs:[],status:m.coverage.state};
    }else{const page=reader.queryPage({...scope,cursor:inner,limit:1},'search');card=page.items[0]?contextCard(page.items[0],scope.query):undefined;next=page.nextCursor;}
    const candidate:Position=next?{v:1,h,p:channel,c:unpack(next)}:{v:1,h,p:channel+1};
    if(!card){position=candidate;continue;}
    const items=channel===0?result.stableMemories:channel===1?result.recentSessions:result.recentRecords;
    items.push(card);result.nextCursor=encode(candidate);result.truncated=Boolean(result.nextCursor);
    result.coverage={recordsReturned:result.recentRecords.length,memoriesReturned:result.stableMemories.length,sessionsReturned:result.recentSessions.length};
    if(JSON.stringify(result).length>maximum&&returned===0){
      // The stable reference preserves expansion even if a very small package
      // cannot carry optional prose or the complete dependency list.
      card.snippet='';card.title=card.title.slice(0,64);card.matchReasons=[];card.evidenceRefs=[];delete card.applicability;delete card.expansion;
      card.origin={source:card.origin.source,deviceId:card.origin.deviceId,appName:'',capturedAt:card.origin.capturedAt,receivedAt:card.origin.receivedAt};
      delete card.revision;
    }
    if(JSON.stringify(result).length>maximum){items.pop();if(!returned)throw new StoreError('Context response budget too small for one reference',413);break;}
    position=candidate;returned++;
  }
  result.nextCursor=encode(position);result.truncated=Boolean(result.nextCursor);
  result.coverage={recordsReturned:result.recentRecords.length,memoriesReturned:result.stableMemories.length,sessionsReturned:result.recentSessions.length};
  if(JSON.stringify(result).length>maximum)throw new StoreError('Context response budget too small',413);
  return result;
}
