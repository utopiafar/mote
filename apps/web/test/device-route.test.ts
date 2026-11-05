import '@mote/shared/i18n-all';
import test from 'node:test';
import assert from 'node:assert/strict';
import {featuresReady} from '../src/features/bootstrap.js';
import {webFeatures} from '../src/features/registry.js';
import {readPage} from '../src/navigation.js';
import {readWorkspaceRoute} from '../src/workspace-route.js';
import {devicePageRoute,redirectDeviceRoute} from '../src/device-route.js';

test('采集与设备 registers under 来源 and the retired route redirects to the same page',async()=>{
 await featuresReady;
 const pages=webFeatures.pages().filter(entry=>entry.id==='devices');
 assert.equal(pages.length,1,'one device page owns the workspace');
 assert.equal(pages[0].route,devicePageRoute);
 assert.equal(devicePageRoute,'sources/devices');
 assert.equal(readPage('#/sources/devices'),'devices');
 assert.equal(readPage('#/connections/devices'),'devices','a saved old URL still opens the device workspace');
 assert.equal(redirectDeviceRoute('#/connections/devices'),'#/sources/devices');
 assert.equal(redirectDeviceRoute('#/connections/devices?deviceId=generated-device'),'#/sources/devices?deviceId=generated-device');
 assert.equal(redirectDeviceRoute('#/sources/devices?deviceId=generated-device'),undefined,'the current route never redirects again');
 assert.equal(readWorkspaceRoute('#/connections/devices?deviceId=generated-device',readPage,[],undefined).page,'devices');
});
