import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {StoreError} from './evidence-store.js';

const writeError=(error:unknown)=>{
 const code=error&&typeof error==='object'?(error as {errcode?:unknown}).errcode:undefined;
 return typeof code==='number'&&(code&255)===13?new StoreError('SQLite storage is full',507,{cause:error}):error;
};

const safeInteger=(value:number|bigint):number|bigint=>typeof value==='bigint'&&value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):value;

/** FTS5 contentless deletions can leave a 64-bit internal rowid on the
 * connection. Even UPDATE/DELETE run() reads that unrelated lastInsertRowid.
 * Decode write receipts losslessly without changing query result types. */
export class StoreDatabase extends DatabaseSync {
 override exec(sql:string):void{try{super.exec(sql);}catch(error){throw writeError(error);}}
 override prepare(sql:string):StatementSync {
  const statement=super.prepare(sql),run=statement.run.bind(statement),get=statement.get.bind(statement),setReadBigInts=statement.setReadBigInts.bind(statement);
  let readBigInts=false;
  statement.setReadBigInts=enabled=>{setReadBigInts(enabled);readBigInts=enabled;};
  statement.run=((...args:Parameters<StatementSync['run']>)=>{
   setReadBigInts(true);
   try{
    const result=run(...args);
    return readBigInts?result:{changes:safeInteger(result.changes),lastInsertRowid:safeInteger(result.lastInsertRowid)};
   }catch(error){throw writeError(error);}finally{setReadBigInts(readBigInts);}
  }) as StatementSync['run'];
  // Scheduling persists its sequence with INSERT ... RETURNING through get().
  statement.get=((...args:Parameters<StatementSync['get']>)=>{try{return get(...args);}catch(error){throw writeError(error);}}) as StatementSync['get'];
  return statement;
 }
}
