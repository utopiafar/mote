import {createHash} from 'node:crypto';
import {estimateSerializedTokens} from './context-budget.js';

type Slot = {get():unknown; set(value:unknown):void};
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const omission='[Previously delivered tool result omitted from this request to fit the context window. Its contents are not included here; use the tool again if needed.]';

/** Find actual provider result slots, without treating arbitrary evidence fields
 * as messages. Images are replaced only after their earlier request was sent. */
function resultSlots(value:unknown, slots:Slot[]=[]):Slot[]{
  if(Array.isArray(value)){for(const item of value)resultSlots(item,slots);return slots;}
  if(!value||typeof value!=='object')return slots;
  const row=value as Record<string,unknown>;
  const key=row.role==='tool'?'content':row.type==='function_call_output'?'output':row.type==='tool_result'?'content':undefined;
  if(key&&row[key]!==undefined){slots.push({get:()=>row[key],set:item=>{row[key]=item;}});return slots;}
  if(row.functionResponse&&typeof row.functionResponse==='object'){
    const response=row.functionResponse as Record<string,unknown>;
    if(response.response!==undefined)slots.push({get:()=>response.response,set:item=>{response.response=item;}});
  }
  for(const item of Object.values(row))resultSlots(item,slots);
  return slots;
}

/** Locate only Mote's JSON request envelope inside a provider message. */
function historySlots(value:unknown, slots:Slot[]=[], withinUser=false):Slot[]{
  if(Array.isArray(value)){for(const item of value)historySlots(item,slots,withinUser);return slots;}
  if(!value||typeof value!=='object')return slots;
  const row=value as Record<string,unknown>;
  if(row.role!==undefined&&row.role!=='user'||row.type==='tool_result'||row.functionResponse)return slots;
  const user=withinUser||row.role==='user';
  for(const [key,item] of Object.entries(row)){
    if(user&&typeof item==='string'&&item.startsWith('{')){
      try{const parsed=JSON.parse(item);if(parsed&&typeof parsed==='object'&&typeof parsed.request==='string'&&typeof parsed.taskId==='string'&&Array.isArray(parsed.conversation?.turns)){
        slots.push({get:()=>JSON.parse(row[key] as string),set:next=>{row[key]=JSON.stringify(next);}});continue;
      }}catch{/* Not an envelope. */}
    }
    if(item&&typeof item==='object')historySlots(item,slots,user);
  }
  return slots;
}

/** One isolated transport tracks only hashes of tool results accepted by a
 * preceding provider request. Unsent reads are never shortened here: the Host
 * must decide their disclosure and citation receipts before sending them. */
export function createRequestBudget(window:number,output:number){
  const delivered=new Set<string>();
  const measure=(body:unknown)=>estimateSerializedTokens(body).tokens+output;
  const remember=(body:unknown)=>{for(const slot of resultSlots(body))delivered.add(fingerprint(slot.get()));};
  const fit=(body:Record<string,unknown>,target=window):boolean=>{
    if(measure(body)<=target)return true;
    for(const slot of historySlots(body)){
      const envelope=slot.get() as {conversation:{turns:unknown[];omittedTurns?:number;budgetCoverage?:string}};
      const turns=envelope.conversation.turns;
      while(turns.length&&measure(body)>target){
        turns.shift();envelope.conversation.omittedTurns=(envelope.conversation.omittedTurns??0)+1;
        envelope.conversation.budgetCoverage='Earlier dialogue was omitted from this request to fit the model window; original history remains available through the history tools.';
        slot.set(envelope);
      }
    }
    for(const slot of resultSlots(body)){
      if(measure(body)<=target)break;
      const old=slot.get();if(old===omission||!delivered.has(fingerprint(old)))continue;
      // Google expects an object for function responses, other protocols accept text.
      slot.set(old&&typeof old==='object'&&!Array.isArray(old)?{budgetCoverage:omission}:omission);
    }
    return measure(body)<=target;
  };
  return {measure,remember,fit};
}
