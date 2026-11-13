import test from 'node:test';
import assert from 'node:assert/strict';
import {hasTimeOrDeviceScope,scopeContainsHistory} from '../src/query-scope.js';
import {selectedHistoryScope as selected,permittedHistoryScopes,deniedHistoryScopes} from './fixtures/query-scope.js';

test('history scope containment is inclusive at after and exclusive at before',()=>{
 for(const history of permittedHistoryScopes)assert.equal(scopeContainsHistory(selected,history),true,JSON.stringify(history));
 for(const history of deniedHistoryScopes)assert.equal(scopeContainsHistory(selected,history),false,JSON.stringify(history));
 assert.equal(scopeContainsHistory({after:'invalid'},selected),false);
 assert.equal(scopeContainsHistory({},selected),true);
 assert.equal(hasTimeOrDeviceScope({}),false);
 assert.equal(hasTimeOrDeviceScope({evidenceIds:[]}),false,'an evidence grant is not a device or time restriction');
 assert.equal(hasTimeOrDeviceScope({deviceId:'generated-device'}),true);
});

test('source history grants contain only explicitly selected subsets and keep empty selections empty',()=>{
 const scope={sourceIds:['generated-a','generated-b']};
 assert.equal(scopeContainsHistory(scope,{kind:'selection',sourceIds:['generated-a']}),true);
 for(const history of [{},{kind:'all' as const},{kind:'selection' as const,evidenceIds:[]},{sourceIds:['generated-hidden']},{sourceIds:['generated-a','generated-hidden']}])assert.equal(scopeContainsHistory(scope,history),false);
 assert.equal(scopeContainsHistory({sourceIds:[]},{kind:'selection',sourceIds:[]}),true);
 assert.equal(scopeContainsHistory({sourceIds:[]},{sourceIds:['generated-a']}),false);
 assert.equal(scopeContainsHistory({...scope,...selected},{sourceIds:['generated-a'],...permittedHistoryScopes[1]}),true);
 assert.equal(scopeContainsHistory({...scope,...selected},{sourceIds:['generated-a'],...deniedHistoryScopes[0]}),false);
});
