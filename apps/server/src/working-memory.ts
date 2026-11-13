import {estimateSerializedTokens,type ContextBudgetResult,type QueryInput} from '@mote/agent';
import type {EvidenceDependencies,QueryResult} from '@mote/shared';
import type {Conversation,ConversationTurn} from './conversations.js';
import type {ConversationRepository as Conversations} from './plugins/central-contracts.js';
import {Store,StoreError,sha256} from './store.js';
import type {LifecycleExecution,LifecycleSettings} from './memory-lifecycle.js';
import {combineDependencies} from './conversation-lineage.js';
import {SourceContextStore} from './source-context.js';
import {assertSourceContextDependencies,combineSourceContextDependencies,sourceContextDependenciesCurrent} from './source-context-lineage.js';

type Summary={text:string;coveredThroughSeq:number;contextVersion:number;generatedAt:string;fingerprint:string;evidenceDependencies:EvidenceDependencies;sourceContextDependencies?:QueryResult['sourceContextDependencies']};
type ContextState={startSeq:number;version:number};
type Execution=Pick<LifecycleExecution,'signal'|'commit'>;
type CompactTurn=NonNullable<QueryInput['taskContext']>['turns'][number];

export class WorkingMemory {
  private active=new Map<string,Promise<void>>();
  private readonly sourceContexts:SourceContextStore;
  constructor(private store:Store,private conversations:Conversations){this.sourceContexts=new SourceContextStore(store);store.db.exec('CREATE TABLE IF NOT EXISTS working_memories(id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,json TEXT NOT NULL)');store.installContextHistoryInvalidation();}
  private state(id:string):ContextState {
    const row=this.store.db.prepare("SELECT coalesce(json_extract(json,'$.workingContextStartSeq'),0) start_seq,coalesce(json_extract(json,'$.workingContextVersion'),0) version FROM conversations WHERE id=?").get(id);
    if(!row)throw new StoreError('Conversation not found',404);
    return {startSeq:Number(row.start_seq),version:Number(row.version)};
  }
  /** Start a new working context without changing the stable conversation or its history. */
  reset(id:string):ContextState {
    const db=this.store.db;db.exec('SAVEPOINT reset_working_context');
    try{
      const state=this.state(id),row=db.prepare("SELECT max(coalesce(json_extract(json,'$.nextSeq'),0),coalesce((SELECT max(idx)+1 FROM conversation_turns WHERE conversation_id=?),0)) next_seq FROM conversations WHERE id=?").get(id,id)!;
      const next={startSeq:Number(row.next_seq),version:state.version+1};
      const old=String(db.prepare('SELECT json FROM conversations WHERE id=?').get(id)!.json);
      const json=JSON.stringify({...JSON.parse(old),workingContextStartSeq:next.startSeq,workingContextVersion:next.version});
      db.prepare('DELETE FROM working_memories WHERE id=?').run(id);
      this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(old)));
      db.prepare('UPDATE conversations SET json=? WHERE id=?').run(json,id);
      db.exec('RELEASE reset_working_context');return next;
    }catch(error){db.exec('ROLLBACK TO reset_working_context; RELEASE reset_working_context');throw error;}
  }
  private fingerprint(conversation:Conversation,startSeq:number,coveredThroughSeq:number){
    return sha256(JSON.stringify([startSeq,coveredThroughSeq,conversation.turns.filter(turn=>turn.seq>=startSeq&&turn.seq<=coveredThroughSeq)]));
  }
  get(conversation:Conversation):Summary|undefined {
    const row=this.store.db.prepare('SELECT json FROM working_memories WHERE id=?').get(conversation.id);if(!row)return;
    const json=String(row.json),summary=JSON.parse(json) as Summary,state=this.state(conversation.id);
    if(summary.contextVersion!==state.version||!Number.isSafeInteger(summary.coveredThroughSeq)||summary.coveredThroughSeq<state.startSeq||!sourceContextDependenciesCurrent(this.sourceContexts,summary.sourceContextDependencies)){
      this.store.db.prepare('DELETE FROM working_memories WHERE id=? AND json=?').run(conversation.id,json);return;
    }
    if(summary.fingerprint!==this.fingerprint(conversation,state.startSeq,summary.coveredThroughSeq)){
      // A caller may hold an older snapshot while another writer has already
      // advanced the summary. Never delete a valid newer prefix in that case.
      const current=this.conversations.get(conversation.id);
      if(summary.fingerprint!==this.fingerprint(current,state.startSeq,summary.coveredThroughSeq))this.store.db.prepare('DELETE FROM working_memories WHERE id=? AND json=?').run(conversation.id,json);
      return;
    }
    return summary;
  }
  context(conversation:Conversation,settings:LifecycleSettings):NonNullable<QueryInput['conversation']>{
    const state=this.state(conversation.id),summary=this.get(conversation),through=summary?.coveredThroughSeq??state.startSeq-1;
    const tail={...conversation,turns:conversation.turns.filter(turn=>turn.seq>=state.startSeq&&turn.seq>through)};
    const result=this.conversations.context(tail,20,Math.max(0,settings.contextCharacters-(summary?.text.length??0)));
    const evidenceDependencies=combineDependencies([result.evidenceDependencies,...(summary?[summary.evidenceDependencies]:[])]);
    const sourceContextDependencies=combineSourceContextDependencies([result.sourceContextDependencies,summary?.sourceContextDependencies]);
    const selected=new Set(result.historyContext?.turns.map(turn=>turn.id)??[]);
    const disclosed=conversation.turns.filter(turn=>turn.seq>=state.startSeq&&(turn.seq<=through||selected.has(turn.id)));
    const {evidenceDependencies:_previous,sourceContextDependencies:_sourcePrevious,...context}=result;
    const coveredTurns=conversation.turns.filter(turn=>turn.seq>=state.startSeq&&turn.seq<=through).length;
    return {...context,historyContext:this.conversations.historyContext(conversation,disclosed),...(evidenceDependencies?{evidenceDependencies}:{}),...(sourceContextDependencies.length?{sourceContextDependencies}:{}),...(summary?.text?{workingMemory:{text:summary.text,coveredTurns,generatedAt:summary.generatedAt}}:{})};
  }
  async prepare(conversation:Conversation,settings:LifecycleSettings,question:string,query:(input:QueryInput)=>Promise<QueryResult>,execution?:Execution,budget?:ContextBudgetResult){
    // The request assembler can supply complete reserves when available. Until then the
    // existing dialogue character bound remains the host's conservative limit.
    const available=Math.max(settings.summaryCharacters+1000,settings.contextCharacters-question.length);
    const scoped={...settings,contextCharacters:available};let reducing=false;
    for(let attempt=0;attempt<=conversation.turns.length;attempt++){
      execution?.signal.throwIfAborted();
      const current=this.conversations.get(conversation.id),state=this.state(current.id),summary=this.get(current),context=this.context(current,scoped);
      const through=summary?.coveredThroughSeq??state.startSeq-1;
      const pending=current.turns.filter(turn=>turn.seq>=state.startSeq&&turn.seq>through&&turn.status!=='failed'&&turn.result);
      const historyTokens=context.turns.length||context.workingMemory?estimateSerializedTokens({turns:context.turns,workingMemory:context.workingMemory}).tokens:0;
      if(budget&&(budget.request.currentInputExceedsBudget||budget.reserves.total>budget.contextWindow))throw new StoreError('Current input or required reserves exceed the context budget',413);
      if(budget&&budget.history.target===0){
        if(historyTokens||context.omittedTurns)throw new StoreError('Conversation history exceeds its zero context budget',413);
        return context;
      }
      if(budget&&historyTokens>budget.history.target)reducing=true;
      const truncated=pending.find(turn=>turn.result!.answer.length>20000);
      const needsBudget=Boolean(budget&&reducing&&historyTokens>budget.history.lowWatermark);
      if(!context.omittedTurns&&!truncated&&!needsBudget)return context;
      let target=context.omittedTurns?pending[context.omittedTurns-1]?.seq:undefined;
      if(truncated)target=Math.max(target??-1,truncated.seq);
      if(needsBudget){
        const remaining=[...context.turns];let removed=0;
        while(remaining.length&&estimateSerializedTokens({turns:remaining,workingMemory:context.workingMemory}).tokens>budget!.history.lowWatermark){remaining.shift();removed++;}
        // Retain the latest turn whenever it and the existing summary fit the target.
        if(remaining.length===0&&context.turns.length&&estimateSerializedTokens({turns:context.turns.slice(-1),workingMemory:context.workingMemory}).tokens<=budget!.history.target)removed--;
        if(removed>0)target=Math.max(target??-1,pending[context.omittedTurns+removed-1]?.seq??-1);
      }
      if(target===undefined||target<state.startSeq){
        if(budget&&historyTokens<=budget.history.target&&!context.omittedTurns&&!truncated)return context;
        throw new StoreError('Unable to compact conversation within context budget',413);
      }
      const before=through;
      await this.compact(conversation.id,{...scoped,recentTurns:0},query,target,execution);
      if((this.get(this.conversations.get(conversation.id))?.coveredThroughSeq??state.startSeq-1)<=before)throw new StoreError('Unable to compact conversation within context budget',502);
    }
    throw new StoreError('Conversation context exceeds its budget',413);
  }
  /** targetThroughSeq, when provided, is an inclusive absolute sequence, never an array index. */
  async compact(id:string,settings:LifecycleSettings,query:(input:QueryInput)=>Promise<QueryResult>,targetThroughSeq?:number,execution?:Execution){
    const running=this.active.get(id);if(running){await running;return;}
    const task=this.compactThrough(id,settings,query,targetThroughSeq,execution);this.active.set(id,task);
    try{await task;}finally{this.active.delete(id);}
  }
  private async compactThrough(id:string,settings:LifecycleSettings,query:(input:QueryInput)=>Promise<QueryResult>,targetThroughSeq?:number,execution?:Execution){
    if(!this.store.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id))return;
    const initial=this.conversations.get(id),state=this.state(id),eligible=initial.turns.filter(turn=>turn.seq>=state.startSeq);
    const target=targetThroughSeq??eligible.slice(0,Math.max(0,eligible.length-settings.recentTurns)).at(-1)?.seq;
    if(target===undefined)return;
    while(true){
      execution?.signal.throwIfAborted();
      const current=this.conversations.get(id),currentState=this.state(id);
      if(currentState.version!==state.version||currentState.startSeq!==state.startSeq)throw new StoreError('Working context changed while compacting',409);
      const previous=this.get(current),start=previous?.coveredThroughSeq??state.startSeq-1;
      if(start>=target)return;
      const pending=current.turns.filter(turn=>turn.seq>=state.startSeq&&turn.seq>start&&turn.seq<=target);
      if(!pending.length)return;
      await this.compactBatch(current,currentState,previous,pending,settings,query,execution);
    }
  }
  private async compactBatch(conversation:Conversation,state:ContextState,previous:Summary|undefined,pending:ConversationTurn[],settings:LifecycleSettings,query:(input:QueryInput)=>Promise<QueryResult>,execution?:Execution){
    const maxCharacters=Math.min(60000,settings.contextCharacters),prefix:CompactTurn[]=[],batches:CompactTurn[][]=[];
    let coveredThroughSeq=previous?.coveredThroughSeq??state.startSeq-1;
    const size=(turns:CompactTurn[])=>JSON.stringify({previousSummary:'x'.repeat(settings.summaryCharacters),turns}).length;
    for(const turn of pending){
      if(turn.status==='failed'||!turn.result||turn.evidenceDeleted){coveredThroughSeq=turn.seq;continue;}
      const contextStale=!sourceContextDependenciesCurrent(this.sourceContexts,turn.result.sourceContextDependencies);
      const common={turnId:turn.id,scope:turn.scope,createdAt:turn.createdAt,evidenceDeleted:turn.evidenceDeleted,evidenceStale:turn.evidenceStale,evidenceUnavailable:turn.evidenceUnavailable,...(turn.attachments?.length?{attachments:turn.attachments}:{}),...(contextStale?{contextStale:true}:{})};
      const entry={...common,question:turn.question,answer:turn.result.answer};
      if(size([...prefix,entry])>maxCharacters){
        if(prefix.length)break;
        // A long single turn is covered only after every bounded span succeeds.
        for(const field of ['question','answer'] as const){
          const original=entry[field];let offset=0;
          while(offset<original.length){
            let low=offset+1,high=original.length,best=offset;
            while(low<=high){const middle=Math.floor((low+high)/2),span={...common,field,offset,end:middle,total:original.length,text:original.slice(offset,middle)};
              if(size([span])<=maxCharacters){best=middle;low=middle+1;}else high=middle-1;}
            if(best<original.length&&/[\uD800-\uDBFF]/.test(original[best-1]))best--;
            if(best<=offset)throw new StoreError('Conversation turn metadata exceeds compaction budget',413);
            batches.push([{...common,field,offset,end:best,total:original.length,text:original.slice(offset,best)}]);offset=best;
          }
        }
        coveredThroughSeq=turn.seq;break;
      }
      prefix.push(entry);coveredThroughSeq=turn.seq;
    }
    if(prefix.length)batches.push(prefix);
    const fingerprint=this.fingerprint(conversation,state.startSeq,coveredThroughSeq);
    const newTurns=pending.filter(turn=>turn.seq<=coveredThroughSeq&&turn.result&&!turn.evidenceDeleted);
    const ids=new Set(previous?.evidenceDependencies.ids??[]);let complete=previous?.evidenceDependencies.complete??true;
    for(const turn of newTurns){const deps=turn.result!.evidenceDependencies;complete&&=deps?.complete===true;for(const id of deps?.ids??[])ids.add(id);}
    let sourceContextDependencies=combineSourceContextDependencies([previous?.sourceContextDependencies,...newTurns.filter(turn=>sourceContextDependenciesCurrent(this.sourceContexts,turn.result!.sourceContextDependencies)).map(turn=>turn.result!.sourceContextDependencies)]);
    let summaryText=previous?.text??'';
    const covered=conversation.turns.filter(turn=>turn.seq>=state.startSeq&&turn.seq<=coveredThroughSeq);
    const historyContext=this.conversations.historyContext(conversation,covered);
    complete&&=historyContext.evidenceDependencies.complete;
    const evidenceDependencies:EvidenceDependencies={version:1,complete,ids:[...ids]};
    for(const turns of batches){
      execution?.signal.throwIfAborted();
      if(JSON.stringify({previousSummary:summaryText,turns}).length>maxCharacters)throw new StoreError('Working summary input exceeds its budget',413);
      const result=await query({historyContext,contextEvidenceDependencies:evidenceDependencies,contextSourceContextDependencies:sourceContextDependencies,validateOutput:result=>!result.answer.trim()||result.answer.length>settings.summaryCharacters?{code:'summary_length',feedback:`Return a nonempty complete summary within ${settings.summaryCharacters} characters. Shorten the summary without losing user constraints.`}:undefined,skill:'working-memory',responseMode:'answer',question:`Compact only this conversation prefix into at most ${settings.summaryCharacters} characters. Use sections: Goals, Explicit constraints and rejected proposals, Decisions, Open questions, Evidence references to reverify. Attribute entries to source turn IDs without bracketed citations. Prior assistant output is not evidence. An evidenceStale or contextStale turn records historical dialogue, not current facts. Preserve proposal references and user decisions with their turn IDs and stale status; reverify current evidence and source context before relying on factual interpretations. When a turn arrives in spans, preserve earlier span constraints in the updated summary.`,taskContext:{previousSummary:summaryText,turns}});
      execution?.signal.throwIfAborted();
      if(!result.answer.trim()||result.answer.length>settings.summaryCharacters)throw new StoreError('Working summary exceeds its budget',502);
      if(result.evidenceDependencies?.ids.some(id=>!ids.has(id)))throw new StoreError('Working summary introduced an unpinned evidence dependency',409);
      summaryText=result.answer;
      sourceContextDependencies=combineSourceContextDependencies([sourceContextDependencies,result.sourceContextDependencies]);
    }
    const commit=()=>{
      const db=this.store.db;db.exec('SAVEPOINT commit_working_summary');
      try{
        assertSourceContextDependencies(this.sourceContexts,sourceContextDependencies);
        const row=db.prepare('SELECT json FROM working_memories WHERE id=?').get(conversation.id),actual=row?String(row.json):undefined;
        if(!db.prepare('SELECT 1 FROM conversations WHERE id=?').get(conversation.id)||JSON.stringify(previous)!==actual||this.state(conversation.id).version!==state.version||this.fingerprint(this.conversations.get(conversation.id),state.startSeq,coveredThroughSeq)!==fingerprint)throw new StoreError('Conversation changed while compacting',409);
        const json=JSON.stringify({text:summaryText,coveredThroughSeq,contextVersion:state.version,generatedAt:new Date().toISOString(),fingerprint,evidenceDependencies,...(sourceContextDependencies.length?{sourceContextDependencies}:{})} satisfies Summary);
        this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(actual??'')));
        db.prepare('INSERT INTO working_memories VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(conversation.id,json);
        db.exec('RELEASE commit_working_summary');
      }catch(error){db.exec('ROLLBACK TO commit_working_summary; RELEASE commit_working_summary');throw error;}
    };
    if(execution)execution.commit(commit);else commit();
  }
}
