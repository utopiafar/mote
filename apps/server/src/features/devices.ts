import type {FastifyInstance,FastifyRequest} from 'fastify';
import {firstDeviceData} from '../first-device-data.js';
import {createDevicesSource} from '../plugins/devices-source.js';
import {StoreError} from '../store.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {FileStore} from '../files.js';
import type {NotesCapture} from './notes.js';
import type {Store} from '../store.js';
import type {FeatureRoute} from './index.js';

export interface DevicesFeatureDependencies {
  readonly diagnostics:ServerDiagnostics;
  readonly store:Store;
  readonly files:FileStore;
  readonly evidenceReader:EvidenceReader;
  readonly notesCapture:NotesCapture|undefined;
  readonly request:(request:FastifyRequest)=>unknown;
}

export function devicesFeature(dependencies:DevicesFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.devices',mount(app:FastifyInstance,scope:import('./index.js').FeatureScope){
    const {diagnostics,store,files,evidenceReader,notesCapture}=dependencies;
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
    scope.defer(()=>source.close());
    source.start();
    source.routes(app,{request:request=>notesCapture.route.request(request)});
  }});
}
