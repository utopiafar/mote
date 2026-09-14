import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {MediaMetadata,MediaSession} from '@mote/shared';
import {MediaActivityContent,MediaSnapshot} from '../src/Media';
import {mediaStatus,mediaCardText,mediaDuration} from '../src/media-presentation';
import {dateTime,type MediaActivity} from '../src/api';

const session:MediaSession={sessionId:'generated-session',appId:'fixture.player',appName:'合成播放器',playbackState:'playing',appVisibility:'background',playbackType:'local',title:'<script>合成标题</script>',artist:'合成作者',album:'合成专辑',positionMs:0,durationMs:180000,playbackSpeed:1};
const media:MediaMetadata={status:'available',sessions:[session]};
test('short sampled playback totals retain seconds',()=>{
  assert.equal(mediaDuration(75000),'1 分钟 15 秒');
  assert.equal(mediaDuration(0),'0 秒');
  assert.equal(mediaDuration(60000),'1 分钟');
});
test('missing, unavailable, unauthorized and empty media observations never claim no audio',()=>{
  assert.match(mediaStatus().description,/无法判断/);
  assert.match(mediaStatus({status:'permission_required',sessions:[]}).label,/等待授权/);
  assert.match(mediaStatus({status:'unavailable',sessions:[]}).description,/不能据此认定/);
  assert.match(mediaStatus({status:'disabled',sessions:[]}).description,/无法判断/);
  assert.equal(mediaStatus({status:'available',sessions:[]}).label,'未观察到媒体会话');
  assert.match(mediaStatus({status:'available',sessions:[]}).description,/未公开媒体会话/);
});
test('media snapshots preserve zero progress, escape evidence and distinguish remote and unknown state',()=>{
  const html=renderToStaticMarkup(React.createElement(MediaSnapshot,{media,screenLocked:true}));
  assert.match(html,/&lt;script&gt;合成标题&lt;\/script&gt;/);assert.ok(!html.includes('<script>'));
  assert.match(html,/屏幕已锁定/);assert.match(html,/后台应用/);assert.match(html,/本机播放/);assert.match(html,/0 秒/);
  assert.match(html,/媒体总长度/);assert.match(html,/不保存通知正文或音频/);
  const unknown=renderToStaticMarkup(React.createElement(MediaSnapshot,{media:{status:'available',sessions:[{...session,playbackState:'unknown',appVisibility:'unknown',playbackType:'remote'}]}}));
  assert.match(unknown,/播放状态未知/);assert.match(unknown,/前后台未知/);assert.match(unknown,/锁屏状态未知/);assert.match(unknown,/远程播放/);
});
test('activity collection suppresses content even if a malformed response includes titles',()=>{
  const html=renderToStaticMarkup(React.createElement(MediaSnapshot,{media,collection:'activity'}));
  for(const content of ['合成标题','合成作者','合成专辑'])assert.ok(!html.includes(content));
  assert.match(html,/仅保留应用与播放状态/);assert.match(html,/合成播放器/);
  assert.ok(!mediaCardText(media,'activity').includes('合成标题'));
  assert.match(mediaCardText(media),/合成标题/);
});
test('cached media observations preserve their own time separately from later device state',()=>{
  const mediaAt='2026-09-14T01:00:00Z',deviceAt='2026-09-14T02:00:00Z';
  const html=renderToStaticMarkup(React.createElement(MediaSnapshot,{media:{...media,observedAt:mediaAt},observedAt:deviceAt,screenLocked:true,compact:true}));
  assert.ok(html.includes(`媒体观察于 ${dateTime(mediaAt)}`));
  assert.ok(html.includes(`${dateTime(deviceAt)} 设备上报：`));
  assert.match(html,/当时的状态不代表现在/);
});
test('media statistics use backend measured totals and disclose independent, overlapping measurements',()=>{
  const value:MediaActivity={totalDurationMs:60000,observations:5,playingSamples:2,apps:[{appId:'fixture.player',appName:'合成播放器',durationMs:60000,observations:2,evidenceIds:['synthetic-evidence'],evidenceTruncated:false}],devices:[],visibility:{foreground:0,background:60000,unknown:0},screenLock:{locked:30000,unlocked:0,unknown:30000},playbackType:{local:60000,remote:0,unknown:0},evidenceIds:['synthetic-evidence'],evidenceTruncated:false,accounting:'union_per_device_sum_across_devices',coverage:'observed_intervals_only'};
  const html=renderToStaticMarkup(React.createElement(MediaActivityContent,{value,onOpen:()=>{}}));
  assert.match(html,/媒体播放采样时长/);assert.match(html,/1 分钟/);assert.match(html,/锁屏状态未知 30 秒/);assert.match(html,/5 次状态观察/);
  assert.match(html,/媒体播放与前台应用使用分别计时/);assert.match(html,/不应相加/);assert.match(html,/截图附带的媒体状态不重复计时/);
  assert.match(html,/查看 合成播放器 的媒体证据/);
  const empty=renderToStaticMarkup(React.createElement(MediaActivityContent,{value:{...value,observations:0},onOpen:()=>{}}));
  assert.match(empty,/没有记录不代表没有播放/);
});
