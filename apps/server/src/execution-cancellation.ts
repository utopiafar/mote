/** Cancellation revokes commit eligibility even when a plugin ignores AbortSignal. */
export async function withExecutionCancellation<T>(signal:AbortSignal,run:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();
  let abort:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return run();}),cancelled]);}
  finally{signal.removeEventListener('abort',abort);}
}
