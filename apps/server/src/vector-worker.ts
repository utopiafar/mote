import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {captureOcrState} from '@mote/shared';
import type {VectorTask,VectorScan} from './vector-work.js';

// A separate process owns the read-only snapshot and all full-corpus CPU work.
process.once('message',(task:VectorTask)=>{
 let db:DatabaseSync|undefined;
 try{
  db=new DatabaseSync(task.path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
  db.function('mote_ocr_status',(json)=>captureOcrState(JSON.parse(String(json))).status);
  const norm=Math.hypot(...task.vector),scans:VectorScan[]=[];
  db.exec('BEGIN');
  for(const query of task.queries){
   const best:{id:string;score:number;embedding:string}[]=[];let scanned=0,invalid=0;
   for(const row of db.prepare(query.sql).iterate(...query.values)){
    scanned++;let vector:unknown;try{vector=JSON.parse(String(row.embedding));}catch{invalid++;continue;}
    if(!Array.isArray(vector)||vector.length!==task.vector.length||!vector.every(Number.isFinite)){invalid++;continue;}
    let product=0,squared=0;for(let i=0;i<vector.length;i++){product+=vector[i]*task.vector[i];squared+=vector[i]*vector[i];}
    if(!norm||!squared){invalid++;continue;}
    const score=product/(Math.sqrt(squared)*norm);if(!Number.isFinite(score)){invalid++;continue;}
    const item={id:String(row.id),score,embedding:String(row.embedding)};
    const last=best.at(-1);if(best.length>=task.limit&&last&&(item.score<last.score||item.score===last.score&&item.id.localeCompare(last.id)>=0))continue;
    best.push(item);best.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));if(best.length>task.limit)best.pop();
   }
   scans.push({candidates:best.map(({id,embedding})=>({id,embeddingHash:createHash('sha256').update(embedding).digest('hex')})),coverage:{candidateLimit:null,scanned,invalid,bounded:false,selection:'all_indexed_within_scope'}});
  }
  db.exec('COMMIT');db.close();db=undefined;
  process.send?.({ok:true,scans},()=>process.exit(0));
 }catch{db?.close();process.send?.({ok:false},()=>process.exit(1));}
});
process.on('disconnect',()=>process.exit(1));
