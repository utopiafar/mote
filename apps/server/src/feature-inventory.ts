import {createHash} from 'node:crypto';
import type {FeatureCapability,FeatureComponent,FeatureInventory,FeatureManifest,FeatureRequirement} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginSnapshot} from '@mote/plugin-api/contracts';

/** One live capability owned by a host contribution. Route, upload, command
 * and connector capabilities carry the availability their owning host reports;
 * a common-host contribution instead follows the PluginHost snapshot. */
export type HostCapabilityDescriptor=FeatureComponent&{readonly state?:'active'|'unavailable';readonly reason?:string};

/** Contribution metadata selected by trusted assembly plus the capabilities the
 * contribution actually projects. `state` is only used for contributions that
 * are not installed in the common PluginHost (for example the HTTP feature
 * host, Agent read tools and connector instances); installed contributions
 * always follow the host snapshot. `self` includes the contribution's own
 * descriptor as a capability; component-only projections set it false. */
export type HostContributionDescriptor=ManifestContribution&{
  readonly featureId?:string;
  readonly featureVersion:string;
  readonly components?:readonly HostCapabilityDescriptor[];
  readonly state?:'active'|'unavailable';
  readonly reason?:string;
  readonly self?:boolean;
};

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
  const add=(descriptor:HostContributionDescriptor,active:boolean,reason:string|undefined,component?:HostCapabilityDescriptor)=>{
    const id=component?.id??descriptor.id;
    if(capabilityIds.has(id))throw new Error('Ambiguous host inventory contribution: '+id);
    capabilityIds.add(id);
    const featureId=descriptor.featureId??descriptor.id;
    const version=featureVersions.get(featureId);
    if(version!==undefined&&version!==descriptor.featureVersion)throw new Error('Conflicting feature version for '+featureId);
    featureVersions.set(featureId,descriptor.featureVersion);
    const requires=component?.requires??requirements(descriptor);
    capabilities.push({
      id,version:component?.version??descriptor.version,surface:component?.surface??descriptor.surface,featureId,
      ...(requires.length?{requires}:{}),state:active?'active':'unavailable',
      ...(active?{}:{reason:component?.reason??reason??'dependency_unavailable'}),
    });
  };
  const installed=new Set(snapshot.contributions.map(contribution=>contribution.identity.contributionId));
  for(const contribution of snapshot.contributions){
    const id=contribution.identity.contributionId,descriptor=descriptors.get(id);
    if(!descriptor)throw new Error('Unknown host inventory contribution: '+id);
    const availability=contribution.availability,active=availability.state==='active',reason=active?undefined:availability.reason;
    const featureId=contribution.identity.scope.packageId;
    const featureDescriptor=descriptor.featureId===undefined?{...descriptor,featureId}:descriptor;
    if(descriptor.self!==false)add(featureDescriptor,active,reason);
    for(const component of descriptor.components??[])add(featureDescriptor,active,reason,component);
  }
  // Contributions owned by another live host still project their real
  // capabilities through this single inventory; they are not a second package
  // authority and never replace an installed common-host contribution.
  for(const descriptor of descriptors.values()){
    if(installed.has(descriptor.id)||descriptor.state===undefined)continue;
    const active=descriptor.state==='active';
    if(descriptor.self!==false)add(descriptor,active,descriptor.reason);
    for(const component of descriptor.components??[])add(descriptor,active,descriptor.reason,component);
  }
  const features:FeatureManifest[]=[...featureVersions].map(([id,version])=>({
    id,version,components:capabilities.filter(capability=>capability.featureId===id).map(({featureId:_,state:_state,reason:_reason,...descriptor})=>descriptor),
  }));
  const revision=parseInt(createHash('sha256').update(JSON.stringify({features,capabilities})).digest('hex').slice(0,12),16);
  return {schemaVersion:1,revision,features,capabilities};
}
