import type {ContextReader,QueryInput} from '@mote/agent';
import {memorySchema} from '../apps/server/src/memory-schema.js';
import type {MemoryWorkMember} from '../apps/server/src/memory-work-contract.js';

type Candidate={evidenceIds:string[];evidence:{id:string;quote:string;offset?:number}[]};

/** Construct the generated model's coverage for the exact targets in its input. */
export function generatedMemoryAnswer<T extends Candidate>(input:QueryInput,memories:readonly T[]=[]){
  const work=input.taskContext?.memoryWork as {members:MemoryWorkMember[]}|undefined;
  const coverage=work?.members.map(member=>{
    const candidateIndexes=memories.flatMap((candidate,index)=>candidate.evidence.some(span=>
      span.id===member.id&&(span.offset===undefined||span.offset>=member.offset&&span.offset+span.quote.length<=member.offset+member.length)
    )?[index]:[]);
    return {key:member.key,state:candidateIndexes.length?'checked':'no_candidates',candidateIndexes};
  });
  return JSON.stringify({memories,coverage});
}

export async function readGeneratedIntegration(reader:ContextReader,input:QueryInput){
  const ids=JSON.parse(input.question.slice(input.question.lastIndexOf('\n')+1)) as string[];
  const cards=await Promise.all(ids.map(async id=>{
    const [card]=(await reader.memories!({id})).items;
    if(!card)throw Error('Generated integration could not read its input card');
    return memorySchema.pick({domain:true,evidenceIds:true}).passthrough().parse(card);
  }));
  const evidenceIds=[...new Set(cards.flatMap(card=>card.evidenceIds))];
  const evidence=await reader.evidence({ids:evidenceIds});
  return {ids,cards,evidenceIds,evidence};
}
