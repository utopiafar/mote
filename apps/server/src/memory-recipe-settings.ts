import {z} from 'zod';
import {Store,StoreError,sha256} from './store.js';
import type {MemoryStrategies} from './memory-strategies.js';
import {memoryRecipeBindingSchema,memoryStrategyRefSchema,type MemoryRecipeBinding} from './memory-strategy-contract.js';
import {isCaptureMemorySource} from './capture-memory-source.js';
import {RANGE_SELECTION_PERSONAL_RECIPE,RANGE_SELECTION_DAILY_RECIPE} from './memory-range-selection-policy.js';

export const memoryRecipeScope=(binding:MemoryRecipeBinding)=>'recipe/'+sha256(JSON.stringify(binding));
const bindingsSchema=z.array(memoryRecipeBindingSchema).min(1).max(10);
const selectionSchema=z.array(memoryStrategyRefSchema).min(1).max(10).refine(values=>new Set(values.map(v=>v.id+'@'+v.version)).size===values.length,'Duplicate Memory recipe');
export type MemoryRecipeDefaultScope='capture'|'lark-docs';
const defaultScopeSchema=z.enum(['capture','lark-docs']);
export const memoryRecipeSettingsQuery=z.object({sourceId:z.string().min(1).max(256).optional(),scope:defaultScopeSchema.optional()}).strict().refine(value=>!(value.sourceId&&value.scope),'Choose source or category defaults');

/** Owner strategy selection is separate from installation. Persist exact selected
 * definitions; installed versions never change a saved selection. */
export class MemoryRecipeSettings {
  onChange?:()=>void;
  onApplied?:()=>void;
  constructor(private store:Store,private strategies:MemoryStrategies){
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_recipe_settings(id TEXT PRIMARY KEY,source_id TEXT REFERENCES source_connections(id) ON DELETE CASCADE,json TEXT NOT NULL)');
    this.initializeDefaults();
  }
  private stored(id:string){return this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(id);}
  private insert(id:string,selection:MemoryRecipeBinding[]){
    const json=JSON.stringify(selection);
    this.store.reserveMetadata(Buffer.byteLength(json)+128);
    this.store.db.prepare('INSERT INTO memory_recipe_settings VALUES(?,NULL,?)').run(id,json);
  }
  private initializeDefaults(){
    const fresh=!this.stored('default'),current=this.strategies.resolve(RANGE_SELECTION_PERSONAL_RECIPE).binding,
      daily=this.strategies.resolve(RANGE_SELECTION_DAILY_RECIPE).binding;
    // A new vault starts from the current defaults directly. An existing vault
    // keeps its general default when a category default is first established.
    if(fresh)this.insert('default',[current]);
    const base=fresh?[current]:this.selection();
    for(const id of ['capture-default','lark-docs-default'])if(!this.stored(id))this.insert(id,base.some(binding=>binding.recipe.id===daily.recipe.id)?base:[...base,daily]);
  }
  private key(sourceId?:string,scope?:MemoryRecipeDefaultScope){return sourceId===undefined?scope?scope+'-default':'default':'source:'+sourceId;}
  private sourceDefault(sourceId:string){
    const source=this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);
    if(!source)return 'default';
    const value=JSON.parse(String(source.json));
    return isCaptureMemorySource(sourceId,value.deviceId)?'capture-default':value.kind==='lark-docs'?'lark-docs-default':'default';
  }
  private source(sourceId?:string){if(sourceId!==undefined&&!this.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId))throw new StoreError('Source not found',404);}
  selection(sourceId?:string,scope?:MemoryRecipeDefaultScope):MemoryRecipeBinding[]{
    const own=sourceId===undefined?undefined:this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(this.key(sourceId));
    if(own)return bindingsSchema.parse(JSON.parse(String(own.json)));
    const setting=sourceId===undefined?this.key(undefined,scope):this.sourceDefault(sourceId);
    return bindingsSchema.parse(JSON.parse(String(this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(setting)!.json)));
  }
  enabled(sourceId:string,binding:MemoryRecipeBinding){
    const scope=memoryRecipeScope(binding);return this.selection(sourceId).some(selected=>memoryRecipeScope(selected)===scope);
  }
  available(binding:MemoryRecipeBinding){try{this.strategies.resolvePinned(binding);return true;}catch{return false;}}
  view(sourceId?:string,scope?:MemoryRecipeDefaultScope){this.source(sourceId);const own=sourceId===undefined?undefined:this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(this.key(sourceId));return {sourceId:sourceId??null,...(scope?{scope}:{}),inherited:sourceId!==undefined&&!own,items:this.selection(sourceId,scope).map(binding=>({binding,available:this.available(binding)}))};}
  configure(raw:unknown){
    const input=z.object({sourceId:z.string().min(1).max(256).optional(),scope:defaultScopeSchema.optional(),recipes:selectionSchema.nullable()}).strict().refine(value=>!(value.sourceId&&value.scope),'Choose source or category defaults').refine(value=>value.sourceId!==undefined||value.scope!==undefined||value.recipes===null||value.recipes.length<=9,'General defaults allow at most nine recipes').parse(raw);this.source(input.sourceId);
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
