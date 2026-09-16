import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {UsageGroups,TurnUsage} from '../src/Usage.js';
import type {UsageGroup,UsageReceipt} from '@mote/shared';
test('usage groups show unknown measurements distinctly from free usage and retain failure context',()=>{
  const group:UsageGroup={id:'fixture',label:'生成的 Agent',filter:{agentId:'fixture'},runs:2,completed:0,failed:1,running:1,successRate:0,averageDurationMs:1000,p95DurationMs:1000,requests:3,reportedRequests:1,inputTokens:100,outputTokens:10,totalTokens:110,cacheReadTokens:0,cacheHitRate:null,unknownUsage:1,unknownCache:2,unpriced:1,costs:{USD:0,CNY:null}};
  const html=renderToStaticMarkup(React.createElement(UsageGroups,{groups:[group],totalTokens:110,onSelect:()=>{}}));
  assert.match(html,/生成的 Agent/);assert.match(html,/100.0%/);assert.match(html,/0.0%/);assert.match(html,/US\$0.00/);assert.match(html,/未估算/);assert.match(html,/1 次用量不完整/);assert.match(html,/2 次未上报/);assert.match(html,/1 进行中 · 1 失败/);
});
test('turn receipts expose explicit attribution and label untagged history without guessing from operation',()=>{
  const receipt:UsageReceipt={id:'fixture',provider:'fixture',model:'model',operation:'personal-insight',createdAt:'2026-09-16T00:00:00Z',durationMs:0,status:'completed',estimatedCost:null,currency:'USD'};
  const legacy=renderToStaticMarkup(React.createElement(TurnUsage,{usage:receipt}));assert.match(legacy,/历史未标记/);assert.doesNotMatch(legacy,/个人洞察/);
  const tagged=renderToStaticMarkup(React.createElement(TurnUsage,{usage:{...receipt,attribution:{agentId:'context-query',moduleId:'conversations',skillId:null}}}));assert.match(tagged,/上下文查询 Agent/);assert.match(tagged,/问答/);assert.match(tagged,/未指定 Skill/);assert.match(tagged,/用量未上报/);
});
