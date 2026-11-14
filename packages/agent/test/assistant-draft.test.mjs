import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentResponseError,parseAnswer,prepareTaskContext,systemInstructions,taskTools,SYSTEM_PROMPT} from '../dist/index.js';

const answer=(draft,extra={})=>JSON.stringify({answer:'Generated answer',citationIds:[],...(draft===undefined?{}:{draft}),...extra});
const rejects=(raw,options={draft:true})=>assert.throws(()=>parseAnswer(raw,new Map(),options),error=>error instanceof AgentResponseError&&error.reason==='invalid_shape');

test('a model draft is only a goal and is accepted only when the host opts in',()=>{
  assert.deepEqual(parseAnswer(answer({goal:'  Generated follow-up  '}),new Map(),{draft:true}).draftProposal,{goal:'Generated follow-up'});
  assert.equal(parseAnswer(answer(undefined),new Map(),{draft:true}).draftProposal,undefined);
  assert.equal(parseAnswer(answer(null),new Map(),{draft:true}).draftProposal,undefined);
  assert.equal(parseAnswer(answer(undefined),new Map()).draftProposal,undefined);

  rejects(answer({goal:'Generated follow-up'}),{});
  rejects(answer(null),{});
  for(const draft of [{}, {goal:''}, {goal:'   '}, {goal:'Generated',scope:{kind:'all'}},
    {goal:'Generated',requestId:'11111111-1111-4111-8111-111111111111'}, {goal:'Generated',revision:2},
    {goal:'Generated',capability:'assistant.task.start'}, {goal:'Generated',action:'message.send'}])
    rejects(answer(draft));
});

test('the strict host output schema permits a nullable goal-only draft without widening tools',()=>{
  assert.equal(systemInstructions({question:'Generated question'}),SYSTEM_PROMPT);
  const withDraft=systemInstructions({question:'Generated question',assistantDraft:true});
  assert.match(withDraft,/requires draft: null or one object with exactly goal/);
  assert.match(withDraft,/Set draft to null when no concrete work is warranted/);
  assert.match(withDraft,/not a task, action, permission, request ID, revision, scope or capability/);

  const ordinary=prepareTaskContext({question:'Generated question'});
  assert.equal(ordinary.id,'answer');
  assert.equal(Object.hasOwn(ordinary.outputSchema.properties,'draft'),false);
  const draft=prepareTaskContext({question:'Generated question',assistantDraft:true});
  assert.equal(draft.id,'answer-draft');
  assert.deepEqual(draft.outputSchema.properties.draft,{type:['object','null'],properties:{goal:{type:'string'}},required:['goal'],additionalProperties:false});
  assert.deepEqual(new Set(draft.outputSchema.required),new Set(Object.keys(draft.outputSchema.properties)));
  const evidenceId='11111111-1111-4111-8111-111111111111';
  assert.equal(prepareTaskContext({question:'Generated question',evidenceIds:[evidenceId]}).id,'selected-answer');
  assert.equal(prepareTaskContext({question:'Generated question',evidenceIds:[evidenceId],assistantDraft:true}).id,'selected-answer-draft');
  assert.deepEqual(taskTools({question:'Generated question',assistantDraft:true}),taskTools({question:'Generated question'}));
  assert.equal(taskTools({question:'Generated question',assistantDraft:true}).includes('assistant_draft'),false);
});
