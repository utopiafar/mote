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

## 公开发布

[Mote 0.6.0](https://github.com/utopiafar/mote/releases/tag/v0.6.0) 于 2026-09-14 发布，对应代码提交 `835efadfd5ce4c33e47fcc67fa9a575d3e151aff`。[Release 流水线](https://github.com/utopiafar/mote/actions/runs/34805096401) 的 8 个任务全部通过，包含 Linux 工作区回归、Docker 隔离／备份／回退／Tunnel 生命周期、Mac 原生连接与更新测试、Android 测试与签名，以及双架构镜像发布。主分支的独立 [Checks](https://github.com/utopiafar/mote/actions/runs/34805096226) 也通过。

公开资产包含 Mac arm64 ZIP、Android arm64 日常版与 Dev APK、中央源码包、签名更新清单和 SHA256SUMS。签名私钥仍由 GitHub `release` Environment Secrets 提供，没有进入仓库或安装包；Mac 仍为 adhoc 签名。

公开 Android 两包实际下载后，通过内置公钥清单、大小／SHA、APK 签名、包名、版本和 16 KiB ZIP 对齐检查；正式包不带 debuggable，证书继续使用既有发布身份。在全新专用 API35 模拟器中安装官方 0.5.1 Dev，只写入生成资料，再用官方 0.6.0 Dev 执行 `adb install -r`：设置、设备 ID、原记录 ID 的加密笔记队列、加密草稿和模型目录标记的指纹全部一致。生产更新器另从公网读取并验证 0.6.0 清单、实际下载 Dev APK 并校验签名，界面拒绝重复覆盖相同 versionCode；没有创建安装会话。覆盖安装的数据保留与更新器下载检查是两项独立验证，不能据此声称已走过用户确认安装 UI。该专用模拟器完成后已关闭。

公开 Mac ZIP 通过内置公钥、大小／SHA、解压结构、`codesign --deep --strict`、实际 Bundle ID／版本／arm64 架构和包内更新助手检查。包内 Swift 助手解码生成的邀请二维码；包内 Electron 载入连接模块与共享协议成功，Qwen 对生成白图完成真实离线推理。没有启动日常 App、读取个人 profile／Keychain 或替换现有安装。本机命令行默认直连清单曾在 30 秒截止时超时，使用 Node 的 `--use-env-proxy` 后，以原生产校验与下载函数通过公开资产验证；没有替换公钥或绕过校验。

公开中央源码包的签名、大小／SHA、解包路径、各组件版本及新连接模块通过检查。匿名读取 GHCR 的签名不可变摘要 `sha256:28b6f4b9281f3d6f7a2885f9ff588e1c37bb8724ecf4eadc6045b85b98646145`，与 `0.6.0` 标签一致；linux/amd64 和 linux/arm64 的子清单与配置逐一核对实际字节散列、大小、架构和版本标签，全部一致。本地没有另行拉取镜像层或运行容器；容器运行结果来自上述成功的 CI 集成任务。

公开分发的本地验收记录保存在忽略的 `.mote/release-validation/`：Android 的 `android-0.6.0/summary.json`、Mac 的 `mac-0.6.0-1789359963202/result.json`、中央与镜像的 `v0.6.0/result.json`。这些记录只描述生成测试资料、公开产物及验证结果。

## 0.6.1 Mac 更新网络修补

公开包验收额外发现旧版更新器的网络差异：在独立 Electron 会话中，同一个 GitHub 清单地址，Node 请求连接超时，而 Electron 网络请求成功。0.6.1 将 Mac 的检查与下载接入 Electron 系统网络，使用独立内存会话并省略 Cookie／登录凭据，继续由共享更新模块检查每一跳地址、发布签名、大小和散列。原来的 CLI 仍使用 Node 网络，可按 [更新说明](updating.md) 显式启用环境代理。

固定 Electron 版本的 `net.fetch` 无法按共享更新器所需的方式返回手动重定向响应，因此适配层使用 `net.request` 暴露每次跳转，下载目标仍由共享模块逐跳决定。没有通过自动跳转或关闭证书检查来解决网络问题。

修补后的完整工作区 271 项测试和类型检查通过，其中桌面 114 项。真实 Electron 的生成网络 fixture 验证手动 302、拒绝外域／HTTP 跳转、签名和 SHA 失败、会话 Cookie 与认证头剔除、首块数据后取消、消费者取消及 partial 文件清理；另捕获并修复请求写入端提前 `close` 被误当成下载失败的时序问题。相同路径实际访问 0.6.0 公开签名清单、下载 114,082,194 字节 Mac ZIP 并校验散列与包结构，无需环境代理开关。结果在 `.mote/release-validation/mac-network-0.6.1-result.json`。

新增原生网络回归已加入 Release CI。可在构建桌面端后运行 `node_modules/.bin/electron apps/desktop/scripts/update-network-smoke.cjs`；显式加 `--public-version=0.6.0` 才会访问并下载该公开版本，其默认模式只连接生成的本地服务。

[0.6.1 正式版本](https://github.com/utopiafar/mote/releases/tag/v0.6.1) 对应提交 `fbf978a4b52fe9c602fa4afceed7f28b9d2d3ee6`。[Release 的 8 项任务](https://github.com/utopiafar/mote/actions/runs/34807124530)和主分支 [Checks](https://github.com/utopiafar/mote/actions/runs/34807124491)全部通过。公开源码包、公钥与版本元数据核验通过，两个 Android 变体均为 code 9；GHCR 不可变摘要 `sha256:5578b676bc1f9932d17eeb25cf63ae8b204c51fdef43f701e7e7149d690d9aa1` 与 `0.6.1` 标签一致，amd64／arm64 的清单、配置及散列链全部匹配。证据保存在 `.mote/release-validation/v0.6.1/result.json`。

公开 Android 0.6.1 双 APK 的实际签名、包身份、大小／SHA、内置公钥和 16 KiB 对齐通过；从官方 0.6.0 Dev 经 ADB 覆盖安装官方 0.6.1 Dev 后，生成设置、设备 ID、原 ID 的加密队列、草稿与模型目录标记全部保留。真实更新器再次完成公网清单、APK 下载及 apksig 校验，同 code 9 被拒绝覆盖且没有创建安装会话。记录在 `.mote/release-validation/android-0.6.1/summary.json`，独立模拟器已关闭；此结果仍不能代替真机或用户确认安装界面测试。

公开 Mac 0.6.1 ZIP 的实际大小／SHA、公钥签名、包结构、`codesign --deep --strict`、版本／Bundle ID／arm64 和包内更新助手检查通过。使用与公开包 Electron Framework 版本相同的独立 Electron host，直接加载解包后 `app.asar` 内的更新适配层和共享公钥，对 0.6.1 再次完成实际清单验签与完整 ZIP 下载，每个请求均手动处理两跳重定向；子进程未使用 Node 环境代理开关。两次独立下载散列一致，证明修复已进入公开产物。记录在 `.mote/release-validation/mac-0.6.1-1789361756071/result.json`。没有启动正常 App、运行 Qwen、读取个人 profile／Keychain 或替换日常安装，验收进程已全部退出。

## 实际使用边界

尚未在 K90 Pro Max／HyperOS 真机验证相机扫码和后台恢复；模拟器验证不能代替厂商系统的权限与耗电行为。本轮没有验证公网 Cloudflare Tunnel 或各家 Chatbot 的配置界面；实际 MCP HTTP／stdio SDK 传输已覆盖，只接受 OAuth 的聊天产品仍不支持直接导入 Bearer JSON。

Android 累计统计从本功能首次记录或用户明确重置时开始。计数与队列分开持久化，极端断电窗口可能少记累计事件；当前队列直接读取实际文件，不用累计数推算。统计无法读取或曾写入失败时应显示不完整状态。文件大小不等于 Android 系统安装占用，整机电量变化也不能归因于 Mote。
