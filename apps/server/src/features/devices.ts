import type { FeatureServices } from '../feature-services.js';
import {firstDeviceData} from '../first-device-data.js';
import {createDevicesSource} from '../plugins/devices-source.js';
import {StoreError} from '../store.js';
import type {ServerFeatureAdapter} from './index.js';

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.devices',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services:Pick<FeatureServices,'agentFeatures'|'diagnostics'|'store'|'files'|'evidenceReader'|'notesCapture'>)=>{
    const {agentFeatures,diagnostics,store,files,evidenceReader,notesCapture}=services;
    if(!notesCapture)throw new StoreError('Devices source authorization is unavailable',503);
    const source=createDevicesSource({recordQueueSnapshot:beat=>diagnostics.record('queue.snapshot',{queueDepth:beat.queueDepth})},{
      devices:store,
      firstData:()=>firstDeviceData(store,files,evidenceReader),
      authority:notesCapture.authority,
      identity:{
        assertOwnDevice:(request,beat)=>notesCapture.authority.requests.assertOwnDevice(request,beat),
        assertOwnPlatform:(request,platform)=>notesCapture.authority.requests.assertOwnPlatform(request,platform),
      },
    });
    scope.retire(()=>agentFeatures.dispose('mote.devices'));
    scope.retire(()=>source.close());
    source.start();
    source.routes(app,{request:notesCapture.route.request});
  },
};
