# 0.0.61 验证记录（发布前工作记录）

本记录仅描述实际执行的验证。共享对话的 55 项需求在 [逐项清单](implementation-backlog.json) 中分别记录证据和未完成部分，不能把本次回归通过等同于 55 项架构工作全部完成。当前清单有 26 项通过所列验收、27 项部分实现、2 项待迁移；尚未发布版本。

## 生成数据与规模

- HTTP 长周期协议测试：480 条跨六个月数据分别走批量和逐条写入，检查重放、版本、同时间戳分页、作用域、删除与中央重启。
- 浏览器二进制导入：480 个原件，分片接收、断点重放、冲突检测、重启恢复、过期回收、入库和原件附件关联；UI 单独验证随手记、Todo、批量导入和 Gmail 连接旅程。
- Gmail：480 封覆盖 480 天的合成邮件，模拟 OAuth、分页、429、增量重放、正文修改/改回、删除、history 过期、全量重扫、撤权和备份恢复。测试没有登录用户邮箱，也没有收集真实邮件。只读范围和附件限制见 [Gmail](gmail.md)。
- 桌面目录同步：100,000 条目录，1,101 个请求，163.19 秒，ACK p95 221.14 ms，浏览 p95 0.47 ms。是桌面 SourceSync 到中央 FileStore 的进程内传输，**不包含网络 RTT**。
- 架构规模测试：20,000 条生成截图观察、100,000 条文件目录、1,000 次文本索引变更，保留独立观察并聚合成 2,001 个内容和 334 个产物。目录耗时 90.08 秒；历史查询 1.39 秒；峰值 RSS 648 MB。这是顺序阶段测试，**不是持续采集、处理和模型问答同时运行的长时间混合负载**。
- 桌面原件分片测试使用 17/20 MiB 生成文件，验证排队后原文件修改/删除不影响固定版本，重启后只发送缺片，错误 ACK 不丢队列。

原始数字见 [目录同步](validation/0.0.61/sync-benchmark.json) 和 [架构规模](validation/0.0.61/architecture-benchmark.json)。测量包含本机并行测试负载，不能作为设备间性能对比或功耗结论。

## 自动测试和 UI

14 组验证全部通过：npm 工作区测试、类型和中英文检查、隐私、端到端采集、媒体统计、MCP stdio/连接、更新与安全、模型安装、运行配置、隧道，以及 Python 归档/音频工具测试。

工作区全量回归当次通过：server 404、desktop 266、web 60、agent 101（另 1 项可选测试跳过）、diagnostics 5、local-inference 13、shared 53。随后分别增加并通过了 1 项 OCR 不响应取消的回归和 1 项 SQLite 初始化竞争回归。类型检查再次通过。

25 组桌面/Web UI 测试已执行。离线同步首次遇到 SQLite 初始化锁竞争；修复 busy_timeout 初始化顺序后单独重跑通过，并用独立线程持有排他事务验证竞争处理。其余 24 组通过。包括：登录、导航、语言、设置草稿、记录筛选/分页/媒体详情、对话、日历提议、Todo、导入、Gmail、连接、离线首次绑定、Shadow 回源、窗口身份和更新网络/回滚。

命令和结果见 [基础套件](validation/0.0.61/suite.json)、[UI 套件](validation/0.0.61/ui.json)。

## Android

使用专用 `mote_fixture_api35` API 35 模拟器、DEV 包 `dev.mote.collector.dev`，没有在物理设备运行，也没有采集个人屏幕。截图只来自测试应用生成画面。

- development APK/androidTest 构建、单元测试、lint 均通过。
- 当前 instrumentation 方法 92 项通过，另外 3 个离线笔记阶段各重复 3 轮通过；6 项可选方法跳过。逐方法结果见 [Android](validation/0.0.61/android.json)。
- 实际验证了无障碍截图、MediaProjection 复用、上传 ACK、隐私排除、状态压缩保留采样、2,000 条记录/去重、懒构建、旋转与后台草稿、配对与节点切换、网络错误分类、本地文件/日历来源删除恢复。
- 长文本 3 轮测试经过真实 force-stop 和 adb reverse 断开/恢复，包含 100,000 字符笔记、复杂 Unicode、调度失败后的固定提交 ID；中央逐字、时间与 SHA-256 核验，重发不重复。
- 跳过项是 4 个需要本地视觉模型权重的方法、旧单独无障碍入口方法和可选系统安装替换方法。无障碍采集由 AppPolicy 的实际测试覆盖；不把跳过方法记为通过。真实签名 APK 错误包名、证书、降级和损坏校验已通过；系统安装替换仍未验证。

复现长文本阶段（仅专用 AVD，connection 文件必须是生成数据测试中央）：

```sh
python3 apps/android/scripts/run-complex-fixtures.py --connection /private/fixture-connection.json --build-type development --rounds 3
```

## 真实模型

本地 Codex Server 的 `gpt-5.6-luna` 实际执行 9 次调用，输入全部为生成数据：2 次分层检索/原文回查及持久语义处理，7 次记忆归属/准入案例。检查第三方陈述不变成用户事实、被动展示不变成偏好、计划不变成完成、项目约束保留范围、删除使产物失效以及注入文本不成为命令。两次检索/处理耗时约 34.26 和 25.99 秒。

该运行时未返回完整 usage，费用保留 `null`，不按零成本计算。9 次调用不是质量全集，也未完成同模型优化前后的质量/费用对照。

## 发布前尚需核验

- GitHub Checks 两轮通过，包含 Docker 容器、Compose 备份/回滚、隧道与协议/工作区全量测试：[push](https://github.com/utopiafar/mote/actions/runs/35616437562)、[PR](https://github.com/utopiafar/mote/actions/runs/35616502313)。这是提交 f67e70a 的 CI 结果，后续提交仍需重新核验。本机没有 Docker。
- 最终提交的 Release workflow、Mac/Android 安装包下载、版本与签名核验。
- 清单中剩余架构工作，包括单一执行引擎、统一资产存储、跨调用预算预留和旧逻辑退役；不能仅凭现有测试通过宣布这些项目完成。
- npm audit 仍有 ExcelJS 间接依赖 uuid 8 的两项 moderate 报告（uuid v3/v5 越界问题；ExcelJS 调用 v4）。未通过强制降级或删除依赖掩盖报告。

## 后续补充验证

- 来源能力注册：10 类来源都复用归档、版本和读取流程；reference 拒绝正文、能力字段不能被客户端伪造；MCP/upload 明确为一次导入，不自动监听或执行外部写入。
- 跨轮摘要：保留既有摘要，仅摘要新增的未覆盖 turn；重复调用不重新压缩；重建读取实例后覆盖游标仍在，编辑旧 turn 则使摘要失效。12 项生命周期/摘要测试通过。
- 200% 浏览器缩放下用真实键盘事件打开导航、进入资料库、打开/关闭原文、Esc 关闭导航并恢复焦点；发现并修复隐藏侧栏仍可聚焦的问题。桌面/窄屏布局回归通过。
- 同依赖下对比基线 3561947 的前端代码：入口 JavaScript 1,286,212 → 1,136,591 bytes，gzip 414,253 → 370,179 bytes。5 轮交替冷缓存、同一生成归档的首页内容就绪中位数 271.3 → 266.1 ms，20 ms 检测粒度，这个差值不能证明明显提速。离屏 Chromium 的 FCP 条目不完整，不宣称 FCP 改善。详细数据见 [前端对比](validation/0.0.61/frontend-comparison.json)。

- 扫描与目录存储：扫描中途目录不可读时，失败标记跨分片和重启持久化；失败 epoch 不判断删除，后续完整扫描才确认缺失。元数据 I/O 最多 4 个并发且保持名称游标顺序。目录 checkpoint 由整段 JSON 改为 SQLite 逐条目录行，修改一项只更新一行；旧 SQLite 内嵌目录会原子迁移。24 项扫描/同步/状态测试通过。
- 后续工作区全量测试通过：server 407、desktop 267、web 60、agent 101 + 1 可选跳过、diagnostics 5、local-inference 13、shared 53。之后新增的 3 项扫描/目录测试在上述 24 项定向回归中通过；离线首次绑定/上传 UI 再次通过。

复现前端构建与首屏对照（两次构建使用当前相同依赖；connection 是专用生成数据中央的私有 JSON）：

```sh
python3 scripts/benchmark-web-bundle.py --baseline 3561947 --out /tmp/mote-web-comparison.json
node_modules/.bin/electron scripts/benchmark-web-startup.cjs --comparison /tmp/mote-web-comparison.json --connection /private/fixture-connection.json --out /tmp/mote-render-comparison.json --generated-fixture
```

编码身份补充：以来源、设备、provider、项目路径身份和真实 session 隔离提取批次。目录卡片保留每台设备的候选项目；显式 Git metadata 可产生剔除凭据的 repositoryKey，用于查询跨设备候选，不能自动扩大 Memory 适用范围。相同项目名而无 Git 信息时不产生统一身份。23 项定向测试通过；随后全量 npm test 通过。

资产存储补充：原件写入已统一为 AssetStore，观察和版本由 EvidenceStore 保存。400 条跨 400 天观察（200 条批量、200 条逐条）与导入、目录原件共享字节，逐类删除不误删其他引用。64 MiB/16 分片提交的 Buffer.concat 最大分配不超过 4 MiB + 128 字节；这只是提交路径分配界限测试，不是全服务 RSS 测量。独立数据库连接的 GC/pin、旧格式、加密切换和备份恢复通过。实现与迁移边界见 [资产存储](asset-storage.md)。

资产改动后的全量工作区回归：server 413、desktop 271、web 60、agent 101 + 1 可选跳过、diagnostics 5、local-inference 13、shared 53，通过；另外配置 4 项、计量/归档 32 项定向回归、类型检查和 5195 条双语检查通过。真实浏览器 Todo/8 文件导入/Gmail 夹具、桌面 Shadow 回源、采集端到端、媒体端到端及隐私脚本再次通过。未改变真实设备与真实邮箱的未验证状态。


### Shared evidence retrieval follow-up (2026-09-22)

- `EvidenceReader` is constructed once with the server and passed to MCP. Agent adaptation, current/historical version decoration, original expansion, file chunk scope and source history now live in that service rather than `app.ts`/MCP SQL. The service stores no credentials or per-request scope.
- Web `/api/context/{browse,search,bundle,read,retrieve}` and MCP share `ContextQuery`. Ranked retrieval (`retrieve`/`mote_retrieve`) uses the Agent's optional-vector/lexical-fallback path; literal `search` remains the exhaustive, keyset-paged path. Ranked results do not pretend to have exhaustive pagination.
- Canonical capture/memory references reject unknown nested prefixes. Original and Memory expansions apply device, source, coding identity and time filters again. Immutable IDs continue to read their original version; deleting an observation removes it from all three entry points. Authorization remains at each protocol boundary, and collectors cannot use these owner APIs.
- Generated test: 400 records over 400 days, 200 individual writes plus two 100-item source batches, with equivalent ranked references and text across Web, a real MCP SDK client and the Agent reader. Includes alternating scopes, old/new versions and deletion. Eight focused tests pass; server suite **415/415** and all-workspace TypeScript checks pass. These are fixture tests, no live model or personal content.
- CI for `8ab6399` failed due to optional `storage.assetDir` passed to a required configuration value. The follow-up supplies the canonical directory fallback; local type checks now pass. Fresh CI must still be checked before release.


### Memory cancellation regression (2026-09-22)

A new regression first reproduced a cancelled extraction saving a late candidate. Memory runs now propagate cancellation to extraction/review, race uncooperative providers, and check cancellation again before validation and commit. Closing returns promptly and leaves the interrupted batch recoverable. The late-response tests assert zero memories and zero checkpoints after cancellation, and a clean restart completes the interrupted batch. All 30 Memory-pipeline/perception tests and server type checks pass. This is a commit-fencing fix; it does not claim the remaining executors are unified.
