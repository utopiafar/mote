import type {TopicMemory} from './memory-topics';
export function memoryTopicSnapshot(row:TopicMemory,id:string):string|undefined{
 if(row.id!==id||!Number.isSafeInteger(row.version)||row.version<1||!['published','proposed'].includes(row.status)||row.supersededBy)return undefined;
 return JSON.stringify([row.id,row.version,row.status,row.fingerprint??'']);
}
