import {z} from 'zod';
import {ConfigService,type ConfigDomainReference} from './config-service.js';
import {defaultLogMaxBytes,MAX_LOG_FILE_BYTES,DEFAULT_LOG_RETENTION,type LogRetention,MiB} from './log-retention-config.mjs';
import type {ConfigurationDomain} from './plugins/central-contracts.js';
export const executionSettingsSchema=z.object({interactiveConcurrency:z.number().int().min(1).max(8).default(2),agentConcurrency:z.number().int().min(1).max(64).default(8),llmConcurrency:z.number().int().min(1).max(64).default(4),memoryConcurrency:z.number().int().min(1).max(16).default(3)}).strict();
export const diagnosticsSettingsSchema=z.object({enabled:z.boolean().default(true),debug:z.boolean().default(false),traceEnabled:z.boolean().default(false),traceExpiresAt:z.number().int().nonnegative().refine(value=>value<=Date.now()+86400000).default(0),level:z.enum(['debug','info','warn','error','silent']).default('info')}).strict();
export const executionConfigSchema = executionSettingsSchema.extend({ insightIntervalHours: z.number().min(0).max(168).default(0) }).strict();
export const diagnosticsConfigSchema = diagnosticsSettingsSchema.extend({
  directory: z.string().min(0).max(4096).refine(value => !/[\r\n\0]/.test(value)).default(''), maxBytes: z.number().min(Math.floor(0.1 * MiB)).max(MAX_LOG_FILE_BYTES).default(defaultLogMaxBytes()),
  maxTotalBytes:z.number().int().min(1024).max(16*1024*MiB).default(2048*MiB),
  retention:z.object(Object.fromEntries(Object.entries(DEFAULT_LOG_RETENTION).map(([key,value])=>[key,z.object({days:z.number().min(1/24).max(3650).default(value.days),maxBytes:z.number().int().min(1024).max(8*1024*MiB).default(value.maxBytes)}).strict().default(value)])) as unknown as Record<keyof LogRetention,z.ZodType<{days:number;maxBytes:number}>>).strict().default(DEFAULT_LOG_RETENTION),
  maxEntries: z.number().int().min(100).max(5000).default(2000),
}).strict();
export const executionConfigDomain = Object.freeze({id:'execution',schema:executionConfigSchema}) satisfies ConfigDomainReference<typeof executionConfigSchema>;
export const diagnosticsConfigDomain = Object.freeze({id:'diagnostics',schema:diagnosticsConfigSchema}) satisfies ConfigDomainReference<typeof diagnosticsConfigSchema>;
export type ExecutionSettingsValue=z.infer<typeof executionSettingsSchema>;
export type DiagnosticsSettingsValue=z.infer<typeof diagnosticsSettingsSchema>;
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const executionUpdateSchema=executionSettingsSchema.extend({revision}).strict();
const diagnosticsUpdateSchema=diagnosticsSettingsSchema.extend({revision}).strict();
/** These domains share the authoritative YAML file and revision. SQLite settings are business state only. */
export class ExecutionSettings {
  private readonly domains:{execution:ConfigurationDomain<ExecutionSettingsValue>;diagnostics:ConfigurationDomain<DiagnosticsSettingsValue>};
  constructor(input:ConfigService|{execution:ConfigurationDomain<ExecutionSettingsValue>;diagnostics:ConfigurationDomain<DiagnosticsSettingsValue>}){
    const bind=<S extends z.ZodTypeAny>(service:ConfigService,reference:ConfigDomainReference<S>):ConfigurationDomain<z.output<S>>=>({
      snapshot:()=>({revision:service.revision,value:service.current(reference)}),
      update:async(value,revision)=>{await service.update(reference.id,{...service.saved<Record<string,unknown>>(reference.id),...value},revision);return {revision:service.revision,value:service.current(reference)};},
      subscribe:listener=>service.onChange(()=>listener({revision:service.revision,value:service.current(reference)})),
    });
    this.domains=input instanceof ConfigService?{execution:bind(input,executionConfigDomain),diagnostics:bind(input,diagnosticsConfigDomain)}:input;
  }
  execution(){const {interactiveConcurrency,agentConcurrency,llmConcurrency,memoryConcurrency}=this.domains.execution.snapshot().value;return {interactiveConcurrency,agentConcurrency,llmConcurrency,memoryConcurrency};}
  diagnostics(){const {enabled,debug,traceEnabled,traceExpiresAt,level}=this.domains.diagnostics.snapshot().value;return {enabled,debug,traceEnabled:traceEnabled&&traceExpiresAt>Date.now(),traceExpiresAt,level};}
  executionView(){const {revision}=this.domains.execution.snapshot();return {...this.execution(),revision};}
  diagnosticsView(){const {revision}=this.domains.diagnostics.snapshot();return {...this.diagnostics(),revision};}
  async saveExecution(raw:unknown){const {revision,...value}=executionUpdateSchema.parse(raw);await this.domains.execution.update(value,revision);return this.executionView();}
  async saveDiagnostics(raw:unknown){const {revision,...value}=diagnosticsUpdateSchema.parse(raw);const before=this.diagnostics();value.traceExpiresAt=value.traceEnabled?(before.traceEnabled?before.traceExpiresAt:Date.now()+86400000):0;await this.domains.diagnostics.update(value,revision);return this.diagnosticsView();}
}
