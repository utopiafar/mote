import {Mem0MemoryRuntime,mem0RuntimeConfigSchema} from './mem0-memory-runtime.js';
import {MemoryProviderError} from './memory-provider-contract.js';
let provider:Mem0MemoryRuntime|undefined;
const methods=new Set(['put','read','remove','search','export','health','recover']);
process.on('message',async(value:unknown)=>{
  const message=value as {id?:number;method?:string;input?:unknown};
  if(!Number.isSafeInteger(message?.id)||!message.method)return;
  try{
    if(message.method==='initialize'){if(provider)throw new MemoryProviderError('conflict','Provider is already initialized');provider=new Mem0MemoryRuntime(mem0RuntimeConfigSchema.parse(message.input));process.send?.({id:message.id,ok:true,result:{initialized:true}});return;}
    if(message.method==='close'){await provider?.close();process.send?.({id:message.id,ok:true,result:null});process.disconnect();return;}
    if(!provider||!methods.has(message.method))throw new MemoryProviderError('unavailable','Provider method is unavailable');
    const result=await (provider[message.method as 'put'] as (input:any)=>Promise<unknown>).call(provider,message.input);
    process.send?.({id:message.id,ok:true,result});
  }catch(error){process.send?.({id:message.id,ok:false,error:{code:error instanceof MemoryProviderError?error.code:'unavailable',message:error instanceof MemoryProviderError?error.message:'Memory provider request failed'}});}
});
process.on('disconnect',()=>{void provider?.close().finally(()=>process.exit(0));});
process.on('SIGTERM',()=>{void provider?.close().finally(()=>process.exit(0));});
