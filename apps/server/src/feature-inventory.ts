import {createHash} from 'node:crypto';
import type {FeatureInventory,FeatureCapability,FeatureManifest} from '@mote/shared';
import type {PluginSnapshot} from '@mote/plugin-api/contracts';
import type {ServerFeatureHost} from './feature-host.js';
import type {FeatureServices} from './feature-services.js';

/** The common PluginHost snapshot supplies actual availability; the existing
 * FeatureManifest supplies the trusted surface/feature grouping it omits. */
export interface HostInventoryProjection {
  readonly snapshot: PluginSnapshot;
  readonly manifests: readonly FeatureManifest[];
}

/** Inputs from the actual host registry and the existing domain ports. This is
 * one projection, not a second inventory authority; revision is a content
 * digest for consumers and never a command CAS revision. */
export interface FeatureInventoryParts {
  server: FeatureInventory;
  agent: FeatureInventory;
  connectors: readonly {id: string; version: string; active: boolean}[];
  pipelines: readonly FeatureCapability[];
  processing: readonly FeatureCapability[];
  workflows: readonly FeatureCapability[];
  host?: HostInventoryProjection;
}

export function projectFeatureInventory(parts: FeatureInventoryParts): FeatureInventory {
  const connectorCapabilities: FeatureCapability[] = parts.connectors.map(c => ({
    id: 'connector:' + c.id, featureId: 'mote.connector.' + c.id, version: c.version, surface: 'ingress', state: c.active ? 'active' : 'unavailable',
  }));
  const hostCapabilities: FeatureCapability[] = [];
  const hostFeatures: FeatureManifest[] = [];
  for (const manifest of parts.host?.manifests ?? []) {
    const components: FeatureManifest['components'][number][] = [];
    for (const component of manifest.components) {
      const contribution = parts.host?.snapshot.contributions.find(value => value.identity.contributionId === component.id);
      const availability = contribution?.availability;
      const active = availability?.state === 'active';
      hostCapabilities.push({
        ...component, featureId: manifest.id,
        state: active ? 'active' : 'unavailable',
        ...(active ? {} : {reason: availability ? availability.reason : 'dependency_unavailable'}),
      });
      components.push(component);
    }
    if (components.length) hostFeatures.push({id: manifest.id, version: manifest.version, components});
  }
  const capabilities = [
    ...connectorCapabilities,
    ...parts.server.capabilities,
    ...parts.agent.capabilities,
    ...parts.pipelines,
    ...parts.processing,
    ...parts.workflows,
    ...hostCapabilities,
  ];
  const features: FeatureManifest[] = [...new Map([
    ...parts.server.features,
    ...parts.agent.features,
    ...parts.connectors.map(c => ({id: 'mote.connector.' + c.id, version: c.version, components: []})),
    ...hostFeatures,
  ].map(f => [f.id, f])).values()].map(f => ({
    ...f,
    components: capabilities.filter(c => c.featureId === f.id).map(({featureId: _, state: _state, reason: _reason, ...descriptor}) => descriptor),
  }));
  const revision = parseInt(createHash('sha256').update(JSON.stringify({features, capabilities})).digest('hex').slice(0, 12), 16);
  return {schemaVersion: 1, revision, features, capabilities};
}

/** Read actual independent runtime registries, never claim declared work executed. */
export function featureInventory(host: ServerFeatureHost, services: Pick<FeatureServices, 'connectors' | 'agentFeatures' | 'sourcePipelines' | 'processing' | 'workflows'>, hostProjection?: HostInventoryProjection): FeatureInventory {
  const pipelines: FeatureCapability[] = services.sourcePipelines.registry.list().map(p => {
    let available = true;
    try { if (p.recipe) services.sourcePipelines.recipes.resolve(p.recipe.id, p.recipe.version); } catch { available = false; }
    return {id: 'pipeline:' + p.id, version: p.version, surface: 'processing' as const, featureId: p.featureId ?? 'mote.sources', state: available ? 'active' as const : 'unavailable' as const, ...(!available ? {reason: 'recipe_unavailable'} : {})};
  });
  const processing: FeatureCapability[] = services.processing.runtime.registry.list().map(p => ({id: 'file-processor:' + p.id, version: p.version, surface: 'processing' as const, featureId: 'mote.files', state: 'active' as const}));
  const workflows: FeatureCapability[] = services.workflows.registry.list().map(p => ({id: 'context-processor:' + p.id, version: p.version, surface: 'processing' as const, featureId: 'mote.processing', state: 'active' as const}));
  return projectFeatureInventory({
    server: host.registry.inventory(),
    agent: services.agentFeatures.registry.inventory(),
    connectors: services.connectors.inventory(),
    pipelines,
    processing,
    workflows,
    ...(hostProjection ? {host: hostProjection} : {}),
  });
}
