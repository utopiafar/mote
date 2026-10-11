import {z} from 'zod';
import {Store,StoreError,sha256} from './store.js';
import type {MemoryStrategies} from './memory-strategies.js';
import {memoryRecipeBindingSchema,memoryStrategyRefSchema,type MemoryRecipeBinding} from './memory-strategy-contract.js';
import {DAILY_EVENT_RECIPE} from './daily-event-memory-policy.js';
import {isCaptureMemorySource} from './capture-memory-source.js';
import {PERSONAL_MEMORY_RECIPE} from './bounded-personal-memory-policy.js';

export const memoryRecipeScope=(binding:MemoryRecipeBinding)=>'recipe/'+sha256(JSON.stringify(binding));
const bindingsSchema=z.array(memoryRecipeBindingSchema).min(1).max(9);
const selectionSchema=z.array(memoryStrategyRefSchema).min(1).max(9).refine(values=>new Set(values.map(v=>v.id+'@'+v.version)).size===values.length,'Duplicate Memory recipe');
export const memoryRecipeSettingsQuery=z.object({sourceId:z.string().min(1).max(256).optional(),scope:z.literal('capture').optional()}).strict().refine(value=>!(value.sourceId&&value.scope),'Choose source or capture defaults');

/** Owner strategy selection is separate from installation. Persist exact selected
 * definitions. A named built-in default upgrade affects future receipts only;
 * arbitrary installed versions never change a saved selection. */
export class MemoryRecipeSettings {
  onChange?:()=>void;
  onApplied?:()=>void;
  constructor(private store:Store,private strategies:MemoryStrategies){
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_recipe_settings(id TEXT PRIMARY KEY,source_id TEXT REFERENCES source_connections(id) ON DELETE CASCADE,json TEXT NOT NULL)');
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_recipe_default_upgrades(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_recipe_legacy_scopes(setting_id TEXT NOT NULL REFERENCES memory_recipe_settings(id) ON DELETE CASCADE,scope TEXT NOT NULL,PRIMARY KEY(setting_id,scope));
      CREATE TABLE IF NOT EXISTS memory_recipe_legacy_exclusions(source_id TEXT PRIMARY KEY REFERENCES source_connections(id) ON DELETE CASCADE);`);
    if(!store.db.prepare("SELECT 1 FROM memory_recipe_settings WHERE id='default'").get()){
      const initial=[strategies.resolve(PERSONAL_MEMORY_RECIPE).binding];
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
    this.upgradeBuiltInDefaults();
  }
  private upgradeBuiltInDefaults(){
    const db=this.store.db,id='bounded-personal@3';if(db.prepare('SELECT 1 FROM memory_recipe_default_upgrades WHERE id=?').get(id))return;
    const old=this.strategies.resolve({id:'mote.personal-memory',version:'2'}).binding,
      next=this.strategies.resolve(PERSONAL_MEMORY_RECIPE).binding,daily=this.strategies.resolve(DAILY_EVENT_RECIPE).binding;
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const [setting,expected] of [['default',[old]],['capture-default',[old,daily]]] as const){
        const row=db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(setting);
        if(!row||String(row.json)!==JSON.stringify(expected))continue;
        const json=JSON.stringify(expected.map(binding=>memoryRecipeScope(binding)===memoryRecipeScope(old)?next:binding));
        this.store.reserveMetadata(Buffer.byteLength(json)+256);
        // Keep already authorized version-2 receipts runnable. This does not
        // create receipts, reauthorize revoked work, or publish historical data.
        db.prepare('INSERT OR IGNORE INTO memory_recipe_legacy_scopes VALUES(?,?)').run(setting,memoryRecipeScope(old));
        db.prepare('UPDATE memory_recipe_settings SET json=? WHERE id=?').run(json,setting);
      }
      db.prepare('INSERT INTO memory_recipe_default_upgrades VALUES(?)').run(id);db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
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
  enabled(sourceId:string,binding:MemoryRecipeBinding){
    const scope=memoryRecipeScope(binding);if(this.selection(sourceId).some(selected=>memoryRecipeScope(selected)===scope))return true;
    if(this.store.db.prepare('SELECT 1 FROM memory_recipe_legacy_exclusions WHERE source_id=?').get(sourceId))return false;
    const own=this.store.db.prepare('SELECT 1 FROM memory_recipe_settings WHERE id=?').get(this.key(sourceId));
    if(own)return false;
    const source=this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);
    const setting=source&&isCaptureMemorySource(sourceId,JSON.parse(String(source.json)).deviceId)?'capture-default':'default';
    return Boolean(this.store.db.prepare('SELECT 1 FROM memory_recipe_legacy_scopes WHERE setting_id=? AND scope=?').get(setting,scope));
  }
  available(binding:MemoryRecipeBinding){try{this.strategies.resolvePinned(binding);return true;}catch{return false;}}
  view(sourceId?:string,scope?:'capture'){this.source(sourceId);const own=sourceId===undefined?undefined:this.store.db.prepare('SELECT json FROM memory_recipe_settings WHERE id=?').get(this.key(sourceId));return {sourceId:sourceId??null,...(scope?{scope}:{}),inherited:sourceId!==undefined&&!own,items:this.selection(sourceId,scope).map(binding=>({binding,available:this.available(binding)}))};}
  configure(raw:unknown){
    const input=z.object({sourceId:z.string().min(1).max(256).optional(),scope:z.literal('capture').optional(),recipes:selectionSchema.nullable()}).strict().refine(value=>!(value.sourceId&&value.scope),'Choose source or capture defaults').parse(raw);this.source(input.sourceId);
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
    // Any subsequent explicit owner choice ends grandfathering for this setting.
    db.prepare('DELETE FROM memory_recipe_legacy_scopes WHERE setting_id=?').run(this.key(input.sourceId,input.scope));
    // Inheriting removes the override row, so remember its explicit opt-out
    // separately. It must not regain the global legacy allowance on restart.
    if(input.sourceId!==undefined&&!db.prepare('SELECT 1 FROM memory_recipe_legacy_exclusions WHERE source_id=?').get(input.sourceId)){
      this.store.reserveMetadata(Buffer.byteLength(input.sourceId)+128);
      db.prepare('INSERT INTO memory_recipe_legacy_exclusions VALUES(?)').run(input.sourceId);
    }
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
