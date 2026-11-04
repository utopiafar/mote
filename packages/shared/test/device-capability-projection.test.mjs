import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceCapabilityProjectionSchema,projectDeviceCapability} from '../dist/action-capabilities.js';

const declaration=(patch={})=>({deviceId:'generated-device',revision:1,connectionActive:true,permission:'granted',calendars:[{id:'generated-calendar'}],...patch});
const grant=(patch={})=>({state:'active',authorized:true,target:{deviceId:'generated-device'},...patch});

test('installation, live device grant, owner authorization and waiting-device stay independent',()=>{
 const installed=projectDeviceCapability({id:'calendar.manage',version:1,installed:true,declarations:[declaration()],grants:[]});
 assert.deepEqual(installed,deviceCapabilityProjectionSchema.parse(installed));
 assert.equal(installed.installed,true);assert.equal(installed.grant,'granted');assert.equal(installed.available,true);assert.equal(installed.authorized,false);assert.equal(installed.waitingDevice,false);
 const waiting=projectDeviceCapability({id:'calendar.manage',version:1,installed:true,declarations:[declaration({connectionActive:false})],grants:[grant()]});
 assert.equal(waiting.installed,true);assert.equal(waiting.grant,'unavailable');assert.equal(waiting.available,false);assert.equal(waiting.authorized,true,'an owner grant survives while the device is absent');assert.equal(waiting.waitingDevice,true);
 const missing=projectDeviceCapability({id:'calendar.manage',version:1,installed:false,declarations:[],grants:[grant()]});
 assert.equal(missing.installed,false);assert.equal(missing.waitingDevice,false,'an uninstalled capability is never waiting for a device');
 const connectedWithoutPermission=projectDeviceCapability({id:'calendar.manage',version:1,installed:true,declarations:[declaration({permission:'required',calendars:[]})],grants:[]});
 assert.equal(connectedWithoutPermission.grant,'required');assert.equal(connectedWithoutPermission.available,false);assert.equal(connectedWithoutPermission.waitingDevice,false,'a connected device with a withdrawn grant is not waiting for a device');
});

test('per-device facts do not borrow another device authorization',()=>{
 const projection=projectDeviceCapability({id:'calendar.manage',version:1,installed:true,
  declarations:[declaration({deviceId:'generated-a',revision:2}),declaration({deviceId:'generated-b',revision:1,connectionActive:false})],
  grants:[grant({target:{deviceId:'generated-a'}})]});
 assert.deepEqual(projection.devices.map(({deviceId,available,authorized,waitingDevice})=>({deviceId,available,authorized,waitingDevice})),[
  {deviceId:'generated-a',available:true,authorized:true,waitingDevice:false},
  {deviceId:'generated-b',available:false,authorized:false,waitingDevice:true},
 ]);
 assert.equal(projection.authorized,true);
 assert.throws(()=>deviceCapabilityProjectionSchema.parse({...projection,devices:[{...projection.devices[0],available:'yes'}]}));
});
