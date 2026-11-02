import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

// Trusted plugin code runs with host permissions. This process boundary is a
// lifecycle boundary; it is deliberately not advertised as a security sandbox.
const pending=new Map();
let runtime;
let closing=false;
const work=new Set();
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
async function dispatch(line){
 if(closing)return;
 let message;try{message=JSON.parse(line);}catch{return;}
 if(!message||typeof message.id!=='number')return;
 if(message.method==='cancel'){pending.get(message.id)?.abort();return;}
 try{
  if(message.method==='initialize'){
   if(runtime)throw Error('already_initialized');
   const module=await import(pathToFileURL(message.params.entry).href);
   if(typeof module.createMemoryProvider!=='function')throw Error('provider_factory_missing');
   runtime=await module.createMemoryProvider(message.params.configuration);
   send({id:message.id,result:{initialized:true}});return;
  }
  if(!runtime||!['health','put','read','remove','search','export','close'].includes(message.method)||typeof runtime[message.method]!=='function')throw Error('method_unavailable');
  const controller=new AbortController();pending.set(message.id,controller);
  const result=await runtime[message.method](message.params,controller.signal);
  controller.signal.throwIfAborted();send({id:message.id,result});
 }catch(error){send({id:message.id,error:{code:typeof error?.code==='string'?error.code:'plugin_operation_failed'}});}
 finally{pending.delete(message.id);}
}
input.on('line',line=>{const task=dispatch(line);work.add(task);void task.finally(()=>work.delete(task));});
input.on('close',()=>{
 closing=true;for(const controller of pending.values())controller.abort();
 // Drain accepted calls (including initialization) before their provider closes.
 // The parent still enforces its physical shutdown deadline for uncooperative code.
 void Promise.allSettled([...work]).then(()=>runtime?.close?.()).then(()=>process.exit(0),()=>process.exit(1));
});
