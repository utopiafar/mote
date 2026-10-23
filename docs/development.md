# 开发、验证与环境隔离

开发默认使用 dev 中央 47842，测试使用 test 中央 47852；正式部署 prod 使用 47832。不要用正式中央的配置、令牌、数据库、App profile 或实际屏幕做自动化测试。所有验证素材应由程序生成。

日常修改先看[验证阶段](#validation-stages)与[定向命令](#focused-validation)；大型需求使用[Agent 协作与交接](agent-development-workflow.md)。候选版本的完整检查、回执复用见 [PR 检查范围](#pr-check-scope)，CI 返修见 [CI 反馈闭环](#ci-feedback)。这些是当前工作规则；历史方案、验证记录和旧派单中的检查频率按此更新，原执行证据保留。

## Technical plan review

方案审查按改变的决策分级，不把所有验收器小修都视为新方案：

- 职责、架构、授权与隔离、生命周期契约、数据安全或对外契约变化，先由原 owner 提交有界技术方案，再由独立 reviewer 明确 `APPROVE`，之后才实现。
- 既有批准范围内、保持行为、断言含义和必要覆盖的局部实现或 fixture 状态控制修正，记录 delta 并定向验证，无需重新取得方案批准。
- 放宽断言、超时或成功标准，或改变测试覆盖入口，同样须独立预审覆盖影响，不能用“失败改成通过”代替等价修复。

纯文档修订按本文的文档检查规则处理。已有边界内的普通需求、局部修复及 CI 返修由原负责人推进，按实际变化选择验证；无需为每次提交、测试或草稿 PR 更新新建方案审批。工程方案审查不新增人类产品审批，也不重复完整代码审查。

方案至少包括：准确 base/head 与计划文本身份；旧行为和预期的完整用户入口、输入、准备、处理、产物、消费、时序及失败恢复；`KEEP / CHANGE / REMOVE / EXCEPTION / UNKNOWN`；哪些差异是必要账号/数据/资源/权限隔离、哪些有明确人类例外依据；最小源码与共享文件唯一 owner；消费者、状态转换、正常入口的验证设计；风险、未知项与有界资源。单用户和多用户应使用相同领域流程，不能为隔离缩减配方、输入、独审或产物。

回执记录 reviewer、按难度选择的 Sol Medium/High、准确方案/基线/范围、结论和未决项。不得默认使用 Max/Ultra。实现后的源码审查或测试通过不能追认为开工前方案批准。已有独立方案只在准确范围和假设不变时复用；新范围或假设影响上述决策边界时，先补 delta 审查。产品政策仍由人类决定，已授权工程方案不重复向人类请示。

原 owner 是唯一实现者，共享文件先指定归属；跨模块仍由一个 driver 派发真实资源和完整检查。已在运行的工作正常收尾，不为补流程重复实现、重审不变库存、重跑已准确验证的输入或增加常驻 reviewer。当前恢复工作的准确目标、必要隔离/例外和剩余差异见[越界恢复闭合表与技术方案](design/multiuser-parity-boundary-restoration-plan.md)。源码、生成 fixture、真实 UI/模型/设备证据分别登记；“已恢复”须确认改动确在所称目标分支，并验证原真实入口 A→B→C 与账号隔离对照，诊断简化不能代替它。

## 首次准备

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
node scripts/mote.mjs init --profile dev
node scripts/mote.mjs init --profile test
```

每个环境都有自己的 `.mote/profiles/<name>/mote.yaml`、`data/`、`logs/`、`backups/` 和 `file-sync/`。`file-sync/` 在第一次明确文件导入时创建。初始化不读取根 `.env`，不继承模型 key，不复制正式资料。默认模型预设使用 Codex；仅验证存储、UI 与同步时，可在该私有 YAML 将 `models.deployment.model` 留空。

CLI 不自动初始化，已有 profile 不会被覆盖；重复 init 报错后直接使用已有配置即可。`--home /absolute/test-profiles` 可创建另一整套环境，Docker project 与 volume 也随路径隔离。不要把私有 YAML 加入 Git。旧 `mote.env` profile 会被拒绝；先停止旧版本、保留原目录，再离线手工填写新 YAML，CLI 不自动迁移。

## 日常开发

从当前源码直接启动中央和网页：

```sh
node scripts/dev-server.mjs
```

该脚本自动创建缺失的本地 dev profile，安装变化的依赖，构建共享库、中央与网页，再以前台进程启动。空账号库首次创建管理员 `admin`，密码为 `admin`；可直接在网页或客户端登录。已有账号与修改后的密码不会被重置。按 Ctrl+C 停止本次服务及其子进程。可用 `--home /absolute/dev-profiles --profile NAME` 选择另一套本地开发环境；初始化仅允许 native、loopback、非 prod 且端口不是 47832 的配置。已有旧格式或不完整的 profile 会被拒绝，不自动迁移。

账号初始化失败时，终端输出 `development.initialize_failed` 诊断：配置错误提供 `category: configuration` 和字段位置（例如 `field: models.defaults`）；运行中的数据目录、开发环境限制、存储格式、权限、文件系统及 SQLite 错误提供对应类别，已知系统错误附带错误码。配置值、原始异常、SQL、私有路径和堆栈不会输出；未知异常保留通用初始化失败类别。修正私有 YAML 后重试原启动命令，脚本不会自动删除不受支持的配置或迁移存储。

`dev-server.mjs` 运行当前 checkout 的源码；`node scripts/mote.mjs start --profile dev` 运行 profile 已选定的安装版本。启动排查时同时核对配置选定的 release 和进程记录实际使用的 release。HTTP 健康检查通过后，还应验证受影响账号的实际页面或 API：个人配置在首次访问时加载，健康检查不能证明所有账号配置均兼容。配置字段是否有效应以实际运行版本为准，不能仅根据另一 checkout 的校验结果删除。

已构建中央服务并配置命名 Tunnel 的本机 DEV，可用一个命令前台运行两者：

```sh
npm run up
```

该命令使用 DEV 中已有的 Tunnel 凭据并自动启用隧道，先启动中央服务再启动 cloudflared；按 Ctrl+C 同时停止两者，任一进程退出也会停止另一个。已有中央或隧道实例时会拒绝重复启动。它不执行构建、不启动屏幕采集，也不创建 Cloudflare 域名路由。中央日志仍在 `.mote/profiles/dev/logs/central.log`；cloudflared 原始输出仍由运行器抑制。其他原生 profile 可使用 `node scripts/mote.mjs run-all --profile NAME`。

```sh
npm run dev
```

此命令先构建共享库，再通过 `mote exec --profile dev` 启动 API 热重载和 Vite。API 是所选 dev 端口，Web 默认 `http://localhost:5173`。如果先前用 CLI 后台启动过 dev 中央，先 `node scripts/mote.mjs stop --profile dev`，避免两个进程争用同一个环境。

```sh
# 构建完成后启动独立 Mac App，绑定独立 dev profile
npm run build -w @mote/desktop
npm run desktop:dev
```

Mac 的命名 profile 使用独立的用户数据目录、队列、草稿和连接设置。`desktop:dev` 为新 profile 引导所选中央连接，已有设置不会被后台替换；进入客户端后使用账号登录，旧实例 owner token 不能代替当前登录凭据。通过开发脚本初始化的空库可首次使用 `admin/admin`。首次开始截图仍需要用户在 App 中设置并授权；这些命令本身不会采集屏幕。未命名 App 的 default profile 使用原 Electron 用户数据路径，当前本机格式为 4，旧格式拒绝且不自动迁移，详见 [电脑端说明](desktop.md) 和 [更新说明](updating.md)。

运行 test 环境的同一套热重载界面：

```sh
node scripts/mote.mjs exec --profile test -- npm run dev:workspace
```

test Web 默认 5174。Vite 的代理读取 `MOTE_CONFIG_FILE` 选择的 dev/test YAML 中 `server.port`；没有所选环境或端口为 47832 时会拒绝启动。浏览器 bundle 不包含 `MOTE_*` 配置或令牌。`dev:workspace` 是内部命令，应由 `mote exec` 提供环境。

## CLI 工具使用同一连接

任意已有工具都可在所选环境执行：

```sh
node scripts/mote.mjs exec --profile dev -- npm run demo
node scripts/mote.mjs exec --profile dev -- npm run import:files -- --root /absolute/selected-notes --dry-run
node scripts/mote.mjs exec --profile dev -- npm run import:files -- --root /absolute/selected-notes
node scripts/mote.mjs exec --profile test -- npm run import:files -- --root /absolute/selected-notes
```

导入脚本只读取用户明确选择的 UTF-8 文件夹，默认 `.md,.txt`，单文件不超过 100 KB，不递归隐藏目录或符号链接。加 `--extensions .md,.txt,.csv` 明确类型；`--watch` 每 30 秒检查更改。文件状态基于实际所选节点 URL，落在该 profile 的 `file-sync/`，所以同一个源目录可以分别导入 dev 与 test；成功 ACK 后同环境再次运行会跳过不变文件。原文删除不删除中央历史。

`exec` 清除继承的普通 `MOTE_*` 与 `COMPOSE_*` 参数，设置所选 `MOTE_CONFIG_FILE`，并从同一 YAML 派生设备/工具连接 URL 与令牌。普通进程环境不能覆盖服务端 YAML；只有声明的敏感字段支持 `${SECRET_NAME}` 引用。直接运行 `npm start` 默认读取工作目录的 `mote.yaml`，或显式设置 `MOTE_CONFIG_FILE=/absolute/mote.yaml`；导入工具同样支持该文件选择。`MOTE_ENV_FILE` 已拒绝，根 `.env` 不参与加载。API/model 密钥不要写进命令参数、示例文件或公开诊断。

## Android 开发连接

```sh
adb reverse tcp:47842 tcp:47842
```

开发版 Android 填 `http://127.0.0.1:47842`，并显式允许调试 HTTP。开发 APK 使用独立 application ID 和本地存储，与日常版本分开；实际 Gradle 命令及 HyperOS 设备设置见 [Android 说明](android.md)。手机 loopback 默认指手机本身，USB reverse 断开后待传事件应保留，恢复网络再重试。跨设备长期部署使用 HTTPS。

## 验证命令

<a id="validation-stages"></a>

### 按开发阶段选择验证

先确定这次要证明的行为与风险，再选择最小有效检查。测试规模由受影响行为、接口和消费者决定；“本轮对话结束”或“更新了 PR”本身不扩大范围。

| 阶段 | 谁负责 | 执行与完成条件 |
| --- | --- | --- |
| 纯文档修订 | 作者 | 格式、语法、链接、命令示例和必要的渲染检查；无需安装应用依赖、构建或跑应用测试 |
| 日常实现、普通修复 | 模块负责人 | 受影响测试文件、必要类型检查及直接消费者检查；确认需要的构建前置，失败先定向定位 |
| 中间提交、草稿 PR、模块交接 | 模块负责人 | 记录本轮定向结果与剩余项；范围内行为与定向验收完成后可报告 `implementation-complete`，列出待集成与待验证项；此阶段不要求每个执行者重复完整计划 |
| 跨模块首次接通、接口变化 | 相邻模块负责人和集成负责人 | 尽早用生成数据走真实边界；记录准确组合版本、用户入口、状态变化和结果，覆盖相关授权、隔离、删除或恢复风险 |
| 稳定候选准备合并 | 一个集成负责人；单模块任务由作者兼任 | 冻结候选，完成 `check:affected` 所选任务、必要旅程及适用的 GitHub 检查，达到 `merge-ready` |
| 候选修复、基线更新 | 原负责人和集成负责人 | 重新选择计划，先定向复现与验证，再执行失效任务；符合规则的原始任务回执由驱动显式复用 |
| 发布 | 发布负责人 | 按[发布预检](releasing.md#release-preflight)验证目标 Profile/variant、构建与产物；在创建 Tag 前发现发布配置差异 |

`integration-verified` 表示指定组合上的真实链路已验证，报告须写明是哪条链路；大型需求可先验证一条最小路径，再继续并行补全。最终交付还须确认提交已进入所称目标分支或版本。直接合入 `main` 的独立子 PR 需要自己的合并检查；汇入功能分支的阶段性子 PR 可以先交接定向证据，最终组合由集成负责人验收，仓库现有必需检查照常适用。

授权、隐私、数据一致性、共享接口、生命周期等变化应尽早验证相关真实边界和高风险状态。规模较小不自动降低这些要求。完整套件通过后，只有新改动、新失败或具体覆盖缺口才扩大或重复验证。

<a id="focused-validation"></a>

### 当前可用的定向命令

以下是现有入口，按改动选择执行，不是每次都要跑的清单。先安装所需依赖；只有前置输出缺失或输入变化时才重建相应库。工作区类型检查可能依赖 `shared`、`agent` 等生成声明，真实 Server fixture 还需要可用的原生 SQLite。

```sh
# 仓库根目录：仅显示计划，不执行测试，也不计为通过
npm run check:affected -- --dry-run

# 示例：Server 的 shared / agent 前置缺失或变化时构建
npm run build -w @mote/shared -w @mote/agent
# 按需执行受影响工作区的类型检查
npm run typecheck -w @mote/server
```

Server 使用明确的文件选择，替换默认集合；重复 `--file` 可指定多个文件。文件不存在、为空或不是测试文件时立即失败。原有时限、reporter、真实模型关闭规则和退出/清理行为保持不变：

```sh
# 轻量包装器入口，不自动构建，不产生驱动回执
npm test -w @mote/server -- --file test/import-upload-http.test.ts
# 仓库根目录：共享锁、环境预检、shared/agent 构建和原始回执
npm run check:affected -- --test-file apps/server/test/import-upload-http.test.ts --dry-run
npm run check:affected -- --test-file apps/server/test/import-upload-http.test.ts
# 可重复 --test-file；后续复验可显式添加 --reuse <原始回执>
# 仅修改检查工具时，执行生成 fixture，不构建产品
npm run check:affected -- --component tooling
```

`--test-file` 当前只接受 Server 顶层功能测试，与组件/Git 范围参数互斥。该计划只证明选中的文件，不能作为候选完整检查通过。驱动每次重建 shared/agent 前置；普通包装器要求调用方按输入变化准备已有构建。直接原生 Node 命令及包装器不经过共享资源锁；同机资源冲突时使用驱动入口，不并发启动重型测试。

Desktop 的 Vitest 支持 `npm test -w @mote/desktop -- test/实际文件.test.ts` 文件筛选；Android 可用 `apps/android/gradlew -p apps/android --no-daemon :app:testDebugUnitTest --tests '完整测试类名'`。运行前确认路径或类名存在，并保留该用例所需前置、时限与清理。

当前没有 `check:fast`、`test:focused` 或 `check:full` 脚本；使用上述实际入口。根 `npm test`、`check:local` 和完整受影响计划仍可能耗时较长。日常修改先定向检查，组合候选先确认所有环境前置、相关新增/修改用例及关键真实连接，再执行剩余必要回归；发布继续验证实际分发产物和 Release 配置。

### 功能、性能与真实模型入口

`npm test`、`npm test -w @mote/server`、`check:local` 和 `check:affected` 默认只执行
功能测试；生成素材、loopback 模型响应、真实 HTTP/子进程和必要的重启、撤权、租约与
周期等待仍属于功能回归。大输入的完整性断言和物理并发限制不按名称或耗时自动归为性能测试。
真实模型调用与绝对速度指标使用显式可选入口：

| 入口（仓库根目录） | 范围 | 是否需要显式选择可选模式 |
| --- | --- | --- |
| `npm test` / `npm run check:affected -- --base origin/main` | 整仓功能回归 / 所选组件功能检查；依阶段选用 | 否；执行命令时运行功能模式 |
| `npm run test:performance` | 120 条记录检索的 1 秒指标、2000 块转录 100 次校验的 2 秒指标；同时验证原功能断言 | 是 |
| `npm run test:live` | 既有生成日记的真实 Codex Memory 链路；保留 8 次 query、8 次模型 turn 和既有单次 300 秒预算 | 是 |
| `MOTE_MEM0_TEST_EMBEDDING_CONFIG=/absolute/private/config.json npm run test:live:embeddings` | 两个 Mem0/消费者套件使用明确配置的真实嵌入模型 | 是 |

先构建相关工作区；可选入口也应记录版本、配置身份、结果与耗时。嵌入配置使用既有
`baseUrl`、`apiKey`、`model`、`dimension` 字段，保存在私有本地文件中；默认入口忽略
环境中遗留的真实嵌入配置与可选模式 guard，始终使用生成向量端点。显式模型入口可能产生费用，
功能夹具通过不表示真实模型验收通过。本轮修改测试分组时不自动执行真实模型。
其他 `scripts/benchmark-*` 各有输入要求，仍单独按需运行，不由默认检查或性能入口批量启动。

Server 的 `npm test -w @mote/server` 使用 Node/tsx 按文件隔离运行，默认文件并发为
`max(1, min(可用 CPU 数, 6))`；文件内部仍按原来的顺序执行。长套件已拆成均衡文件，
断言、真实生命周期和原有时限保持不变。需要定向测量时可显式覆盖，例如
`npm test -w @mote/server -- --test-concurrency=4`。并发越高不一定越快：部分场景
自身会启动多路真实子进程，当前配置及测量依据见[Server 测试并行方案](design/server-test-parallelism.md)。

<a id="test-performance-budget"></a>

### 测试性能预算

当前先对 Server 实施软预算：

| 指标 | 建议值 | 超额后的处理 |
| --- | --- | --- |
| 普通测试文件 | 60 秒 | 新增或扩大的文件超额时，拆分独立场景，或记录具体长场景及保留原因 |
| 单个测试用例 | 超过 30 秒提醒 | 检查重复准备、资源等待和可控时钟的适用性，保留必要的真实计时与生命周期 |
| 文件行数、用例数 | 不设性能硬限制 | 用于可读性判断，不能代替实测耗时 |
| 文件并发数 | 不设最低值 | 调整默认值前验证完整套件，并记录总耗时、CPU、内存和失败情况 |

默认 `npm test -w @mote/server` 在原生 spec 输出后列出全部超额文件和用例，不额外运行测试。
这个耗时提醒不执行性能探针，也不启用真实模型；两者仍由上表入口显式选择。
文件使用 Node 的逐文件 summary wall time，不累加可能重叠的父子用例耗时；
case 提醒不包含 suite、skip 或 TODO，失败用例的耗时仍保留。
这些是性能与评审预算，不是新的执行超时或失败门槛；测试失败、取消、原有 deadline 和清理规则照常生效。
中断可能只有部分记录或没有报告，不能据此声称完整通过。

参考环境为 macOS arm64、18 核、64 GiB、Node 26.11.1、npm 11.20.0、默认六文件并发。
不同机器、并发、缓存和后台负载会影响结果；比较时记录这些条件及源码、依赖和构建输入。
一次超额先定位原因，不据此放宽超时，也不通过删断言、跳过场景或缩小必要规模达标。
新增例外应注明精确场景、真实时序或规模依据、现有 timeout 和验证证据；例外继续显示提醒。

已确认需要保留完整流程的长场景如下；说明仅适用于列明 case，不豁免同文件其他测试，也不表示当前耗时不可优化：

- [自动 Insight](../apps/server/test/multiuser-ask.test.ts) 的 `automatic Insight waits for interval AND increments…`，真实等待 61 秒并验证窗口冻结、撤权和重启；[重新登录后的 future authority](../apps/server/test/multiuser-restored-future-authority.test.ts) 的 `password relogin issues fresh future…`，等待恢复后的真实 60 秒周期。均保留原生默认 120 秒时限。
- [千条原件后台导入](../apps/server/test/memory-import-background.test.ts) 的 `HTTP import of a thousand generated originals…`，保留 HTTP 准备/确认路由（Fastify inject）、周期 worker、处理中间态及完整千条收尾，保留既有 390 秒 case timeout。
- Perception 的 [OCR/pixel 实际调用复用监听器](../apps/server/test/multiuser-perception-history.test.ts)、[独立监听器](../apps/server/test/multiuser-perception-history-02.test.ts)，以及 declared kinds 的 [limit 8](../apps/server/test/multiuser-perception-history-04.test.ts) / [limit 3](../apps/server/test/multiuser-perception-history-05.test.ts) 场景，保留同实例内的多路实际执行、限流调整、资源占用及取消顺序，The limit-8/limit-3 cases retain the default 120 s cap. The two physical OCR/pixel-eight cases use a 240 s functional cap after the owner deferred their original latency budgets; see [deferred round-one performance work](validation/performance-round1-deferred-2026-10-21.md). 素材与模型响应为生成 fixture。

其余现有慢文件继续作为性能债列出，详见[性能预算基线与验证记录](validation/server-test-performance-budgets-2026-10-20.md)。
显式传入原生 reporter/destination（含 `NODE_OPTIONS`、下划线别名）时完全交由 Node 处理，避免改变机器可读输出。
需要自定义选择本报告器时，例如从仓库根目录运行：

```sh
npm test -w @mote/server -- --test-reporter=./test/performance-reporter.mjs
```

<a id="background-testing"></a>

### 本地后台测试

本地自动化测试默认不显示窗口、不激活应用、不抢占当前焦点。单测、类型检查、构建及 Gradle JVM 测试直接在终端运行，不需要启动客户端或模拟器。需要 UI 验证时仍运行真实渲染器、preload/IPC 和应用生命周期，使用生成素材与独立测试 profile。

中央网页的首次加载、同范围后台刷新、空状态、滚动时间范围、分页及撤权回归见 [Web 后台刷新稳定性](testing-web-background-refresh.md)。

Electron UI/桌面 fixture 入口必须在导入 `electron` 或产品模块之前加载 `scripts/fixture-background.cjs`（桌面脚本使用对应相对路径）。该测试专用入口强制隐藏窗口、禁止原生窗口获取焦点，并关闭后台渲染节流，使动画帧、DOM 焦点、键盘/滚轮输入及生成页面截图仍可验证。macOS 使用 accessory 激活策略避免 Dock 图标；不使用禁止创建窗口的 prohibited 策略。新建、重建窗口及后续 `show()` / `focus()` 调用均遵守同一规则。产品正常启动行为不变。

```sh
# 后台窗口、真实输入、动画帧、截图和窗口重建的生成 fixture 回归
npm run test:background-ui
# 构建客户端后运行真实桌面 UI 与 profile 重启流程
npm run test:ui -w @mote/desktop
npm run test:profiles -w @mote/desktop
```

隐藏窗口不会自动隐藏系统原生文件选择、消息提示或外部浏览器。因此后台 fixture 遇到未预期的原生 dialog 或 `shell.openExternal` 会报错；未捕获异常（包括 ready 前的启动失败）输出错误并以非零状态退出，避免 Electron 自身显示错误窗口。需要这些操作的测试应在加载入口后提供明确的生成响应或记录目标 URL。原生 Chrome 登录 fixture 已拦截 `/usr/bin/open`；不要为了让测试通过而静默选择取消或绕过授权。资料测试的 `interactive-400` 表示数据和交互场景，默认也隐藏窗口。

确实需要查看界面时，明确设置 `MOTE_TEST_SHOW_UI=1`，例如：

```sh
MOTE_TEST_SHOW_UI=1 npm run test:ui -w @mote/desktop
```

此开关只用于测试进程，会显示 fixture 窗口并允许原生提示；已有生成 dialog/browser 响应仍按各测试原有逻辑处理。自动化 agent 在需要前台 UI、系统授权或人工操作时，应先说明原因和影响；用户明确要求展示时直接按要求执行。隐藏模式不能代替原生焦点、菜单、系统授权等必须前台验证的行为，未执行的检查应单独报告。

Android instrumentation 和 ADB UI 验证优先连接专用、无窗口的 `mote_fixture_api35` 模拟器。以下命令在另一个终端启动它（SDK 路径按本机配置调整）：

```sh
"${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator/emulator" \
  -avd mote_fixture_api35 -port 5580 -no-window -no-audio -read-only -no-snapshot-save
adb -s emulator-5580 wait-for-device
adb -s emulator-5580 shell getprop sys.boot_completed
```

确认 `sys.boot_completed` 返回 `1` 后，再执行 [Android 说明](android.md) 中带明确 serial 的安装、instrumentation 或页面采集命令。`-no-window` 隐藏的是主机上的模拟器窗口，Android Activity 仍可在虚拟设备内部前台运行；不要把 Activity 压到后台，否则不能验证实际页面。`-no-audio` 禁止声音，`-read-only` 和 `-no-snapshot-save` 避免写回 AVD/快照。端口占用时选另一空闲偶数端口并同步更新 serial；不要停止不属于本轮测试的模拟器。

现有 Android E2E 脚本连接已启动的模拟器，不负责启动或隐藏已有窗口。不要对正在使用的真机直接执行会切换页面的测试；需要真机或系统权限交互时，单独安排和报告该验证。本轮结束后只清理本轮创建的测试进程和临时目录。

<a id="pr-check-scope"></a>

### PR 检查范围

准备验证稳定的合并候选时，使用依赖图和构建输入规则选择完整检查范围；日常开发和阶段性交接遵循上面的[验证阶段](#validation-stages)。发布组件与检查工作区分别计算，不因 Web 属于 Central 发布就运行全部 Server 测试：

```sh
npm run check:affected -- --dry-run
npm run check:affected
# 指定 PR 基线；默认 origin/main，先获取最新基线
npm run check:affected -- --base origin/main
# 只核对已提交范围，适用于 CI 或明确提交的验证
npm run check:affected -- --base origin/main --head HEAD --dry-run
# 后续候选显式复用原始回执中输入完全相同且已通过的可复用任务
npm run check:affected -- --reuse /absolute/path/to/mote-check-receipts/receipt-id.json
```

默认范围包含与基线共同祖先相比的已提交改动，以及当前暂存、未暂存和未被忽略的未跟踪文件。移动文件同时检查原位置与新位置，避免把移入文档目录的运行代码误判为纯文档。基线无法解析时命令失败，不会当作无改动跳过检查。`--dry-run` 输出发布组件投影 `affected`、细分范围 `selection` 和实际任务 `checks`，只展示计划，不代表检查通过。

| 改动场景 | 自动检查 | 按实际行为补充 |
| --- | --- | --- |
| 纯文档、根 AGENTS.md、各语言 README、历史发布说明 | 不构建或测试应用；人工检查格式、语法、链接和必要的渲染 | 运行时 prompt、配置及 workspace 内资源按代码输入处理 |
| `docs/design/scope-inventory.json` | scope 契约及检查基础设施回归，不构建应用 | 该文件是检查器的可执行输入，不按纯文档跳过 |
| 仅 Web | Web 类型/测试及共享契约测试；构建 shared、Agent 等实际前置 | Web 集成 fixture 仍使用真实 Server 代码；对应浏览器交互另验，不自动运行整个 Server 套件 |
| 已明确归属的工作区 `test/` 顶层测试文件 | 完整所属工作区测试及其实际构建前置，不因测试修改默认扩大到产品消费者套件 | 共享 helper、fixture 和配置仍保守按消费者选择；跨端读取测试文件的已知例外保留消费者 |
| Server | Server 及 Web 消费者检查、共享契约与中央运行器回归 | 对应 API、导入/查询/Memory 等流程；客户端契约变化补跨端旅程 |
| 仅 `scripts/backup.ts`、`scripts/scoped-backup-schema.mjs`、`scripts/scoped-backup.mjs` | 完整 Server / Web 消费者检查、共享契约、中央运行器、profile/日志保留及根级 security/update 回归；`backup.ts` 额外保留脚本 TypeScript 检查及 diagnostics 声明构建前置 | 这些是实例备份入口与 helper；混合 Desktop、Android、shared 或未知路径继续合并各自义务；移动/改名同时检查旧新路径 |
| Agent / 中央插件 | Agent 的实际消费者，或中央工作区检查 | 对应委派、恢复、插件生命周期及上下文授权 |
| macOS / diagnostics | Desktop 及实际依赖检查、共享契约；diagnostics 变化覆盖 Desktop 消费者 | Desktop 构建、受影响 UI；原生助手/依赖/打包变更在 macOS 编译；权限与系统生命周期单独验收 |
| Android | `check:i18n`、发布工具回归、Gradle debug 单测（包含测试依赖的代码编译） | 对应 variant 构建、lint、instrumentation；后台与权限变化单独真机验收 |
| 共享包或协议 | 检查所有受影响消费者；目前 shared / protocol 选择三端 | 跨端契约与连接/同步生成 fixture；不要把检查范围当作发布范围 |
| 单端发布 workflow | 对应端检查及发布工具回归 | 对应 workflow 的构建、签名和产物身份检查；无关端不构建 |
| 检查选择器、计划、驱动、环境预检及本地检查入口 | 对应检查基础设施回归，包含 CLI 的隔离 Git fixture | 无需应用构建 |
| 明确登记归属的独立验证脚本 | 登记的工作区及实际前置检查 | 独立脚本的旅程须按行为另行执行；登记归属不代表脚本已经执行 |
| 通用发布工具、公共 workflow、根配置/lockfile、未知构建输入 | 保守检查全部消费者 | 相关部署、容器、依赖安装或发布链路 |

所有范围由同一驱动执行，先运行所选环境、翻译、scope 契约和纯发布工具预检，再构建、检查类型、执行工作区测试及其余运行时回归，最后执行所需 Android 单测。环境预检核对 Node、依赖是否安装、Server/Mem0 实际解析的原生 SQLite 能否运行、macOS 隐藏窗口测试所需 Electron 可执行文件，以及 Android 所需 Java/SDK；缺失时直接失败，不自动安装或修复。构建前置与测试消费者分别选择，同一计划中的任务只执行一次；已由构建执行的同份 TypeScript 检查、Agent 隐式构建及共享测试不再重复运行。Server 的 dev-server/profile 运行时回归只随 Server、Central 或全量计划执行，不加入无关 Desktop/Android 计划。实例备份 helper 的根级回归通过真实 CLI 和 profile 恢复入口验证安全边界，并保留更新/回滚测试；全量计划同样包含这两份完整测试入口。

`check:local` 固定选择全部 TypeScript 工作区和根回归；`check:central`、`check:desktop` 固定选择各自工作区，均使用同一驱动。`check:local` 不包含 Android 测试、Desktop 原生编译、浏览器 E2E、真机或真实模型验收。`check:affected` 在共享协议、根配置、lockfile 或未知输入影响三端时仍选择全部 TypeScript 与 Android 单测。新增文案需检查翻译和 Android catalog 同步；shared 和共享翻译目录仍保守选择全部消费者。

完整计划在计划内实现修改收敛、关键故障场景定向验证实际进入目标状态后启动。跨模块组合由一个执行者冻结候选并运行完整计划，其他任务提交自己的精确前置、定向结果和未验范围，不各自重复启动同一组合门禁。若重复试跑始终没有进入要求的租约过期、进程死亡、撤权等目标状态，应改进可观测状态控制或如实记录覆盖缺口；阶段是否完成取决于前置、状态转移和结果断言。

这些入口在同一仓库的所有 worktree 间共享 Git common dir 下的 `mote-check-driver.lock`；已有驱动时，新请求以非零状态报告 `UNRUN`，不会排队或把占用当作通过。输出包含锁的所属进程和工作目录；只有确认原驱动及其子进程都已结束后才手工移除残留锁。不确定或过期锁不会自动抢占，也不终止其他任务。

驱动仍顺序执行，每个正式计划任务声明前置依赖。普通断言、类型检查或构建失败后继续独立任务，依赖失败的任务保留 `unrun`、`prerequisite_failed` 和 `blockedBy`；整体结果仍失败。环境失败、信号中断、运行中输入变化或清理异常立即停止。未声明依赖的外部计划仍遇错停止。不要启动第二个完整计划，或把 `UNRUN` 记录为已执行。定向驱动与完整计划共用同一把锁；原生定向命令仍需自行隔离端口、profile、数据库、浏览器和设备。

每轮回执位于 Git common dir 的 `mote-check-receipts/<id>.json`，只保存输入摘要、逐步状态、耗时及退出/清理结果等元数据，不保存源码、命令输出或凭据。失败、中断和未执行步骤分别保留。一次执行仍冻结运行时输入和计划；运行期间相关输入变化时，保留已执行记录，停止把本轮作为最终候选门禁，重新选择计划。普通文档、根 `AGENTS.md` 和 PR 元数据不进入运行时输入身份；运行时 prompt、配置、scope 清单及 workspace 资源仍是输入。

后续候选使用 `--reuse <receipt-path>` 显式请求按任务复用，不自动寻找旧 PASS；可重复该参数以指定多个原始回执。仅支持 schema v2、同一主机和工作目录、确认清理完成的原始回执。原轮可以因后续无关任务失败或运行时输入变化而失败；能复用的是原本实际通过、退出码为 0、执行前后输入稳定且现在仍完全匹配的任务。中断、锁占用、阻塞、旧格式回执及身份不明的任务均重新执行。驱动比较任务定义、命令参数、所属源码、传递依赖、测试与 fixture/配置、依赖安装和执行环境的摘要，包括安装树和 `PATH` 工具元数据；HEAD 只记录来源，不单独使内容相同的任务失效。Server 完整功能测试按文件名 SHA-256 分入 16 个稳定组，每个文件恰好出现一次；组内仍使用原包装器和 Node 文件隔离/并发。测试文件局部修正只使包含它的组失效，新增/删除文件改变所属组的任务定义。每组保守包含产品源码、共享 helper/fixture、配置和传递依赖；发现测试或 fixture 引用其他 `.test` 路径时，保留整个所属套件作为输入。其他工作区仍按完整套件复用。不推断产品代码的逐文件依赖；不确定输入需要重新执行。定向任务有独立身份，不能填补完整计划中尚未通过的组。

安装树使用本机文件与符号链接元数据识别重装、替换及本地依赖修补；仅排除已确认由 Vite/Vitest 生成的 `node_modules/.vite` 和 `.vite-temp` 输出缓存。工作区 `dist/` 的实际内容也进入消费它的任务身份，相同字节的重建不使任务失效，缺失、篡改或多余旧产物会使其失效。非空 `MOTE_*`、外部进程入口、Node preload/模块搜索或自定义 TypeScript 配置等未建模的外部覆盖，以及无法核对的依赖或工具输入，会禁止自动复用，任务仍正常执行。

任务子进程统一移除调用方的 `CODEX_TOOL_CALL_ID`，输入身份也使用同一执行环境，避免每次工具调用的追踪 ID 制造无关失效。其余继承环境值仍进入摘要；不能只在摘要中忽略一个实际仍会传给测试的变量。

真实 CLI、输入失效、失败轮复用和回执出处的回归记录见[2026-10-20 按任务复用验证](validation/incremental-check-evidence-2026-10-20.md)。

Android 预检与 Gradle 子进程使用同一份解析 SDK 环境；遵守 local.properties 优先级，并在长检查前核对 Java 17+、platform 36 和 build-tools 36.0.0。Android 单测中的真实 Node 后端 fixture 需要 shared/agent 构建与 Server 原生 SQLite 预检，计划显式保留这些前置。环境预检、构建和 Android Gradle 命令每轮实际执行，构建产物不从回执恢复；可复用任务只有输入身份完全相同才记为 `REUSED`，回执保留原始执行来源与身份。`REUSED` 不表示在新 SHA 重新执行，不沿着复用链把旧证据改成新的原始执行。运行期间发现的任务输入变化会保留为 `invalidated`，恢复原内容也不能抹去本轮已发现的不稳定。输入变化、未声明的输入或不稳定的外部条件不能靠同名任务或之前成功来证明；无法建模的检查重新执行。需要设备、模型或指定生命周期状态的旅程证据仍单独验收，通用任务复用不代替它们。

选择器不能从路径证明运行时兼容性。例如 Central 即使没有改客户端文件，若改变了客户端使用的 API、授权或同步契约，仍应补测受影响客户端。反之，内部实现、网页样式或普通服务端修复不默认要求 macOS 编译和单测。仅变更文案通常只需翻译与显示检查；新增翻译目录之外的变化按实际输入范围处理。

追加修改后重新选择计划，执行已失效的检查，并通过驱动显式核对未变任务的原始证据。仅修改 PR 标题/描述不改变被测输入；补充验证文档仍需按纯文档规则审阅，并明确原回执的被测版本。代码、依赖、基线合并或执行环境变化使对应任务重新执行；无法证明影响边界时保守扩大范围。全量 TypeScript 集成检查保留用于跨模块重构最终验收或影响范围不明的情况，不作为每次单端 PR 更新的固定门槛。发布前始终验证发布组件的版本、构建与产物，以及相关安装/升级流程。

验收工具按[方案审查分级](#technical-plan-review)处理：既有批准范围内、保持行为与断言含义的定位、状态控制、清理或实现修正，记录差异并定向验证即可；职责、契约、安全或覆盖影响变化保留独立预审。已有决定仍适用时，复用其范围并记录新增差异，不重复发起同一决策。

当前规则保留（KEEP）生成 fixture、历史回归、消费者检查、先预检、跨 worktree 单驱动和所需旅程验收；改变（CHANGE）为按任务完整输入复用原始证据及明确测试/验证工具归属；移除（REMOVE）全仓 SHA 或无关文档变化引起的任务失效，以及禁止一切跨轮复用；例外（EXCEPTION）环境和构建每轮重跑，共享协议、翻译、根配置及未知输入仍保守扩大；未知（UNKNOWN）CI 是否启用及设备/模型环境能力需实际核实，不能由本地选择器推断。CI 使用同一细分计划，Android 验证仍单独执行；本地通过不代表 GitHub workflow 已运行。历史验证报告保留当时执行记录，不改写成新的验证结果。设计依据与限制见[增量检查证据 ADR](adr-incremental-check-evidence.md)。

以下保留整仓或特定行为的入口，按需要单独选择；不要把代码块作为每次提交的顺序检查清单：

```sh
npm run typecheck
npm test
npm run test:privacy
npm run test:e2e
npm run test:profiles
```

`test:profiles` 使用系统临时目录和随机 loopback 端口，实际创建两套当前 Wire-2 dev/test 中央 Node 子进程。验证首次账号初始化前的公开健康检查、隔离存储、启停和重启，以及拒绝占用端口、旧 owner token 和不属于该配置的 PID；只清理本次创建的进程与目录。不会使用正式 47832、前台 UI 或外部模型。运行前先完成 `build:central`。当前恢复矩阵见 [多用户恢复生命周期](validation/multiuser-recovery-lifecycle-seams.md)，日志与监督器由发布工具回归和 `test-central-runner.mjs` 单独验证。

main 与多用户集成分支合流后的实际检查、原生与浏览器回归、来源版本和未执行范围见 [2026-10-17 合流回归记录](validation/main-multiuser-integration-2026-10-17.md)。历史报告保留当时的源码和执行结果。

问答依赖或 Memory 启动/恢复变化需覆盖正式 HTTP 与应用重启顺序：宽依赖续问跨过执行租约、核对中删除、外联中删除、未激活任务重启休眠、显式启动后的恢复，以及取消/撤权拒绝。使用生成原件与 loopback 模型 fixture；测试次数、真实模型计量和部署版本分别记录。当前回归入口与执行证据见[租约与启动授权验证](validation/query-lease-and-memory-activation-2026-10-14.md)。

```sh
# 需要 Docker Engine 与 Compose 2.30+
npm run test:container
npm run test:profiles:container
```

第二个脚本实际构建本仓库镜像、启动隔离 Compose project，验证命名卷重建、停止后备份、空卷恢复、镜像切换回退、Caddy 配置解析。临时镜像/容器/卷以测试唯一标识命名；不会 publish 或全局 prune。脚本已加入 GitHub Linux CI。本机没有 Docker 时应明确记录未执行，不能将 TypeScript、配置静态检查或之前版本的 CI 结果当作本次容器验证。

真实 DeepSeek / Qwen 调用与实体手机测试需单独记录所用版本、输入是否合成、耗时与失败行为。macOS 权限、HyperOS 后台恢复、公网 HTTPS、launchd 登录/重启行为均不能由上述 fixture 代替。

<a id="ci-feedback"></a>

## CI 反馈闭环

本地与 GitHub 复用现有检查脚本。日常开发做定向验证；集成负责人在候选稳定时本地预检完整受影响范围，再由 GitHub 检查目标环境。已有有效回执按上文复用，不为每次草稿更新再跑一遍完整本地检查。

准备候选时核对最新目标分支，记录 base、PR head 和实际测试的 checkout。`--head` 只选择差异范围，不会检出指定提交；在与候选相符的工作树执行。GitHub 的 PR checkout 可能是测试合并提交，应同时记录其身份。CI 风格的 TypeScript 计划可使用：

```sh
npm run check:affected -- --base <base-sha> --head <head-sha> --typescript-only --dry-run
# 确认候选工作树、环境和计划后执行；Android 在对应环境单独验证
npm run check:affected -- --base <base-sha> --head <head-sha> --typescript-only
```

当前 [Component checks](../.github/workflows/component-checks.yml) 在启用时对草稿与非草稿 PR 使用同一套范围选择；Android Job 仍等待 TypeScript Job。[Checks](../.github/workflows/checks.yml) 是手动完整集成入口。工作流启停和仓库设置独立于文档，状态见实际 Actions；[MVP 检查开关](releasing.md#mvp-阶段的-github-检查开关)保留操作说明。草稿状态用于表达阶段，不能据此预期云端自动减少检查。

PR 负责人在推送后持续处理当前 revision 的结果：

1. 查看实际触发的 run、提交和必需 Job；新提交出现后跟踪新 run，旧提交成功不作为新候选的验证。
2. 失败时读取失败步骤、测试报告和环境信息。确定性代码或断言失败交原模块负责人定向复现、修复、复测，随后更新同一 PR。跨模块接口或产品取舍由协调者处理，其余工作继续推进。
3. 明确的 Runner、下载或服务临时故障可重试失败 Job；重复失败应定位原因。不稳定测试保留原失败与复现条件，修复等待/资源隔离等原因，保留断言与必要覆盖。
4. 复用未失效的本地证据，执行失效范围，并核对新提交的 CI。记录当前成功、失败、取消、跳过和未执行项。环境确实不可用时保留具体阻塞与后续负责人。

已安装并登录 GitHub CLI 时，可用以下命令查看状态和失败日志；确认临时故障后再重试失败 Job：

```sh
gh pr checks <pr-number> --repo utopiafar/mote
gh run view <run-id> --repo utopiafar/mote --log-failed
# 确认临时故障后执行；此命令会触发新的执行尝试
gh run rerun <run-id> --repo utopiafar/mote --failed
```

按实际 CI 对齐 Node 24、lockfile、原生 SQLite、Java/SDK、操作系统与构建 variant。需要定位 Linux 特有问题时使用对应容器或 Runner；macOS 原生、Electron 和签名问题在对应 Mac 环境处理。修改 workflow 时可用已安装的 [actionlint](https://github.com/rhysd/actionlint) 静态检查；[act](https://nektosact.com/) 可用于定向调试 Linux Job，按需使用即可。

### 后续工具改进

以下尚未由本次文档调整实现，应作为独立工程改动验证：

- 给 Server 增加真正替换默认文件集的定向入口，并在统一检查器中提供快速层；保留真实模型隔离、消费者和高风险覆盖。
- 根据输入依赖细化工作区内部选择，继续保留完整候选验证和必要长生命周期用例。
- 调整草稿/候选 CI 分层、Android 无关串行依赖与 Gradle 缓存，核对必需检查及 `ready_for_review` 等触发时机。
- 在驱动中支持独立任务失败后继续、资源调度与更细粒度失效，保留真实状态、清理和回执出处。

这些工具变化按[方案审查分级](#technical-plan-review)处理，验证普通修改的耗时减少和关键消费者覆盖。流程回顾利用已有 CI 与回执数据观察首次 CI 通过率、从候选就绪到通过的耗时、重型检查次数和首次真实链路接通时间，不额外跑整套测试来收集指标。

## 调试与分享诊断

每个中央环境默认开启有上限的结构化诊断，Dev 的 `diagnostics.debug` 默认 `true`，其它 Profile 默认 `false`；显式配置优先。需要调试时只修改正在测试的 `mote.yaml`；enabled/debug/traceEnabled/level 经校验热应用，日志目录与容量参数需要重启。中央界面的运行诊断、Mac 和 Android 的支持包用于查看版本、连接类别、队列状态、数值指标与固定事件。分享前仍应查看导出内容；不要改为转发原始截图、OCR、随手记、模型 prompt 或 token。

原生 `logs/central.log` 默认只保存固定监督事件；未知 SDK/runtime 输出只保存类型与字节数。新 DEV 的 YAML 省略 `diagnostics.maxBytes`，每份最多 100 MiB、3 份；结构化 `central.N.ndjson` 与监督日志分别轮转，各最多 300 MiB。其它 profile 保留每份 2 MiB、3 份。已有 DEV 的显式数值保持不变，主动采用默认值见 [部署说明](deployment.md#dev-log-retention)。支持包、内存事件数和单条日志仍各有自身边界。

Dev 客户端初始开启诊断；Mac Dev build 或 `--profile=dev` 使用 0600 JSON 凭据和配对恢复文件，Android Dev 使用 app-private JSON 设置及文件 AES 密钥，私有内容继续认证加密；均不读取系统密钥存储。Prod 保留原保护。新 Dev 不读取旧加密凭据，也不自动转换，先保留旧目录并创建新的空 Dev 目录（正式 Mac build 的名称仍选 dev），见 [更新说明](updating.md)。第三方 Lark / DingTalk CLI 不受此规则影响。Central 多用户正文 trace 仍由本人显式开启，实例日志只提供固定安全诊断。

## 独立版本与发布

保留 npm workspaces。Central（server + web）、macOS、Android 分别维护版本和标签；改动一个端只发布该端。共享依赖和协议改动需要检查所有受影响端，但不会自动生成其他端的发布。操作、发布产物和迁移说明见 [发布流程](releasing.md) 与 [独立发布架构](release-architecture.md)。
