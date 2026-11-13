import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {ContextRange,QueryInput} from '@mote/agent';
import type {Conversations,ConversationTurn} from './conversations.js';
import {combineDependencies} from './conversation-lineage.js';
import {combineSourceContextDependencies} from './source-context-lineage.js';
import {scopedHistoryTurns,type QueryScope} from './query-scope.js';
import {StoreError,type Store} from './store.js';

const prefix='/_conversation/';
type Args=ContextRange&{path?:string;query?:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const splitsPair=(value:string,index:number)=>index>0&&index<value.length&&/[\uD800-\uDBFF]/.test(value[index-1])&&/[\uDC00-\uDFFF]/.test(value[index]);
const excerpt=(value:string,length:number)=>{let end=Math.min(value.length,length);if(splitsPair(value,end))end--;return {text:value.slice(0,end),truncated:end<value.length};};

/** The existing catalog read transports dialogue navigation; it does not grant
 * access to originals. Only the active conversation and its established scope
 * can be read, and every disclosed turn is added to the existing history pin. */
export function conversationHistoryReader(deps:{store:Store;conversations:Pick<Conversations,'get'|'historyContext'|'assertHistoryContext'|'referenceAvailability'>;current:()=>QueryInput|undefined;assert:(input:QueryInput)=>void;cursorSecret:string;historyBeforeSeq:(workId:string)=>number|undefined}){
  const {store,conversations,current,assert}=deps;
  // A model cursor must not reveal gaps belonging to filtered-out turns.
  const cursorKey=deps.cursorSecret?createHash('sha256').update('mote.conversation-history.cursor\0').update(deps.cursorSecret).digest():randomBytes(32);
  const seal=(before:number,binding:string)=>{
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey,iv);
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify({before,binding}),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url');
  };
  const open=(cursor:string)=>{
    const bytes=Buffer.from(cursor,'base64url');if(bytes.length<29)throw Error();
    const decipher=createDecipheriv('aes-256-gcm',cursorKey,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')) as {before?:unknown;binding?:unknown};
  };
  return (args:Args)=>{
    if(!args.path?.startsWith(prefix))return undefined;
    const input=current(),conversation=input?.conversation,initial=conversation?.historyContext;
    if(!input||input.executionLane!=='interactive'||!conversation||!initial)throw new StoreError('Conversation history is unavailable',404);
    const turnPath=/^\/_conversation\/turn\/([0-9a-f-]{36})\/(0|[1-9][0-9]{0,7})$/i.exec(args.path);
    const mode=args.path===prefix+'history'?'history':args.path===prefix+'search'?'search':turnPath?'turn':undefined;
    const anchor=turnPath?.[1],offset=Number(turnPath?.[2]??0);
    if(!mode||offset>10000000||mode==='search'&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>200))throw new StoreError('Invalid conversation history request',400);
    const operation=input.traceContext?.operationId;
    if(!operation?.startsWith('query:'))throw new StoreError('Conversation history is unavailable',404);
    const run=store.db.prepare("SELECT json_extract(json,'$.conversationId') conversation_id,json_extract(json,'$.turnId') turn_id FROM query_runs WHERE id=?").get(operation.slice(6));
    if(!run||run.conversation_id!==initial.conversationId)throw new StoreError('Conversation history is unavailable',404);
    const saved=conversations.get(initial.conversationId);
    const currentTurn=run.turn_id?store.db.prepare('SELECT idx FROM conversation_turns WHERE conversation_id=? AND id=?').get(saved.id,run.turn_id):undefined;
    if(run.turn_id&&!currentTurn)throw new StoreError('Conversation message is no longer available',409);
    const high=currentTurn?Number(currentTurn.idx):deps.historyBeforeSeq(operation);
    if(!Number.isSafeInteger(high)||Number(high)<0)throw new StoreError('Conversation history boundary is unavailable',409);
    // Both queued and synchronous runs freeze an exclusive sequence boundary;
    // equal timestamps and later messages cannot expand an already admitted run.
    const older=saved.turns.filter(turn=>turn.seq<Number(high));
    const scope={after:input.after,before:input.before,deviceId:input.deviceId,sourceIds:(input as QueryScope).sourceIds,evidenceIds:input.historicalSelection?.evidenceIds??input.evidenceIds};
    const sourceScope=scope.sourceIds===undefined?{}:{sourceIds:scope.sourceIds};
    const eligible=scopedHistoryTurns(older,scope,input.directImages?.map(image=>image.id)).filter(turn=>Boolean(turn.result));
    const binding=digest([initial.conversationId,mode,args.query??null,scope,anchor??null,offset]);
    let before=Number.MAX_SAFE_INTEGER;
    if(args.cursor){
      try{const cursor=open(args.cursor);
        if(cursor.binding!==binding||!Number.isSafeInteger(cursor.before)||Number(cursor.before)<0)throw Error();before=Number(cursor.before);
      }catch{throw new StoreError('Invalid conversation history cursor',400);}
    }
    const authorized=(turn:ConversationTurn)=>{
      if(turn.evidenceDeleted)return true;
      const snapshot=conversations.historyContext(saved,[turn]);
      const evidenceDependencies=turn.result?.evidenceDependencies;
      if(!evidenceDependencies?.complete||!snapshot.evidenceDependencies.complete)return false;
      try{
        assert({question:'',...sourceScope,conversation:{turns:[{question:turn.question,answer:turn.result!.answer,scope:turn.scope,createdAt:turn.createdAt}],omittedTurns:0,historyContext:snapshot,evidenceDependencies,
          ...(!turn.evidenceStale&&turn.result?.sourceContextDependencies?{sourceContextDependencies:turn.result.sourceContextDependencies}:{})}});
        return true;
      }catch{return false;}
    };
    const literal=args.query?.toLowerCase();
    const matching=eligible.filter(turn=>turn.seq<before&&(!anchor||turn.id===anchor)&&authorized(turn)&&
      (mode!=='search'||!turn.evidenceDeleted&&(turn.question.toLowerCase().includes(literal!)||turn.result!.answer.toLowerCase().includes(literal!)))).reverse();
    const limit=Math.max(1,Math.min(Math.trunc(args.limit??8),20)),page=matching.slice(0,limit),hasMore=matching.length>limit;
    if(anchor&&!page.length)throw new StoreError('Conversation message not found',404);
    const shown=page.filter(turn=>!turn.evidenceDeleted);
    const attachments=new Map<string,NonNullable<ConversationTurn['attachments']>>();
    for(const turn of shown){
      const visible=(turn.attachments??[]).filter(attachment=>{
        // A filename can reach a later model only when the saved answer's
        // existing lineage already includes that attachment.
        if(!turn.result?.evidenceDependencies?.ids.includes(attachment.id))return false;
        try{assert({question:'',...sourceScope,contextEvidenceDependencies:{version:1,complete:true,ids:[attachment.id]}});return true;}catch{return false;}
      });
      if(visible.length)attachments.set(turn.id,visible);
    }
    const attachmentIds=[...new Set([...attachments.values()].flatMap(items=>items.map(item=>item.id)))];
    conversations.assertHistoryContext(initial);
    const ids=[...initial.turns.map(turn=>turn.id),...shown.map(turn=>turn.id)];
    const byId=new Map(saved.turns.map(turn=>[turn.id,turn]));
    const pinned=[...new Set(ids)].map(id=>byId.get(id));
    if(pinned.some(turn=>!turn))throw new StoreError('Conversation history changed',409);
    const snapshot=conversations.historyContext(saved,pinned as ConversationTurn[]);
    const dependencies=combineDependencies([conversation.evidenceDependencies,...shown.map(turn=>turn.result!.evidenceDependencies)]);
    if(!dependencies?.complete||!snapshot.evidenceDependencies.complete)throw new StoreError('Conversation history lineage is incomplete',409);
    // The live input is shared with the existing provider and publication
    // checks; the snapshot contains only actually disclosed turns.
    conversation.historyContext=snapshot;conversation.evidenceDependencies=dependencies;
    const pins=combineSourceContextDependencies([conversation.sourceContextDependencies,...shown.filter(turn=>!turn.evidenceStale).map(turn=>turn.result!.sourceContextDependencies)]);
    if(pins.length)conversation.sourceContextDependencies=pins;
    assert(input);
    const items=page.map(turn=>{
      if(turn.evidenceDeleted)return {id:turn.id,createdAt:turn.createdAt,evidenceDeleted:true};
      let end=offset+4000;
      if(mode==='turn'){
        if(splitsPair(turn.question,offset)||splitsPair(turn.result!.answer,offset))throw new StoreError('Invalid conversation text offset',400);
        while(splitsPair(turn.question,end)||splitsPair(turn.result!.answer,end))end--;
      }
      const question=mode==='turn'?{text:turn.question.slice(offset,end),truncated:offset>0||end<turn.question.length}:excerpt(turn.question,mode==='search'?400:2000);
      const answer=mode==='turn'?{text:turn.result!.answer.slice(offset,end),truncated:offset>0||end<turn.result!.answer.length}:excerpt(turn.result!.answer,mode==='search'?1000:8000);
      const references=turn.result!.citations.filter(cite=>{
        if(!conversations.referenceAvailability(saved.id,cite.id).available)return false;
        try{assert({question:'',...sourceScope,contextEvidenceDependencies:{version:1,complete:true,ids:[cite.id]}});return true;}catch{return false;}
      }).map(cite=>cite.id);
      return {id:turn.id,createdAt:turn.createdAt,question:question.text,answer:answer.text,
        ...(question.truncated?{questionTruncated:true}:{}),...(answer.truncated?{answerTruncated:true}:{}),
        ...(mode==='turn'?{textRange:{offset,nextOffset:end<Math.max(turn.question.length,turn.result!.answer.length)?end:null}}:{}),
        ...(turn.evidenceStale?{evidenceStale:true}:{}),...(turn.evidenceUnavailable?{evidenceUnavailable:true}:{}),
        ...(attachments.has(turn.id)?{attachments:attachments.get(turn.id)}:{}),references};
    });
    return {items,nextCursor:hasMore?seal(page.at(-1)!.seq,binding):null,
      disclosureDependencies:combineDependencies([...shown.map(turn=>turn.result!.evidenceDependencies),{version:1,complete:true,ids:attachmentIds}])!,
      sourceContextDependencies:pins};
  };
}
