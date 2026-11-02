import {register as ownerQuestionsEntry} from './owner-questions.js';
import {register as filesEntry} from './files.js';
import type { ServerFeatureHost } from '../feature-host.js';
import { featureInventory } from '../feature-inventory.js';
import type { FeatureServices } from '../feature-services.js';
import { register as actionsEntry } from './actions.js';
import { register as activityEntry } from './activity.js';
import { register as agentView } from './agent-view.js';
import { register as askEntry } from './ask.js';
import { register as captureEntry } from './capture.js';
import { register as codingEntry } from './coding.js';
import { register as connectionsEntry } from './connections.js';
import { register as contextEntry } from './context.js';
import { register as devicesEntry } from './devices.js';
import { register as diagnosticsEntry } from './diagnostics.js';
import { register as importsEntry } from './imports.js';
import { register as insightsEntry } from './insights.js';
import { register as materialsEntry } from './materials.js';
import { register as mediaEntry } from './media.js';
import { register as memoryEntry } from './memory.js';
import { register as modelsEntry } from './models.js';
import { register as notesEntry } from './notes.js';
import { register as processingEntry } from './processing.js';
import { register as sourcesEntry } from './sources.js';
import { register as storageEntry } from './storage.js';
import { register as systemEntry } from './system.js';
import { register as usageEntry } from './usage.js';
import type {ManifestContribution} from '@mote/plugin-api';
import type {FastifyInstance} from 'fastify';
import type {ServerFeatureScope} from '../feature-host.js';

/** Development-time adapters over the existing real feature factories. H14 removes
 * this assembly bridge as domain-owned native factories replace it. No package
 * installation or alternate Manifest is created here. */
export interface ServerFeatureAdapter {
  readonly descriptor: ManifestContribution;
  readonly factory: (app:FastifyInstance,scope:ServerFeatureScope,services:FeatureServices,host:ServerFeatureHost)=>void;
}
export const serverFeatureAdapters:readonly ServerFeatureAdapter[]=Object.freeze([
  {descriptor:{id:'mote.activity',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services,host)=>activityEntry(app,services)},
  {descriptor:{id:'mote.files',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.files'));filesEntry(app,services,scope);}},
  {descriptor:{id:'mote.actions',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.actions'));actionsEntry(app,services,scope);}},
  {descriptor:{id:'mote.connections',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.connections'));connectionsEntry(app,services);}},
  {descriptor:{id:'mote.system',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.system'));systemEntry(app,services);}},
  {descriptor:{id:'mote.storage',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.storage'));storageEntry(app,services,scope);}},
  {descriptor:{id:'mote.capture',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.capture'));captureEntry(app,services,scope);}},
  {descriptor:{id:'mote.context',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.context'));contextEntry(app,services);}},
  {descriptor:{id:'mote.materials',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.materials'));materialsEntry(app,services,scope);}},
  {descriptor:{id:'mote.coding',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.coding'));codingEntry(app,services);}},
  {descriptor:{id:'mote.sources',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.sources'));sourcesEntry(app,services,scope);}},
  {descriptor:{id:'mote.models',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.models'));modelsEntry(app,services);}},
  {descriptor:{id:'mote.processing',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.processing'));processingEntry(app,services,scope);}},
  {descriptor:{id:'mote.notes',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.notes'));notesEntry(app,services);}},
  {descriptor:{id:'mote.devices',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.devices'));devicesEntry(app,services);}},
  {descriptor:{id:'mote.media',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.media'));mediaEntry(app,services);}},
  {descriptor:{id:'mote.owner-questions',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services,host)=>ownerQuestionsEntry(app,services)},
  {descriptor:{id:'mote.memory',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.memory'));memoryEntry(app,services,scope);}},
  {descriptor:{id:'mote.imports',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.imports'));importsEntry(app,services,scope);}},
  {descriptor:{id:'mote.ask',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.ask'));askEntry(app,services,scope);}},
  {descriptor:{id:'mote.usage',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.usage'));usageEntry(app,services);}},
  {descriptor:{id:'mote.insights',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.insights'));insightsEntry(app,services,scope);}},
  {descriptor:{id:'mote.diagnostics',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.diagnostics'));diagnosticsEntry(app,services);}},
  {descriptor:{id:'mote.agent-view',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services)=>{scope.retire(()=>services.agentFeatures.dispose('mote.agent-view'));agentView(app,services);}},
  {descriptor:{id:'mote.features',version:'1',surface:'data',runtime:'host'},factory:(app,scope,services,host)=>{app.get('/api/features',async()=>featureInventory(host,services));}},
]);
export async function installServerFeatures(host:ServerFeatureHost,services:FeatureServices,entries:readonly ServerFeatureAdapter[]=serverFeatureAdapters){
  for(const {descriptor,factory} of entries){
    await host.install({id:descriptor.id,version:descriptor.version,components:[]},(app,scope)=>factory(app,scope,services,host));
  }
}
