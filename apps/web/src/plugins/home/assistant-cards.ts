import type {EvidenceDependencies,OwnerQuestionEvidence,QueryScope,SourceContextDeclaration} from '@mote/shared';

/** The existing card HTTP projection. This client adds no publication fields or
 * semantic interpretation; its boundary test consumes the real producer. */
export type AssistantCardVersion={
 version:string;state:'open'|'resolved'|'stale';title:string;body:string;evidence:OwnerQuestionEvidence[];
 evidenceDependencies:EvidenceDependencies;sourceContextDependencies?:SourceContextDeclaration[];
 evidenceStale?:boolean;reminderReason?:string;createdAt:string;
};
export type AssistantCard=AssistantCardVersion & {
 id:string;kind:'activity'|'suggestion'|'briefing'|'artifact'|'question';matterId:string|null;revision:number;
 readAt:string|null;acceptedTaskId:string|null;updatedAt:string;
 feedback:{version:string;action:'later'|'ignore'|'correct'|'never_remind';note?:string;until?:string;evidenceStale?:boolean;createdAt:string}[];
};
export type AssistantCardPage={items:AssistantCard[];nextCursor:string|null};
export type AssistantCardHistoryPage={items:AssistantCardVersion[];nextCursor:string|null};
export const homeAssistantScope:QueryScope={kind:'all'};
export const assistantScopeQuery=(scope:QueryScope)=>new URLSearchParams({scope:JSON.stringify(scope)});
export const assistantCardPath=(id:string,scope:QueryScope)=>'/api/assistant-cards/'+encodeURIComponent(id)+'?'+assistantScopeQuery(scope);
