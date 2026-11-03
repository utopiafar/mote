import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PluginHost} from '@mote/plugin-sdk/node';
import {createPlugin, manifest} from '../plugin.mjs';
import {collectionPort, COLLECTION_PORT_ID} from '../port.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

const hostIdentity = {kind: 'central', id: 'generated-template-collection-host'};
const identity = activationId => ({
  host: hostIdentity,
  packageId: 'template.collection',
  installationId: 'generated-template-collection-installation',
  instanceId: 'generated-template-collection-instance',
  activationId,
});

async function install(host, activationId) {
  const scope = identity(activationId);
  await host.install({
    identity: scope,
    contributions: [{id: 'template-collection.port', apiVersion: collectionPort.apiVersion}],
    factory: createPlugin,
  });
  const binding = {
    service: {id: collectionPort.id, apiVersion: collectionPort.apiVersion},
    provider: {scope, contributionId: 'template-collection.port'},
    revision: 0,
  };
  return host.acquire(collectionPort, binding);
}

test('the public SDK host installs the package and serves the typed port from ctx.state', async () => {
  const state = createFixtureStateStore();
  const host = new PluginHost(hostIdentity, undefined, undefined, {stateFor: () => state});
  const lease = await install(host, randomUUID());
  assert.equal(manifest.id, 'template.collection');
  assert.equal(COLLECTION_PORT_ID, 'template.collection.log');
  assert.equal(lease.binding.service.id, COLLECTION_PORT_ID);

  const added = await lease.value.add({text: 'Generated via lease'});
  assert.equal(added.text, 'Generated via lease');
  assert.equal((await lease.value.summary()).items, 1);
  await host.close();
});
