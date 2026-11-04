import type {FastifyInstance} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {ServerFeatureHost,ServerFeatureScope} from '../feature-host.js';
import type {FeatureServices} from '../feature-services.js';
import {adapter as activityAdapter} from './activity.js';
import {adapter as filesAdapter} from './files.js';
import {adapter as connectionsAdapter} from './connections.js';
import {adapter as systemAdapter} from './system.js';
import {adapter as storageAdapter} from './storage.js';
import {adapter as captureAdapter} from './capture.js';
import {adapter as contextAdapter} from './context.js';
import {adapter as materialsAdapter} from './materials.js';
import {adapter as codingAdapter} from './coding.js';
import {adapter as sourcesAdapter} from './sources.js';
import {adapter as modelsAdapter} from './models.js';
import {adapter as processingAdapter} from './processing.js';
import {adapter as notesAdapter} from './notes.js';
import {adapter as devicesAdapter} from './devices.js';
import {adapter as mediaAdapter} from './media.js';
import {adapter as ownerQuestionsAdapter} from './owner-questions.js';
import {adapter as memoryAdapter} from './memory.js';
import {adapter as importsAdapter} from './imports.js';
import {adapter as insightsAdapter} from './insights.js';
import {adapter as featuresAdapter} from './features.js';

/** Development-time adapters over the existing real feature factories. H14 removes
 * this assembly bridge as domain-owned native factories replace it. No package
 * installation or alternate Manifest is created here. */
export interface ServerFeatureAdapter {
  readonly descriptor: ManifestContribution;
  readonly factory: (app:FastifyInstance,scope:ServerFeatureScope,services:FeatureServices,host:ServerFeatureHost)=>void;
}
const domainRouteContribution=(id:string):ServerFeatureAdapter=>({
  descriptor:{id,version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,_services,host)=>{scope.assertCurrent();host.mountDomainRoutes(id,app);},
});
export const serverFeatureAdapters:readonly ServerFeatureAdapter[]=Object.freeze([
  activityAdapter,
  filesAdapter,
  domainRouteContribution('mote.actions'),
  connectionsAdapter,
  systemAdapter,
  storageAdapter,
  captureAdapter,
  contextAdapter,
  materialsAdapter,
  codingAdapter,
  sourcesAdapter,
  modelsAdapter,
  processingAdapter,
  notesAdapter,
  devicesAdapter,
  mediaAdapter,
  ownerQuestionsAdapter,
  memoryAdapter,
  importsAdapter,
  domainRouteContribution('mote.ask'),
  insightsAdapter,
  domainRouteContribution('mote.agent-view'),
  featuresAdapter,
]);
export async function installServerFeatures(host:ServerFeatureHost,services:FeatureServices,entries:readonly ServerFeatureAdapter[]=serverFeatureAdapters){
  for(const {descriptor,factory} of entries){
    await host.install({id:descriptor.id,version:descriptor.version,components:[]},(app,scope)=>factory(app,scope,services,host));
  }
}
