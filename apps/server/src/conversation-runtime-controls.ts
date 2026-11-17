import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {HostRunControl,HostSteeringTarget} from '@mote/agent';

export interface ConversationRuntimeControl {
  readonly registrationId:string;
  readonly supported:boolean;
  current():HostSteeringTarget|undefined;
  steer(target:HostSteeringTarget,text:string,acknowledge:(receipt:HostSteeringTarget)=>void):Promise<HostSteeringTarget>;
}

/** Local query-owner state only. Each closure retains its original immutable
 * model authorization context; a later caller cannot lend it a newer grant. */
export class ConversationRuntimeControls {
  private readonly entries=new Map<string,ConversationRuntimeControl>();
  register(operationId:string,control:HostRunControl,assertCurrent:()=>void){
    const bound=AsyncLocalStorage.snapshot(),registrationId=randomUUID();
    const entry:ConversationRuntimeControl={registrationId,supported:control.supported,
      current:()=>bound(()=>{assertCurrent();return control.current();}),
      steer:(target,text,acknowledge)=>bound(async()=>{assertCurrent();return control.steer(target,text,receipt=>{assertCurrent();acknowledge(receipt);assertCurrent();});}),
    };
    this.entries.set(operationId,entry);return()=>{if(this.entries.get(operationId)===entry)this.entries.delete(operationId);};
  }
  get(operationId:string){return this.entries.get(operationId);}
}
