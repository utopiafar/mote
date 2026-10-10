import type {CaptureInput} from '@mote/shared';
import {screenImageSource} from './image-inputs.js';
import type {MaterialMemoryWork} from './material-memory-work.js';
import {sha256,type Store} from './store.js';
import {uiPageCaptureSource} from './capture-memory-source.js';

export {uiPageCaptureSource} from './capture-memory-source.js';

/** Capture receipts share the source Memory queue. Only fresh durable intake
 * grants work; retries, portable restore and organizer rebuilds never do. */
export function installCaptureMemoryIntake(store:Store,work:MaterialMemoryWork){
  const receive=(input:CaptureInput)=>{
    const sourceId=input.imageBase64?screenImageSource(input.deviceId,sha256):
      input.source==='ui_page'&&input.metadata?.uiPage?.version===2?uiPageCaptureSource(input.deviceId):undefined;
    if(!sourceId)return;
    const db=store.db,now=new Date().toISOString();
    if(!db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId)){
      const source={id:sourceId,name:input.deviceName||input.deviceId,kind:'custom',deviceId:input.deviceId,platform:input.platform,retention:'archive',enabled:true,createdAt:now,updatedAt:now};
      store.reserveMetadata(Buffer.byteLength(JSON.stringify(source))+256);
      db.prepare('INSERT INTO source_connections VALUES(?,?)').run(sourceId,JSON.stringify(source));
    }
    work.inputs.receive({sourceId,inputKey:input.id,captureId:input.id});
  };
  if(store.captureInputReceived)throw Error('Capture Memory intake is already installed');
  store.captureInputReceived=receive;
  return ()=>{if(store.captureInputReceived===receive)store.captureInputReceived=undefined;};
}
