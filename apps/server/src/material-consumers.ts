import {z} from 'zod';
import type {Context} from '@deepseek-ai/cordis';
import {InstallationEpochs} from './installation-epochs.js';
const id=z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
const binding=z.object({id,version:z.string().min(1).max(64),processor:id,processorVersion:z.string().min(1).max(64),
  accepts:z.object({kind:z.string().min(1).max(128),schemaVersion:z.number().int().positive(),key:z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/)}).strict(),
  config:z.record(z.unknown()).default({})}).strict();
export type MaterialConsumer=z.input<typeof binding>;
/** Deployment modules declare bindings; source owner configuration opts into deterministic consumers. */
export class MaterialConsumerRegistry {
  private entries=new Map<string,z.output<typeof binding>>();
  readonly epochs=new InstallationEpochs();
  register(raw:MaterialConsumer){const value=binding.parse(raw);if(this.entries.has(value.id)||JSON.stringify(value.config).length>16000)throw Error('Invalid or duplicate material consumer');
    const revoke=this.epochs.install(value.id);this.entries.set(value.id,value);
    return ()=>{revoke();if(this.entries.get(value.id)===value)this.entries.delete(value.id);};
  }
  get(id:string){const value=this.entries.get(id);return value?structuredClone(value):undefined;}
  list(){return [...this.entries.values()].map(value=>structuredClone(value));}
}
declare module '@deepseek-ai/cordis' {interface Context {moteMaterialConsumers:MaterialConsumerRegistry;}}
