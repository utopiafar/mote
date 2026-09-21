import {z} from 'zod';
import {Store} from './store.js';
import type {Config} from './config.js';
export const executionSettingsSchema=z.object({interactiveConcurrency:z.number().int().min(1).max(8).default(2),agentConcurrency:z.number().int().min(1).max(64),llmConcurrency:z.number().int().min(1).max(64),memoryConcurrency:z.number().int().min(1).max(16)}).strict();
export const diagnosticsSettingsSchema=z.object({enabled:z.boolean(),debug:z.boolean(),traceEnabled:z.boolean(),level:z.enum(['debug','info','warn','error','silent'])}).strict();
export class ExecutionSettings {
  constructor(private store:Store,private config:Config){}
  execution(){const row=this.store.db.prepare("SELECT value FROM settings WHERE key='execution-settings'").get();return executionSettingsSchema.parse(row?JSON.parse(String(row.value)):{agentConcurrency:this.config.agentConcurrency??8,llmConcurrency:this.config.llmConcurrency??4,memoryConcurrency:this.config.memoryConcurrency??3});}
  diagnostics(){const row=this.store.db.prepare("SELECT value FROM settings WHERE key='diagnostics-settings'").get();return diagnosticsSettingsSchema.parse(row?JSON.parse(String(row.value)):{enabled:this.config.diagnosticsEnabled??true,debug:this.config.diagnosticsDebug??false,traceEnabled:this.config.agentTraceEnabled??false,level:this.config.logLevel??'info'});}
  saveExecution(raw:unknown){const value=executionSettingsSchema.parse(raw);this.save('execution-settings',value);return value;}
  saveDiagnostics(raw:unknown){const value=diagnosticsSettingsSchema.parse(raw);this.save('diagnostics-settings',value);return value;}
  private save(key:string,value:unknown){this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
}
