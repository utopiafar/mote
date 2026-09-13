import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { apiClient } from './client.js';
const request=apiClient();
const now=Date.now();
const sources=[
  {app:'合成 · 编辑器',id:'fixture.editor',text:'【合成演示，非真实活动】Mote 设计笔记：端点离线保存脱敏截图，中央节点独立部署。先完成幂等上传和证据检索。',color:'#315e50'},
  {app:'合成 · 阅读',id:'fixture.reader',text:'【合成演示，非真实活动】阅读上下文采集协议。需要分别保存事件发生时间、入库时间和索引进度。',color:'#bd8b48'},
  {app:'合成 · 备忘录',id:'fixture.notes',text:'【合成演示，非真实活动】与项目有关的想法：迁移服务器时保持事件 ID 不变，截图依照内容哈希去重。',color:'#547183'},
];
for(let i=0;i<24;i++) {
  const source=sources[Math.floor(i/4)%sources.length];const mobile=i%3===0;
  const image=await sharp(Buffer.from(`<svg width="960" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="600" fill="#f3f1e9"/><rect x="36" y="36" width="888" height="70" rx="14" fill="${source.color}"/><text x="65" y="82" font-family="sans-serif" font-size="26" fill="white">MOTE / SYNTHETIC FIXTURE</text><text x="65" y="165" font-family="sans-serif" font-size="22" fill="#203a31">Personal context, with evidence.</text><rect x="65" y="205" width="730" height="18" rx="9" fill="#d6dbd2"/><rect x="65" y="245" width="570" height="18" rx="9" fill="#d6dbd2"/><rect x="65" y="285" width="650" height="18" rx="9" fill="#d6dbd2"/><rect x="65" y="360" width="240" height="125" rx="16" fill="${source.color}"/><text x="340" y="420" font-family="sans-serif" font-size="18" fill="#66736a">Generated test data only.</text></svg>`)).webp({quality:72}).toBuffer();
  await request('/api/captures',{id:randomUUID(),deviceId:mobile?'fixture-android':'fixture-mac',deviceName:mobile?'演示 · Android':'演示 · Mac',platform:mobile?'android':'macos',capturedAt:new Date(now-(24-i)*15000).toISOString(),durationMs:15000,appName:source.app,appId:source.id,windowTitle:'合成演示资料',ocrText:source.text,imageBase64:image.toString('base64'),imageMime:'image/webp',source:'screen',privacy:{excluded:false,redacted:false,mode:'local'}});
}
console.info('Imported 24 clearly labeled synthetic observations. No personal screen was captured.');
