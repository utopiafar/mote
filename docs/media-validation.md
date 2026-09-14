# 媒体上下文验证记录

验证日期：2026-09-15（Asia/Shanghai）。所有自动测试使用生成内容、临时数据库和合成媒体会话，不连接个人资料库，不截图真实设备，不调用外部真实模型。

## TypeScript 与中央节点

- `npm run typecheck`：所有 npm workspaces 与 scripts 通过。
- `npm test`：564 项通过（Desktop 189、Server 146、Web 33、Agent 57、Diagnostics 5、Local inference 13、Shared 21）。
- Server 与 Web 构建通过；共享库与 Agent 构建通过。
- `npm run test:e2e`：原有生成截图／笔记的实际 Harness 工具链验证通过，新增只读工具不破坏既有工具注册。
- `npm run test:media-e2e`：生成媒体记录上传、幂等重试、独立播放统计、受限时间线、证据展开、媒体标题引用和导入导出往返通过。使用实际 Harness 与本机合成模型回复，不代表真实模型的分析质量。

新增检查覆盖：无图无 OCR 媒体协议、标题与元数据大小限制、未知／缺权状态、仅活动隐私、超过 60 秒间隔拒绝、暂停／缓冲不计时、并发会话去重、跨设备计时、时间窗口裁剪、区间嵌套、前后台／锁屏筛选、多会话应用检索、旧库索引迁移、采集凭据设备隔离、撤销权限和 MCP 只读权限。

统计返回的 ID 不直接开放 Agent 证据访问；Agent 必须先在当前范围发现记录。媒体标题按原样作为不可信证据投影，不能执行其中的指令。字段缺失不会转换成零收听时间。

## Web 界面

执行扩展后的 `apps/web/scripts/capture-browser-smoke.cjs`，使用临时生成数据中央节点与 Electron，验证现有 OCR 浏览功能、媒体来源筛选、无图片媒体详情、75 秒独立播放统计、权限不可用、设备最近状态，以及桌面与 390 px 手机布局。完成截图目视检查。

生成的本地视验文件在 `apps/web/artifacts/capture-browser/media-*.png`，该目录被 Git 忽略。媒体快照使用自身观察时间；设备状态时间不同时单独标注。界面明确当前状态未知、统计分项可能重叠、播放不等于收听或完成阅读。

## 平台与真实模型边界

Android 执行 `./gradlew :app:compileDebugKotlin :app:compileDebugAndroidTestKotlin :app:testDebugUnitTest --offline`，使用 Android Studio bundled JBR 和本机 Android SDK：BUILD SUCCESSFUL；18 个 suites、88 项 JVM tests、0 failures、0 errors。其中新增 7 项媒体测试覆盖隐私、电量门控、暂停／切章、并发会话、时钟与睡眠缺口、加密队列往返、统计迁移和手机无图媒体浏览。主代码与 instrumentation 源码编译通过，不等同实际运行 instrumentation。

静态复核额外修复快速停止／重启的计时竞态、撤销通知使用权后的保存边界、无障碍服务断开时的媒体状态、锁屏广播断段，以及媒体详情收到 `imageMime: null` 时误请求图片的问题。本机存在 `mote_fixture_api35` AVD，但本次未启动、安装或执行模拟器测试。

未执行实体 Android 手机验证、真实音乐／有声书 App 兼容性检查、厂商后台存活与 Doze 实测，也未验证真实模型的内容类型判断。未采集、传输真实个人截图或播放历史。APK 构建和 JVM fixture 不能证明这些行为。

真机后续应分别检查通知使用权首次授权与撤销、仅媒体模式、播放和暂停／切章、前后台切换、锁屏／熄屏、进程终止／重启、远程播放、应用隐私规则、低电量限制、离线补传及手动同步模式。
