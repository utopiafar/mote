import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureSessions} from '../dist/capture-sessions.js';
const sample=(id,ms,appId='a',deviceId='one')=>({id,deviceId,appId,appName:appId,capturedAt:new Date(Date.UTC(2026,8,16)+ms).toISOString(),hasImage:true});
test('observed continuity splits switches, missing identities and gaps without merging devices or clock buckets',()=>{
  const rows=[sample('1',899000),sample('2',900000),sample('3',1200000),sample('4',1500001),sample('5',1500002,'b'),sample('6',1500003),sample('7',900000,'a','two'),sample('8',1600000,''),sample('9',1600001,'')];
  const sessions=captureSessions(rows.reverse());
  assert.equal(sessions.length,7);assert.equal(sessions.find(s=>s.id==='1').count,3);
  assert.equal(sessions.find(s=>s.id==='1').firstAt,sample('1',899000).capturedAt);
  assert.equal(sessions.find(s=>s.id==='6').count,1);
  assert.equal(sessions.find(s=>s.id==='7').deviceId,'two');
});
test('ties are deterministic and metadata-only samples remain visible',()=>{
  const rows=[sample('c',0),sample('b',0,'b'),{...sample('a',0),hasImage:false}];
  const sessions=captureSessions(rows);assert.deepEqual(sessions.map(s=>s.id),['a','b','c']);assert.equal(sessions[0].imageCount,0);
  assert.throws(()=>captureSessions([{...rows[0],capturedAt:'invalid'}]),/Invalid/);
});
