# 插件化收敛旅程收尾（J01–J20）

2026-11-04，REL07 在收敛候选上逐项核对 J01–J20。代码候选为 `83ef03664997f38c3bd28a347db5752af7c69ae5`（REL06 之后，REL07 只新增文档）。本单元实际运行使用生成 profile、真实 SQLite/HTTP/进程、本地脚本模型和生成的发行产物；没有调用真实模型、没有使用物理设备或第三方账户。负责人另行提供的真实主机、模拟器和真实模型手工证据在单独的表中标出，未计入本单元自己的运行结果。

## 结论

- fixture 范围内，J01–J14、J17–J20 有真实入口/真实 host/真实进程或真实构建产物证据；其中 J02、J14、J17、J18 为 PARTIAL，原因见各行。
- J15（Android 记录/系统入口/恢复）和 J16（真实模型语义）在本单元为未验证；J10 的真实 Codex 账户、J11 的独立第三方作者、J17 的真实日历账户也未验证。
- Android APK、Central/Web/Mac 产物均完成构建与 `verify`，Android JVM 单元也通过；这仍是生成 fixture 证据，不是真机/模拟器旅程。
- 因为物理设备和第三方账户/真实日历/真实模型证据不完整，本候选**不宣布具备完整发布资格**。

## 本单元运行结果

路径均为仓库根目录相对路径。`PASS` 表示该行命令在本候选上实际通过；`PARTIAL` 表示只覆盖了行内注明的部分；`未验证` 表示本单元没有执行能证明该旅程的检查。

| 旅程 | 证据种类 | 命令或证据 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| J01 默认组合真实启动与第一份资料 | fixture | `node --import tsx scripts/journeys/plugin-central-stage.ts`；`apps/server/test/plugin-startup-contract.test.ts`；`apps/server/test/plugin-central-distribution.test.ts`；`plugin-central-release.ts` 的 `default-distribution` | PASS | 真实 `src/index.ts` 入口、owner 认证、Note POST/GET、同 profile 重启后重读；打包产物 clean-run 为 23 features/39 packages，并写入/读回生成 Note。 |
| J02 同包双实例安装、授权与独立同步 | fixture | `apps/server/test/plugin-plugin-control-store.test.ts`（“two actual host instances isolate leases…”）；`plugin-instance-state.test.ts`；`plugin-instance-state-host.test.ts`；`plugin-connector-host-adapter.test.ts` | PARTIAL | 同一 package 的两个 installation 有独立安装身份、lease、状态和停用隔离，兄弟实例继续服务；未组装“双实例各自独立 source sync”的完整旅程。 |
| J03 独立 Processor 与可恢复资料链 | fixture | `apps/server/test/plugin-templates.test.ts`（connector/domain/worker）；`community-plugin.test.ts`；`plugin-import-services.test.ts`；`plugin-c10-integration.test.ts`；`node --import tsx scripts/media-e2e.ts` | PASS | 生成的仓库外模板能构建、安装、在实际 host 运行；processor 卸载会 fence 在途结果并可重试恢复；Python pack、HTTP media 和真实 Harness fixture 链通过。真实 OCR/ASR 模型未安装，见负责人证据的 PARTIAL。 |
| J04 升级、重装、撤权和在途停止 | fixture | `apps/server/test/plugin-control-upgrade-failure.test.ts`；`plugin-control-journeys.test.ts`；`plugin-central-release.ts` 的 `provider-and-plugin-lifecycle` | PASS | 热升级旧 activation 排空、坏候选保留运行版本；迁移/暂停/立即停止/撤销/未知写与重装状态由真实控制面覆盖；打包候选重启通过。 |
| J05 显式绑定与插件依赖失效 | fixture | `apps/server/test/plugin-central-contracts.test.ts`；`plugin-plugin-control-store.test.ts`（“missing exact dependency is blocked…”）；`plugin-control-journeys.test.ts`（scope/intent 拒绝） | PASS | 显式 binding、反向安装顺序、错误 API 版本、reinstall/foreign host 不静默换 sibling；缺失精确依赖在真实 host/control 路径被阻止。`plugin-central-contracts` 的 T1 声明检查只作为补充，不单独算集成。 |
| J06 默认 Memory 策略对等与完整发布 | fixture | `apps/server/test/official-agent-consumers.test.ts`；`memory-phase-lifecycle.test.ts`；`memory-pipeline.test.ts`；`memory-receipt-integration.test.ts` | PASS | 真实 app + 生成本地模型端点驱动 Query/Memory/Insight/Activity/Actions/Probe/usage；Memory phase/pipeline/publication 使用真实 SQLite 与审批账本。真实模型语义见 J16。 |
| J07 现有 Memory Provider、未知写与备份恢复 | fixture | `plugin-central-release.ts` 的 `backup-restore`；`memory-adapters-journey.test.ts`；`plugin-memory-provider-adapters.test.ts`；`plugin-memory-deletion.test.ts`；`memory-provider-consumers.test.ts` | PASS | 生成 worker provider、Mem0/Hindsight 兼容安装路径、未知写/擦除意图跨重启对账、CLI 全库备份恢复到新数据目录后重读原文。没有使用上游真实 Mem0/Hindsight，也没有真实模型备份证据。 |
| J08 只读工具及新 Runtime 独立接入 | fixture | `apps/server/test/agent-read-tools.test.ts`；`plugin-evidence-context-reader.test.ts`；`official-agent-consumers.test.ts`；`packages/agent/test/official-agent-composition.test.mjs`；`official-read-packs.test.mjs` | PASS | 只读 reader/工具注册、feature 卸载 fence、证据范围与 citation 边界；官方 Agent composition 被 Query/Memory/Insight/Activity/Actions/Probe 消费。没有真实模型会话。 |
| J09 DSH 原生包、Hook 与 Factory 替换 | fixture | `packages/agent/test/dsh-native-extension.test.mjs`；`dsh-native-lifecycle.test.mjs`；`dsh-native-replacement.test.mjs` | PASS | 真实锁定 DSH loader 运行原生 package、读取/改变 request config、卸载 Hook；Factory A→B 热替换和 restart-required 替换均通过。使用本地脚本 provider，不证明模型语义。 |
| J10 Codex 并列运行、Import 和既有 Host 委派 | fixture | `apps/server/test/codex-query.test.ts`；`agent-import-host.test.ts`；`delegated-query-app.test.ts`；`delegation-runtime.test.ts`；`packages/agent/test/codex-provider.test.mjs`；`codex-protocol.test.mjs`；`codex-tool-consumer.test.mjs`；`host-delegation.test.mjs` | PASS（fixture） | Codex App Server fixture 的认证查询、取消、崩溃恢复、DSH/Codex import 和 Host delegation 通过。真实 Codex 登录/账户未验证。 |
| J11 新领域与二级插件的独立作者旅程 | fixture | `apps/server/test/plugin-templates.test.ts`（`[U]`/两个 `[K]`）；`plugin-pack.test.ts`；`plugin-central-stage.ts` 的仓库外插件 | PASS（fixture） | connector/domain/worker 模板在临时外部目录生成并构建，实际 host 安装运行；pack 产物被真实 `GitHubPluginReleases` resolve/install/verify 消费；仓库外 sample 通过真实入口装载。独立第三方作者未验证。 |
| J12 完整 Web 插件页面和消息桥 | fixture | `apps/web/test/plugin-custom-page.test.ts`；`plugin-host.test.ts`；`cd apps/web && npx electron test/plugin-stage-browser.cjs` | PASS | 自定义页面 bridge 的字段/实例/generation 校验、revoke/late result fence；真实构建 Web + 生成 Central HTTP 的 stage 浏览器遍历 29 个页面、9 个 collection、9 个 settings surface，89 张隐藏截图。 |
| J13 界面替换、草稿、返回与隐藏停读 | fixture | `apps/web/test/plugin-view-lifetime.test.ts`；`plugin-library-lifetime.test.ts`；`plugin-stage-browser.cjs`；`apps/desktop/test/plugin-stage-smoke.cjs` | PASS | 替换只移除目标插件的页面/collection；隐藏页停止轮询、恢复快照与草稿；详情返回保留 cursor/scroll/draft；桌面 stage 的 quick-note 草稿、返回和隐藏读取同样通过。 |
| J14 Mac 已有原生能力的插件旅程 | fixture | `cd apps/desktop && npx electron test/plugin-stage-smoke.cjs`；`plugin-default-inventory.test.ts`；`plugin-note-draft.test.ts`；`plugin-sources.test.ts`；`plugin-system-tools.test.ts` | PARTIAL | 真实隐藏 Electron renderer/preload、30 个路由页面、11 个业务 scope、插件 IPC/source/queue/quick-note 通过；fixture 明确 stub 掉原生 capture/permission/tray，故原生权限、真实屏幕采集和真实 Central HTTP 未验证。 |
| J15 Android 记录、系统入口和恢复 | 未验证（本单元） | 候选 APK 构建与 `verify` 通过；Android JVM 6 个 class/26 tests（1 skipped）通过；未运行 Android instrumentation | 未验证 | 本单元没有安装到模拟器运行记录/系统入口/恢复旅程；JVM 不是集成旅程。负责人另行提供的模拟器证据见下表，物理设备仍未验证。 |
| J16 手选真实模型的运行与语义证据 | 未验证（本单元） | 未调用真实 provider；本单元只使用 fixture model transport | 未验证 | `official-agent-consumers` 和 `media-e2e` 的模型端点是本地生成 fixture，不能算真实模型证据。负责人证据见下表。 |
| J17 既有日历 Action 插件的授权与回执 | fixture | `apps/server/test/managed-calendar.test.ts`；`plugin-actions-services.test.ts`；`actions.test.ts` | PARTIAL | Central grant/claim/receipt、离线回执、取消/迟到成功、重启、跨设备拒绝和撤权 fence 通过；本单元没有跑 Android/OS 日历消费者或真实日历账户。 |
| J18 插件状态、删除、卸载和备份 | fixture | `plugin-central-release.ts` 的 `backup-restore`；`plugin-control-journeys.test.ts`（uninstall/erase）；`plugin-memory-backup.test.ts`；`plugin-memory-publication.test.ts`；`apps/desktop/test/plugin-local-storage-backup.test.ts` | PARTIAL | 服务端/CLI 的未知写、擦除意图、卸载/retire、备份恢复和桌面本地备份通过。Web 完整安装/卸载 UI 的 `plugin-final-browser.cjs` 因生成 manifest 仍是旧 `dependencies: string[]` 形状而在 preview 前被当前 schema 拒绝；未把它算作通过。 |
| J19 基础插件重启替换与依赖裁剪 | fixture | `plugin-central-release.ts` 的 `provider-and-plugin-lifecycle`；`plugin-bootstrap.test.ts`；`plugin-control-upgrade-failure.test.ts`；`plugin-central-distribution.test.ts` 的 `[M]` | PASS | 存储 provider 重启替换并关闭旧 vault；移除 notes 插件后 feature/route 消失但原件保留，恢复完整清单后重读；打包候选同 profile 重启后 44 features。 |
| J20 打包产物、全量功能与最终退出旧装配 | fixture | `node scripts/plugin-distribution.mjs build --products central,web,mac,android`；`verify`；`clean-run`；`plugin-central-release.ts`；`plugin-central-distribution.test.ts` 的 `[R]`/`[K]`；Web/Desktop default inventory；`node scripts/ci/architecture.mjs` | PASS（fixture） | Central 39 packages/23 features，Web 24/59，Mac 12/1 native provider，Android 14/36 components；错误 contract 版本返回具体 `version_mismatch`；clean-run 写入/读回生成 Note 并安装 SDK sample；架构边界 1001 文件/13 个既有例外。产物未签名、未发布。 |

## 负责人提供的手工验收（未由本单元重跑）

以下证据来自负责人 2026-11-04 在 main `e1ac40978` / `4cf2ae6a0` 上的真实主机/生成测试 profile 手工验收；它们与上表分开记录，不能当作 REL07 自己的运行结果。

| 旅程 | 负责人结果 | 证据与边界 |
| --- | --- | --- |
| J01 | PASS | 真实写入 3 条 Note、GET、重启后重读；`plugin-central-stage.ts` PASS；REL05 打包产物在干净目录启动（23 features、Note 写入/读回、SDK sample 安装）PASS。 |
| J03 | PARTIAL | 文件/文件夹导入 + media e2e fixture PASS；真实 media OCR/ASR 模型未安装。 |
| J06/J07 | PASS | 真实模型 OpenAI `gpt-6.1-terra` 完成 Memory 提取，2 条 Memory 审核并发布，recall Ask 带 citation PASS。真实模型下的备份恢复未验证（只有 REL06 fixture）。 |
| J10 | 未验证 | Codex、Feishu/Lark 或其他第三方账户没有真实账户证据；只有 fixture 旅程。 |
| J11 | PASS（fixture） | EXT01 checks + EXT03 plugin templates PASS；独立第三方作者未验证。 |
| J12/J13 | PASS | Web UI journeys + route checks（`#/system/plugins`、`#/library?view=memories`）在 Electron 驱动的 Web 中 PASS。 |
| J14 | PASS | 真实桌面 renderer 的 Ask UI 使用 `gpt-6.1-terra` PASS；EXT16 desktop plugin stage smoke PASS（30 pages/10 scopes）。 |
| J15 | PARTIAL | Android 模拟器 `emulator-5590`（不是物理设备）：EXT17 denied-capture/notification 3/3 PASS，Android Ask UI 真实模型 PASS；物理设备未验证。 |
| J16 | PASS | 真实模型 `gpt-6.1-terra`：API Ask、Memory、Web/Desktop/Android Ask UI 均 PASS 且有 citation。 |
| J17 | PARTIAL | Android AND10 calendar JVM 11/11；`ManagedCalendarNative` instrumented 在模拟器 PASS；`ActionFirstJourneys` firstRun four-tab 测试自 `c69ad0d15` 起 stale 失败（负责人尚未决定），真实日历账户未验证。 |

## 未验证与未执行

- **J15 物理设备**：未验证。模拟器证据只来自负责人，且本单元没有重跑 Android instrumentation。
- **J16 真实模型**：未验证（本单元）。fixture model transport 不能替代 provider 语义质量。
- **J10 Codex/第三方账户**：未验证。`codex-query` 等使用本地 App Server fixture。
- **J17 真实日历账户/OS 授权**：未验证。服务器和 Android JVM/test fixture 通过不等于真实 EventKit/Calendar Provider 已写入。
- **J11 独立第三方作者**：未验证。模板构建/安装通过，但没有外部作者独立操作证据。
- **J02 独立 source sync 双实例**：当前只有 host/installation/lease/state 隔离证据，没有两个同包实例各自同步的组装旅程。
- **J03 真实 OCR/ASR 模型**：未验证；本轮 media e2e 使用生成 provider。
- **J07 上游真实 Mem0/Hindsight 与真实模型备份**：未验证；测试使用生成兼容 worker。
- **J18 Web 完整安装/卸载 UI**：本轮未通过。`plugin-final-browser.cjs` 的生成 manifest 仍把 `dependencies` 写成字符串数组，当前 `@mote/plugin-api` manifest schema 要求依赖对象；浏览器在 preview 阶段收到 validation 错误，随后超时。直接以当前 manifest 形状调用 `/api/plugins/resolve` 返回 200，说明是旧 fixture 与当前 schema 不一致，不是新路由回归。该测试未在 REL07 修改。

## 可复现命令

```sh
# 真实入口 + 仓库外插件 + 重启
node --import tsx scripts/journeys/plugin-central-stage.ts

# 打包默认发行、生命周期、未知写/撤权和 CLI 备份恢复
node --import tsx scripts/journeys/plugin-central-release.ts

# 默认产物构建/校验/干净目录启动（本单元实际构建了 central,web,mac,android）
node scripts/plugin-distribution.mjs build
node scripts/plugin-distribution.mjs verify
node scripts/plugin-distribution.mjs clean-run

# 架构边界
node scripts/ci/architecture.mjs
```

本单元实际执行的测试批次和失败/跳过数见提交说明；完整日志保存在被忽略的 `.mote/REL07-*.log`，没有把生成产物、凭据或个人信息写入仓库。
