import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {english} from '../dist/i18n-en.js';

const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const catalog=Object.keys(english);

// K07/D26: terms retired by the UI wording migration stay out of every authored Chinese message and client source.
const retired=['随手记','中央节点','中央端','中央服务器','Mote 中心','中央档案','中央资料库'];
const sourceDirectories=[
  'apps/web/src',
  'apps/desktop/src',
  'apps/desktop/resources',
  'apps/server/src',
  'apps/android/app/src/main/java',
  'apps/android/app/src/main/res',
  'apps/ios',
  'packages/shared/src',
  'packages/plugin-api/src',
  'packages/diagnostics/src',
];
const sourceExtensions=/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|kt|swift|html|css|xml|strings)$/;

function walk(directory){
  return readdirSync(join(repo,directory),{withFileTypes:true}).flatMap(entry=>{
    const relative=join(directory,entry.name);
    return entry.isDirectory()?walk(relative):[relative];
  });
}

// G02: prompts reworded by this migration state the condition only; none of them uses 请.
const changedPrompts=[
  '当前网页地址未获中央允许。公开地址或反向代理配置不匹配。',
  '网页或客户端与中央的协议版本不匹配。',
  '所需服务暂不可用。',
  '中央未接受当前登录身份（401）。登录信息可能已失效。',
  '请求内容超过中央或公网入口的大小限制（413）。',
  '查询服务暂不可用。',
  '此中央尚不支持页面模型配置。升级中央后重试。',
  '此令牌没有管理权限。使用中央的管理令牌；设备配对凭据不能登录管理页面。',
  '先连接中央；本机记录仍可查看',
  '中央返回 HTTP {0}。稍后重试',
  '先保存中央访问令牌',
  '中央界面加载失败。确认中央正在运行且提供前端页面',
  '还有待上传记录，不能切换中央；先完成上传，或导出并移走旧队列后重启',
  '待完成记录属于原中央；恢复原节点后完成保存',
  '中央暂不支持 OCR 补写；升级至 0.0.2 或更新版本后重试。结果已保留',
  '配置中央访问令牌',
  '中央拒绝访问；检查令牌。队列已保留',
  '中央报告事件 ID 冲突；队列已保留。检查服务端',
  '当前截图协议未被接受。确认中央已升级至 0.0.2 或更新版本；队列已保留',
  '中央地址需为完整的 HTTPS 地址；本机回环地址可使用 HTTP。',
  '中央地址需为完整的 HTTPS 地址，不能包含账号、路径、查询或片段。',
  '连接凭据文件无法读取。保留数据并检查中央文件权限。',
  '中央正在关闭。稍后重试。',
  '连接凭据未保存，操作未生效。检查中央存储后重试。',
  '邀请已使用、取消或过期。在中央重新生成。',
  '此邀请已绑定另一台设备。在中央确认设备后重新生成。',
  'Agent 未配置。在中央配置模型后重试。',
  '中央重启中断了此次回顾。',
  '中央重启中断了此次问答。',
  '填写完整的中央地址',
  '连接邀请已过期。在中央重新生成',
  '先在连接与同步中配置中央',
  '中央尚不支持两端检查。升级中央代码后重试；未修改本机状态',
  '中央可在电脑、NAS 或服务器部署。手机的 localhost 指手机本身；跨设备需填写局域网 IP 或 HTTPS 域名。',
  '尚未连接中央。导入邀请或填写下方设置',
  '备份属于不同中央。先连接原节点',
  '备份属于不同中央。连接原节点后导入',
  '问答请求失败（HTTP {0}）。检查中央模型设置或稍后重试',
  '中央已改变。关闭问答后重新打开',
  '这是中央返回的结构化记忆记录；下载文本是导出表示，实际模型输入见运行追踪。',
  '先在中央完成飞书账号授权，再连接录音',
  '先在中央完成钉钉账号授权，再连接录音',
  '先登录中央，各页面会共用这次登录',
  '填写中央所在机器上的目录',
  '该路径不是目录。填写中央所在机器上可读取的目录',
  '中央所在机器上的目录不存在或文件已移动。检查路径后重新提交',
  '中央无法读取该目录。检查访问权限后重新提交',
  '升级中央后再登录',
  '此凭据不具备客户端权限。升级中央或重新登录',
  '中央的文档原件归档暂不可用。检查节点版本与存储后重试',
];

test('retired wording no longer appears in Chinese entries or client source',()=>{
  const hits=[];
  for(const message of catalog)for(const term of retired)if(message.includes(term))hits.push({term,message});
  for(const directory of sourceDirectories)for(const file of walk(directory).filter(file=>sourceExtensions.test(file))){
    const text=readFileSync(join(repo,file),'utf8');
    for(const term of retired)if(text.includes(term))hits.push({term,file});
  }
  assert.deepEqual(hits,[],'Retired wording still appears');
});

test('changed prompts state the condition without 请',()=>{
  for(const prompt of changedPrompts){
    assert.ok(catalog.includes(prompt),`Changed prompt missing from the Chinese catalog: ${prompt}`);
    assert.ok(!/(?<![邀申])请(?!求)/.test(prompt),`Changed prompt still uses 请: ${prompt}`);
  }
});

test('promise copy stays verbatim across clients',()=>{
  const memoryDelete='原始资料保留。同一批旧证据不会重新生成这个结论；有新证据时可以重新判断。';
  const conversationTitle='删除整段对话？';
  const conversationBody='会删除这段对话的所有问答。已单独保存的记录保留。';
  const conversationAction='删除对话';
  for(const copy of [memoryDelete,conversationTitle,conversationBody,conversationAction]){
    assert.ok(catalog.includes(copy),`Promise copy missing from the Chinese catalog: ${copy}`);
  }
  const required=new Map([
    ['apps/web/src/plugins/memory/MemoryDeleteDialog.tsx',[memoryDelete]],
    ['apps/android/app/src/main/java/dev/mote/collector/CentralLibrary.kt',[memoryDelete]],
    ['apps/web/src/plugins/ask/Conversations.tsx',[conversationTitle,conversationBody,conversationAction]],
    ['apps/android/app/src/main/java/dev/mote/collector/CentralScreens.kt',[conversationTitle,conversationBody,conversationAction]],
  ]);
  for(const [file,copies] of required){
    const text=readFileSync(join(repo,file),'utf8');
    for(const copy of copies)assert.ok(text.includes(copy),`${file} must contain the promise copy verbatim: ${copy}`);
  }
});
