import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentResponseError,parseAnswer,prepareTaskContext,systemInstructions,taskTools,SYSTEM_PROMPT} from '../dist/index.js';

const answer=(draft,extra={})=>JSON.stringify({answer:'Generated answer',citationIds:[],...(draft===undefined?{}:{draft}),...extra});
const rejects=(raw,options={draft:true})=>assert.throws(()=>parseAnswer(raw,new Map(),options),error=>error instanceof AgentResponseError&&error.reason==='invalid_shape');

test('a model draft is only a goal and is accepted only when the host opts in',()=>{
  assert.deepEqual(parseAnswer(answer({goal:'  Generated follow-up  '}),new Map(),{draft:true}).draftProposal,{goal:'Generated follow-up'});
  assert.equal(parseAnswer(answer(undefined),new Map(),{draft:true}).draftProposal,undefined);
  assert.equal(parseAnswer(answer(undefined),new Map()).draftProposal,undefined);

  rejects(answer({goal:'Generated follow-up'}),{});
  for(const draft of [null,{}, {goal:''}, {goal:'   '}, {goal:'Generated',scope:{kind:'all'}},
    {goal:'Generated',requestId:'11111111-1111-4111-8111-111111111111'}, {goal:'Generated',revision:2},
    {goal:'Generated',capability:'assistant.task.start'}, {goal:'Generated',action:'message.send'}])
    rejects(answer(draft));
});

test('the host output schema and prompt permit one optional draft without widening tools',()=>{
  assert.equal(systemInstructions({question:'Generated question'}),SYSTEM_PROMPT);
  const withDraft=systemInstructions({question:'Generated question',assistantDraft:true});
  assert.match(withDraft,/optional draft object with exactly goal/);
  assert.match(withDraft,/not a task, action, permission, request ID, revision, scope or capability/);

  const ordinary=prepareTaskContext({question:'Generated question'});
  assert.equal(ordinary.id,'answer');
  assert.equal(Object.hasOwn(ordinary.outputSchema.properties,'draft'),false);
  const draft=prepareTaskContext({question:'Generated question',assistantDraft:true});
  assert.equal(draft.id,'answer-draft');
  assert.deepEqual(draft.outputSchema.properties.draft,{type:'object',properties:{goal:{type:'string'}},required:['goal'],additionalProperties:false});
  const evidenceId='11111111-1111-4111-8111-111111111111';
  assert.equal(prepareTaskContext({question:'Generated question',evidenceIds:[evidenceId]}).id,'selected-answer');
  assert.equal(prepareTaskContext({question:'Generated question',evidenceIds:[evidenceId],assistantDraft:true}).id,'selected-answer-draft');
  assert.deepEqual(taskTools({question:'Generated question',assistantDraft:true}),taskTools({question:'Generated question'}));
  assert.equal(taskTools({question:'Generated question',assistantDraft:true}).includes('assistant_draft'),false);
});
