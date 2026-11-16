import test from 'node:test';
import assert from 'node:assert/strict';
import {configurationPatches,savedValues} from '../src/configuration-draft.js';
import {deviceState,type Device} from '../src/api.js';
import type {ServerConfiguration} from '@mote/shared';
const config={revision:7,groups:[{fields:[
 {key:'maxExportBytes',domain:'storage',path:'maxExportBytes',value:3145728,savedValue:5242880,unit:'bytes'},
 {key:'connectorSyncInterval',domain:'connectors',path:'syncIntervalMs',value:300,savedValue:900},
 {key:'mcpEnabled',domain:'connectors',path:'mcpEnabled',value:false},
 {key:'mcpWriteSourceIds',domain:'connectors',path:'mcpWriteSourceIds',value:[]},
 {key:'apiKey',domain:'server',path:'embeddingApiKey',value:true,visibility:'secret-status'}
]}]} as ServerConfiguration;
test('file editors use saved values and keep pending-restart values distinct from effective values',()=>{
 assert.deepEqual(savedValues(config),{maxExportBytes:'5',connectorSyncInterval:'900',mcpEnabled:'0',mcpWriteSourceIds:''});
});
test('domain patches contain only edited fields and never echo credential status as credential values',()=>{
 assert.deepEqual(configurationPatches(config,{maxExportBytes:'9',connectorSyncInterval:'1800',mcpEnabled:'1',mcpWriteSourceIds:'generated-a, generated-b'}),[
  {id:'storage',value:{maxExportBytes:9*1048576}},
  {id:'connectors',value:{syncIntervalMs:1800000,mcpEnabled:true,mcpWriteSourceIds:['generated-a','generated-b']}}
 ]);
 assert.throws(()=>configurationPatches(config,{apiKey:'true'}));
 assert.throws(()=>configurationPatches(config,{unregistered:'generated'}));
 assert.throws(()=>configurationPatches(config,{maxExportBytes:'not-a-number'}));
 assert.equal(config.groups[0].fields[0].savedValue,5242880);
});
test('stale or malformed last contact does not report that a device is currently capturing',()=>{
 const device={status:'capturing',lastSeenAt:new Date(Date.now()-3600000).toISOString()} as Device;
 assert.equal(deviceState(device),'stale');
 assert.equal(deviceState({...device,lastSeenAt:'invalid'}),'stale');
 assert.equal(deviceState({...device,lastSeenAt:new Date().toISOString()}),'capturing');
});
