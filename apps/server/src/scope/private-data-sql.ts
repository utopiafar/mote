import type {DatabaseSync,SQLInputValue,StatementSync} from 'node:sqlite';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';

export class PrivateDataError extends Error{
  constructor(readonly code:'not_found'|'conflict'|'invalid_data'|'invalid_cursor'|'scope_unavailable'|'snapshot_input_expired'|'file_forgotten',readonly statusCode=400){super(code);}
}
export const missing=()=>new PrivateDataError('not_found',404);
// Reuse only compiled SQL, never rows, owner bindings or an authorization result.
// Synchronous get/all/run leave no iterator active; SQLite reparses on schema changes.
const statements=new WeakMap<DatabaseSync,Map<string,StatementSync>>();
/** The sole private SQL gateway. Named owner binding is supplied by the host,
 * never by a caller. Ordinary operations revalidate captured authority; an exact
 * pin disposer is minted while current and only deletes its fixed row.
 * No connection or statement escapes through a user service. */
export class PrivateSql{
  constructor(private readonly db:DatabaseSync,readonly userId:string,private readonly authorize:()=>void){}
  private statement(sql:string,write=false){
    this.authorize();if(!/(?:\buser_id\s*=\s*\$user|\bVALUES\s*\(\s*\$user)/i.test(sql))throw new Error('Private SQL requires an owner binding');
    let cache=statements.get(this.db);if(!cache){cache=new Map();statements.set(this.db,cache);}
    const key=(write?'write:':'read:')+sql,prior=cache.get(key);if(prior)return prior;
    const statement=this.db.prepare(sql);if(cache.size>=256)cache.delete(cache.keys().next().value!);cache.set(key,statement);return statement;
  }
  get(sql:string,...args:SQLInputValue[]){return this.statement(sql).get({$user:this.userId},...args);}
  all(sql:string,...args:SQLInputValue[]){return this.statement(sql).all({$user:this.userId},...args);}
  run(sql:string,...args:SQLInputValue[]){const statement=this.statement(sql,true);statement.setReadBigInts(true);return statement.run({$user:this.userId},...args);}
  /** Cleanup capability for one fixed pin UUID; retirement must not
   * turn its release into a read or leave a live pin until expiration. */
  pinDisposer(id:string):()=>void{
    const statement=this.statement('DELETE FROM ig_pins WHERE user_id=$user AND id=?'),owner=this.userId,pinId=id;
    return ()=>{statement.run({$user:owner},pinId);};
  }
  transaction<T>(run:()=>T):T{
    this.authorize();
    // Host callers may compose atomic source/task writes. Savepoints keep a
    // failed nested operation from leaving partially written links behind.
    const nested=this.db.isTransaction;
    this.db.exec(nested?'SAVEPOINT private_data':'BEGIN IMMEDIATE');
    try{const result=run();this.authorize();this.db.exec(nested?'RELEASE private_data':'COMMIT');return result;}
    catch(error){this.db.exec(nested?'ROLLBACK TO private_data':'ROLLBACK');if(nested)this.db.exec('RELEASE private_data');throw error;}
  }
}

/** HMAC and durable host key prevent forging a position. User/deployment,
 * collection and complete filters prevent replay on another query or account. */
export class PrivateCursor{
  constructor(private readonly key:string,private readonly deploymentId:string,private readonly userId:string){}
  encode(query:unknown,position:{at:string;id:string}){
    const body=Buffer.from(JSON.stringify({v:1,deployment:this.deploymentId,user:this.userId,query,position})).toString('base64url');
    return body+'.'+createHmac('sha256',this.key).update(body).digest('base64url');
  }
  /** Nested read cursors remain opaque while their full query, user and host are
   * authenticated without repeating that metadata in every response budget. */
  encodeCompact(query:unknown,position:unknown){const serialized=JSON.stringify(position);if(Buffer.byteLength(serialized)>16384)throw new PrivateDataError('invalid_cursor');const body=deflateRawSync(Buffer.from(serialized)).toString('base64url'),signature=createHmac('sha256',this.key).update(JSON.stringify(['private-compact-v1',this.deploymentId,this.userId,query,body])).digest('base64url');return body+'.'+signature;}
  decodeCompact(cursor:string,query:unknown):unknown{try{if(cursor.length>16384)throw Error();const [body,signature,...rest]=cursor.split('.');if(rest.length||!body||!signature)throw Error();const expected=createHmac('sha256',this.key).update(JSON.stringify(['private-compact-v1',this.deploymentId,this.userId,query,body])).digest(),actual=Buffer.from(signature,'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw Error();return JSON.parse(inflateRawSync(Buffer.from(body,'base64url'),{maxOutputLength:16384}).toString());}catch{throw new PrivateDataError('invalid_cursor');}}
  decode(cursor:string,query:unknown):{at:string;id:string}{
    try{
      const [body,signature,...extra]=cursor.split('.');
      if(extra.length||!body||!signature)throw Error();
      const actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',this.key).update(body).digest();
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();
      const value=JSON.parse(Buffer.from(body,'base64url').toString());
      if(value.v!==1||value.deployment!==this.deploymentId||value.user!==this.userId||JSON.stringify(value.query)!==JSON.stringify(query)||typeof value.position?.at!=='string'||typeof value.position?.id!=='string')throw Error();
      return value.position;
    }catch{throw new PrivateDataError('invalid_cursor');}
  }
}
