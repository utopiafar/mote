import {buildApp} from '../../src/app.js';
import {EXECUTION_POLICIES} from '../../src/execution-policy.js';
import {z} from 'zod';

// Only the external effect is synthetic. The app, executor, HTTP, authority,
// journal and SQLite lifecycle are the normal production composition.
const node=await buildApp({dataDir:process.env.MOTE_GENERATED_RECOVERY_DIRECTORY!});
if(process.env.MOTE_GENERATED_RECOVERY_INITIALIZE==='1')await node.accounts!.initialize('generated-admin','Generated-recovery-seams-password');
node.execution!.register({
 kind:'generated.recovery-http',pool:'generated-recovery-http',concurrency:()=>4,policy:EXECUTION_POLICIES.deterministic,
 parseInput:input=>z.object({external:z.boolean()}).strict().parse(input),portableInput:input=>input,
 execute:async run=>{
  const prior=run.checkpoint.read('completed-local-stage');
  if(!prior)run.checkpoint.write('completed-local-stage',{count:1,owner:run.context.userId});
  if(run.task.input.external){
   const issuance=run.external.begin('generated-recovery-effect');
   try{
    const reply=await fetch(process.env.MOTE_GENERATED_RECOVERY_EXTERNAL!,{method:'POST',body:JSON.stringify({taskId:run.task.id,issuance,owner:run.context.userId})});
    if(!reply.ok)throw Error('Generated external transport failed');
    await reply.text();run.external.complete();
    process.send?.({settled:run.task.id,accepted:true});
   }catch(error){process.send?.({settled:run.task.id,accepted:false});throw error;}
  }
  return {owner:run.context.userId,checkpoint:run.checkpoint.read('completed-local-stage'),reused:Boolean(prior)};
 },
});
await node.app.listen({host:'127.0.0.1',port:0});
process.send?.({ready:node.app.server.address()});
process.on('message',async message=>{
 if((message as {close?:boolean}).close){await node.app.close();process.disconnect?.();}
});
