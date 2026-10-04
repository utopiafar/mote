import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Store,StoreError} from './store.js';
import type {MemoryStrategies} from './memory-strategies.js';
import {memoryIntegrationBindingSchema,memoryStrategyRefSchema} from './memory-strategy-contract.js';
import {defaultMemoryIntegrationRecipe} from './memory-integration-policy.js';

export const memoryIntegrationSelectionSchema=z.object({activation:z.string().uuid(),afterSequence:z.number().int().min(0),binding:memoryIntegrationBindingSchema.nullable()}).strict();
export type MemoryIntegrationSelection=z.infer<typeof memoryIntegrationSelectionSchema>;
const settingKey='memory-integration-selection';

/** A selection applies to new memory events, never an implicit history replay. */
export class MemoryIntegrationSettings {
  onApplied?:(through:number)=>void;
  constructor(private store:Store,private strategies:MemoryStrategies){
    if(!store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(settingKey))this.save(this.newSelection(strategies.resolveIntegration(defaultMemoryIntegrationRecipe).binding));
  }
  private latest(){return Number(this.store.db.prepare("SELECT coalesce(max(seq),0) n FROM memory_events WHERE stream='memory'").get()!.n);}
  private newSelection(binding:MemoryIntegrationSelection['binding']):MemoryIntegrationSelection{return {activation:randomUUID(),afterSequence:this.latest(),binding};}
  private save(value:MemoryIntegrationSelection){const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json)+128);this.store.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(settingKey,json);}
  selection(){return memoryIntegrationSelectionSchema.parse(JSON.parse(String(this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(settingKey)!.value)));}
  view(){const selection=this.selection();let available=false;if(selection.binding)try{this.strategies.resolvePinnedIntegration(selection.binding);available=true;}catch{}return {...selection,available};}
  current(selection:MemoryIntegrationSelection){return JSON.stringify(this.selection())===JSON.stringify(selection);}
  configure(raw:unknown){
    const input=z.object({recipe:memoryStrategyRefSchema.nullable()}).strict().parse(raw);
    let binding:MemoryIntegrationSelection['binding'];try{binding=input.recipe?this.strategies.resolveIntegration(input.recipe).binding:null;}catch{throw new StoreError('Memory integration recipe is unavailable',409);}
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');let next:MemoryIntegrationSelection;
    try{
      const previous=this.selection();if(JSON.stringify(previous.binding)===JSON.stringify(binding)){db.exec('COMMIT');return this.view();}
      next=this.newSelection(binding);this.save(next);db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    this.onApplied?.(next.afterSequence);return this.view();
  }
  eligible(ids:readonly string[],afterSequence:number,through:number){const allowed=new Set(this.store.db.prepare("SELECT DISTINCT entity FROM memory_events WHERE stream='memory' AND seq>? AND seq<=? AND entity IN (SELECT value FROM json_each(?))").all(afterSequence,through,JSON.stringify(ids)).map(r=>String(r.entity)));return ids.filter(id=>allowed.has(id));}
}
