import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

/** Run while the reader is paused at a synchronous domain validation boundary.
 * No busy wait: the caller cannot release its transaction until this returns. */
export function competingSqliteWrite(directory:string,value:string):'committed'|'busy'{
 const result=execFileSync(process.execPath,['--input-type=module','-e',String.raw`
  import {DatabaseSync} from 'node:sqlite';
  const db=new DatabaseSync(process.argv[1]);
  db.exec('PRAGMA busy_timeout=0');
  try{
   db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('generated-contention',process.argv[2]);
   process.stdout.write('committed');
  }catch(error){if(error.errcode!==5)throw error;process.stdout.write('busy');}
  finally{db.close();}
 `,join(directory,'mote.sqlite'),value],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 if(result!=='committed'&&result!=='busy')throw Error('Unexpected generated SQLite writer result');
 return result;
}
