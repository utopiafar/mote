import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {StoreError} from './store.js';
import type {MaterialStore} from './materials.js';

export type MaterialIndexStatus={state:'disabled'|'pending'|'running'|'indexed'|'failed';revision?:string;reason?:string};
type Request={material_id:string;revision:string;enabled:number;generation:number;state:MaterialIndexStatus['state'];error:string|null};
type Input={materialId:string;revision:string;generation:number};
type Projection={rowid:number;coding:boolean;blocks:{id:number;text:string}[];text?:string};
const KIND='material.index';
const operation=(id:string)=>`material-index:${id}`;
const stepId=(row:Request)=>`${operation(row.material_id)}:${row.generation}`;
const runtimes=new WeakMap<ExecutionEngine,MaterialIndexRuntime>();

/** One handler on the host's shared engine. Index failures and retries have
 * their own operation and never invalidate an already published revision. */
export function materialIndexRuntime(materials:MaterialStore,engine:ExecutionEngine){
  let runtime=runtimes.get(engine);
  if(!runtime){runtime=new MaterialIndexRuntime(materials,engine);runtimes.set(engine,runtime);}
  return runtime;
}
export class MaterialIndexRuntime {
  private closed=false;
  private unregister:()=>Promise<void>;
  constructor(readonly materials:MaterialStore,readonly engine:ExecutionEngine){
    this.unregister=engine.register({kind:KIND,pool:'material.index',concurrency:()=>2,
      resourceKeys:step=>[`material:${(step.input as Input).materialId}`],
      validate:step=>this.valid(step),execute:async(step,signal)=>{signal.throwIfAborted();return this.projection(step);},
      commit:(step,result)=>this.commit(step,result as Projection),project:step=>this.project(step),
      classify:error=>new ExecutionFailure('permanent',error instanceof StoreError&&error.statusCode===507?'storage_full':'material_index_failed'),maxAttempts:1});
  }
  private request(id:string){return this.materials.store.db.prepare('SELECT * FROM material_index_requests WHERE material_id=?').get(id) as Request|undefined;}
  private valid(step:ExecutionStep){
    const input=step.input as Input,row=this.request(input.materialId),head=this.materials.get(input.materialId);
    return Boolean(!this.closed&&row?.enabled&&row.revision===input.revision&&row.generation===input.generation&&head?.revision===input.revision);
  }
  private projection(step:ExecutionStep):Projection {
    if(!this.valid(step))throw new ExecutionFailure('stale','input_changed');
    const input=step.input as Input,db=this.materials.store.db,head=this.materials.get(input.materialId)!;
    const rowid=Number(db.prepare('SELECT rowid FROM material_heads WHERE id=?').get(input.materialId)!.rowid);
    const coding=Boolean(db.prepare('SELECT 1 FROM material_coding_snapshots WHERE material_id=? AND revision=?').get(input.materialId,input.revision));
    if(coding){
      // Reused Coding prefix blocks retain their index rows. Only the new tail
      // is read, while query joins continue to filter old closed intervals.
      const blocks=db.prepare(`SELECT b.id,p.text FROM material_block_versions b JOIN material_block_payloads p ON p.hash=b.payload_hash
        WHERE b.material_id=? AND b.kind='text' AND b.from_sequence<=? AND (b.until_sequence IS NULL OR b.until_sequence>?)
        AND (NOT EXISTS(SELECT 1 FROM material_fts_blocks f WHERE f.rowid=b.id)
          OR EXISTS(SELECT 1 FROM material_index_garbage g WHERE g.kind='block' AND g.row_id=b.id))`).all(input.materialId,head.sequence,head.sequence) as {id:number;text:string}[];
      return {rowid,coding,blocks};
    }
    const text=db.prepare(`SELECT p.text,b.format FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
      WHERE b.material_id=? AND b.revision=? ORDER BY b.idx`).all(input.materialId,input.revision)
      .map(row=>String(row.text)+(row.format==='markdown-fragment'?'':'\n')).join('');
    return {rowid,coding,blocks:[],text};
  }
  private commit(step:ExecutionStep,result:Projection){
    if(!this.valid(step))throw new ExecutionFailure('stale','input_changed');
    const input=step.input as Input,db=this.materials.store.db;
    // All FTS writes and restored search authority commit together, separately
    // from the organizer/publication transaction.
    db.prepare('DELETE FROM material_fts WHERE rowid=?').run(result.rowid);
    db.prepare("DELETE FROM material_index_garbage WHERE kind='head' AND row_id=?").run(result.rowid);
    if(result.coding){const remove=db.prepare('DELETE FROM material_fts_blocks WHERE rowid=?'),insert=db.prepare('INSERT INTO material_fts_blocks(rowid,text) VALUES(?,?)');for(const block of result.blocks){remove.run(block.id);insert.run(block.id,block.text);db.prepare("DELETE FROM material_index_garbage WHERE kind='block' AND row_id=?").run(block.id);}}
    else db.prepare('INSERT INTO material_fts(rowid,material_id,text) VALUES(?,?,?)').run(result.rowid,input.materialId,result.text!);
    db.prepare('INSERT OR IGNORE INTO material_searchable VALUES(?)').run(input.materialId);
  }
  private project(step:ExecutionStep){
    const input=step.input as Input,state:MaterialIndexStatus['state']=step.state==='succeeded'?'indexed':
      step.state==='running'?'running':step.state==='waiting'?'pending':'failed';
    this.materials.store.db.prepare(`UPDATE material_index_requests SET state=?,error=?
      WHERE material_id=? AND revision=? AND generation=? AND enabled=1`)
      .run(state,step.error??null,input.materialId,input.revision,input.generation);
  }
  private enqueue(row:Request){return this.engine.enqueue(operation(row.material_id),KIND,
    {materialId:row.material_id,revision:row.revision,generation:row.generation},
    {id:stepId(row),generation:{slot:'index',version:String(row.generation)}});}
  async tick(limit=200){
    if(this.closed)return;
    this.materials.pruneIndexes();
    const rows=this.materials.store.db.prepare("SELECT * FROM material_index_requests WHERE enabled=1 AND state IN ('pending','running') LIMIT ?").all(limit) as Request[];
    const ids:string[]=[];
    for(const row of rows){
      try{ids.push(this.enqueue(row));}
      catch(error){this.materials.store.db.prepare("UPDATE material_index_requests SET state='failed',error=? WHERE material_id=? AND generation=?")
        .run(error instanceof StoreError&&error.statusCode===507?'storage_full':'material_index_unavailable',row.material_id,row.generation);}
    }
    // The engine classifies index failures into the durable independent state.
    await this.engine.drain(ids);
  }
  retry(id:string){
    if(this.closed)throw new StoreError('Material indexing is closed',503);
    const row=this.request(id);if(!row||!this.materials.get(id))throw new StoreError('Material not found',404);
    if(!row.enabled)throw new StoreError('Material indexing is disabled',409);
    const step=this.enqueue(row);if(this.engine.get(step)?.state!=='running')this.engine.retry(step);
    return this.materials.indexStatus(id);
  }
  async close(){if(this.closed)return;this.closed=true;await this.unregister();}
}
