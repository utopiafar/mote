import {AgentTimeoutError} from '@mote/agent';

/** Own only this host deadline; an earlier caller cancellation keeps its reason. */
export function agentDeadline(parent:AbortSignal|undefined,timeoutMs:number|null):{signal:AbortSignal|undefined;dispose:()=>void}{
  if(timeoutMs===null)return {signal:parent,dispose:()=>{}};
  const control=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const dispose=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}parent?.removeEventListener('abort',cancel);};
  const cancel=()=>{dispose();control.abort(parent!.reason);};
  if(parent?.aborted)cancel();
  else {
    parent?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{dispose();control.abort(new AgentTimeoutError());},timeoutMs);
    timer.unref();
  }
  return {signal:control.signal,dispose};
}
