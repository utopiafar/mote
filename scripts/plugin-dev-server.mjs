#!/usr/bin/env node
/** Private plugin-dev host entry. It starts the real Central app with the
 * package's declared ingress/processing contributions as trusted assembly
 * inputs; no configuration code-module list is written or read. */
import {startServer} from '../apps/server/dist/index.js';
import {loadDevPluginPackage} from './plugin-dev-package.mjs';

try {
  const directory = process.env.MOTE_DEV_PLUGIN_PACKAGE;
  if (!directory) throw Error('MOTE_DEV_PLUGIN_PACKAGE is required');
  const loaded = await loadDevPluginPackage(directory);
  await startServer({dependencies: {connectorManifests: loaded.connectorManifests, processingPlugins: loaded.processingPlugins}});
} catch (error) {
  console.error(JSON.stringify({event: 'server.start_failed', category: 'startup'}));
  process.exitCode = 1;
}
