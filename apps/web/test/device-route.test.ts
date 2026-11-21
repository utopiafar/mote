import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import {featuresReady} from '../src/features/bootstrap.js';
import {webFeatures} from '../src/features/registry.js';
import {readPage} from '../src/navigation.js';
import {readWorkspaceRoute} from '../src/workspace-route.js';
import {devicePageRoute,redirectDeviceRoute} from '../src/device-route.js';

test('the retired device page has no workspace page and its saved redirect lands on the unavailable page',async()=>{
 await featuresReady;
 assert.equal(webFeatures.pages().filter(entry=>entry.id==='devices').length,0,'device settings live in the Library source bar');
 assert.equal(devicePageRoute,'sources/devices');
 assert.equal(readPage('#/sources/devices'),'unavailable');
 assert.equal(readPage('#/connections/devices'),'unavailable','a saved old URL no longer opens a device workspace');
 assert.equal(redirectDeviceRoute('#/connections/devices'),'#/sources/devices');
 assert.equal(redirectDeviceRoute('#/connections/devices?deviceId=generated-device'),'#/sources/devices?deviceId=generated-device');
 assert.equal(redirectDeviceRoute('#/sources/devices?deviceId=generated-device'),undefined,'the current route never redirects again');
 assert.equal(readWorkspaceRoute('#/connections/devices?deviceId=generated-device',readPage,[],undefined).page,'unavailable');
});
