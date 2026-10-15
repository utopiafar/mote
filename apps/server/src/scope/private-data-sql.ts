import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {createHmac,timingSafeEqual} from 'node:crypto';

export class PrivateDataError extends Error{
  constructor(readonly code:'not_found'|'conflict'|'invalid_data'|'invalid_cursor'|'scope_unavailable',readonly statusCode=400){super(code);}
}
export const missing=()=>new PrivateDataError('not_found',404);
/** The sole private SQL gateway. Named owner binding is supplied by the host,
 * never by a caller, and every operation revalidates its captured authority.
 * No connection or statement escapes through a user service. */
export class PrivateSql{
  constructor(private readonly db:DatabaseSync,readonly userId:string,private readonly authorize:()=>void){}
  private statement(sql:string){
    this.authorize();if(!/(?:\buser_id\s*=\s*\$user|\bVALUES\s*\(\s*\$user)/i.test(sql))throw new Error('Private SQL requires an owner binding');
    return this.db.prepare(sql);
  }
  get(sql:string,...args:SQLInputValue[]){return this.statement(sql).get({$user:this.userId},...args);}
  all(sql:string,...args:SQLInputValue[]){return this.statement(sql).all({$user:this.userId},...args);}
  run(sql:string,...args:SQLInputValue[]){const statement=this.statement(sql);statement.setReadBigInts(true);return statement.run({$user:this.userId},...args);}
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
