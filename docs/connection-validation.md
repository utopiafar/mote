# 0.6.0 连接与统计验证

本轮使用生成的邀请、凭据、图片和日记，节点、App profile 与 Android 模拟器数据均与日常环境隔离。没有采集个人屏幕、连接真实日历或调用云端大模型；连接和统计功能不依赖模型判定。

最终工作区回归共 266 项通过：Mac 109、服务端 88、Web 14、Agent 28、诊断 5、端上推理 13、共享协议 9；全工作区 TypeScript 检查通过。原生界面、跨端联调和升级／回退另按下表验证，不计入这 266 项。

## 已验证的路径

| 范围 | 验证内容 |
|---|---|
| 中央配对 | 所有者发放、10 分钟过期、一次性兑换、取消、并发兑换、设备绑定、重启持久化、凭据哈希与文件权限 |
| 权限与撤销 | 采集凭据只能写入自身设备／来源；拒绝跨设备、管理、导出和 Agent 请求；准备中的上传在撤销后不能提交；MCP 读写分开且限制来源 |
| 中央界面 | 真实浏览器渲染并本地生成 QR、下载 JSON、绑定已有设备重新授权、撤销、生成并隐藏 MCP JSON；桌面和窄屏不横向溢出 |
| MCP | 从中央导出的 HTTP JSON 使用实际 MCP SDK 连接并读取生成记录；stdio 桥接兼容同一 JSON，并拒绝命令型配置、额外请求头和非 HTTPS 远程地址 |
| Mac | 实际 Electron／Swift Vision 解码生成 QR，JSON 和文件导入只预览不联网；明确确认后配对；失败保留配置；同节点重授权保持原截图／笔记／来源队列，更换节点被阻止 |
| Android | 44 项 JVM 测试与 5 项模拟器 instrumentation 通过；生成邀请连接真实隔离中央，验证重放拒绝、管理权限隔离、撤销后 401、同节点重连后原 1 张生成图与 2 条笔记确认上传；重复入队不重复计数；外部链接仅审阅、修改地址清除旧令牌、迟到的投屏授权不启动旧配置 |
| 配置与诊断 | 整个中央配置页面、私有路径与密钥状态、诊断下载和窄屏布局回归；凭据与生成的原始正文不进入支持包 |
| 升级／回退 | 实际临时 Node 进程升级后设备凭据仍可用；升级后撤销，再恢复旧数据快照时继续拒绝该凭据，撤销状态与文件 600 权限保留 |

审查修复了三个时序问题：旧节点延迟返回的 401 不再清除新节点的登录；Mac 正在提交连接时不能显示可取消的假象；Android 采集授权的迟到回调需要验证连接状态，不能绕过连接锁启动旧配置采集。云端截图归档、隐私过滤和 Harness 工具循环也通过生成数据回归，其中模型响应为 fixture，不能据此推断真实模型质量。

## 复现

需要 Node.js 24、npm，原生 UI 测试另需 macOS 和已编译的 Swift 助手。

```sh
npm ci
npm run build:libs
npm run typecheck
npm run build -w @mote/server -w @mote/web -w @mote/desktop
npm test
npm run test:e2e
npm run test:privacy
node scripts/test-mcp-stdio.mjs
node --test scripts/mcp-connection-tests.mjs scripts/update-deployment-tests.mjs
node apps/desktop/scripts/connection-server-smoke.cjs
node_modules/.bin/electron apps/desktop/scripts/connection-smoke.cjs
node_modules/.bin/electron scripts/test-web-connections.cjs
node_modules/.bin/electron scripts/test-web-diagnostics.cjs
```

测试输出和生成页面图保存在忽略的 `.mote/connections-validation/` 中。GUI 测试的浏览器 profile、中央目录及进程在退出时清理。需要给原生客户端提供临时节点时，可使用 `scripts/test-client-connections-fixture.mjs --connection-file /绝对路径/私有测试连接.json`；该文件权限 600，只保存生成的测试凭据，终止测试节点后自动删除。

Android 本地完成 debug／development APK 构建和两个 variant 的 lint；统计页用生成数据绘制并检查分组、留白和目录信息，截图仅保存在本地忽略目录。模拟器测试的启动方式和连接参数见 [Android 说明](android.md)。

## 实际使用边界

尚未在 K90 Pro Max／HyperOS 真机验证相机扫码和后台恢复；模拟器验证不能代替厂商系统的权限与耗电行为。本轮没有验证公网 Cloudflare Tunnel 或各家 Chatbot 的配置界面；实际 MCP HTTP／stdio SDK 传输已覆盖，只接受 OAuth 的聊天产品仍不支持直接导入 Bearer JSON。

Android 累计统计从本功能首次记录或用户明确重置时开始。计数与队列分开持久化，极端断电窗口可能少记累计事件；当前队列直接读取实际文件，不用累计数推算。统计无法读取或曾写入失败时应显示不完整状态。文件大小不等于 Android 系统安装占用，整机电量变化也不能归因于 Mote。
