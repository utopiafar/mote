import test from 'node:test';
import assert from 'node:assert/strict';
import {codexReasoningChoices} from '../src/model-reasoning';

test('Codex choices follow the selected model catalog and preserve legacy off as none',()=>{
  const first=codexReasoningChoices({id:'first',name:'First',defaultReasoningEffort:'medium',reasoningEfforts:['none','low','medium','xhigh','max']});
  assert.deepEqual(first.options.map(option=>[option.value,option.wire]),[['off','none'],['low','low'],['medium','medium'],['xhigh','xhigh'],['max','max']]);
  assert.equal(first.known,true);
  const second=codexReasoningChoices({id:'second',name:'Second',reasoningEfforts:['low','ultra']});
  assert.deepEqual(second.options.map(option=>option.value),['low','ultra']);
  assert.deepEqual(codexReasoningChoices(undefined),{options:[],known:false,unknown:[]});
});
