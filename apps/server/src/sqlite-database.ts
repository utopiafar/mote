import {DatabaseSync,type StatementSync} from 'node:sqlite';

const safeInteger=(value:number|bigint):number|bigint=>typeof value==='bigint'&&value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):value;

/** FTS5 contentless deletions can leave a 64-bit internal rowid on the
 * connection. Even UPDATE/DELETE run() reads that unrelated lastInsertRowid.
 * Decode write receipts losslessly without changing query result types. */
export class StoreDatabase extends DatabaseSync {
 override prepare(sql:string):StatementSync {
  const statement=super.prepare(sql),run=statement.run.bind(statement),setReadBigInts=statement.setReadBigInts.bind(statement);
  let readBigInts=false;
  statement.setReadBigInts=enabled=>{setReadBigInts(enabled);readBigInts=enabled;};
  statement.run=((...args:Parameters<StatementSync['run']>)=>{
   setReadBigInts(true);
   try{
    const result=run(...args);
    return readBigInts?result:{changes:safeInteger(result.changes),lastInsertRowid:safeInteger(result.lastInsertRowid)};
   }finally{setReadBigInts(readBigInts);}
  }) as StatementSync['run'];
  return statement;
 }
}
