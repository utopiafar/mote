import {createHash} from 'node:crypto';
import type {FeatureCapability,FeatureInventory,FeatureManifest,FeatureRequirement} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginSnapshot} from '@mote/plugin-api/contracts';

export type HostContributionDescriptor=ManifestContribution&{readonly featureVersion:string};

function requirements(contribution:ManifestContribution):FeatureRequirement[]{
  return (contribution.requires??[]).filter(dependency=>dependency.kind==='contribution'&&dependency.required!==false).map(({id,version})=>({id,version}));
}

/** Project the selected package metadata through the common host's live state.
 * Revision is a content digest for consumers, never a command CAS revision. */
export function featureInventory(snapshot:PluginSnapshot,contributions:readonly HostContributionDescriptor[]):FeatureInventory{
  const descriptors=new Map<string,HostContributionDescriptor>();
  for(const descriptor of contributions){
    if(descriptors.has(descriptor.id))throw new Error('Ambiguous host inventory descriptor: '+descriptor.id);
    descriptors.set(descriptor.id,descriptor);
  }
  const capabilities:FeatureCapability[]=[],capabilityIds=new Set<string>(),featureVersions=new Map<string,string>();
  for(const contribution of snapshot.contributions){
    const id=contribution.identity.contributionId,descriptor=descriptors.get(id);
    if(!descriptor)throw new Error('Unknown host inventory contribution: '+id);
    if(capabilityIds.has(id))throw new Error('Ambiguous host inventory contribution: '+id);
    capabilityIds.add(id);
    const featureId=contribution.identity.scope.packageId,version=featureVersions.get(featureId);
    if(version!==undefined&&version!==descriptor.featureVersion)throw new Error('Conflicting feature version for '+featureId);
    featureVersions.set(featureId,descriptor.featureVersion);
    const requires=requirements(descriptor),active=contribution.availability.state==='active';
    capabilities.push({
      id,version:descriptor.version,surface:descriptor.surface,featureId,
      ...(requires.length?{requires}:{}),state:active?'active':'unavailable',
      ...(active?{}:{reason:contribution.availability.reason}),
    });
  }
  const features:FeatureManifest[]=[...featureVersions].map(([id,version])=>({
    id,version,components:capabilities.filter(capability=>capability.featureId===id).map(({featureId:_,state:_state,reason:_reason,...descriptor})=>descriptor),
  }));
  const revision=parseInt(createHash('sha256').update(JSON.stringify({features,capabilities})).digest('hex').slice(0,12),16);
  return {schemaVersion:1,revision,features,capabilities};
}
