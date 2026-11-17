import test from 'node:test';
import assert from 'node:assert/strict';
import {configurationPatches,savedValues} from '../src/configuration-draft.js';
import {deviceState,type Device} from '../src/api.js';
import type {ServerConfiguration} from '@mote/shared';
const config={revision:7,domains:[
 {id:'storage',saved:{maxExportBytes:5242880},effective:{maxExportBytes:3145728},fields:[{path:'maxExportBytes'}]},
 {id:'connectors',saved:{syncIntervalMs:900000,mcpEnabled:false,mcpWriteSourceIds:[]},effective:{syncIntervalMs:300000,mcpEnabled:false,mcpWriteSourceIds:[]},fields:[{path:'syncIntervalMs'},{path:'mcpEnabled'},{path:'mcpWriteSourceIds'}]},
 {id:'server',saved:{token:true},effective:{token:true},fields:[{path:'token',sensitive:true}]},
]} as ServerConfiguration;
test('file editors use saved values and keep pending-restart values distinct from effective values',()=>{
 assert.deepEqual(savedValues(config),{'storage.maxExportBytes':'5','connectors.syncIntervalMs':'900','connectors.mcpEnabled':'0','connectors.mcpWriteSourceIds':''});
});
test('domain patches contain only edited fields and never echo credential status as credential values',()=>{
 assert.deepEqual(configurationPatches(config,{'storage.maxExportBytes':'9','connectors.syncIntervalMs':'1800','connectors.mcpEnabled':'1','connectors.mcpWriteSourceIds':'generated-a, generated-b'}),[
  {id:'storage',value:{maxExportBytes:9*1048576}},
  {id:'connectors',value:{syncIntervalMs:1800000,mcpEnabled:true,mcpWriteSourceIds:['generated-a','generated-b']}}
 ]);
 assert.throws(()=>configurationPatches(config,{'server.token':'true'}));
 assert.throws(()=>configurationPatches(config,{unregistered:'generated'}));
 assert.throws(()=>configurationPatches(config,{'storage.maxExportBytes':'not-a-number'}));
 assert.equal((config.domains[0].saved as {maxExportBytes:number}).maxExportBytes,5242880);
});
test('stale or malformed last contact does not report that a device is currently capturing',()=>{
 const device={status:'capturing',lastSeenAt:new Date(Date.now()-3600000).toISOString()} as Device;
 assert.equal(deviceState(device),'stale');
 assert.equal(deviceState({...device,lastSeenAt:'invalid'}),'stale');
 assert.equal(deviceState({...device,lastSeenAt:new Date().toISOString()}),'capturing');
});
