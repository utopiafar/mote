import {readFile, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {packageManifestSchema} from '@mote/plugin-sdk';

/** Load a private plugin-dev package through its Manifest. The package is the
 * only executable input: `plugin-dev` validates it before starting the private
 * profile, and this loader maps declared ingress/processing contributions to
 * the trusted assembly seams. Production Central never calls it. */
export async function loadDevPluginPackage(directory, {schema = packageManifestSchema} = {}) {
  const root = resolve(directory);
  const manifest = schema.parse(JSON.parse(await readFile(join(root, 'mote-plugin.json'), 'utf8')));
  const modules = new Map();
  const load = async path => {
    if (!modules.has(path)) {
      await stat(path).catch(() => { throw Error(`Plugin package entry is missing: ${path}`); });
      modules.set(path, await import(pathToFileURL(path).href));
    }
    return modules.get(path);
  };
  const connectorManifests = [], processingPlugins = [];
  for (const contribution of manifest.contributions ?? []) {
    if (contribution.surface !== 'ingress' && contribution.surface !== 'processing') continue;
    const module = await load(join(root, contribution.entry ?? manifest.entry));
    if (contribution.surface === 'ingress') {
      const connector = module.connector ?? module.default;
      if (!connector) throw Error(`Plugin package ingress contribution ${contribution.id} has no connector export`);
      connectorManifests.push(connector);
    } else {
      const plugin = module.backendPlugin ?? module.default;
      if (!plugin) throw Error(`Plugin package processing contribution ${contribution.id} has no backend plugin export`);
      processingPlugins.push(plugin);
    }
  }
  if (!connectorManifests.length && !processingPlugins.length)
    throw Error('Plugin package has no ingress or processing contribution for plugin-dev; worker packages install through the plugin center');
  return {manifest, connectorManifests, processingPlugins};
}
