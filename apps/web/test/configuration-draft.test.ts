import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
import {environmentFragment,effectiveValues} from '../src/configuration-draft.js';
import {deviceState,type Device} from '../src/api.js';
import type {ServerConfiguration} from '@mote/shared';
test('deployment fragments round trip literal values without becoming extra variables or shell code',()=>{
 const changes={MOTE_MODEL:'model/custom:#$value`literal`',MOTE_MODEL_BASE_URL:'https://fixture.example/v1',MOTE_RETENTION_DAYS:'90',MOTE_EMPTY:''};
 assert.deepEqual({...parseEnv(environmentFragment(changes))},changes);
 assert.throws(()=>environmentFragment({MOTE_MODEL:'x\nMOTE_TOKEN=bad'}));
 assert.throws(()=>environmentFragment({'MOTE_MODEL\nEXTRA':'bad'}));
 assert.throws(()=>environmentFragment({MOTE_MODEL:'x\0y'}));
});
test('effective draft defaults preserve custom values, convert MiB, and never reproduce secret status as credentials',()=>{
 const config={groups:[{fields:[{envVar:'MOTE_MODEL',value:'custom-model'},{envVar:'MOTE_MAX_STORAGE_MB',value:3145728,unit:'bytes'},{envVar:'MOTE_MCP_ENABLED',value:true},{envVar:'MOTE_TOKEN',value:true,visibility:'secret-status'}]}]} as ServerConfiguration;
 assert.deepEqual(effectiveValues(config),{MOTE_MODEL:'custom-model',MOTE_MAX_STORAGE_MB:'3',MOTE_MCP_ENABLED:'1'});
});
test('stale or malformed last contact does not report that a device is currently capturing',()=>{
 const device={status:'capturing',lastSeenAt:new Date(Date.now()-3600000).toISOString()} as Device;
 assert.equal(deviceState(device),'stale');
 assert.equal(deviceState({...device,lastSeenAt:'invalid'}),'stale');
 assert.equal(deviceState({...device,lastSeenAt:new Date().toISOString()}),'capturing');
});
