import {z} from 'zod';
import {Store,StoreError,sha256} from './store.js';
import type {MemoryStrategies} from './memory-strategies.js';
import {memoryRecipeBindingSchema,memoryStrategyRefSchema,type MemoryRecipeBinding} from './memory-strategy-contract.js';
import {DAILY_EVENT_RECIPE} from './daily-event-memory-policy.js';
import {isCaptureMemorySource} from './capture-memory-source.js';

export const memoryRecipeScope=(binding:MemoryRecipeBinding)=>'recipe/'+sha256(JSON.stringify(binding));
const bindingsSchema=z.array(memoryRecipeBindingSchema).min(1).max(9);
const selectionSchema=z.array(memoryStrategyRefSchema).min(1).max(9).refine(values=>new Set(values.map(v=>v.id+'@'+v.version)).size===values.length,'Duplicate Memory recipe');
export const memoryRecipeSettingsQuery=z.object({sourceId:z.string().min(1).max(256).optional(),scope:z.literal('capture').optional()}).strict().refine(value=>!(value.sourceId&&value.scope),'Choose source or capture defaults');

/** Owner strategy selection is separate from installation. Persist exact selected
 * definitions; neither a newer installed version nor a missing plugin changes
 * the selection or authorizes historical work. */
export class MemoryRecipeSettings {
  onChange?:()=>void;
  onApplied?:()=>void;
  constructor(private store:Store,private strategies:MemoryStrategies){
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_recipe_settings(id TEXT PRIMARY KEY,source_id TEXT REFERENCES source_connections(id) ON DELETE CASCADE,json TEXT NOT NULL)');
    if(!store.db.prepare("SELECT 1 FROM memory_recipe_settings WHERE id='default'").get()){
      const initial=[strategies.resolve({id:'mote.personal-memory',version:'2'}).binding];
      store.reserveMetadata(Buffer.byteLength(JSON.stringify(initial))+128);
      store.db.prepare("INSERT INTO memory_recipe_settings VALUES('default',NULL,?)").run(JSON.stringify(initial));
    }
    // Establish the new capture-only default once; it never changes saved source
    // overrides, old receipts or later owner choices. Other sources keep defaults.
    if(!store.db.prepare("SELECT 1 FROM memory_recipe_settings WHERE id='capture-default'").get()){
      const prior=this.selection(),daily=strategies.resolve(DAILY_EVENT_RECIPE).binding;
      const initial=prior.some(binding=>memoryRecipeScope(binding)===memoryRecipeScope(daily))?prior:[...prior,daily];
      store.reserveMetadata(Buffer.byteLength(JSON.stringify(initial))+128);
      store.db.prepare("INSERT INTO memory_recipe_settings VALUES('capture-default',NULL,?)").run(JSON.stringify(initial));
    }
  }
  private key(sourceId?:string,scope?:'capture'){return sourceId===undefined?scope==='capture'?'capture-default':'default':'source:'+sourceId;}
  private source(sourceId?:string){if(sourceId!==undefined&&!this.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId))throw new StoreError('Source not found',404);}
  selection(sourceId?:string,scope?:'capture'):MemoryRecipeBinding[]{
    const own=sourceId===undefined?undefined:this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(this.key(sourceId));
    if(own)return bindingsSchema.parse(JSON.parse(String(own.json)));
    const source=sourceId===undefined?undefined:this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);
    const capture=scope==='capture'||Boolean(source&&isCaptureMemorySource(sourceId!,JSON.parse(String(source.json)).deviceId));
    return bindingsSchema.parse(JSON.parse(String(this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(capture?'capture-default':'default')!.json)));
  }
  enabled(sourceId:string,binding:MemoryRecipeBinding){return this.selection(sourceId).some(selected=>memoryRecipeScope(selected)===memoryRecipeScope(binding));}
  available(binding:MemoryRecipeBinding){try{this.strategies.resolvePinned(binding);return true;}catch{return false;}}
  view(sourceId?:string,scope?:'capture'){this.source(sourceId);const own=sourceId===undefined?undefined:this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(this.key(sourceId));return {sourceId:sourceId??null,...(scope?{scope}:{}),inherited:sourceId!==undefined&&!own,items:this.selection(sourceId,scope).map(binding=>({binding,available:this.available(binding)}))};}
  configure(raw:unknown){
    const input=z.object({sourceId:z.string().min(1).max(256).optional(),scope:z.literal('capture').optional(),recipes:selectionSchema.nullable()}).strict().refine(value=>!(value.sourceId&&value.scope),'Choose source or capture defaults').parse(raw);this.source(input.sourceId);
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
    if(input.recipes===null){if(input.sourceId===undefined)throw new StoreError('Only a source override can inherit defaults',400);this.store.db.prepare('DELETE FROM memory_recipe_settings WHERE id=?').run(this.key(input.sourceId));}
    else{
      let selected:MemoryRecipeBinding[];
      try{selected=input.recipes.map(ref=>this.strategies.resolve(ref).binding);}catch{throw new StoreError('Memory recipe is unavailable',409);}
      const json=JSON.stringify(selected);this.store.reserveMetadata(Buffer.byteLength(json)+256);
      this.store.db.prepare('INSERT INTO memory_recipe_settings VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(this.key(input.sourceId,input.scope),input.sourceId??null,json);
    }
      // Revocation is committed with enablement, so a crash between saving the
      // selection and cancelling a provider cannot resurrect old permission.
      this.onChange?.();db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    this.onApplied?.();return this.view(input.sourceId,input.scope);
  }
}
