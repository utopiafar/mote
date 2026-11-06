import type {LogEntry} from './logger';

const databaseName = 'mote-browser-logs';
const storeName = 'events';
const retainedEvents = 2000;
let database: Promise<IDBDatabase> | undefined;
let pending: Promise<void> = Promise.resolve();
let lastFailure = false;
let queued = 0;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Browser storage unavailable')); return; }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(storeName, {autoIncrement:true}); };
    request.onsuccess = () => { request.result.onversionchange = () => {request.result.close();database=undefined;}; resolve(request.result); };
    request.onerror = () => reject(request.error ?? new Error('Browser storage unavailable'));
    request.onblocked = () => reject(new Error('Browser storage blocked'));
  }).catch(error => { database=undefined; throw error; });
  database = opening;
  return opening;
}

function append(entry: LogEntry): Promise<void> {
  return openDatabase().then(db => new Promise<void>((resolve,reject) => {
    const transaction=db.transaction(storeName,'readwrite'),store=transaction.objectStore(storeName);
    store.add(entry);
    const count=store.count();
    count.onsuccess=()=>{
      let excess=count.result-retainedEvents;
      if(excess<=0)return;
      const cursor=store.openCursor();
      cursor.onsuccess=()=>{const row=cursor.result;if(row&&excess>0){row.delete();excess--;row.continue();}};
    };
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error ?? new Error('Log write failed'));
    transaction.onabort=()=>reject(transaction.error ?? new Error('Log write aborted'));
  }));
}

/** Logging failures never change the operation being diagnosed. */
export function persistBrowserLog(entry: LogEntry): void {
  if(typeof indexedDB==='undefined')return;
  if(queued>=1024){lastFailure=true;return;}
  queued++;
  pending=pending.then(()=>append(entry)).then(()=>{queued--;},()=>{queued--;lastFailure=true;});
}
export function browserLogWriteFailed() {return lastFailure;}
export async function readStoredBrowserLogs(): Promise<LogEntry[]> {
  await pending;
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(storeName,'readonly');
    const request=transaction.objectStore(storeName).getAll();
    request.onsuccess=()=>resolve(request.result as LogEntry[]);
    request.onerror=()=>reject(request.error ?? new Error('Log read failed'));
  });
}
