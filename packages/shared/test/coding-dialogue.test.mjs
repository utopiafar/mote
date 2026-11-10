import test from 'node:test';
import assert from 'node:assert/strict';
import {codingConversationEvidence,codingDialogueText,sourceItemSchema} from '../dist/sources.js';

const human={version:1,provider:'codex',sessionId:'generated',projectKey:'generated',eventId:'generated',role:'user',attribution:'human',part:0,parts:1};

test('dialogue admission requires verified speaker and a protocol-final reply without a message-length budget',()=>{
  assert.equal(codingConversationEvidence(human,'Actual request'),true);
  assert.equal(codingConversationEvidence({...human,attribution:undefined},'Unknown speaker'),false);
  assert.equal(codingConversationEvidence({...human,role:'assistant',attribution:'agent',channel:'final'},'Formal reply'),true);
  for(const channel of ['analysis','commentary','unknown',undefined])assert.equal(codingConversationEvidence({...human,role:'assistant',attribution:'agent',channel},'Process'),false);
  assert.equal(codingConversationEvidence({...human,role:'assistant_delta',attribution:'agent',channel:'final'},'Unconfirmed delta'),false);
  assert.equal(codingConversationEvidence(human,'x'.repeat(12000)),true);
  assert.equal(codingConversationEvidence(human,'x'.repeat(12001)),true);
  assert.equal(codingConversationEvidence(human,'x'.repeat(1_000_000)),true);
});

test('source items accept long bodies and titles while HTTP request limits remain the byte boundary',()=>{
  const text='x'.repeat(150_000),title='Generated '.repeat(500),item={externalId:'generated-long',revision:'1',observedAt:'2026-09-24T01:00:00.000Z',title,text,kind:'message',layer:'original'};
  const parsed=sourceItemSchema.parse(item);
  assert.equal(parsed.text.length,text.length);assert.equal(parsed.title.length,title.length);
});

test('explicit leading host wrappers are removed without classifying the remaining human prose',()=>{
  const wrappers='# AGENTS.md instructions for /generated\n<INSTRUCTIONS>Host rules</INSTRUCTIONS>\n<environment_context>Generated environment</environment_context>\n<in-app-browser-context tab="generated">Host browser</in-app-browser-context>\n';
  assert.equal(codingDialogueText(human,wrappers+'Explain the log and tool call.'),'Explain the log and tool call.');
  assert.equal(codingDialogueText(human,'Quoted example: <environment_context>literal</environment_context>'),'Quoted example: <environment_context>literal</environment_context>');
  assert.equal(codingDialogueText(human,'<environment_context>Incomplete literal'),'<environment_context>Incomplete literal');
  assert.equal(codingDialogueText({...human,provider:'claude'},wrappers),wrappers);
});
