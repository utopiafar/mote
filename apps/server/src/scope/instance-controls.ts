import {z} from 'zod';
import {ConcurrencyGate} from '../concurrency.js';
import {executionSettingsSchema,diagnosticsSettingsSchema,type ExecutionSettingsValue} from '../execution-settings.js';
import type {Configurations} from './configuration.js';
import type {TaskExecution} from './task-execution.js';
import {registerAuthenticatedRoute,type ScopedRuntime} from './http.js';

const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const diagnostic=diagnosticsSettingsSchema.omit({traceEnabled:true}).extend({traceEnabled:z.literal(false).default(false)});
/** Reuse the original harness gates. Durable scheduling, fairness, cancellation
 * and publication still belong to M05; these gates bound physical model loops. */
export function registerInstanceControls(runtime:ScopedRuntime,configuration:Configurations,execution:TaskExecution){
 const gates={agents:new ConcurrencyGate(8),models:new ConcurrencyGate(4),interactive:new ConcurrencyGate(2),memory:new ConcurrencyGate(3)};
 const apply=(next:ExecutionSettingsValue)=>{gates.agents.configure(next.agentConcurrency);gates.models.configure(next.llmConcurrency);gates.interactive.configure(next.interactiveConcurrency);gates.memory.configure(next.memoryConcurrency);};
 apply(executionSettingsSchema.strip().parse(configuration.instance.current('execution')));
 configuration.instance.setHandler<ExecutionSettingsValue>('execution',(next,previous)=>({apply:()=>{},publish:()=>apply(next),rollback:()=>apply(previous)}));
 execution.bindModelAdmission((run,work)=>{
  const guarded=()=>{run.grant.assert();return work();},key=run.context.userId;
  if(['ask.chat','ask.compact'].includes(run.task.kind))return gates.interactive.run(guarded,run.signal,key);
  const background=()=>gates.agents.run(()=>gates.models.run(guarded,run.signal,key),run.signal,key);
  return run.task.kind.startsWith('memory.')?gates.memory.run(background,run.signal,key):background();
 });
 const view=()=>({...executionSettingsSchema.strip().parse(configuration.instance.current('execution')),revision:configuration.instance.revision,scope:'instance',queues:Object.fromEntries(Object.entries(gates).map(([name,gate])=>[name,gate.snapshot()]))});
 registerAuthenticatedRoute(runtime,{method:'GET',url:'/api/admin/execution-settings',administrator:true,handle:(_context,request)=>{z.object({}).strict().parse(request.query);return view();}});
 registerAuthenticatedRoute(runtime,{method:'PUT',url:'/api/admin/execution-settings',administrator:true,handle:async(context,request)=>{
  const {revision:expected,...value}=executionSettingsSchema.extend({revision}).strict().parse(request.body);
  await configuration.instance.update('execution',value,expected,()=>runtime.authority.assertAdministrator(context));return view();
 }});
 // The M16 writer supplies the diagnostics prepare/publish/rollback handler.
 // Its finite instance metadata never enables a private Agent trace.
 registerAuthenticatedRoute(runtime,{method:'GET',url:'/api/admin/diagnostics-settings',administrator:true,handle:(_context,request)=>{z.object({}).strict().parse(request.query);const {enabled,debug,level}=configuration.instance.current<z.infer<typeof diagnosticsSettingsSchema>>('diagnostics');return {enabled,debug,level,traceEnabled:false,scope:'instance-safe-diagnostics',revision:configuration.instance.revision};}});
 registerAuthenticatedRoute(runtime,{method:'PUT',url:'/api/admin/diagnostics-settings',administrator:true,handle:async(context,request)=>{
  const {revision:expected,...value}=diagnostic.extend({revision}).strict().parse(request.body);
  await configuration.instance.update('diagnostics',value,expected,()=>runtime.authority.assertAdministrator(context));
  const {enabled,debug,level}=configuration.instance.current<z.infer<typeof diagnosticsSettingsSchema>>('diagnostics');return {enabled,debug,level,traceEnabled:false,scope:'instance-safe-diagnostics',revision:configuration.instance.revision};
 }});
 runtime.app.addHook('onClose',async()=>{for(const gate of Object.values(gates))gate.close();});
}
