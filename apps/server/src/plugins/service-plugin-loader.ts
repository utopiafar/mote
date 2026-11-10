import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import type {PluginManifest} from '../plugin-release.js';
import type {ConnectorManifest} from '../connectors/registry.js';
import {StoreError} from '../store.js';

/** Load a trusted installed service package entry. Official packages have host
 * privileges; the installer never runs npm/shell lifecycle scripts. */
export async function loadServicePackageModule(directory: string, manifest: PluginManifest) {
  const entry = join(directory, manifest.entry);
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new StoreError(`Failed to load service package entry: ${error instanceof Error ? error.message : 'unknown'}`, 422);
  }
}

export function connectorFromModule(module: Record<string, unknown>, contributionId?: string): ConnectorManifest {
  const connector = (module.connector ?? module.default) as ConnectorManifest | undefined;
  if (!connector || typeof connector !== 'object' || connector.apiVersion !== 1 || typeof connector.id !== 'string' || typeof connector.create !== 'function') {
    throw new StoreError(contributionId
      ? `Ingress contribution ${contributionId} has no connector export`
      : 'Service package has no connector export', 422);
  }
  return connector;
}

/** An outbound package declares presentation choices only. The Central host
 * still owns the export cursor, target sandbox, sensitive filtering and all
 * conflict decisions; this descriptor never contains a path to write. */
export type OutboundExportDescriptor = {
  apiVersion: 1;
  id: string;
  format: {extension: 'md'; frontmatter: 'yaml' | 'none'; folder: string};
};
export const isOutboundExportCapability = (id: string) => id === 'outbound.export' || id.startsWith('outbound.');
export function outboundExportFromModule(module: Record<string, unknown>): OutboundExportDescriptor {
  const value = (module.outboundExport ?? module.default) as Partial<OutboundExportDescriptor> | undefined;
  const format = value?.format;
  if (!value || value.apiVersion !== 1 || typeof value.id !== 'string' || !/^[a-z][a-z0-9.-]{2,127}$/.test(value.id)
    || !format || format.extension !== 'md' || !['yaml', 'none'].includes(format.frontmatter)
    || typeof format.folder !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(format.folder) || format.folder.includes('..'))
    throw new StoreError('Outbound export contribution has no valid host contract', 422);
  return Object.freeze({apiVersion: 1, id: value.id, format: Object.freeze({extension: 'md', frontmatter: format.frontmatter, folder: format.folder})});
}

/** Surfaces this Central host can activate for service-runtime packages. */
export function servicePackageSurfaces(manifest: PluginManifest) {
  const surfaces = new Set((manifest.contributions ?? []).map(contribution => contribution.surface));
  return {
    ingress: surfaces.has('ingress'),
    processing: surfaces.has('processing'),
  };
}

export function assertServicePackageSupported(manifest: PluginManifest) {
  if (manifest.runtime !== 'service') return;
  const surfaces = servicePackageSurfaces(manifest);
  if (!surfaces.ingress && !surfaces.processing) {
    throw new StoreError('This release requires a service runtime that this host does not provide', 422);
  }
}
