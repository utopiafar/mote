import {z} from 'zod';
import {ConfigService} from './config-service.js';
import type {ConfigurationDomain} from './plugins/central-contracts.js';
export const executionSettingsSchema=z.object({interactiveConcurrency:z.number().int().min(1).max(8).default(2),agentConcurrency:z.number().int().min(1).max(64).default(8),llmConcurrency:z.number().int().min(1).max(64).default(4),memoryConcurrency:z.number().int().min(1).max(16).default(3)}).strict();
export const diagnosticsSettingsSchema=z.object({enabled:z.boolean().default(true),debug:z.boolean().default(false),traceEnabled:z.boolean().default(false),level:z.enum(['debug','info','warn','error','silent']).default('info')}).strict();
export type ExecutionSettingsValue=z.infer<typeof executionSettingsSchema>;
export type DiagnosticsSettingsValue=z.infer<typeof diagnosticsSettingsSchema>;
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const executionUpdateSchema=executionSettingsSchema.extend({revision}).strict();
const diagnosticsUpdateSchema=diagnosticsSettingsSchema.extend({revision}).strict();
/** These domains share the authoritative YAML file and revision. SQLite settings are business state only. */
export class ExecutionSettings {
  private readonly domains:{execution:ConfigurationDomain<ExecutionSettingsValue>;diagnostics:ConfigurationDomain<DiagnosticsSettingsValue>};
  constructor(input:ConfigService|{execution:ConfigurationDomain<ExecutionSettingsValue>;diagnostics:ConfigurationDomain<DiagnosticsSettingsValue>}){
    const bind=<T>(service:ConfigService,id:string):ConfigurationDomain<T>=>({
      snapshot:()=>({revision:service.revision,value:service.current<T>(id)}),
      update:async(value,revision)=>{await service.update(id,{...service.saved<Record<string,unknown>>(id),...value},revision);return {revision:service.revision,value:service.current<T>(id)};},
      subscribe:listener=>service.onChange(()=>listener({revision:service.revision,value:service.current<T>(id)})),
    });
    this.domains=input instanceof ConfigService?{execution:bind(input,'execution'),diagnostics:bind(input,'diagnostics')}:input;
  }
  execution(){const {interactiveConcurrency,agentConcurrency,llmConcurrency,memoryConcurrency}=this.domains.execution.snapshot().value;return {interactiveConcurrency,agentConcurrency,llmConcurrency,memoryConcurrency};}
  diagnostics(){const {enabled,debug,traceEnabled,level}=this.domains.diagnostics.snapshot().value;return {enabled,debug,traceEnabled,level};}
  executionView(){const {revision}=this.domains.execution.snapshot();return {...this.execution(),revision};}
  diagnosticsView(){const {revision}=this.domains.diagnostics.snapshot();return {...this.diagnostics(),revision};}
  async saveExecution(raw:unknown){const {revision,...value}=executionUpdateSchema.parse(raw);await this.domains.execution.update(value,revision);return this.executionView();}
  async saveDiagnostics(raw:unknown){const {revision,...value}=diagnosticsUpdateSchema.parse(raw);await this.domains.diagnostics.update(value,revision);return this.diagnosticsView();}
}
