import assert from 'node:assert/strict';
import {test} from 'node:test';
import {officialPluginCatalog} from '../src/official-plugin-catalog.js';
import {sourceCapabilities} from '@mote/shared';

test('local meeting recording is a host source kind, never an installable official package', () => {
  assert.ok(sourceCapabilities.has('local-meeting-recording'));
  const catalog = officialPluginCatalog();
  assert.equal(catalog.some(entry => /meeting|录音/i.test(entry.packageId ?? '') || /meeting|会议录音/i.test(entry.name)), false);
  assert.equal(catalog.some(entry => entry.group === 'connectors' && /meeting/i.test(entry.description)), false);
});
