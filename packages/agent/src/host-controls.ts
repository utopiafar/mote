import type {ContextRecord} from './types.js';

/** A separate host authority channel. It can create durable work and is never
 * registered as a read-only ContextToolContribution or supplied by evidence. */
export interface HostControlDefinition {
  name:string;
  description:string;
  fields:Record<string,Record<string,unknown>>;
}
export interface HostControlResult {
  data:unknown;
  /** Exact originals delivered by the child, revalidated again by the bridge. */
  evidence?:ContextRecord[];
  /** Private lineage receipts: revalidated before derived prose, never citations. */
  dependencies?:readonly ContextRecord[];
  /** Fresh originals supplied by an explicit host policy check. Never serialized. */
  authorizedOriginals?:readonly ContextRecord[];
  /** End this model fragment immediately, releasing its model admission slot. */
  yield?:boolean;
}
export interface HostControlChannel {
  readonly definitions:readonly HostControlDefinition[];
  execute(name:string,args:Readonly<Record<string,unknown>>):Promise<HostControlResult>;
}
export class AgentYieldError extends Error {
  constructor(){super('The coordinator yielded to durable delegated work');this.name='AgentYieldError';}
}
export function hostControlDefinitions(channel?:HostControlChannel):[string,string,Record<string,Record<string,unknown>>][] {
  const names=new Set<string>();
  return (channel?.definitions??[]).map(tool=>{
    if(!/^delegation_[a-z_]{1,48}$/.test(tool.name)||names.has(tool.name))throw Error('Invalid host control definition');
    names.add(tool.name);return [tool.name,tool.description,tool.fields];
  });
}
