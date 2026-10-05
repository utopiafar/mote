import test from 'node:test';
import assert from 'node:assert/strict';
import {codingConversationEvidence,codingDialogueText} from '../dist/sources.js';

const human={version:1,provider:'codex',sessionId:'generated',projectKey:'generated',eventId:'generated',role:'user',attribution:'human',part:0,parts:1};

test('dialogue admission requires verified speaker and a protocol-final reply before applying the message budget',()=>{
  assert.equal(codingConversationEvidence(human,'Actual request'),true);
  assert.equal(codingConversationEvidence({...human,attribution:undefined},'Unknown speaker'),false);
  assert.equal(codingConversationEvidence({...human,role:'assistant',attribution:'agent',channel:'final'},'Formal reply'),true);
  for(const channel of ['analysis','commentary','unknown',undefined])assert.equal(codingConversationEvidence({...human,role:'assistant',attribution:'agent',channel},'Process'),false);
  assert.equal(codingConversationEvidence({...human,role:'assistant_delta',attribution:'agent',channel:'final'},'Unconfirmed delta'),false);
  assert.equal(codingConversationEvidence(human,'x'.repeat(12000)),true);
  assert.equal(codingConversationEvidence(human,'x'.repeat(12001)),false);
});

test('explicit leading host wrappers are removed without classifying the remaining human prose',()=>{
  const wrappers='# AGENTS.md instructions for /generated\n<INSTRUCTIONS>Host rules</INSTRUCTIONS>\n<environment_context>Generated environment</environment_context>\n<in-app-browser-context tab="generated">Host browser</in-app-browser-context>\n';
  assert.equal(codingDialogueText(human,wrappers+'Explain the log and tool call.'),'Explain the log and tool call.');
  assert.equal(codingDialogueText(human,'Quoted example: <environment_context>literal</environment_context>'),'Quoted example: <environment_context>literal</environment_context>');
  assert.equal(codingDialogueText(human,'<environment_context>Incomplete literal'),'<environment_context>Incomplete literal');
  assert.equal(codingDialogueText({...human,provider:'claude'},wrappers),wrappers);
});
