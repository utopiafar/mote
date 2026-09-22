import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Conversations,type Conversation} from './conversations.js';
import {Store,StoreError,sha256} from './store.js';
import type {LifecycleExecution,LifecycleSettings} from './memory-lifecycle.js';
import {combineDependencies} from './conversation-lineage.js';

type Summary={text:string;coveredTurns:number;generatedAt:string;fingerprint:string;evidenceDependencies?:QueryResult['evidenceDependencies']};
export class WorkingMemory {
  private active=new Map<string,Promise<void>>();
  constructor(private store:Store,private conversations:Conversations){store.db.exec('CREATE TABLE IF NOT EXISTS working_memories(id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,json TEXT NOT NULL)');}
  private fingerprint(conversation:Conversation,count:number){return sha256(JSON.stringify(conversation.turns.slice(0,count)));}
  get(conversation:Conversation):Summary|undefined {
    const row=this.store.db.prepare('SELECT json FROM working_memories WHERE id=?').get(conversation.id);if(!row)return;
    const summary=JSON.parse(String(row.json)) as Summary;
    if(summary.fingerprint!==this.fingerprint(conversation,summary.coveredTurns)){this.store.db.prepare('DELETE FROM working_memories WHERE id=?').run(conversation.id);return;}
    return summary;
  }
  context(conversation:Conversation,settings:LifecycleSettings):NonNullable<QueryInput['conversation']>{
    const summary=this.get(conversation),tail={...conversation,turns:conversation.turns.slice(summary?.coveredTurns??0)};
    const result=this.conversations.context(tail,20,settings.contextCharacters-(summary?.text.length??0));
    const evidenceDependencies=combineDependencies([result.evidenceDependencies,...(summary?[summary.evidenceDependencies]:[])]);
    const {evidenceDependencies:_previous,...context}=result;
    return {...context,...(evidenceDependencies?{evidenceDependencies}:{}),omittedTurns:tail.turns.filter(t=>t.status!=='failed'&&t.result).length-result.turns.length,...(summary?{workingMemory:{text:summary.text,coveredTurns:summary.coveredTurns,generatedAt:summary.generatedAt}}:{})};
  }
  async prepare(conversation:Conversation,settings:LifecycleSettings,question:string,query:(input:QueryInput)=>Promise<QueryResult>,execution?:Pick<LifecycleExecution,'signal'|'commit'>){
    // Current input consumes the same host dialogue budget. Never silently drop
    // an unsummarized prefix: compact it first, or surface the provider failure.
    const available=Math.max(settings.summaryCharacters+1000,settings.contextCharacters-question.length);
    const scoped={...settings,contextCharacters:available};
    for(let attempt=0;attempt<=conversation.turns.length;attempt++){
      const current=this.conversations.get(conversation.id),context=this.context(current,scoped);
      if(context.omittedTurns===0&&!context.turns.some(t=>t.answerTruncated))return context;
      const before=this.get(current)?.coveredTurns??0;
      const truncated=current.turns.findIndex((t,i)=>i>=before&&Boolean(t.result&&t.result.answer.length>20000));
      await this.compact(conversation.id,{...scoped,recentTurns:0},query,Math.max(before+1,current.turns.length-context.turns.length,truncated+1),execution);
      if((this.get(this.conversations.get(conversation.id))?.coveredTurns??0)<=before)throw new StoreError('Unable to compact conversation within context budget',502);
    }
    throw new StoreError('Conversation context exceeds its budget',413);
  }
  async compact(id:string,settings:LifecycleSettings,query:(input:QueryInput)=>Promise<QueryResult>,targetEnd?:number,execution?:Pick<LifecycleExecution,'signal'|'commit'>){
    const running=this.active.get(id);if(running){await running;return;}
    const task=this.compactPrefix(id,settings,query,targetEnd,execution);this.active.set(id,task);
    try{await task;}finally{this.active.delete(id);}
  }
  private async compactPrefix(id:string,settings:LifecycleSettings,query:(input:QueryInput)=>Promise<QueryResult>,targetEnd?:number,execution?:Pick<LifecycleExecution,'signal'|'commit'>){
    if(!this.store.db.prepare('SELECT id FROM conversations WHERE id=?').get(id))return;
    const conversation=this.conversations.get(id),previous=this.get(conversation),start=previous?.coveredTurns??0,end=targetEnd??conversation.turns.length-settings.recentTurns;
    if(end<=start)return;
    let count=start,characters=JSON.stringify({previousSummary:previous?.text,turns:[]}).length;const prefix:NonNullable<QueryInput['taskContext']>['turns']=[];
    const batches:NonNullable<QueryInput['taskContext']>['turns'][]=[];
    for(const turn of conversation.turns.slice(start,end)){
      if(turn.status==='failed'||!turn.result){count++;continue;}
      const entry={turnId:turn.id,question:turn.question,answer:turn.result.answer,scope:turn.scope,createdAt:turn.createdAt,evidenceDeleted:turn.evidenceDeleted};
      const text=JSON.stringify(entry);if(characters+text.length>60000){
        if(prefix.length)break;
        // One very long answer still needs complete coverage. Summarize its
        // bounded spans in order, committing the covered-turn cursor only after
        // every span succeeds. JSON escaping is included in each span's budget.
        for(const field of ['question','answer'] as const){
          const original=entry[field];let offset=0;
          while(offset<original.length){
            let end=Math.min(original.length,offset+6000);
            if(end<original.length&&/[\uD800-\uDBFF]/.test(original[end-1]))end--;
            batches.push([{turnId:turn.id,field,offset,end,total:original.length,text:original.slice(offset,end),scope:turn.scope,createdAt:turn.createdAt,evidenceDeleted:turn.evidenceDeleted}]);offset=end;
          }
        }
        count++;break;
      }
      prefix.push(entry);characters+=text.length+1;count++;
    }
    const fingerprint=this.fingerprint(conversation,count),revision=this.store.deletionRevision();
    if(prefix.length)batches.push(prefix);
    let summaryText=previous?.text??'';
    for(const turns of batches){
      const result=await query({validateOutput:result=>!result.answer.trim()||result.answer.length>settings.summaryCharacters?{code:'summary_length',feedback:`Return a nonempty complete summary within ${settings.summaryCharacters} characters. Shorten the summary without losing user constraints.`}:undefined,skill:'working-memory',responseMode:'answer',question:`Compact only this conversation prefix into at most ${settings.summaryCharacters} characters. Use sections: Goals, Explicit constraints and rejected proposals, Decisions, Open questions, Evidence references to reverify. Attribute entries to source turn IDs without bracketed citations. Prior assistant output is not evidence. When a turn arrives in spans, preserve earlier span constraints in the updated summary.`,taskContext:{previousSummary:summaryText,turns}});
      if(!result.answer.trim()||result.answer.length>settings.summaryCharacters)throw new StoreError('Working summary exceeds its budget',502);
      summaryText=result.answer;
    }
    const commit=()=>{
    if(this.store.deletionRevision()!==revision||!this.store.db.prepare('SELECT id FROM conversations WHERE id=?').get(id)||this.fingerprint(this.conversations.get(id),count)!==fingerprint)throw new StoreError('Conversation changed while compacting',409);
    const evidenceDependencies=combineDependencies(conversation.turns.slice(0,count).filter(turn=>turn.result).map(turn=>turn.evidenceDeleted?{version:1,complete:true,ids:[]}:turn.result!.evidenceDependencies));
    const json=JSON.stringify({text:summaryText,coveredTurns:count,generatedAt:new Date().toISOString(),fingerprint,...(evidenceDependencies?{evidenceDependencies}:{})});
    this.store.reserveMetadata(Buffer.byteLength(json));
    this.store.db.prepare('INSERT INTO working_memories VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id,json);
    };if(execution)execution.commit(commit);else commit();
  }
}
