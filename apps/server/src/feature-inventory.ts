import {createHash} from 'node:crypto';
import type {FeatureInventory,FeatureCapability} from '@mote/shared';
import type {ServerFeatureHost} from './feature-host.js';
import type {FeatureServices} from './feature-services.js';
/** Read actual independent runtime registries, never claim declared work executed. */
export function featureInventory(host:ServerFeatureHost,services:Pick<FeatureServices,'connectors'|'agentFeatures'|'sourcePipelines'|'processing'|'workflows'>):FeatureInventory{
  const server=host.registry.inventory(),agent=services.agentFeatures.registry.inventory();
  const processing:FeatureCapability[]=[
    ...services.sourcePipelines.registry.list().map(p=>({id:'pipeline:'+p.id,version:p.version,surface:'processing' as const,featureId:p.featureId??'mote.sources',state:'active' as const})),
    ...services.processing.runtime.registry.list().map(p=>({id:'file-processor:'+p.id,version:p.version,surface:'processing' as const,featureId:'mote.files',state:'active' as const})),
    ...services.workflows.registry.list().map(p=>({id:'context-processor:'+p.id,version:p.version,surface:'processing' as const,featureId:'mote.processing',state:'active' as const})),
  ];
  const connectors=services.connectors.inventory();
  const connectorCapabilities:FeatureCapability[]=connectors.map(c=>({id:'connector:'+c.id,featureId:'mote.connector.'+c.id,version:c.version,surface:'ingress',state:c.active?'active':'unavailable'}));
  const capabilities=[...connectorCapabilities,...server.capabilities,...agent.capabilities,...processing];
  const features=[...new Map([...server.features,...agent.features,...connectors.map(c=>({id:'mote.connector.'+c.id,version:c.version,components:[]}))].map(f=>[f.id,f])).values()].map(f=>({...f,components:capabilities.filter(c=>c.featureId===f.id).map(({featureId:_,state:_state,reason:_reason,...descriptor})=>descriptor)}));
  const revision=parseInt(createHash('sha256').update(JSON.stringify({features,capabilities})).digest('hex').slice(0,12),16);
  return {schemaVersion:1,revision,features,capabilities};
}
