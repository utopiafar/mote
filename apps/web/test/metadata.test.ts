import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Metadata,activityExplanation,sourceLabels} from '../src/Metadata';

test('metadata details preserve zero/false, disclose missing fields and escape untrusted device labels',()=>{
  const html=renderToStaticMarkup(React.createElement(Metadata,{metadata:{version:1,observedAt:'2026-09-14T01:00:00Z',device:{model:'<script>secret</script>'},state:{batteryPercent:0,charging:false,availableStorageBytes:0}}}));
  assert.match(html,/0%/);assert.match(html,/正在充电/);assert.match(html,/>否</);assert.match(html,/缺失不代表否或零/);
  assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
  assert.ok(!html.includes('屏幕锁定'));assert.ok(!html.includes('提供方创建时间'));
});
test('file times are labeled separately and activity is intentionally content-free',()=>{
  const html=renderToStaticMarkup(React.createElement(Metadata,{modifiedAt:'2026-09-13T01:00:00Z',source:{version:1,file:{accessedAt:'2026-09-13T02:00:00Z',deletionObservedAt:'2026-09-14T01:00:00Z'}}}));
  assert.match(html,/源内容修改时间/);assert.match(html,/无法确认实际删除时刻/);assert.match(html,/不能据此断定你查看过文件/);
  assert.equal(sourceLabels.activity,'仅应用活动');assert.match(activityExplanation,/没有采集截图/);
  const missing=renderToStaticMarkup(React.createElement(Metadata,{}));assert.match(missing,/未上报额外元数据/);
});
