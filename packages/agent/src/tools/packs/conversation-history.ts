import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor,type ToolDescriptor,type ToolFields} from '../descriptor.js';
import {invalidPackArgument,scopedRange} from './materials.js';

/** Dialogue travels over the existing host catalog read and has no original
 * evidence or write authority. The server binds it to the current dialogue. */
export function createConversationHistoryPack():readonly ToolDescriptor[]{
  return Object.freeze(['conversation_history','conversation_search'].map(name=>{
    const spec=CONTEXT_TOOLS.find(entry=>entry[0]===name)!;
    return defineToolDescriptor({apiVersion:'1',name,version:'1',description:spec[1],fields:spec[2] as ToolFields,kind:'derived',exposure:'native',requires:['catalog'],
      parse(args){
        if(args.id!==undefined&&(typeof args.id!=='string'||!/^[0-9a-f-]{36}$/i.test(args.id))||args.id!==undefined&&args.cursor!==undefined)invalidPackArgument('Invalid conversation turn');
        if(args.offset!==undefined&&(!args.id||!Number.isSafeInteger(args.offset)||Number(args.offset)<0||Number(args.offset)>10000000))invalidPackArgument('Invalid conversation text offset');
        if(name==='conversation_search'&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>200))invalidPackArgument('Enter a literal history search up to 200 characters');
        if(args.cursor!==undefined&&(typeof args.cursor!=='string'||!args.cursor||args.cursor.length>4096))invalidPackArgument('Invalid conversation cursor');
        if(args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||Number(args.limit)<1||Number(args.limit)>20))invalidPackArgument('Invalid conversation page size');
        return args;
      },
      async execute(args,port){
        const path=args.id?`/_conversation/turn/${args.id}/${Number(args.offset??0)}`:name==='conversation_search'?'/_conversation/search':'/_conversation/history';
        const raw=await port.read('catalog',{...scopedRange(port,args),path,...(args.query?{query:args.query as string}:{})});
        if(!raw||typeof raw!=='object'||!Array.isArray((raw as {items?:unknown}).items))invalidPackArgument('Conversation history is unavailable');
        const {disclosureDependencies,sourceContextDependencies,...data}=raw as Record<string,unknown>;
        return {source:'untrusted_personal_context',data,disclosureDependencies,sourceContextDependencies};
      },
    });
  }));
}
