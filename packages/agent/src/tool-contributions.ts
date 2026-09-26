import {CONTEXT_TOOLS} from './context-tools.js';
import type {ContextRange,ContextReader,QueryInput} from './types.js';

/** Trusted host code only. Contributions are read-only, bounded metadata tools;
 * original evidence and image grants remain owned by the evidence bridge. */
export interface ContextToolContribution {
  name:string;
  version:string;
  description:string;
  fields:Record<string,Record<string,unknown>>;
  maxCharacters:number;
  parse(args:Record<string,unknown>):Record<string,unknown>;
  authorize(scope:Readonly<ContextRange>,args:Readonly<Record<string,unknown>>):boolean|Promise<boolean>;
  read(args:Readonly<Record<string,unknown>>,context:{scope:Readonly<ContextRange>;signal?:AbortSignal}):unknown|Promise<unknown>;
}
export class ContextToolRegistry {
  private entries=new Map<string,ContextToolContribution>();
  register(tool:ContextToolContribution){
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)||!tool.version||this.entries.has(tool.name)||CONTEXT_TOOLS.some(([name])=>name===tool.name)||['skill','_ready'].includes(tool.name))throw Error('Invalid or duplicate context tool');
    if(!Number.isSafeInteger(tool.maxCharacters)||tool.maxCharacters<1||tool.maxCharacters>16000)throw Error('Invalid context tool budget');
    const entry=Object.freeze({...tool,fields:structuredClone(tool.fields)});this.entries.set(tool.name,entry);
    return ()=>{if(this.entries.get(tool.name)===entry)this.entries.delete(tool.name);};
  }
  snapshot():readonly ContextToolContribution[]{
    return Object.freeze([...this.entries.values()].map(entry=>Object.freeze({...entry,fields:structuredClone(entry.fields),
      authorize:async(scope:Readonly<ContextRange>,args:Readonly<Record<string,unknown>>)=>this.entries.get(entry.name)===entry&&await entry.authorize(scope,args),
    })));
  }
}
/** A run pins schemas/versions once; authorization is still checked on every read. */
export function pinContextTools(input:QueryInput,reader:ContextReader):QueryInput{
  return input.toolContributions?input:{...input,toolContributions:reader.contextTools?.()??[]};
}
export function contextToolDefinitions(input:QueryInput){
  return [...CONTEXT_TOOLS,...(input.toolContributions??[]).map(tool=>[tool.name,tool.description,tool.fields] as [string,string,Record<string,Record<string,unknown>>])];
}
