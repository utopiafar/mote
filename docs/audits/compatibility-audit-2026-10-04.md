# Mote 旧版本兼容逻辑审计

这是提交 `8d68aef2ddd9f531d88e3337ce97215945222f14` 的原始逐文件审计快照，包含改动前的行号、表示和依赖。后续清理的最终行为、逐项处理与验证结果见[兼容清理实施记录](compatibility-cleanup-2026-10-04.md)；此文件不代表当前代码仍保留全部旧分支。

审计日期：2026 年 10 月 4 日。代码基线：`8d68aef2ddd9f531d88e3337ce97215945222f14`。本报告回答哪些处理用于旧版本、旧数据或旧接口，以及删除它们前必须完成的操作和直接风险。

**结论：确有多组兼容处理，但其中不少已与当前默认初始化、不可变事件重试、权限边界和恢复功能共用代码。可以先清理没有生产入口的工具与旧解析分支；旧队列、密文、源归档和删除意图必须先迁移；当前仍写旧形状的链路必须先重构。**

逐文件程序扫描覆盖 Git 跟踪的 **1696 个文件**，其中 **1684 个 UTF-8 文本文件、194,040 行**，另登记 **12 个二进制文件**。已对兼容候选、数据库结构升级、缺字段回退及调用方进行重点代码复核。逐文件内容读取不等同于逐行人工审阅；没有命中的文件不构成“绝无兼容逻辑”的证明。

下文共有 **83 条分模块审计记录**，同一跨端链路在各端分别列出，以便实际删改时不漏消费者。每条提供源码位置、当前依赖、删除前操作、风险及关联测试。完整逐文件清单含路径、行数、hash、扫描信号行号和关联条目：[扫描清单与结构化结果](./compatibility-audit-2026-10-04.json)。

本次没有修改业务代码，没有读取真实用户归档、采集截图、执行迁移或清空数据，没有运行 fixture 测试、物理设备测试或 live-model 检查。下列测试链接仅说明已有契约与可复用验证位置，不能视为本次已通过，也不能证明跨版本升级无损。

历史版本号没有确切证据时，条目按可验证的旧数据形状、协议字段或 schema marker 描述，不猜测对应发布版本。部分记录是“拒绝不支持的旧格式”或现行升级能力，不应算成可以直接删除的兼容读取器。

## 删除决策

| 类型 | 可考虑删除的内容 | 必须先做的操作 | 主要风险 |
| --- | --- | --- | --- |
| 低风险优先 | Android 旧 WxH 签名解析（ANDROID-10）；Mac/Android 无生产入口的批量解密工具（D05、ANDROID-02）；旧模型 .part 缓存读取（R18）；旧 MCP 私有 JSON 入口（R19）；内置重复 pipeline callback 注册（S32） | 核对外部调用；保留必需旧密文读取；迁移缓存或私有配置；只删内置重复注册，保留现行 recipe 算法；更新关联测试 | 旧工具/连接配置失效，额外下载 |
| 数据迁移后删除 | AES/GCM 读取；旧资产目录；source manifest；JSON/SQLite 队列升级；旧登录和配置缺键迁移 | 暂停相关写入并做一致性备份，保留密钥；逐格式迁移并核对记录身份、原件、绑定、删除意图和引用；限制旧备份再次导入 | 数据不可读、重复或漏传、资料发错节点、已删除内容再生成 |
| 重构当前链路后删除 | file policy 默认迁移；领域状态和 execution 投影；default 模型预设；裸证据 ID；app 排除名单；旧页 ID 映射 | 新安装与当前写方先只产生新格式；同步更新所有消费者/API/插件/离线状态 | 新安装也损坏、当前权限/隐私策略改变 |
| 建议保留或合并 | 旧 epoch/Coding 格式拒绝；当前 ACK、绑定、授权、lease recovery；未知字段保守显示 | 明确支持版本边界；可以合并重复实现或把历史转换移到独立迁移器 | 静默接受不支持数据、取消隐私边界、把未知当事实 |

兼容入口可退役不代表安全校验可退役。尤其 Ingress v2 是断代切换：现有迁移有意清除部分旧未 ACK 内容，不是无损升级。不能把删除这些重置分支等同于“保留了旧数据”，也不能在迁移之前删除旧读取器。

## 主要链路

| 链路 | 当前路径与兼容点 | 删除时需要联动 |
| --- | --- | --- |
| 启动与配置 | env/profile → 数据目录 → epoch 拒绝 → 各 store schema/default/backfill → model/file/OCR 设置 | 新库 schema、旧配置迁移、所有 profile 路径与密钥 |
| 登录与节点归属 | 本机/网页旧 session → 当前 credential → self 协议 → queue/source 绑定 | collector 旧权限别名、会话存储、protocol metadata、dataOrigin/binding |
| 捕获与上传 | 旧队列/Ingress cutover → 隐私 gate → bundle/batch/individual → durable ACK → 中央归档 | 三端 outbox、旧 OCR 补传、不可变 ID、源文件 spool 与能力 pin |
| 来源与文件 | 本机 JSON/SQLite checkpoint → source receipt → source manifest index → 原件 assets → file policy → execution/material | 源 revision、catalog、旧 file ACK、policy fingerprint、工作输入权限 |
| 记忆与对话 | 原始证据/material → extraction/review → Memory catalog/删除意图 → conversation/insight → 查询工具/UI | 旧 review、admission/lineage、批次 pin、时间、引用、历史结果保守读取 |
| 备份与恢复 | 导出原格式与密钥分离 → 验证 checksum → 导入 → store 再触发旧格式读取 | 原件、加密后缀、便携包版本、任务取消/重建与不完整 lineage |
| 发行升级 | component feed → 无 component/v 标签回退 → 签名清单 → source/APK/App 安装与事务恢复 | TS/Kotlin 清单、CLI版本探测、旧候选包；当前回滚保护保留 |

## 扫描覆盖

| 范围 | 跟踪文件 | 文本行数 |
| --- | ---: | ---: |
| Central | 360 | 37,123 |
| Desktop | 172 | 15,637 |
| Android | 256 | 32,404 |
| Web | 165 | 13,779 |
| Shared | 61 | 8,784 |
| Agent | 67 | 5,562 |
| Local inference | 6 | 453 |
| Diagnostics | 4 | 273 |
| Scripts | 223 | 16,543 |
| Docs | 241 | 37,356 |
| Release | 93 | 1,366 |

根配置、Docker/Compose、协议 fixtures、CI、插件、模型清单、示例与许可证同样登记在逐文件清单中。二进制包含 Gradle wrapper JAR 和已有验证 PNG，只登记大小与 hash，没有将图像作为本次测试数据。

## 条目速查

同一条目可以同时包含可退役的旧转换和必须保留的现行处理。风险以未满足前提便删除时为准，具体范围见详情。

| 编号 | 处理逻辑 | 删除风险 |
| --- | --- | --- |
| [R01](#r01) | 握手缺协议元数据默认接受 v1 | 中 |
| [R02](#r02) | 旧任务状态映射与 execution 双表示 | 高 |
| [R03](#r03) | 统一 v 标签和无 component 发布清单 | 中 |
| [R04](#r04) | 旧根目录 env 与 legacy profile 直接启动 | 中 |
| [R05](#r05) | Agent timeoutMs 旧 SDK 参数 | 中 |
| [R06](#r06) | DeepSeek 旧官方根地址重写 | 中 |
| [R07](#r07) | Codex 旧缺速度值补 Standard 与 off 字段映射 | 中 |
| [R08](#r08) | 网页旧会话 url 校验和缺 viewScope 补身份 | 低中 |
| [R09](#r09) | 旧资料页导航转 archive collection 与路由别名 | 低中 |
| [R10](#r10) | 旧网页随手记缺 client 身份与当前 prepared 幂等重试共用 | 高 |
| [R11](#r11) | UUID裸证据引用和注入reader不透明旧ID | 高 |
| [R12](#r12) | 注入 ContextReader 同时接受数组和分页对象 | 中 |
| [R13](#r13) | 旧洞察 Markdown 读取与现行文字模式共用 | 中 |
| [R14](#r14) | 历史费用缺 attribution 与 usage 保守展示 | 中 |
| [R15](#r15) | 旧截图缺 OCR 字段和 charging pending 读取 | 中高 |
| [R16](#r16) | 无 stateSeries 的单次采样回退 | 中高 |
| [R17](#r17) | 缺 inputPlans 的 Memory 批次进度同时服务当前自动任务 | 高 |
| [R18](#r18) | 模型下载旧固定 .part 临时文件恢复 | 低 |
| [R19](#r19) | MCP stdio 支持旧私有 flat connection JSON | 低 |
| [S01](#s01) | 未显式环境名的 legacy profile / 默认 data 目录 | 中 |
| [S02](#s02) | 模型 timeoutMs / MOTE_MODEL_TIMEOUT_MS 旧别名 | 中 |
| [S03](#s03) | 单模型 default 预设兼容多 profile | 高 |
| [S04](#s04) | 旧 collector 凭据取得 owner 权限 | 高 |
| [S05](#s05) | 无后缀加密文件与 vault-wide encryption 身份 | 高 |
| [S06](#s06) | 旧图像/归档资产目录及 MOTE1 包装 | 高 |
| [S07](#s07) | 旧 source-archive manifest 到 SQLite index 的惰性迁移 | 高 |
| [S08](#s08) | 文件旧 flat settings 转 policy 和旧客户端保护 | 高 |
| [S09](#s09) | 旧文件任务 UI revision → 新执行 fingerprint aliases | 中高 |
| [S10](#s10) | 文件/截图旧 running projections 重置为 waiting | 中 |
| [S11](#s11) | 旧 processing DAG authority/依赖迁移到共享 engine | 中高 |
| [S12](#s12) | 旧 query/insight receipts 安装 canonical execution | 中 |
| [S13](#s13) | 启动时 reviewed legacy Memory 自动发布、清 proposed checkpoints | 高 |
| [S14](#s14) | 旧 Memory 删除意图身份/来源 lineage 补齐 | 高 |
| [S15](#s15) | OCR managed settings 和旧连接失败一次性恢复 | 中高 |
| [S16](#s16) | 不支持的旧 vault/Coding 索引启动拒绝 | 高 |
| [S17](#s17) | 旧截图/文件任务没有自动付费处理资格 | 高 |
| [S18](#s18) | 截图/文件/Memory 搜索、依赖与浏览读模型的历史回填 | 高 |
| [S19](#s19) | Material anchors、可见序号及payload删除触发器升级 | 高 |
| [S20](#s20) | Source pipeline 存量工作无storage/checkpoint/generation/recipe pins | 高 |
| [S21](#s21) | 共享Execution步骤/Operation生成关系和optional计数升级 | 中高 |
| [S22](#s22) | 授权账本、Memory草稿和资产储存ledger升级 | 高 |
| [S23](#s23) | 旧无scope自动Memory工作迁移时保留物料并撤销自动重放 | 高 |
| [S24](#s24) | 对话json.turns拆到conversation_turns历史表 | 高 |
| [S25](#s25) | 旧 Memory batch 缺独立 pins，以及当前 Coding 无 pins 路径共用恢复 | 高 |
| [S26](#s26) | 旧人工任务同时选择authored Material和原件的精确一次性复用 | 中 |
| [S27](#s27) | 旧Memory版本、分类和admission元数据读取默认 | 高 |
| [S28](#s28) | 历史缺disclosure依赖时全量保守清理，混有现行不完整依赖保护 | 高（隐私） |
| [S29](#s29) | 旧raw extraction lifecycle任务/cursor与旧Insight时间配置升级 | 中高 |
| [S30](#s30) | 旧任务没有冻结contextTime时使用持久化创建/开始时间 | 中高 |
| [S31](#s31) | 旧Coding Material schema<5含tool正文，被query和Memory读取隔离 | 高（隐私） |
| [S32](#s32) | Source pipeline旧group/organize callback扩展契约与内置重复入口 | 低（仅内置重复字段）/中高（契约） |
| [S33](#s33) | 旧无结构化Transcript产物只允许重新提取后review | 低（改文案）/高（删验证） |
| [S34](#s34) | 旧Import工作缺处理模式/媒体计数/phase fingerprint元数据 | 中 |
| [S35](#s35) | 升级后旧网页lazy bundle404边界 | 中 |
| [S36](#s36) | Portable archive v1新增字段缺省允许较早或精简归档导入 | 中高 |
| [D01](#d01) | Ingress v1 → v2 断代迁移、旧队列本地归档及重新导入 | 高 |
| [D02](#d02) | 来源状态 JSON → SQLite、整数组 → 单 revision 行、内嵌 catalog → 行存储 | 高 |
| [D03](#d03) | Coding evidence 字段兼容旧中央并永久固定 revision 的 wire schema | 高 |
| [D04](#d04) | 仅为旧队列存在的本机 OCR 补做链路及旧节点 OCR 404 兼容 | 中高 |
| [D05](#d05) | 读取历史本机加密 envelope/key；批量解密入口已无生产调用 | 旧读取高风险，未接入工具低风险 |
| [D06](#d06) | 旧默认 profile 沿用原 Electron userData 和启动项语义 | 高 |
| [D07](#d07) | 无 binding/owner marker 的旧目录安全认领 | 高，涉及隐私 |
| [D08](#d08) | 缺新字段的历史配置补齐及排除列表旧新两套共存 | 中高，涉及隐私 |
| [D09](#d09) | 旧 snapshot 音频索引补建独立本机处理任务 | 中 |
| [D10](#d10) | File manifest 未带 state 的旧 ACK 格式容忍 | 中 |
| [D11](#d11) | 旧 support events.json 作为 NDJSON 不存在时的导出来源 | 低 |
| [D12](#d12) | CodingCheckpoint 新 catalog/counter 字段对旧持久化游标的补齐 | 中高 |
| [D13](#d13) | 来源 adapter 版本升级检查和旧缺版本默认1 | 中高 |
| [ANDROID-01](#android-01) | 读取旧 AES/GCM 内容封装，以及遗留可选加密写入开关 | 高 |
| [ANDROID-02](#android-02) | 全域旧内容批量解密工具残留，目前只有测试入口 | 保留旧读取能力时为低风险 |
| [ANDROID-03](#android-03) | Ingress v2 一次性切换：清除旧 outbox、源检查点、上传状态 | 高 |
| [ANDROID-04](#android-04) | 保留旧用户默认完整内容采集，新安装默认只采应用活动 | 中 |
| [ANDROID-05](#android-05) | 旧独立 central-owner-session.enc 一次性导入统一登录 | 中 |
| [ANDROID-06](#android-06) | 服务器未返回 node.protocol 时按旧协商前 v1 接受 | 中 |
| [ANDROID-07](#android-07) | 上传 bundle -> JSON batch -> individual 老端点回退与24小时能力缓存 | 中 |
| [ANDROID-08](#android-08) | 更新器支持旧 v* 统一 release feed 和无 component 的混合清单 | 中 |
| [ANDROID-09](#android-09) | 文件 transport 索引版本不匹配时重建，兼顾旧版与新来源 | 中 |
| [ANDROID-10](#android-10) | 旧 exact 截图签名 WxH:hash 的解析 | 低 |
| [ANDROID-11](#android-11) | 本机随手记旧 mood 字段隐藏读写 | 低至中 |
| [ANDROID-12](#android-12) | 旧本机延迟OCR及OCR补上传队列 | 旧队列处理方案确定前为高风险 |
| [ANDROID-13](#android-13) | 旧未记dataOrigin的设置从server推导节点绑定 | 高 |
| [ANDROID-14](#android-14) | 旧本机来源配置缺新增字段时补默认 | 中 |
| [ANDROID-15](#android-15) | AskActivity 旧入口class保留但已成为当前导航依赖 | 低 |


## 共享协议 网页 Agent 与运行脚本

<a id="r01"></a>

### R01 握手缺协议元数据默认接受 v1

位置：[protocol.ts:19](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/protocol.ts#L19) · [README.md:13](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/protocol/README.md#L13)。

兼容对象：尚未发 node.protocol 的中央；旧严格客户端不能接受额外字段。

触发条件：协议信息 undefined 或 self 请求没有 X-Mote-Protocol-Version。

现行依赖：当前原生请求有协议头；服务端兼顾无头响应。

链路：连接 self/health → TS 与 Kotlin requireCompatible → 应用凭据。

删除前：统一最低支持中央/客户端；要求必有 protocol；同时移除服务端响应字段 opt-in；升级 protocol fixtures，仍保留 ingress v2、权限与 ACK 校验。

风险（中）：新客户端连不上旧中央；强加字段会使旧桌面客户端 strict parse 失败。

判断：需要先迁移或更新调用方。

关联测试：[protocol.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/test/protocol.test.mjs) · [connection.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/connection.test.ts) · [ProtocolCompatibilityTest.kt](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/ProtocolCompatibilityTest.kt)。


<a id="r02"></a>

### R02 旧任务状态映射与 execution 双表示

位置：[execution.ts:84](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/execution.ts#L84) · [execution.ts:133](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/execution.ts#L133) · [migrate-execution-state.mjs:3](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/migrate-execution-state.mjs#L3)。

兼容对象：pending/completed/waiting_for_model/state 等领域状态，缺 execution。

触发条件：旧 JSON 未带 envelope；当前领域表同样沿用这些状态。

现行依赖：当前 files/imports/memory/run-execution 仍调用 executionEnvelope 写或读投影。

链路：领域任务 → executionEnvelope → UI/operation projection；可选脚本补历史 JSON。

删除前：先把全部当前写者/读取者切到统一状态；回填持久 JSON 与 API；兼容投影退役后再删映射。脚本复制了一份早期规则，与 shared 当前规则已不同，不能当通用安全迁移工具直接运行。

风险（高）：直接删会损坏当前任务、错误恢复动作；只删除可选脚本风险低，失去人工补历史 envelope 的入口。

判断：当前链路仍依赖，必须重构后删除。

关联测试：[execution.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/test/execution.test.mjs) · [execution-protocol.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/execution-protocol.test.ts) · [test-execution-compat.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/test-execution-compat.mjs)。


<a id="r03"></a>

### R03 统一 v 标签和无 component 发布清单

位置：[release.ts:49](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/release.ts#L49) · [release.ts:71](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/release.ts#L71) · [release.ts:130](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/release.ts#L130) · [update-release.mjs:8](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/update-release.mjs#L8) · [update-release.mjs:23](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/update-release.mjs#L23)。

兼容对象：vX.Y.Z 全产品标签；清单无 component；根 package.json 版本；Docker 无 OCI version label。

触发条件：找不到组件标签、显式组件包 404、manifest.component 缺、镜像无label。

现行依赖：make-manifest 当前写 component 和组件标签；源包保留 monorepo。

链路：checkRelease → verify → updater/CLI；profileVersion → prepareProfileUpdate。

删除前：确认组件流都有可用签名包；停止支持旧指定版本/源包；为旧部署记录可核验版本后去根 package 与无label探测。DEV UI 当前手动更新，原生自动更新状态需参照 D/A 条目。

风险（中）：旧版升级/固定版本下载/版本识别失效；签名、hash、来源与包身份验证仍需保留。

判断：需要先迁移或更新调用方。

关联测试：[release.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/test/release.test.mjs) · [update-tests.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/update-tests.mjs) · [update-deployment-tests.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/update-deployment-tests.mjs)。


<a id="r04"></a>

### R04 旧根目录 env 与 legacy profile 直接启动

位置：[environment.ts:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/environment.ts#L10) · [client.ts:8](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/client.ts#L8) · [profile-lib.mjs:15](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/profile-lib.mjs#L15) · [Diagnostics.tsx:52](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/Diagnostics.tsx#L52)。

兼容对象：无 MOTE_ENV_FILE/MOTE_PROFILE 的根 .env 与默认 data。

触发条件：直接 npm start 或 scripts client 没指定环境。

现行依赖：目前直接启动仍支持；隔离CLI明确拒绝管理 legacy。

链路：loadEnvironment → server config / scripts client /desktop profile → status。

删除前：明确是否保留直接启动产品入口；将现有部署显式绑定 env/profile/data，不能只把 profile 默认改 dev；再改示例和CLI文档。

风险（中）：新配置可能指错数据目录、换掉令牌、看起来仓库为空。

判断：仍是受支持入口，删除会改变产品用法。

关联测试：[environment.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/test/environment.test.mjs) · [client.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/client.test.ts)。


<a id="r05"></a>

### R05 Agent timeoutMs 旧 SDK 参数

位置：[types.ts:92](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/types.ts#L92) · [model-runtime.ts:37](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/model-runtime.ts#L37) · [index.ts:251](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/index.ts#L251) · [index.ts:324](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/index.ts#L324) · [codex-session.ts:86](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/codex-session.ts#L86) · [codex-import.ts:12](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/codex-import.ts#L12) · [codex-agent.ts:47](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/codex-agent.ts#L47)。

兼容对象：一个 timeoutMs 同时承担模型请求和完整 agent deadline。

触发条件：未指定新字段而传旧 timeoutMs。

现行依赖：server 调用传双字段；第三方注入仍可旧签名。

链路：AgentOptions → Harness/Codex/exported agent factory → 请求/总deadline。

删除前：扫描所有 SDK/插件/脚本调用；明确 null 含义；统一传 requestTimeoutMs 和 agentTimeoutMs，再从类型和实现删 fallback；连同 server env/JSON/API 别名处理。

风险（中）：旧调用失去原超时，可能改成默认导致过早失败或长占用；部分 fixture 刻意传很短旧值。

判断：需要先迁移或更新调用方。

关联测试：[timeout.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/timeout.test.mjs) · [model-runtime.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/model-runtime.test.mjs)。


<a id="r06"></a>

### R06 DeepSeek 旧官方根地址重写

位置：[model-providers.ts:19](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/model-providers.ts#L19) · [model-runtime.ts:75](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/model-runtime.ts#L75)。

兼容对象：https://api.deepseek.com 与 /v1 旧根。

触发条件：协议显式为 deepseek 或省略协议使用默认 deepseek，baseUrl 恰好是两个旧官方根地址。

现行依赖：当前 preset 使用 /anthropic；旧已保存 profile/env 可以旧根。

链路：saved/env → modelConnection → messages runtime。

删除前：规范化全部 profile/env/自定义外部配置；不重写自定义gateway；之后删函数和所有调用。

风险（中）：旧地址下请求路径错误、模型调用失败。

判断：需要先迁移或更新调用方。

关联测试：[model-runtime.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/model-runtime.test.mjs) · [model-settings.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/model-settings.test.ts)。


<a id="r07"></a>

### R07 Codex 旧缺速度值补 Standard 与 off 字段映射

位置：[model-settings-form.ts:31](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/model-settings-form.ts#L31) · [model-reasoning.ts:6](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/model-reasoning.ts#L6) · [model-providers.ts:44](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/model-providers.ts#L44)。

兼容对象：旧 Codex profile 无 serviceTier；Mote 存 off 而外部协议叫 none。

触发条件：缺速度字段；外部catalog返回 none。

现行依赖：当前 Mote仍把 off 作为统一枚举；priority/fast 是现行外部协议翻译。

链路：模型profile → UI draft/catalog → Codex turn/start。

删除前：先回填 Codex serviceTier；若统一 off 改 none，须迁移所有持久设置/HTTP协议参数和全部消费者。不能只因注释 older 删映射，priority/fast转换仍是现行能力。

风险（中）：速度选择或推理选项无法显示、协议拒绝请求。

判断：缺值 default 可迁移后删；off/none 仍是当前契约。

关联测试：[model-settings-form.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/model-settings-form.test.ts) · [model-reasoning.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/model-reasoning.test.ts) · [codex.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/codex.test.mjs)。


<a id="r08"></a>

### R08 网页旧会话 url 校验和缺 viewScope 补身份

位置：[session.ts:85](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/session.ts#L85) · [session.ts:112](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/session.ts#L112)。

兼容对象：mote.connection={url,token,...} 或没有 viewScope。

触发条件：读取旧 session/local storage。

现行依赖：persistSession 当前不写 url，总生成 viewScope。

链路：启动 main → readStoredSession → restore → ensureViewScope → period view storage。

删除前：可发布一次浏览器存储升级或让用户重新登录；删除前应拒绝所有旧形状而非忽略 url，否则外节点凭据可能被送到当前节点；清理旧 period 时不删除离线 notes。

风险（低中）：重新登录/时间筛选丢失；误删服务边界校验有凭据跨节点风险。

判断：需要先迁移或更新调用方。

关联测试：[session.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/session.test.ts)。


<a id="r09"></a>

### R09 旧资料页导航转 archive collection 与路由别名

位置：[workspace-route.ts:2](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/workspace-route.ts#L2) · [navigation.ts:8](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/navigation.ts#L8) · [agent-view.tsx:8](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/features/agent-view.tsx#L8) · [main.tsx:262](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/main.tsx#L262)。

兼容对象：timeline/materials/files/memories 页ID及 system/agent 路由。

触发条件：旧书签、现行 onPage 调用或 feature pageId 触发。

现行依赖：现行feature entries和首页仍注册/使用旧页ID，mapping也用于新导航。

链路：readPage/onPage → canonicalDestination → #/library?view=…。

删除前：先把当前 page entries、onPage、原生跳转、测试全部改统一collection；再决定旧书签 redirect期限，不能只删 const mapping。

风险（低中）：旧书签/当前导航落错页，功能页布局改变。

判断：兼容和现行路由共用，先更新调用方。

关联测试：[workspace-route.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/workspace-route.test.ts) · [feature-host.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/feature-host.test.ts)。


<a id="r10"></a>

### R10 旧网页随手记缺 client 身份与当前 prepared 幂等重试共用

位置：[notes-state.ts:47](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/notes-state.ts#L47) · [index.ts:105](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/index.ts#L105) · [index.ts:105](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/index.ts#L105)。

兼容对象：旧网页 prepared note 无 client:web，应用归属 dev.mote.notes。

触发条件：相同草稿已有 prepared，升级后传入新版web identity。

现行依赖：新网页写client:web；当前Mac/Android仍合法省client。

链路：local NoteOutbox prepared → upload → noteCapture → same-ID dedup。

删除前：排空旧 web outbox 或继续保留已准备 payload；不能给已尝试上传的同 ID 补 client，这会把 capture.appId 从 dev.mote.notes 改为 web；prepared 原样复用是现行崩溃恢复与幂等机制，旧存量归零也要保留；若统一原生 client 需三端协议改造。

风险（高）：同ID不同payload冲突、重复笔记或离线草稿无法提交。

判断：可退役的是旧 web 身份形状；prepared 原样复用必须保留。

关联测试：[notes-state.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/notes-state.test.ts)。


<a id="r11"></a>

### R11 UUID裸证据引用和注入reader不透明旧ID

位置：[evidence-ref.ts:5](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/evidence-ref.ts#L5) · [evidence-ref.ts:11](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/evidence-ref.ts#L11) · [bridge.ts:333](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/bridge.ts#L333) · [evidence-route.ts:6](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/evidence-route.ts#L6) · [evidence-reader.ts:198](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-reader.ts#L198)。

兼容对象：裸UUID、第三方reader非UUID opaque ID、bare artifact logical id。

触发条件：传入ID未含capture:/memory:；legacy injected reader。

现行依赖：当前 evidence/citations 和不少API仍返回/传裸id；不是历史数据消失就能删。

链路：发现/ref → bridge normalize → scope/grant → reader/server detail。

删除前：统一所有discover/API/citations/SDK至typed ref和pinned artifact ref；转换保存的答案/笔记/书签和第三方接口；保留wrong-kind与授权验证。

风险（高）：证据详情/引用/文件读取失效；错把source ID当证据会破坏授权边界。

判断：当前API仍使用裸ID，必须整体改契约。

关联测试：[evidence-ref.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/test/evidence-ref.test.mjs) · [citations.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/citations.test.mjs) · [scope.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/scope.test.mjs)。


<a id="r12"></a>

### R12 注入 ContextReader 同时接受数组和分页对象

位置：[types.ts:28](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/types.ts#L28) · [types.ts:57](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/types.ts#L57) · [bridge.ts:658](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/bridge.ts#L658)。

兼容对象：timeline/sourceItems 返回 ContextRecord[] 而非 ContextPage。

触发条件：Array.isArray(page)。

现行依赖：现行server走分页；注入reader和fixture仍支持数组。

链路：reader.timeline/sourceItems → bridge projection → tool response。

删除前：要求插件与fixture统一{items,nextCursor,totalCount?}；先验证可继续分页，再删union和array分支。

风险（中）：第三方reader/fixture直接报invalid page；分页完整性假设变更。

判断：需要先迁移或更新调用方。

关联测试：[agent.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/agent.test.mjs) · [layers.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/layers.test.mjs) · [scope.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/test/scope.test.mjs)。


<a id="r13"></a>

### R13 旧洞察 Markdown 读取与现行文字模式共用

位置：[InsightReport.tsx:39](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/InsightReport.tsx#L39) · [insights.ts:33](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/insights.ts#L33) · [insight-runs.ts:62](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/insight-runs.ts#L62)。

兼容对象：历史 QueryResult 仅有 answer/citations，可能缺 snapshot；artifact 可选的 Markdown 结果当前仍受支持。

触发条件：artifact缺失（历史结果或当前允许的纯Markdown），或用户选择文字视图。

现行依赖：server insights.ts33 当前JSON解析失败仍返回原Markdown结果；InsightReport文字标签也使用同一AnswerMarkdown分支。

链路：insight_runs/query history → InsightReport → AnswerMarkdown。

删除前：如只退役历史格式，需按明确结果schema区分历史，而不能以artifact缺失区分；若删除整个Markdown分支，须先改变当前输出契约并取消/替换Text标签。没有原范围不能捏造历史snapshot，转换历史正文也不应重跑模型。

风险（中）：直接删会损坏旧报告、当前纯Markdown洞察与文字模式；重跑旧报告产生不同内容和费用。

判断：历史可读性与现行结果形态共用，不能作为纯旧分支删除。

关联测试：[archive-workflows.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/archive-workflows.test.ts)。

补充：新 InsightRuns 创建时生成 snapshot；历史 snapshot 缺失只能依据原始保存信息处理，不能从 artifact 是否存在推断。


<a id="r14"></a>

### R14 历史费用缺 attribution 与 usage 保守展示

位置：[usage.ts:111](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/usage.ts#L111) · [usage.ts:117](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/usage.ts#L117) · [Usage.tsx:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/Usage.tsx#L10)。

兼容对象：用量记录没有attribution，旧回答未记usage。

触发条件：receipt.attribution/answer.usage缺失。

现行依赖：主机当前写attribution，但第三方和旧导出可能缺。

链路：UsageStore grouping → usageIdentity → facets/filter/UI。

删除前：只按可靠operation/job元数据补归属；无法恢复的保留unknown，不按用户内容猜分类；若退役旧记录先导出并明确报表范围。

风险（中）：统计分组错误或旧回答报错；不能推断未上报token为0。

判断：unknown 仍有现行缺测语义，建议保留。

关联测试：[usage.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/usage.test.ts) · [usage.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/usage.test.ts)。


<a id="r15"></a>

### R15 旧截图缺 OCR 字段和 charging pending 读取

位置：[metadata.ts:56](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/metadata.ts#L56) · [capture-presentation.ts:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/capture-presentation.ts#L34) · [index.ts:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/index.ts#L34)。

兼容对象：旧screen仅ocrText，无ocr状态；老客户端charging pending。

触发条件：缺ocr则按已保存text/ocrEnabled投影，否则unknown。

现行依赖：新capture有明确ocr；历史队列/导入仍旧表示。

链路：archive/vector worker/store preview → captureOcrState → web/Android detail。

删除前：历史状态可按已有事实补completed/disabled，不能凭空把unknown改未识别；排空旧本地OCR及backup；去charging UI前完成D/A链路。

风险（中高）：历史OCR过滤、向量待处理判断、已保存文字显示或老队列同步损坏。

判断：历史兼容和缺测语义共用，保留unknown。

关联测试：[metadata.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/test/metadata.test.mjs) · [capture-presentation.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/capture-presentation.test.ts)。


<a id="r16"></a>

### R16 无 stateSeries 的单次采样回退

位置：[state-series.ts:15](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/state-series.ts#L15)。

兼容对象：单活动/状态事件没有stateSeries。

触发条件：event.stateSeries undefined。

现行依赖：当前单样本、多类来源也可没有stateSeries；仅适用状态扩展的记录生成series。

链路：客户端dedupe/state延长 → server time accounting → activity report。

删除前：若强制新shape，先定义哪些source必须有series，回填单观测为一元素，更新TS/Kotlin时间合约；不要删除非stateOnly合法事件。

风险（中高）：旧样本丢时长，跨设备测量统计改变。

判断：现行合法单样本仍依赖，不能直接删。

关联测试：[metadata.test.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/test/metadata.test.mjs) · [StateSeriesTest.kt](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/StateSeriesTest.kt)。


<a id="r17"></a>

### R17 缺 inputPlans 的 Memory 批次进度同时服务当前自动任务

位置：[MemoryProgress.tsx:54](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/MemoryProgress.tsx#L54) · [MemoryProgress.tsx:57](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/MemoryProgress.tsx#L57) · [Memories.tsx:104](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/src/Memories.tsx#L104) · [memory-pipeline.ts:257](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L257) · [memory-pipeline.ts:326](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L326)。

兼容对象：旧memory job没有inputPlans/recipeProgress/memoryCount。

触发条件：job是当前普通/自动create路径或旧历史，没有inputPlanVersion；手动方案路径才带plans。

现行依赖：memory-pipeline.ts257 当前普通create不写inputPlanVersion；326 manualPlans才写version1；200持久化主动剥离inputPlans/recipeProgress/memoryCount，读时派生；自动记忆仍使用createFromArtifacts。

链路：memory-jobs API → Memories/MemoryProgress → retry/action。

删除前：先决定是否将当前自动/普通提取全部改为输入方案架构，再升级写者和API，迁移运行与历史任务。旧memoryCount缺失显示可在所有接口保证计数后缩减，但不能据此删除无inputPlans批次路径。

风险（高）：直接删会破坏当前自动/普通记忆任务的进度、重试和取消，清空旧job也不能消除此依赖。

判断：属于现行两条任务路径共用，必须先重构自动任务。

关联测试：[archive-workflows.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/archive-workflows.test.ts) · [resource-views.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/web/test/resource-views.test.ts)。


<a id="r18"></a>

### R18 模型下载旧固定 .part 临时文件恢复

位置：[index.ts:77](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/local-inference/src/index.ts#L77) · [index.ts:81](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/local-inference/src/index.ts#L81) · [index.ts:134](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/local-inference/src/index.ts#L134)。

兼容对象：model.gguf.part 旧无进程归属临时文件。

触发条件：partials遇到固定.part。

现行依赖：现行下载总写 .part-PID-UUID。

链路：ModelStore.inspect/download → claimPartial → resume。

删除前：确认无固定.part生产写方；给旧partial一次性转换/删除策略；保留当前PID检查和Range续传。

风险（低）：旧已下载片段不会续传、额外模型下载流量/磁盘占用；已验证完整模型不受影响。

判断：可优先移除，先处理旧缓存。

关联测试：[model-store.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/local-inference/test/model-store.test.ts)。


<a id="r19"></a>

### R19 MCP stdio 支持旧私有 flat connection JSON

位置：[mcp-connection.mjs:6](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/mcp-connection.mjs#L6) · [mcp-stdio.mjs:2](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/mcp-stdio.mjs#L2)。

兼容对象：{url,token}旧私有文件 vs UI导出的mcpServers.mote HTTP JSON。

触发条件：JSON exact keys token,url。

现行依赖：UI当前导出HTTP JSON；老手工连接文件仍可能。

链路：--connection → parseMcpConnection → streamable HTTP bridge。

删除前：只读取受权连接配置后显式转换JSON，不打印token；更新文档和fixture；仍保留私有文件权限、HTTPS与禁止command执行校验。

风险（低）：旧Chatbot stdio配置无法启动，需要转换文件。

判断：可优先移除，需转换私有连接文件。

关联测试：[mcp-connection-tests.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/mcp-connection-tests.mjs) · [test-mcp-stdio.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/test-mcp-stdio.mjs)。


## Central 兼容处理

<a id="s01"></a>

### S01 未显式环境名的 legacy profile / 默认 data 目录

位置：[config.ts:63](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/config.ts#L63) · [updates.ts:18](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/updates.ts#L18)。

兼容对象：无 MOTE_PROFILE 或独立 env/data 目录的部署。

触发条件：环境未设置 MOTE_PROFILE。

现行依赖：configFromEnv 仍可写出 profile=legacy。

链路：loadEnvironment → configFromEnv → configuration/status/connections/updates。

删除前：为所有部署指定 profile、MOTE_ENV_FILE 和绝对 MOTE_DATA_DIR，核对现有目录后移除 default/分支。

风险（中）：部署起不来或指向另一个空数据目录。

关联测试：[config.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/config.test.ts) · [configuration.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/configuration.test.ts) · [updates.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/updates.test.ts)。


<a id="s02"></a>

### S02 模型 timeoutMs / MOTE_MODEL_TIMEOUT_MS 旧别名

位置：[config.ts:74](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/config.ts#L74) · [model-settings.ts:62](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L62) · [model-settings.ts:72](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L72) · [model-settings.ts:81](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L81) · [model-agent.ts:48](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-agent.ts#L48) · [model-agent.ts:59](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-agent.ts#L59)。

兼容对象：旧单 timeout 代替 modelRequestTimeoutMs / agentTimeoutMs。

触发条件：旧 env、旧 model-settings.json 或旧 HTTP settings envelope 有 timeoutMs。

现行依赖：现行 commit 写双 timeout；config 仍带 modelTimeoutMs。

链路：env/readSaved/API draft → normalize → 双 timeout → agent。

删除前：转换 env、主 settings 和全部 profiles，升级旧 API 客户端，再移除别名与 Config 字段。

风险（中）：配置校验失败；默认 deadline 悄然改变。

关联测试：[model-settings.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/model-settings.test.ts) · [config.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/config.test.ts) · [model-settings-api.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/model-settings-api.test.ts)。


<a id="s03"></a>

### S03 单模型 default 预设兼容多 profile

位置：[model-settings.ts:51](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L51) · [model-settings.ts:209](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L209) · [model-settings.ts:223](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L223) · [model-settings.ts:227](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L227) · [model-settings.ts:399](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-settings.ts#L399)。

兼容对象：顶层 settings；没有 profiles/defaults/defaultModels。

触发条件：旧 settings 文件/客户端；功能默认不传 profile。

现行依赖：顶层 settings/default 已仍可被 update 写；并非仅历史存量。

链路：model routes → ModelSettingsStore → feature model selection。

删除前：将顶层 settings 显式转换为命名 profile，迁移功能默认值和所有持久 job 引用，重构旧 update/reset API。

风险（高）：默认模型、凭据、任务 profile 失配；defaults 更改可能错误保留模型 ID。

关联测试：[model-profiles.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/model-profiles.test.ts) · [model-settings.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/model-settings.test.ts)。


<a id="s04"></a>

### S04 旧 collector 凭据取得 owner 权限

位置：[connections.ts:103](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/connections.ts#L103) · [connections.ts:15](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/connections.ts#L15) · [app.ts:160](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/app.ts#L160)。

兼容对象：历史配对凭据 scope=collector。

触发条件：读取旧 client-connections.json 且 scope=collector。

现行依赖：当前Connections.redeem72/session111明确写scope=owner；collector是历史别名，owner为现行合法管理路径。Android现行会以owner写状态，不能删owner分支。

链路：Connections.init → authenticate → isOwner → HTTP owner routes。

删除前：保持 hash/id/撤销信息原子改 scope=owner；升级 schema/客户端 capabilities，同步修改 owner/collector 撤销筛选。

风险（高）：历史设备被当成非 owner，管理/读取访问中断；权限映射必须明确。

关联测试：[connections.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/connections.test.ts) · [central-workflow.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/central-workflow.test.ts)。


<a id="s05"></a>

### S05 无后缀加密文件与 vault-wide encryption 身份

位置：[content-encryption.ts:28](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/content-encryption.ts#L28) · [content-encryption.ts:58](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/content-encryption.ts#L58) · [content-encryption.ts:76](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/content-encryption.ts#L76) · [asset-worker.ts:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/asset-worker.ts#L10)。

兼容对象：settings.encryption key hash；parts/originals 无 .plain/.aes 后缀。

触发条件：无后缀文件或没有 content-key-id。

现行依赖：write 当前总是 .plain/.aes。

链路：backup/asset/archive/upload reads → ContentEncryption.selected/open；worker 复制同逻辑。

删除前：备份密钥，完整枚举 originals/parts/uploads/staging/source-archive 与未入 DB 文件；校验后规范化后缀；验证 backup restore 后移除 legacyEncrypted。

风险（高）：旧密文被读作明文、缺密钥、原件永久不可读取。

关联测试：[content-storage.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/content-storage.test.ts) · [import-backup.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/import-backup.test.ts) · [assets.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/assets.test.ts)。


<a id="s06"></a>

### S06 旧图像/归档资产目录及 MOTE1 包装

位置：[assets.ts:48](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/assets.ts#L48) · [assets.ts:133](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/assets.ts#L133) · [assets.ts:154](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/assets.ts#L154) · [evidence-store.ts:566](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L566)。

兼容对象：assets.format=image-legacy/archive-legacy；blobs/hash MOTE1、files/hash。

触发条件：catalog 回填或 asset 格式非 chunks。

现行依赖：现行 AssetStore.put/putUpload 写 chunks；catalog 首次把 blobs/file_blobs 映射到 legacy。

链路：ingest/archive/file readers → assets.stream/bytes → legacy。

删除前：运行 asset.migrate 每个遗留 asset；verify hash/大小；确认引用、导出恢复、GC 和加密转换；之后去 old tables/readers。

风险（高）：截图、导入原件、range 读取、备份恢复失效。

关联测试：[assets.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/assets.test.ts) · [archived-files.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/archived-files.test.ts) · [import-backup.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/import-backup.test.ts)。


<a id="s07"></a>

### S07 旧 source-archive manifest 到 SQLite index 的惰性迁移

位置：[source-archive.ts:42](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-archive.ts#L42) · [source-archive.ts:77](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-archive.ts#L77)。

兼容对象：source-archive/hash/manifest heads/versions/pendingGroups；缺 append_epoch/head_count。

触发条件：source_archive_indexed_sources 无 source 且 manifest 存在或旧 columns 缺失。

现行依赖：receive 当前写 SQLite index+batch，不写 manifest。

链路：source receipt → readVersion/currentSnapshot/groupCheckpoint/receive → ensureIndexed。

删除前：逐 source 强制索引化并核对 versions/heads/checkpoints/pendingGroups；补齐 column；备份恢复 fixture 全验再移除 manifest reader。

风险（高）：归档看似空、历史版本找不到、已排队任务 checkpoint 失效或漏处理。

关联测试：[source-archive-index.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-archive-index.test.ts) · [source-archive-reader.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-archive-reader.test.ts)。


<a id="s08"></a>

### S08 文件旧 flat settings 转 policy 和旧客户端保护

位置：[file-processing.ts:44](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-processing.ts#L44) · [file-processing.ts:65](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-processing.ts#L65) · [file-processing.ts:130](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-processing.ts#L130) · [file-policy.ts:7](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-policy.ts#L7) · [file-configuration.ts:20](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-configuration.ts#L20)。

兼容对象：dailyAudioMinutes、flat sourceProfiles/typeProfiles/audioProcessor 等；无 policy。

触发条件：旧 file-processing.json 或首次新库也无 policy；旧 settings HTTP 未传 policy。

现行依赖：默认新实例也 saved.policy undefined，update 未传 policy 时继续 flat 写入。

链路：file-processing.json → policy/fileConfiguration → fingerprint/admission/processor；update 禁止旧客户端改新版方案。

删除前：先让新库/更新只写显式 policy，迁移现有 services/profiles/rules/credentials 和 job.policy_json；升 API 后删 flat selection。

风险（高）：当前默认处理也依赖迁移函数；删除直接影响新安装、ASR/image/text/document privacy/service mapping。

关联测试：[file-policy.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/file-policy.test.ts) · [file-config-snapshot.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/file-config-snapshot.test.ts) · [file-processing.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/file-processing.test.ts)。


<a id="s09"></a>

### S09 旧文件任务 UI revision → 新执行 fingerprint aliases

位置：[file-processing.ts:93](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-processing.ts#L93) · [file-processing.ts:267](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-processing.ts#L267)。

兼容对象：files.pipeline/summary step.input.revision 是 saved.revision UUID。

触发条件：未终结 step 的 revision 等于旧 saved revision。

现行依赖：prepare 当前 enqueue fingerprint。

链路：prepare/update → rememberLegacyConfigurations → aliases → exists → shared engine。

删除前：排空/显式取消旧步；把 input revision 与 alias 保持一致完成迁移；确认无 alias 依赖后删表/字段。

风险（中高）：有效旧 job 被判 stale/cancel；重复提取导致额外模型费用。

关联测试：[file-config-snapshot.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/file-config-snapshot.test.ts)。


<a id="s10"></a>

### S10 文件/截图旧 running projections 重置为 waiting

位置：[file-processing.ts:51](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-processing.ts#L51) · [perception.ts:43](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/perception.ts#L43) · [memory-pipeline.ts:385](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L385)。

兼容对象：file_jobs/file_steps/perception_jobs running 但没有 execution_steps。

触发条件：升级共享执行引擎前的旧 projection 存量。

现行依赖：现行 running ownership 在 execution_steps；memory-pipeline385-388亦将无engine step的旧running batches/jobs恢复pending/queued。当前pausing→paused重启修复须保留。

链路：constructors → reset → prepare → engine.enqueue。

删除前：将所有没有 engine step 的 projection 终结或显式转换 engine step，再删重置 SQL；保留现行 lease recovery。

风险（中）：旧任务永久 running；若无 proof 删除会漏处理。

关联测试：[lifecycle-execution.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/lifecycle-execution.test.ts) · [perception.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/perception.test.ts) · [file-processing.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/file-processing.test.ts)。


<a id="s11"></a>

### S11 旧 processing DAG authority/依赖迁移到共享 engine

位置：[processing-runtime.ts:117](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/processing-runtime.ts#L117)。

兼容对象：processing_jobs state/attempts/lease 为 authority；processing_dependencies。

触发条件：settings.execution-dag-v1 不存在。

现行依赖：现在 enqueue → execution_steps，processing_jobs 为 projection。

链路：ProcessingRuntime constructor → migrate → shared engine。

删除前：所有旧 processing_jobs/依赖导入 engine；更新基线 schema 不创建旧 dependency 表；确保 failed retry state/outputs 保留。

风险（中高）：旧工作丢失、依赖未满足而执行、artifact 身份断裂。

关联测试：[architecture-upgrade.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/architecture-upgrade.test.ts) · [execution-engine.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/execution-engine.test.ts)。


<a id="s12"></a>

### S12 旧 query/insight receipts 安装 canonical execution

位置：[run-execution.ts:41](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/run-execution.ts#L41)。

兼容对象：query_runs/insight_runs 没 execution_steps。

触发条件：constructor 遍历历史 runs 且 step 不存在。

现行依赖：新 run start 直接 engine.enqueue。

链路：QueryRuns/InsightRuns init → RunExecution.restore → receipt-only enqueue。

删除前：一次性回填 historical steps 和 operation dates，确保旧 waiting/running 标 interrupted；只删 prior 缺失路径，保留活 owner heartbeat/restart failure。

风险（中）：历史操作页不完整或重启继续显示 running；误删现行 restore 会破坏多进程 owner recovery。

关联测试：[operation-runs.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/operation-runs.test.ts) · [query-runs.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/query-runs.test.ts) · [insight-runs.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/insight-runs.test.ts)。


<a id="s13"></a>

### S13 启动时 reviewed legacy Memory 自动发布、清 proposed checkpoints

位置：[memory.ts:44](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory.ts#L44)。

兼容对象：proposed memory + bounded-exact-review@1 receipt；旧 extraction checkpoint。

触发条件：MemoryStore 每 store 首构造；未加一次性 marker。

现行依赖：当前 pipeline 使用 reviewed publication；须进一步查 checkpoint 清理仍有当前语义。

链路：MemoryStore constructor → activateReviewedLegacy → publish。

删除前：扫描 proposed receipts/evidence，明确 publish/review/reextract；迁移 checkpoint；增加格式版本后移除 startup mutations。

风险（高）：合格旧记忆不再可查询；未审草稿被 checkpoint 永久跳过。

关联测试：[memory-review.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-review.test.ts) · [memory-revisions.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-revisions.test.ts)。


<a id="s14"></a>

### S14 旧 Memory 删除意图身份/来源 lineage 补齐

位置：[memory-deletions.ts:20](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-deletions.ts#L20) · [memory-deletions.ts:25](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-deletions.ts#L25) · [memory-deletions.ts:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-deletions.ts#L10)。

兼容对象：deletion dependencies 无 origin/lineage；json 无 derivationSourceIds/sourceLineageComplete。

触发条件：缺 columns、空身份、缺 source 字段。

现行依赖：当前 deletion writer 写完整权限 lineage。

链路：MemoryStore → MemoryDeletions → migrate → permission checked deletion reuse。

删除前：备份删除意图，仍在的依赖补 identities；已 retention 删的保留 incomplete=false；升级 backup schema 再删除 defaults/backfill。

风险（高）：用户已删除内容可能被再生成；来源权限判断缺漏。

关联测试：[memory-deletion-permissions.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-deletion-permissions.test.ts) · [memory-automatic-deletion.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-automatic-deletion.test.ts)。


<a id="s15"></a>

### S15 OCR managed settings 和旧连接失败一次性恢复

位置：[perception.ts:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/perception.ts#L34) · [perception.ts:119](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/perception.ts#L119)。

兼容对象：旧 perception 配置缺 managed endpoint；旧 failed processor_failed。

触发条件：managed-ocr-v1 / ocr-worker-recovery-v1 markers 缺失。

现行依赖：新库也靠 managed-ocr-v1 分支初始化 managed endpoint。

链路：buildApp(mediaAssets) → Perception ctor/refreshWorker。

删除前：拆出新库 managed defaults，迁移老 settings；手动处理旧 failed 队列；再移除历史恢复 marker。

风险（中高）：新库没有 OCR endpoint；旧错误保留 failed；不要删除现行 worker ready/model missing retries。

关联测试：[perception.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/perception.test.ts)。


<a id="s16"></a>

### S16 不支持的旧 vault/Coding 索引启动拒绝

位置：[evidence-store.ts:54](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L54) · [app.ts:112](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/app.ts#L112)。

兼容对象：无 backend_epoch=2 的 populated vault；captures 中 Coding event。

触发条件：数据库已有任意 table/旧 Coding captures。

现行依赖：新库写 epoch 2，新 Coding source pipeline 不写旧 captures。

链路：config → EvidenceStore → buildApp cutover。

删除前：若坚持 fresh-only，可保留/统一 explicit unsupported guard；只有支持真迁移才可移除门槛。

风险（高）：删拒绝后旧库会伪装成 v2，污染 archive、权限/可见性/旧索引；这不是运行兼容。

判断：保留明确拒绝旧格式的边界；可合并实现，不能静默删除校验。

关联测试：[backend-epoch.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/backend-epoch.test.ts) · [architecture-upgrade.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/architecture-upgrade.test.ts)。


<a id="s17"></a>

### S17 旧截图/文件任务没有自动付费处理资格

位置：[file-schema.ts:38](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-schema.ts#L38) · [evidence-store.ts:119](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L119)。

兼容对象：file_jobs/perception_jobs 无 auto_eligible；补列后把所有存量任务置 0，新行默认 1。

触发条件：数据库尚无 auto_eligible 列；新库 CREATE 也没声明，启动同样通过 ALTER 安装列。

现行依赖：现行新capture/file任务依赖默认1；用户明确重试另行授权，存量任务不能因安装模型自动重放。

链路：EvidenceStore→fileSchema/perception schema→FileProcessing/Perception admission→shared engine。

删除前：迁移旧任务 auto_eligible=0 并冻结基线；把列和默认写入新建 CREATE；只删除检测/旧行 UPDATE，保留资格判定及显式重试。

风险（高）：直接删 ALTER 新安装SQL报错；给旧任务默认1会静默重新OCR/转写、耗费模型费用或扩大个人数据处理。

关联测试：[perception.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/perception.test.ts) · [file-processing.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/file-processing.test.ts)。


<a id="s18"></a>

### S18 截图/文件/Memory 搜索、依赖与浏览读模型的历史回填

位置：[evidence-store.ts:133](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L133) · [evidence-store.ts:142](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L142) · [evidence-store.ts:153](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L153) · [evidence-store.ts:154](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L154) · [evidence-store.ts:162](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L162) · [file-schema.ts:23](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-schema.ts#L23) · [read-models.ts:5](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/read-models.ts#L5) · [read-models.ts:33](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/read-models.ts#L33) · [source-catalog.ts:14](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-catalog.ts#L14) · [memory.ts:52](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory.ts#L52) · [memory.ts:76](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory.ts#L76) · [evidence-archive.ts:21](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-archive.ts#L21) · [evidence-archive.ts:57](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-archive.ts#L57) · [evidence-archive.ts:73](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-archive.ts#L73) · [read-models.ts:36](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/read-models.ts#L36)。

兼容对象：历史captures无context_at/context_end；FTS text/rowid版本旧；旧Memory与file chunk祖先缺memory_dependencies；gallery/count/source目录/Memory scope索引不存在；早期captures未生成context_observations/context_dirty，context_dirty缺error/changed_at，archive FTS缺行。

触发条件：settings gallery-v1/trigram-v1/search_text_version/fts-rowid-v2/read-models-v1/source-catalog-v1/memory-catalog-v2 缺失或索引行缺失。

现行依赖：当前写者用同事务triggers维护投影；captures新CREATE仍无context列；索引/计数/依赖安装同时属于fresh bootstrap；read-models-v1 同时为新空库 seed blob_counts 单行，当前 blob triggers 只 UPDATE 不 INSERT。

链路：EvidenceStore启动→fileSchema/readModels/sourceCatalog→MemoryStore；请求用读模型检索/分页/保留期，删除通过精确依赖级联。

删除前：先离线生成并校验所有投影（FTS含现行OCR、rowid一致；chunk→capture依赖；context按sourceContentTime）；以最终schema建新库；保留当前triggers及投影表，只移除一次性历史扫描/marker和确认不需修复的missing-row backfill；为所有原件建立context observations/dirty与archive FTS后去掉evidence-archive-v1回填；保留当前capture观察triggers和故障error记录。；必须把 blob_counts(id=1,n=0,bytes=0) 新库 seed 独立保留，否则新库插入 blob 永远不累计。

风险（高）：搜索/相册/数量/Memory筛选漏数据，历史Memory删除级联失效；不能只删整初始化函数。无逐vault完成证明不能判断历史回填可删。

关联测试：[memory-admission.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-admission.test.ts)。


<a id="s19"></a>

### S19 Material anchors、可见序号及payload删除触发器升级

位置：[materials.ts:169](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/materials.ts#L169) · [materials.ts:174](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/materials.ts#L174) · [materials.ts:181](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/materials.ts#L181)。

兼容对象：material_heads无min_visible_sequence；material_evidence无invalidated；material_blocks无anchor_id/identity_hash；material_revisions无draft_hash；旧payload删除trigger只检查material_blocks。

触发条件：PRAGMA列不存在或trigger SQL未包含material_block_versions。

现行依赖：现行发布/检索/删除使用这些列；非Coding物料仍写material_blocks，Coding使用material_block_versions，两个layout都是当前有效。

链路：MaterialStore ctor→publish/block version/anchor→EvidenceReader/Memory extraction→retire/privacy delete→shared payload GC。

删除前：补旧anchor严格关联material/revision/block；迁移列/默认并在fresh CREATE声明；最终payload删除trigger须直接安装并检查两个当前引用表，之后删除旧trigger识别/转换分支。

风险（高）：SQL失败、原件锚点缺失/引用错误、旧序号可见性失真或共享payload误删除。不能把material_blocks整体当旧表删。

关联测试：[materials.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/materials.test.ts)。


<a id="s20"></a>

### S20 Source pipeline 存量工作无storage/checkpoint/generation/recipe pins

位置：[source-pipelines.ts:74](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L74) · [source-pipelines.ts:114](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L114) · [source-pipelines.ts:272](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L272) · [source-pipelines.ts:150](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L150) · [source-pipelines.ts:246](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L246)。

兼容对象：bindings无storage；旧work无generation/archive_checkpoint/memory_trigger、recipe版本/定义/config/component pins；旧无checkpoint行从archive补。

触发条件：旧 schema 缺列，旧 work archive_checkpoint 为 null 需补存；memory_trigger 缺省 rebuild。recipe_id 为 null 本身不是历史判据：当前 callback pipeline 合法使用 null recipe pins（见 S32）。

现行依赖：新 work 记 archive checkpoint；recipe pipeline 写不可变 recipe pins，而当前 callback pipeline 仍写 null recipe pins 并支持版本更新。当前 CREATE bindings 缺 storage、work 缺 memory_trigger，ALTER 也服务新库。

链路：source receive→archive immutable batch/head→enqueueWork→recipe executor→MaterialStore publish→MaterialMemoryWork readiness。

删除前：迁移 bindings storage 和旧缺 checkpoint 的 work；recipe 工作只能依据原保存信息补 pins，无法重建时取消或明确手动重建。不要给当前 callback 工作强行补 recipe。fresh schema 补列；若退役无 recipe 契约，须按 S32 同步更新插件和所有工作；保留现行插件版本重建及禁止自动模型重放策略。

风险（高）：读取错误原件、重复建物料/模型付费、按新recipe处理旧未授权工作；删fresh ALTER启动失败。

关联测试：[source-pipelines.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-pipelines.test.ts) · [source-recipe-integration.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-recipe-integration.test.ts) · [material-memory-work.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/material-memory-work.test.ts)。


<a id="s21"></a>

### S21 共享Execution步骤/Operation生成关系和optional计数升级

位置：[execution-engine.ts:60](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/execution-engine.ts#L60) · [operation-projection.ts:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/operation-projection.ts#L10) · [operation-projection.ts:35](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/operation-projection.ts#L35) · [operation-projection.ts:53](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/operation-projection.ts#L53) · [processing-runtime.ts:53](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/processing-runtime.ts#L53)。

兼容对象：execution_steps无recovery_deadline；operation links无slot/generation/active/optional；operation_progress未创建；optional旧投影仅排除blocked；usage无input_characters。

触发条件：列缺失，operation-projection-v1或operation-optional-terminal-v2 marker缺失。

现行依赖：当前engine/operation hierarchy、linkOperation generation及计数必须一直工作；fresh基表省略部分新增字段且通过升级路径装最新trigger。

链路：ExecutionEngine→installOperationProjection→历史host metadata恢复generation→incremental operation counters→API运行看板。

删除前：回填links时保留所有历史并确定现行generation；校验计数与执行step；将最终表/列/四个v2 trigger直接安装到fresh基线；只移除旧重建与trigger替换分支，保留runtime projection/hierarchy、recovery逻辑。

风险（中高）：新库缺列，UI错误显示已完成/失败、历史步骤丢失或当前generation失真；recovery_deadline影响租约恢复的正确性。

关联测试：[operations.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/operations.test.ts) · [operation-runs.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/operation-runs.test.ts) · [execution-engine.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/execution-engine.test.ts) · [architecture-upgrade.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/architecture-upgrade.test.ts)。


<a id="s22"></a>

### S22 授权账本、Memory草稿和资产储存ledger升级

位置：[memory-input-authorization.ts:25](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-input-authorization.ts#L25) · [memory-input-authorization.ts:27](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-input-authorization.ts#L27) · [memory-extraction-drafts.ts:12](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-extraction-drafts.ts#L12) · [storage-ledger.ts:11](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/storage-ledger.ts#L11) · [assets.ts:28](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/assets.ts#L28) · [material-organizers.ts:494](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-organizers.ts#L494)。

兼容对象：memory_input_authorizations无binding_json/revoked_at；drafts无shared；旧storage账本重复计blobs/file_blobs/file_objects、旧授权row-size triggers；资产ref投影未装；organizer inputs旧schema无material_id；当前CREATE已包含，单独ALTER可在旧库迁移后删除。

触发条件：列/marker缺失，旧ledger triggers/数值仍在。

现行依赖：新授权有不可变recipe binding及撤销；drafts.shared及asset_references属于当前复用/GC；旧blobs/file_blobs/file_objects仍作为当前域对象，不是可整表删除的废表。

链路：raw receive→MemoryInputAuthorization→scoped work/paid admission；asset put/delete→asset refs/GC→StorageLedger quotas；extraction draft→bounded review reuse。

删除前：补列、重新计算最终ledger和ref计数；fresh直接定义最终字段/trigger；保留当前授权/撤销/草稿共享/ledger动态表发现，只移除旧schema转换和旧重复计数triggers清理。

风险（高）：权限错误或已撤销授权复活，配额重复/漏计；资产引用漏记导致sweep误删；动态schema缺表/缺列容错也覆盖当前初始化顺序，不能整体删除。

关联测试：[memory-input-authorization.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-input-authorization.test.ts) · [assets.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/assets.test.ts) · [material-memory-work.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/material-memory-work.test.ts)。


<a id="s23"></a>

### S23 旧无scope自动Memory工作迁移时保留物料并撤销自动重放

位置：[material-memory-work.ts:29](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-memory-work.ts#L29) · [material-memory-work.ts:45](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-memory-work.ts#L45) · [material-memory-work.ts:50](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-memory-work.ts#L50) · [material-memory-work.ts:65](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-memory-work.ts#L65) · [material-memory-work.ts:84](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-memory-work.ts#L84)。

兼容对象：material_memory_work或无scope material_memory_requests：缺recipe binding、context_time、input fingerprint；迁移到memory.default，auto_authorized=0，记录job revocation。

触发条件：旧表存在或requests没有scope；新增source_required_json时按required_json回填。

现行依赖：当前observe从不可变原件授权产生scope/binding/time/fingerprint；production recipes存在时无binding行available=false，不自动重放。

链路：Material发布→MaterialMemoryWork ctor迁移→revocations/cancel→observe(receipt grant)→drain→MemoryPipeline。

删除前：执行升级迁移并证明旧jobs被撤销/取消，物料/产物/ready状态保存；基线CREATE加source_required_json/input_fingerprint后删除两种旧表转换；不要给旧行补造自动授权或套新recipe。

风险（高）：重启重复模型付费或无原始授权跑新scope；简单丢表导致准备状态/关联历史丢失；直接去掉ALTER使fresh缺列。

关联测试：[material-memory-work.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/material-memory-work.test.ts) · [memory-input-authorization.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-input-authorization.test.ts)。


<a id="s24"></a>

### S24 对话json.turns拆到conversation_turns历史表

位置：[conversations.ts:18](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/conversations.ts#L18) · [conversations.ts:88](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/conversations.ts#L88)。

兼容对象：conversations.json内嵌整个turns数组；turn缺status；header无turnCount/bytes/revision。

触发条件：conversation-turns-v1 marker不存在；提取旧turns并按有result推completed否则failed。

现行依赖：当前保存分开写header和conversation_turns，header不写turns。

链路：Conversations启动→json turns搬迁→历史分页/working compaction→disclosure invalidation。

删除前：转换每条旧turn和idx/status、header字节/count/revision，验证对话分页与lineage；fresh保留建turns表后去掉旧json扫描和marker。

风险（高）：历史对话突然为空；删内嵌数组而没先落表造成不可恢复丢失；错误revision还影响工作记忆缓存。

关联测试：[conversations.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/conversations.test.ts) · [conversation-lineage.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/conversation-lineage.test.ts) · [combined-backup-recovery.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/combined-backup-recovery.test.ts)。


<a id="s25"></a>

### S25 旧 Memory batch 缺独立 pins，以及当前 Coding 无 pins 路径共用恢复

位置：[memory-pipeline.ts:298](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L298) · [memory-pipeline.ts:310](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L310) · [memory-pipeline.ts:290](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L290) · [app.ts:411](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/app.ts#L411) · [memory-pipeline.ts:236](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L236) · [memory-pipeline.ts:610](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L610)。

兼容对象：旧 StoredBatch.materialInputs 缺失时沿用 job.materialInputs。app understandConversation 的 legacyPin 分支对 materialInputs 空数组也生效；这同时包含当前非 recipe Coding create 路径，并非只有旧 batch。

触发条件：batch.materialInputs === undefined 触发旧 job pin 投影；input.materialInputs.length === 0 触发 conversation pin 恢复，当前 writer 也可能产生该形状。

现行依赖：当前 makeBatches 始终写 materialInputs 数组、materialRefs/artifactRefs/planIds；但未提供 recipes/automaticGrant 的当前 create 可不生成 pins，形成 materialInputs=[]，仍调用 understandConversation 并使用 app legacyPin。

链路：load memory_batches→batchScope→materialAdmission→conversation preparation/processingMaterialInputs→extract/review/commit。

删除前：保留旧 job/batch 关联逐项迁移 pins，依原保存策略恢复；模糊时保留原全 job 授权或终止旧 job，不能改取当前 live Material。完成或取消旧 batch 后可删除 batchScope 历史 fallback。要删除 app legacyPin，必须先让当前所有 Coding create 路径冻结 conversation pins，不能仅迁移旧 batch。

风险（高）：授权范围改变、旧 job 无法恢复、错误材料进入模型或重复费用；给旧 batch 默认 [] 会丢 pins；删除 app 分支还会损坏当前未携带 recipe 的 Coding create 路径。

关联测试：[memory-artifact-composition.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-artifact-composition.test.ts) · [memory-material-gate.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-material-gate.test.ts) · [memory-manual-selection.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-manual-selection.test.ts) · [memory-authored-selection.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-authored-selection.test.ts)。


<a id="s26"></a>

### S26 旧人工任务同时选择authored Material和原件的精确一次性复用

位置：[memory-pipeline.ts:419](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L419) · [memory-pipeline.ts:447](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L447) · [evidence-reader.ts:511](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-reader.ts#L511) · [evidence-reader.ts:291](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-reader.ts#L291)。

兼容对象：旧manual job重复列Material与对应raw original；旧已完成raw batch无planIds/materialInputs/artifact refs。

触发条件：Material plan已blocked memory_authorization_revoked；同模型/profile/config、strategy、exact original fingerprint/quote和bounded-exact-review receipt全部吻合；仅一个完成batch匹配。

现行依赖：当前manual selection排除authored对应原件，当前new plans有inputPlanVersion/pins；该reuse仅显式recheck旧blocked plan。

链路：manual recheck→evaluatePlan→resolved original→exact completed batch检查→把原件已审结果计一次，不伪装成Material输入。

删除前：迁移或结束旧重复 manual plans 并记录已完成结果；可删除 completedAuthoredCoverage 及专用公开 wrapper authoredMaterialOriginalForReuse。保留私有 authoredMaterialOriginal：它仍被当前选择去重、物料曝光和 Memory admission 使用，也须保留正常 review。

风险（中）：旧recheck不能复用已付费审阅结果，重复抽取/Memory或仍blocked；安全条件不可削弱为按标题/文本相同复用。

关联测试：[memory-authored-selection.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-authored-selection.test.ts) · [memory-manual-selection.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-manual-selection.test.ts)。


<a id="s27"></a>

### S27 旧Memory版本、分类和admission元数据读取默认

位置：[memory-schema.ts:37](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-schema.ts#L37) · [memory.ts:139](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory.ts#L139) · [memory.ts:62](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory.ts#L62) · [memory.ts:63](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory.ts#L63) · [memory.ts:165](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory.ts#L165) · [memory-integration.ts:56](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-integration.ts#L56)。

兼容对象：历史Memory无version/domain/tier/kind/admission/evidence的新增字段；get缺version=1，catalog domain personal/tier episode/kind episodic/version1，无admission.layer归legacy。

触发条件：读取旧json缺字段；模型输出走非strict低层extract亦可无admission。

现行依赖：production app Memory pipeline requireAdmission=true；低层MemoryStore.extract(options={})仍是当前库API，可写legacy卡；当前memory查询只认layer=memory，legacy不能自动获得资格。

链路：MemoryStore.get/catalog→page/text/Android→Memory integration；Memory extract→provenance validation→published/projected layer。

删除前：清点缺字段卡，明确补version1及默认分类；缺admission/精确原件必须保留legacy或模型重新review，不能伪造layer memory；先收紧所有当前调用方和writer再改strict schema/defaults；有意可选关系/valid intervals不要误判为历史兼容。

风险（高）：旧Memory不可读或筛选消失；默认升级layer会把未审产物当可信Memory；低层当前调用/fixtures亦破坏。

关联测试：[memory-admission.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-admission.test.ts) · [memory-automatic-deletion.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-automatic-deletion.test.ts) · [memory-integration.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-integration.test.ts) · [memory-pipeline.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-pipeline.test.ts)。


<a id="s28"></a>

### S28 历史缺disclosure依赖时全量保守清理，混有现行不完整依赖保护

位置：[evidence-store.ts:675](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L675) · [conversation-lineage.ts:4](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/conversation-lineage.ts#L4) · [conversation-lineage.ts:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/conversation-lineage.ts#L10) · [query-runs.ts:41](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/query-runs.ts#L41)。

兼容对象：旧QueryResult/working_memory/query_run无evidenceDependencies或version不支持；引用列表不能证明所有模型实际读过的原件和派生产物。

触发条件：删除/保留期清理时version!=1、complete!=true或ids与被删证据交集；缺/aggregate disclosure一律清理相关历史prose。

现行依赖：当前agent聚合检索也会complete=false，注入query消费者可无dependencies；lightweight store缺graph也属当前用途，不应连完整性保护一起删。

链路：user delete/retention→invalidateConversationAnswers→working memory delete/query event文字剥离/conversation answer替换；combine/resolve ancestors冻结lineage。

删除前：只可在所有保留历史结果有显式正确version和完整依赖后去掉missing/unsupported version兼容；否则清除旧prose或留guard；complete=false和当前删除revision保护必须保留，不能从citations补造依赖。

风险（高（隐私））：被删原件的内容继续留在历史回答/工作记忆；保守fallback换成空ids会漏清理；此项不是可整体移除的legacy分支。

关联测试：[conversation-lineage.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/conversation-lineage.test.ts) · [evidence-dependencies.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/evidence-dependencies.test.ts) · [evidence-exposure.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/evidence-exposure.test.ts) · [query-runs.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/query-runs.test.ts)。


<a id="s29"></a>

### S29 旧raw extraction lifecycle任务/cursor与旧Insight时间配置升级

位置：[lifecycle-extensions.ts:29](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/lifecycle-extensions.ts#L29) · [memory-lifecycle.ts:60](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-lifecycle.ts#L60) · [memory-lifecycle.ts:74](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-lifecycle.ts#L74) · [memory-pipeline.ts:182](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L182) · [config.ts:107](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/config.ts#L107) · [app.ts:432](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/app.ts#L432)。

兼容对象：旧 lifecycle Memory job 直接 raw 证据且无 artifactRefs；旧 extraction stream=evidence cursor 不可用于 artifact。MOTE_INSIGHT_INTERVAL_HOURS 虽命名 legacyInsightHours，但仍是当前新安装初始配置入口。

触发条件：layered-extraction-v3 缺失时取消未完成 lifecycle raw jobs 并清旧 extraction/insights state；extension 转 artifact 重置 cursor；当前首次 settings 初始化也采用 insight interval 环境变量。

现行依赖：当前 layered extraction 使用 artifact stream；legacyArtifactIds 是当前截图/人工原件有效入口。config.ts 读取 MOTE_INSIGHT_INTERVAL_HOURS 并经 app.ts 传入新库 settings 初始化，环境变量采用仍有现行生产依赖。

链路：register lifecycle→原cursor reset→discover semantic artifact→Memory pipeline；startup cancel旧raw job防重复抽取。

删除前：完成一次 cancel/reset 并保留明确 settings/新 stream cursor，确认旧 raw jobs 已终止、历史 Memory/原件保留，之后可删一次性 marker 和旧 stream 转换。删除 interval adoption 前须保留新安装环境变量映射，或同步明确退役该 env 参数及全部消费者；存量 settings 已迁移不能单独满足前提。

风险（中高）：旧 cursor 导致漏处理、重复抽取或费用；误删当前 env 映射使新安装忽略用户配置；不能按 legacy 命名删除当前 screen/authored artifact 生命周期。

关联测试：[architecture-upgrade.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/architecture-upgrade.test.ts) · [lifecycle-execution.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/lifecycle-execution.test.ts) · [memory-lifecycle.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-lifecycle.test.ts) · [memory-integration.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-integration.test.ts) · [memory-authored-selection.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-authored-selection.test.ts)。


<a id="s30"></a>

### S30 旧任务没有冻结contextTime时使用持久化创建/开始时间

位置：[memory-integration.ts:63](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-integration.ts#L63) · [memory-pipeline.ts:647](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L647) · [memory-pipeline.ts:255](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-pipeline.ts#L255) · [app.ts:417](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/app.ts#L417)。

兼容对象：旧active integration window.contextTime缺失→startedAt；MemoryJob.contextTime缺失→createdAt。

触发条件：从SQLite载入旧window/job，或当前非recipe create调用未提供contextTime。

现行依赖：现行Memory lifecycle active生成冻结时间；selected recipe强制用jobTime，但非recipe MemoryPipeline.create仍允许contextTime undefined，因此不是纯历史分支。

链路：stored job/window→extract/conversation-understanding/review semanticInput→validity relations/cache/receipt。

删除前：先让所有new create路径始终保存同一个冻结contextTime；旧job按原startedAt/createdAt回填，绝不能用删除兼容当天时间；保持review/cache fingerprint一致或结束旧jobs。

风险（中高）：跨重启改变模型的“现在”、Memory有效期/未来判断和review缓存结果；盲删会破坏当前非recipe writer。

关联测试：[semantic-context-time.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/semantic-context-time.test.ts) · [memory-integration.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/memory-integration.test.ts) · [conversation-understanding.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/conversation-understanding.test.ts)。


<a id="s31"></a>

### S31 旧Coding Material schema<5含tool正文，被query和Memory读取隔离

位置：[evidence-reader.ts:479](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-reader.ts#L479) · [evidence-reader.ts:536](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-reader.ts#L536) · [materials.ts:631](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/materials.ts#L631) · [conversation-understanding.ts:41](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/conversation-understanding.ts#L41) · [source-pipelines.ts:266](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L266)。

兼容对象：历史mote.coding-session schemaVersion<5投影包含旧raw/tool output正文，不符合clean conversation边界。

触发条件：读取旧Material document或其artifact作为query/Memory证据，理解conversation入口；当前统一返回false/409拒绝。

现行依赖：当前Coding source organizer通过新recipe重建clean物料；原件保留在SourceArchive并受original disclosure grant管控。

链路：Source archive→deterministic recipe/version rebuild→Material clean blocks→EvidenceReader query/Memory/conversation understanding。

删除前：先按原件和当前recipe重建所有当前heads，校验clean正文不含工具body；历史<5修订仍可被裸ref引用，因此应退休/删除旧派生版本或保留minimum-safe-schema guard；移除guard不能作为迁移手段。

风险（高（隐私））：旧tool正文重新进入query/model/Memory；全量删旧raw原件反而丢归档证据，原件保留和clean物料重建必须分开。

关联测试：[conversation-understanding.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/conversation-understanding.test.ts) · [source-pipelines.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-pipelines.test.ts) · [source-recipe-integration.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-recipe-integration.test.ts) · [evidence-reader.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/evidence-reader.test.ts)。


<a id="s32"></a>

### S32 Source pipeline旧group/organize callback扩展契约与内置重复入口

位置：[source-pipelines.ts:36](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L36) · [source-pipelines.ts:47](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L47) · [coding-source-plugin.ts:183](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/coding-source-plugin.ts#L183)。

兼容对象：老pipeline仅提供group/organize callback，不具备声明式recipe、component pins/definition fingerprint。

触发条件：archive pipeline.recipe缺失但callback存在，registry仍允许；内置coding保留旧callback给contract测试。

现行依赖：production内置主路径用recipe；community插件仍允许无recipe，tests实际注册该契约；recipe自身仍调用同一organize实现，函数不是废弃代码。

链路：plugin install→registry→source work→recipe executor或旧callback organize→Material publish。

删除前：可先删除内置重复callback registration并改相关tests；要删registry callback分支必须升级所有社区插件/未完成工作到recipe并声明API最低版本，保留organize算法给现行recipe。

风险（低（仅内置重复字段）/中高（契约））：旧插件无法注册，工作队列无法继续；删整个organize会破坏当前recipe。

关联测试：[source-pipelines.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-pipelines.test.ts) · [source-recipe-integration.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/source-recipe-integration.test.ts)。


<a id="s33"></a>

### S33 旧无结构化Transcript产物只允许重新提取后review

位置：[file-reviews.ts:17](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-reviews.ts#L17)。

兼容对象：旧file_artifacts text/dialogue等json只有文本，无标准data.transcript。

触发条件：file review选择现行artifact但没有transcript，409提示重新提取legacy file。

现行依赖：现行文件处理产物带标准transcript，校正依赖精确chunks/时轴；未完整/损坏产物也需要相同拒绝。

链路：FileReviews.propose/confirm→latestFileTranscript→transcriptSchema→校正/日历建议。

删除前：用原件重新提取历史无transcript的current产物并替代chunks/版本；可改通用invalid-schema错误文案，保留结构完整性校验。

风险（低（改文案）/高（删验证））：旧产物无法校正是既定安全边界，直接读未定义transcript导致异常或错位修正。

关联测试：[file-processing.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/file-processing.test.ts)。


<a id="s34"></a>

### S34 旧Import工作缺处理模式/媒体计数/phase fingerprint元数据

位置：[imports.ts:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/imports.ts#L34) · [imports.ts:39](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/imports.ts#L39) · [imports.ts:397](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/imports.ts#L397) · [imports.ts:418](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/imports.ts#L418) · [imports.ts:423](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/imports.ts#L423)。

兼容对象：旧job缺processing→preview安全默认；缺recordsProcessed按processed减media；旧phase未保存manifestHash→legacy sentinel；preparationRevision缺省0。

触发条件：历史import恢复、失败重试、已完成receipt engine化，或当前job准备阶段还没有manifestHash/preparationRevision。

现行依赖：新create在prepare前也可无preparationRevision/manifestHash；正式confirm要求匹配manifestHash，因此fallback不是绕过review；backup/import restart仍调用restoreOperation。

链路：load import_jobs→reviewGate/media progress→restoreOperation phase generation→prepare manifest→human confirmation→commit。

删除前：迁移存量已完成/待执行job准确计数和处理模式；先使新writer明确revision=0及phase schema；只删可识别的历史metadata fallback，保留准备阶段可空字段和现行恢复/确认检查。

风险（中）：升级后历史工作不可恢复、媒体进度错误或重复准备；盲把旧preview改automatic会改变人类确认/自动模型费用边界。

关联测试：[imports.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/imports.test.ts) · [import-media.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/import-media.test.ts) · [import-backup.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/import-backup.test.ts) · [import-manifest-worker.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/import-manifest-worker.test.ts)。


<a id="s35"></a>

### S35 升级后旧网页lazy bundle404边界

位置：[app.ts:532](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/app.ts#L532) · [app.ts:538](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/app.ts#L538)。

兼容对象：升级前已打开网页会继续请求上一build的hashed lazy页面bundle；新dist已移除旧hash。

触发条件：请求/assets/缺失hash时404+no-store；web/server版本不一致非API503；HTML no-store。

现行依赖：每次当前网页升级都会发生，并非某个不再生成的旧记录格式。

链路：old open tab→staticFiles miss→404 assets guard→client reload/update recovery。

删除前：若不支持打开旧tabs跨升级，可简化用户体验，但必须保留未知静态资源404；删旧tab注释不等于可删除通用assets处理。要保留跨升级体验则部署留旧hash或客户端reload策略。

风险（中）：给JS请求回SPA HTML造成MIME/解析失败与难诊断白屏；此guard应视现行发布健壮性保留。


<a id="s36"></a>

### S36 Portable archive v1新增字段缺省允许较早或精简归档导入

位置：[evidence-store.ts:309](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L309) · [evidence-store.ts:311](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L311) · [evidence-store.ts:322](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L322) · [evidence-store.ts:337](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L337) · [evidence-store.ts:339](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L339) · [evidence-store.ts:354](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L354) · [evidence-store.ts:644](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L644) · [evidence-store.ts:329](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L329)。

兼容对象：同一version:1早期归档可能只有captures，缺sources/sourceHeads/sourceVersions/memories/files/captureFiles/perceptionResults/todos/memoryDeletions；source createdAt/updatedAt缺省为导入时间。

触发条件：importArchive envelope字段undefined时当空集合，不要求当前export全部字段齐全；source timestamp缺失时取当前时间。

现行依赖：现行exportArchive644仍生成version1并写全部字段；精简capture-only v1 import作为当前API也被接受，缺字段不能一概认定来自老产品。

链路：POST /api/import → importArchive → capture/file 准备与部分校验 → 事务恢复及关联冲突验证 → source heads/OCR/Memory/删除意图。provenance.document 原件引用检查仅 archive.files 显式存在时执行；导入 Memory 强制 stale/restored_archive。

删除前：定义新版严格 archive envelope、最低支持版本及转换工具；旧 v1 先转换或按现有 import 导入后再导出。缺 source timestamps 需明确历史未知/导入时间语义；对缺 files 而含 document 原件引用的稀疏包，明确补齐、连接目标已有原件或拒绝策略。保留适用的 checksum/原件关联验证和 Memory stale 保护，不能把现行 version1 整体视为旧格式删除。

风险（中高）：旧及当前精简v1 archive不能恢复；删除默认但保留version1会无明确错误；凭空补空memoryDeletions可能丢删除意图。也必须区分full DB backup与portable限制，两者不是同一路径。

关联测试：[import-backup.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/import-backup.test.ts) · [archived-files.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/test/archived-files.test.ts)。

补充：准备与部分 schema/checksum 校验在 BEGIN 之前，另有 source/OCR/Memory 等关联校验在事务内；并非全部检查在事务内。缺 files 字段的稀疏 v1 跳过 prepared document/attachments 的原件存在性检查。


## Desktop 兼容处理

<a id="d01"></a>

### D01 Ingress v1 → v2 断代迁移、旧队列本地归档及重新导入

位置：[queue.ts:182](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/queue.ts#L182) · [queue.ts:114](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/queue.ts#L114) · [queue.ts:590](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/queue.ts#L590) · [note-draft.ts:43](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/note-draft.ts#L43) · [main.ts:172](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/main.ts#L172) · [source-sync.ts:64](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-sync.ts#L64) · [source-manager.ts:60](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-manager.ts#L60) · [background-worker.ts:121](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/background-worker.ts#L121)。

触发条件：queue/capture-ingress-v2.json、notes/note-ingress-v2.json、local-sources/ingress-v2.json 缺失或 ingressVersion != 2。

现行依赖：现行 enqueue 不生成 localArchiveOnly；仅迁移生成。现行笔记生成新 prepared；导入备份仍接受旧归档标记。

链路：main startup → note draft reset；main → queue.initialize → clearLegacyIngressState → retain ACKed rows as localArchiveOnly and delete unACKed legacy events/blobs/stage journals；main → source manager.initialize → delete old original spools → source engine.initialize → discard old protocol outbox/checkpoint → rescan；local archive browser/export → importArchive/background import → reset archived flags and requeue。

删除前：停写并备份全部 profiles/自定义 queue 目录；统计 marker、未确认记录、归档、prepared 笔记、来源 outbox/spools；旧未确认数据需要预先导出或编写独立转换工具；现行迁移本身会删除这类数据；明确停止支持哪个旧版本；只允许已迁移或明确 fresh install 的目录升级；不应静默把旧目录当空目录；旧归档导入/验证/浏览需保留直到完成转换或用户保留独立归档格式；恢复旧笔记时保持文字并更换 v2 ID。

风险（高）：直接删 marker/reset 会把旧 v1 IDs、ACK/cursor/outbox 带入已重置的 v2 中央；可能冲突、遗漏或重复。直接删归档 reader 则用户已确认旧截图/备份不可读。

关联测试：[queue.test.ts:16](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/queue.test.ts#L16) · [note-draft.test.ts:68](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/note-draft.test.ts#L68) · [source-sync.test.ts:25](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/source-sync.test.ts#L25) · [ingress-migration.test.ts:11](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/ingress-migration.test.ts#L11)。

补充：这些分支不都是无损迁移。特别是 queue 未 ACK v1 事件和旧来源原文 spool 被明确清除；审计未触碰真实用户数据；packaged-metadata-smoke compares old 0.6.1 module data through ConfigStore/Queue/NoteDraft initialize, but does not invoke main.clearPreparedForProtocolUpgrade, so cannot establish full startup upgrade preservation.；Existing fixture contracts inspected or located; not executed during audit.。


<a id="d02"></a>

### D02 来源状态 JSON → SQLite、整数组 → 单 revision 行、内嵌 catalog → 行存储

位置：[source-state-store.ts:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-state-store.ts#L34) · [source-state-store.ts:46](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-state-store.ts#L46) · [source-state-store.ts:53](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-state-store.ts#L53)。

触发条件：旧 .json 存在；或 entries(section=state,key=pendingRealtime/pendingHistory)；或 checkpoint.catalog 非空。

现行依赖：现行只写 SQLite 分行数据，JSON 仅迁移输入；每个 value 可使用 local-content envelope。

链路：SourceSync.initialize/commit → background source-state request → sourceState → transactional sourceStatePatch；旧 JSON → durable SQLite commit → rename .pre-sqlite；旧数组/内嵌 catalog → atomic row decomposition → current read reconstruction。

删除前：离线备份 .json/.sqlite/WAL/key，并逐 profile/connection bucket 运行一次性迁移；核对 pending 顺序/数量、known、delivered、quarantine、catalog 和 original references；验证重启中断可恢复；升级前严格识别旧格式并提示使用迁移器，避免删除 reader 后新建空库掩盖旧数据。

风险（高）：删除 JSON reader 会隐藏旧 outbox，触发重新扫描、重复或原文丢失；删除数组/catalog 转换会使旧 checkpoint/outbox 混合布局读取不完整、丢目录状态。

关联测试：[source-state-store.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/source-state-store.test.ts)。

补充：Existing fixture contracts inspected or located; not executed during audit.。


<a id="d03"></a>

### D03 Coding evidence 字段兼容旧中央并永久固定 revision 的 wire schema

位置：[source-sync.ts:233](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-sync.ts#L233) · [source-sync.ts:317](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-sync.ts#L317) · [source-state-store.ts:7](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-state-store.ts#L7)。

触发条件：coding-agent 来源，中央 registration capabilities.codingEvidenceFieldsVersion != 1；以及以前尝试过的 revision 已有 fields=0 pin。

现行依赖：当前 decoder 仍写 channel/attribution；pin0 不仅存在 pending，已 ACK revision 的 pin 也故意保留。

链路：coding agent decoder → SourceItem channel/attribution → register source → capability normalization 0/1 → codingWire persist pin before PUT/batch → remove fields for pin0 → immutable receipt ACK；ACK 丢失/重启/中央升级/重新扫描时继续同 revision 原 wire bytes。

删除前：建立中央最小协议版本并确保 capabilities=1；先结清 pin0 pending/outbox；旧已 ACK revision 需保留 pin 或显式迁移到新 revision/namespace；补发 channel/attribution 必须作为有 provenance 的新 revision，不能原 revision 改 body；修改持久化 map、negotiation、serialization 和 ACK 丢失恢复测试应联动。

风险（高）：仅删降级/pin 会让中央已有同 revision body 与新 payload 不同，引发 409、重复重试/阻塞，并可能丢 channel/attribution 历史。

关联测试：[coding-transport-compatibility.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/coding-transport-compatibility.test.ts)。

补充：Existing fixture contracts inspected or located; not executed during audit.。


<a id="d04"></a>

### D04 仅为旧队列存在的本机 OCR 补做链路及旧节点 OCR 404 兼容

位置：[collector.ts:177](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/collector.ts#L177) · [collector.ts:70](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/collector.ts#L70) · [collector.ts:370](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/collector.ts#L370) · [queue.ts:319](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/queue.ts#L319) · [queue.ts:65](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/queue.ts#L65) · [transport.ts:14](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/transport.ts#L14) · [config.ts:102](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/config.ts#L102) · [index.html:172](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/index.html#L172)。

触发条件：旧/导入/已有 v2 queue record event.ocr.status=pending；已上传截图保留本地原图等待 OCR。

现行依赖：新采集 screenshot 的 OCR disabled、ocrText 空；config update 强制 false；此链路注释明确 Migration only。

链路：collector init/AC/resume → nextOcr → native recognizeText sanitized queued JPEG → save/defer OCR；capture upload ACK pending → retain record/blob → uploadDeferredOcr /api/capture-browser/id/ocr → finish ACK；404 capture_not_found is deletion vs older 0.0.2 node endpoint unsupported。

删除前：统计非 localArchiveOnly 的 pending OCR、uploaded、ocrResult，以及可导入旧备份；先完成旧 OCR 或迁移为中央 OCR/review job 并保存结果；明确放弃 OCR 时保留截图原件和已 ACK 状态；联动删除 timer、电源钩子、旧字段验证/容量预留/ACK分支、transport/UI隐藏配置；保留 native recognizeText：当前 upload-gate 文字规则仍使用，不能删整个 OCR helper。

风险（中高）：否则旧等待OCR数据卡住、原图提前删除、队列容量/统计错误；把 native OCR 一起删会破坏现行隐私 upload review。

关联测试：[collector.test.ts:209](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/collector.test.ts#L209) · [collector.test.ts:221](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/collector.test.ts#L221) · [collector.test.ts:263](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/collector.test.ts#L263) · [queue.test.ts:104](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/queue.test.ts#L104)。

补充：D01 初次 v1 reset 会删除未 ACK 并隔离已 ACK 记录，不能假设所有 v1 pending OCR 会走到补做；主要需看已经有 v2 marker 或导入的旧 pending；Existing fixture contracts inspected or located; not executed during audit.。


<a id="d05"></a>

### D05 读取历史本机加密 envelope/key；批量解密入口已无生产调用

位置：[local-content.ts:28](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/local-content.ts#L28) · [local-content.ts:53](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/local-content.ts#L53) · [local-content.ts:78](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/local-content.ts#L78) · [main.ts:169](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/main.ts#L169) · [config.ts:97](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/config.ts#L97)。

触发条件：本机内容以 MOTE-CONTENT-AES256GCM-V1 envelope 存储，或旧 content-key.json 已存在。新 writes 不开启本机加密。

现行依赖：当前 encodeLocalContent disabled 写明文；reader 仍读取旧 AES-GCM；plain envelope 用于避免 magic-prefix collision，属于现行 encoding invariance。

链路：startup key store loads old system-encrypted key even disabled → global key policy → queue/note/source/localOriginal readLocalContent/decodeLocalContent；decryptLocalContent bulk traversal/SQLite conversion only imported by local-content tests；生产 main/preload/IPC/UI 无调用；content-storage smoke 明确 assert 无此 UI/API。

删除前：批量解密 function/interface 可低风险作为 dormant API 删除，同时删对应测试；先决定是否保留独立迁移 CLI；删除 reader/key loading 前必须拥有原系统密钥和 content key，停写逐文件/SQLite value 迁移，校验解密结果、保留备份；验证 queue/events/blobs、notes、source SQLite/WAL、spools/held stages 均无旧 envelope 后再移除 AES reader；保留 plain-prefix escaping invariance。

风险（旧读取高风险，未接入工具低风险）：删 unused bulk API 基本无产品行为变化；删 decoder/key loading 则旧队列/笔记/来源及原文全部可能不可读，并使历史备份无法导入。

关联测试：[local-content.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/local-content.test.ts) · [content-storage-smoke.cjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/scripts/content-storage-smoke.cjs)。

补充：不能把解密入口无 caller 等同于 decoder 无 caller。 Queue.withContentMaintenance (queue.ts:176) and NoteDraftStore.withContentMaintenance (note-draft.ts:23) also have no current caller; removable with unused bulk entry. setEnabled(true)/encrypted encode only appear in fixture tests; production setEnabled remains false but key load is necessary for old reads.；Existing fixture contracts inspected or located; not executed during audit.。


<a id="d06"></a>

### D06 旧默认 profile 沿用原 Electron userData 和启动项语义

位置：[profile.ts:17](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/profile.ts#L17) · [profile.ts:20](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/profile.ts#L20) · [profile.ts:26](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/profile.ts#L26) · [main.ts:41](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/main.ts#L41)。

触发条件：非 developmentBuild、无 --profile/MOTE_PROFILE 时 name=legacy；旧 ambient MOTE_URL/TOKEN 沿用；legacy 才允许开机登录项。

现行依赖：current packaged nondevelopment launch still uses legacy default；dev package forces dev。

链路：resolveProfile before single-instance lock → existing default userData root → ConfigStore device/token → queue,notes,sources/models；named profile moves storage to originalDir-profiles/name and own sessionData。

删除前：原子迁移整个 userData，保持 deviceId/凭据/队列/笔记/来源/模型，不能仅改 default name；绝对路径参与 queue owner binding；移动目录需安全重绑 owner marker，settle updater transaction；迁移 Electron session/localStorage 和系统 startup login arguments；验证 keychain safeStorage 可解密；用 one-time old-dir locator 或强制 unsupported提示取代静默新建空 profile。

风险（高）：直接删 legacy 分支等同全新用户目录：看不到历史数据、身份改变、旧队列与凭据割裂、开机启动失效。

关联测试：[profile.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/profile.test.ts) · [packaged-metadata-smoke.cjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/scripts/packaged-metadata-smoke.cjs)。

补充：Existing fixture contracts inspected or located; not executed during audit.。


<a id="d07"></a>

### D07 无 binding/owner marker 的旧目录安全认领

位置：[connection-binding.ts:15](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/connection-binding.ts#L15) · [queue-storage.ts:80](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/queue-storage.ts#L80) · [queue.ts:278](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/queue.ts#L278) · [source-manager.ts:85](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-manager.ts#L85)。

触发条件：旧 queue/source 目录没有 connection-binding.json；旧 default queue 没有 owner marker。

现行依赖：现在创建的新目录也需要 bootstrap，历史专用的是非空 hasLegacyData→unknown 和已有 default owner adoption。

链路：queue/source startup → initialize(config,hasLegacyData) → bound when token present; unknown when nonempty/no token; unbound only truly empty；default queue adopt owner; custom unmarked directory refuses adoption。

删除前：盘点无marker目录与旧 original credentials，核对 ownership 后一次性写 binding/owner；无法确认所有者的非空旧目录保持 unknown/block，不可当 unbound 自动改中央；保留现行 connection match/assertChange 和新目录初始化；只删历史缺marker分支。

风险（高，涉及隐私）：错误删改会将旧个人数据绑定到新中央/账户而泄露，或全部旧 backlog 无法恢复。

关联测试：[connection-binding.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/connection-binding.test.ts) · [queue-storage.test.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/queue-storage.test.ts) · [connection-smoke.cjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/scripts/connection-smoke.cjs)。

补充：Existing fixture contracts inspected or located; not executed during audit.。


<a id="d08"></a>

### D08 缺新字段的历史配置补齐及排除列表旧新两套共存

位置：[config.ts:137](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/config.ts#L137) · [config.ts:97](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/config.ts#L97) · [app-collection.ts:22](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/app-collection.ts#L22) · [ui.ts:866](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/ui.ts#L866)。

触发条件：config.json 缺新增 sync/appCollection/auth fields；excludedAppIds 现仍可由完全排除按钮写入且与 appCollectionRules 共存。

现行依赖：current schema仍 version1；当前 UI 仍写 excludedAppIds，所以不能简单称无人写的旧字段。plaintext stored.config.token 显式忽略属于安全规则，应保留。

链路：defaults + stored.config → validate/updateConfig normalization → persist version1；collector appCollection applies exclusion off precedence; UI still writes old excluded IDs。

删除前：建立明确配置 schema version/一次性补齐迁移并保留 deviceId、masks、token/encryptedToken、authSourceBinding；若统一排除策略，先把每个 excludedAppIds 转换成 appCollectionRules[id]=off，保持 off 优先级，再修改 UI writer 和 collector；旧 paused flags需产品决定去留；保留 plaintext token rejection。

风险（中高，涉及隐私）：删默认合并会使旧配置崩溃或丢 settings；删 excludedAppIds 读取会开始采集用户曾明确排除的应用。

关联测试：[app-collection.test.ts:5](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/app-collection.test.ts#L5) · [app-collection.test.ts:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/app-collection.test.ts#L10) · [packaged-metadata-smoke.cjs:40](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/scripts/packaged-metadata-smoke.cjs#L40)。

补充：Existing fixture contracts inspected or located; not executed during audit.。


<a id="d09"></a>

### D09 旧 snapshot 音频索引补建独立本机处理任务

位置：[source-files.ts:48](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-files.ts#L48)。

触发条件：未修改的 snapshot audio：不走普通 unchanged short-circuit，注释明确为了 legacy pending audio index 建 independent processing job。

现行依赖：现行 managed source 有 accessMarkerPath，会生成 independent processing contract/spool；无 accessMarkerPath 的原文 base64路径当前仍是模块支持模式，不能整体算历史。

链路：source manager scan → source-files makeItem/spool → SourceSync localProcessing → local-file-processing → current file revision upload。

删除前：查询旧 fileIndex.parser/status=pending 音频和 catalog/discovery hash，补齐 processing job或完成中央索引；待 legacy backlog清零再让 unchanged audio使用通用skip；保留现行音频首次/变化时 processing path。

风险（中）：直接删例外将导致旧 hash未变的 pending音频永远不被重访，文本索引无法完成。

关联测试：[local-file-processing.test.ts:27](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/local-file-processing.test.ts#L27)。

补充：Existing fixture contracts inspected or located; not executed during audit.；No explicit saved legacy pending audio-index-to-job migration test located; deletion needs such a fixture.。


<a id="d10"></a>

### D10 File manifest 未带 state 的旧 ACK 格式容忍

位置：[source-sync.ts:286](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-sync.ts#L286) · [source-sync.ts:303](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-sync.ts#L303)。

触发条件：批量 response result.state===undefined 且 ack存在；manifestBatch能力不足时改逐条发送。

现行依赖：当前 request在相同v1 file-sync contract；capability不同batch limit也是现行能力协商，不能默认把整个协商当历史。

链路：capabilities GET → batch vs sequential → results exact externalId/revision validation → old shape ack validation → settle。

删除前：确认所有受支持中央固定返回 accepted/existing/rejected/missing_original，并明确最小协议；先收集无state response使用情况，再删单个 ACK shape容忍；仅在全中央有足够batch上限时删 sequential fallback。

风险（中）：旧中央响应会被当无效ACK，outbox保持但无限重试；删全部能力协商会破坏当前有不同batch限制的节点。

关联测试：[source-sync-batch.test.ts:98](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/source-sync-batch.test.ts#L98) · [source-sync-batch.test.ts:127](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/source-sync-batch.test.ts#L127)。

补充：中央writer由server审计确认：apps/server/src/files.ts:65 metadata batch=accepted；:72 missing_original/existing/accepted；:73 rejected，全部显式state。旧响应宽容确实非当前writer输出，具体历史发布版本尚未确定；Existing fixture contracts inspected or located; not executed during audit.；No dedicated missing-state older response shape fixture located.。


<a id="d11"></a>

### D11 旧 support events.json 作为 NDJSON 不存在时的导出来源

位置：[support.ts:108](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/support.ts#L108) · [support.ts:115](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/support.ts#L115) · [support.ts:91](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/support.ts#L91)。

触发条件：查询时间范围从轮转NDJSON没有得到rows时，回读旧events.json。

现行依赖：events.json 本身目前仍在写，故只fallback是老格式兼容，不能无脑删整个JSON存储。

链路：support record → 当前同时写NDJSON和500条events.json → exportRange NDJSON → legacy JSON fallback；readRaw UI仍直接读JSON。

删除前：一次性把现存JSON历史写入NDJSON，去重保留时间/level/sanitized metadata；若删整个JSON，要先迁移readRaw/current双写用户界面；删fallback则只影响历史诊断窗口。

风险（低）：删fallback可能丢旧升级前诊断记录；删JSON当前路径会破坏日志UI。

关联测试：[support.test.ts:46](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/support.test.ts#L46)。

补充：Existing fixture contracts inspected or located; not executed during audit.；No dedicated pre-NDJSON exportRange fallback fixture located.。


<a id="d12"></a>

### D12 CodingCheckpoint 新 catalog/counter 字段对旧持久化游标的补齐

位置：[coding-agents.ts:24](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/coding-agents.ts#L24) · [coding-agents.ts:70](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/coding-agents.ts#L70)。

触发条件：旧checkpoint仅含version/files/initialized；catalog、scanNumber、scanStartedAt、nextFile缺失。

现行依赖：每次现行scan填写catalog/counter/time与每个cursor.size/mtime/ctime/quickHash，历史reader允许旧字段缺失。

链路：SourceSync stored checkpoint → builtIn coding adapter → background coding-scan → scanCodingAgent → optional fields initialized while keeping byte cursors → new catalog checkpoint atomically staged。

删除前：离线版本化转换checkpoint，并保持每个文件offset、anchor、ino、generation、session/context和initialized；建立新的catalog/scan字段但不能强行重置所有byte offsets；current fresh checkpoint factory也要完整初始化；增加保存旧checkpoint → append → restart fixture。

风险（中高）：直接删补齐会让旧catalog undefined或counter NaN；清空checkpoint会重读并形成新/重复identity，new_only错误baselining可能遗漏历史。

关联测试：[coding-agents.test.ts:24](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/coding-agents.test.ts#L24)。

补充：Existing fixtures inspected, not run.；No explicit no-catalog checkpoint upgrade fixture located.。


<a id="d13"></a>

### D13 来源 adapter 版本升级检查和旧缺版本默认1

位置：[source-sync.ts:108](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-sync.ts#L108) · [source-manager.ts:216](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/source-manager.ts#L216)。

触发条件：data.adapterVersion缺失则解释为1；registry adapter.version不同则重置扫描checkpoint，保留所有未确认revision。

现行依赖：全部内建adapter当前version1；registry支持自定义adapter版本，fixture实际执行1→2。

链路：LocalSourceManager chooses registered adapter → SourceSync.ensureAdapterVersion → persist new adapterVersion/checkpoint undefined → adapter fresh scan → retained outbox uploads unchanged。

删除前：如果只删缺版本default，先补齐全部已保存状态adapterVersion=1并严格schema检查；版本变更rescan本身建议保留，未来/外接adapter仍需要；仅冻结全部adapter版本且对不同version给明确不支持错误才可移出运行时；外置迁移保持pending/local originals/coding wire pins。

风险（中高）：把不同adapter的旧checkpoint交给新scanner会遗漏、重复或错误删除；粗暴清state会丢offline backlog。

关联测试：[source-sync.test.ts:158](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/source-sync.test.ts#L158) · [source-scheduling.test.ts:30](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/test/source-scheduling.test.ts#L30)。

补充：这是正在使用的版本演进契约，不能当已结束的一次性legacy迁移整体删除；Inspected current upgrade fixture; not run.。


## Android 兼容处理

<a id="android-01"></a>

### ANDROID-01 读取旧 AES/GCM 内容封装，以及遗留可选加密写入开关

位置：[LocalContentCipher.kt:3](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/LocalContentCipher.kt#L3) · [SecretBox.kt:16](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/SecretBox.kt#L16) · [Settings.kt:111](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L111) · [Settings.kt:132](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L132) · [MainActivity.kt:838](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L838)。

兼容对象：旧本机内容：第一个字节为 IV 长度 12..16，后接 IV 和 AES/GCM 密文；新格式通常原文，歧义二进制使用 MOTE-LOCAL-PLAIN-V1\0 转义；旧 SharedPreferences.contentEncryptionEnabled 可仍为 true。

触发条件：内容读取时，字节不带 MOTE-LOCAL-PLAIN-V1\0 转义前缀、首字节为 12..16 且总长度大于 IV 长度加 1，则按旧 AES/GCM 封装认证解密。写入时，若未进入 withPlaintextWrites 且 raw mote/contentEncryptionEnabled=true，仍会生成该封装；此写入条件在升级后首次保存设置前也可成立。

现行依赖：LocalContentCipher.seal 21 行仍按 raw preferences 决定是否 SecretBox.seal；Settings.read 返回 false，MainActivity 保存写 false；因此升级后、首次保存前仍可能产生新加密内容。SecretBox 同时为当前令牌和待配对凭据加密，不能整体删除。 另外SecretBox也仍用于当前中央原生窗口问答/笔记/附件导入草稿及CalendarActions操作账本，这些不是旧封装兼容。

链路：Settings/read 或 Context.localContentCipher -> DurableQueue/LocalSourceStore/FileArchiveQueue/NoteDraftStore/BulkDedupeStore/ImageDedupeDiagnosticsStore -> cipher.open -> 旧封装认证解密；localContentCipher() -> seal() ->旧 preferences 真值继续加密。

删除前：保留设备 Keystore 和应用数据，先把 raw contentEncryptionEnabled 持久置 false，所有七个内容区域完整解密并校验；保留失败文件；只有扫描无旧 envelope 后才能缩减读兼容；保留新 plaintext escape 读写，因为当前二进制仍可能用它；保持 SecretBox 和 mote.private.v1 KeyStore 别名用于当前凭据 同时保留CentralScreens/CalendarActions当前主动SecretBox加密的读写，七区域解密工具不会转换它们；为跨版本备份/完整目录迁移明确最低格式，并保留一个独立离线迁移版本。

风险（高）：直接删 legacy.open 会让旧图片、记录、草稿、来源和诊断无法读；错误可连带阻止启动恢复/同步；清理 Keystore 别名会同时毁掉当前令牌和旧内容密钥；漏改 raw 旧开关会在删除旧读取后继续产生无法读取的密文。

关联测试：[LocalContentCipherTest.kt:27](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/LocalContentCipherTest.kt#L27) · [LocalContentCipherTest.kt:55](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/LocalContentCipherTest.kt#L55) · [LocalContentCipherTest.kt:83](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/LocalContentCipherTest.kt#L83) · [AnrRegressionInstrumentedTest.kt:252](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/AnrRegressionInstrumentedTest.kt#L252)。

补充：仅静态审计，未检查任何真实用户数据或设备。


<a id="android-02"></a>

### ANDROID-02 全域旧内容批量解密工具残留，目前只有测试入口

位置：[LocalContentDecryptor.kt:20](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/LocalContentDecryptor.kt#L20) · [LocalContentMigration.kt:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/LocalContentMigration.kt#L10) · [DurableQueue.kt:854](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/DurableQueue.kt#L854) · [BulkDedupeWorker.kt:27](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/BulkDedupeWorker.kt#L27) · [NoteDraftStore.kt:14](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/NoteDraftStore.kt#L14) · [LocalSources.kt:106](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/LocalSources.kt#L106) · [FileArchiveQueue.kt:22](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/FileArchiveQueue.kt#L22) · [ImageDedupeDiagnosticsStore.kt:90](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ImageDedupeDiagnosticsStore.kt#L90)。

兼容对象：旧 AES/GCM 文件，逐个认证/验证后原子改为 plaintext，支持取消/重跑。

触发条件：只有显式调用 LocalContentDecryptor.start，且当前没有迁移运行、raw contentEncryptionEnabled=false，才启动七区域扫描；扫描中发现 LocalContentCipher.isLegacy 文件才实际转换。取消标志或开关重新变 true 会停止。仓内生产代码目前没有 start/cancel 调用，仅测试或恢复入口调用可触发。

现行依赖：没有生产调用 LocalContentDecryptor.start/cancel 的引用；只有 instrumented tests。每个 store migrateLegacyContent 被此工具或 tests 调用。

链路：LocalContentDecryptor.start -> 7 个区域 migrateLegacyContent -> withPlaintextWrites/LocalContentMigration.migrate。

删除前：如果只删除未接入 UI 的工具，可保留 LocalContentCipher 读能力并独立导出迁移程序；如果计划一并删除旧读取，先恢复可执行的迁移入口，完成 ANDROID-01 全部前置操作；同步处理迁移工具测试与残留文案。

风险（保留旧读取能力时为低风险）：单独删当前未调用工具对正常运行影响小，但丢失受测试覆盖的迁移/修复入口；不能以工具入口不可达推论旧数据读取不可达；未迁移库仍依赖读兼容。

关联测试：[LibraryResponsivenessInstrumentedTest.kt:162](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/LibraryResponsivenessInstrumentedTest.kt#L162) · [LocalContentCipherTest.kt:55](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/LocalContentCipherTest.kt#L55)。


<a id="android-03"></a>

### ANDROID-03 Ingress v2 一次性切换：清除旧 outbox、源检查点、上传状态

位置：[IngressV2Migration.kt:7](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/IngressV2Migration.kt#L7) · [QueueStorage.kt:46](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QueueStorage.kt#L46) · [SourceProviders.kt:17](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/SourceProviders.kt#L17) · [FileSources.kt:15](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/FileSources.kt#L15) · [QuickNotes.kt:12](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QuickNotes.kt#L12) · [DurableQueue.kt:189](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/DurableQueue.kt#L189) · [LocalSources.kt:99](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/LocalSources.kt#L99) · [FileArchiveQueue.kt:17](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/FileArchiveQueue.kt#L17) · [NoteDraftStore.kt:49](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/NoteDraftStore.kt#L49) · [SyncSchedule.kt:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/SyncSchedule.kt#L34)。

兼容对象：SharedPreferences ingress-protocol/version < 2（包括不存在）；旧 capture stage inbox/journal/checkpoint，未 ACK event/未完成 OCR/冲突记录，旧来源/文件 spool 和 prepared draft ID。

触发条件：queue、localSources、fileArchives 或 QuickNotes.draft 打开并调用 ensure 时，ingress-protocol/version 缺失（默认 0）或小于 2，执行切换并最后提交 2；新安装首次打开、复制未标记目录及上次切换中断也会进入，已有 marker>=2 则跳过。切换要求在非主线程执行。

现行依赖：新上传只能携带 X-Mote-Ingress-Version=2 且校验 v2 nested receipt；marker 最后提交，当前 worker stamp 包含协议 2。

链路：首次任意 queue/localSources/fileArchives/QuickNotes.draft 打开 -> ensure ->移除 stage输入 -> discardLegacyOutbox -> reset sources/files/prepared draft -> clear旧 prefs ->提交 marker 2；MoteApplication启动 queue ->此迁移先于 uploader运行。

删除前：先定义是否允许直接跨越旧版本升级；不允许时需要明确版本/存储拒绝而不能悄悄忽略；允许时保留一次性迁移程序；导出/备份旧未传材料后决定丢弃、重新形成 v2 事件或完成旧端同步；缩减所有 ensure 调用和 reset helpers 前确认所有安装/目录复制都已带 marker 2；保留 v2 header和严格 ACK 校验，取消旧 cutover不能取消当前授权/耐久确认。

风险（高）：删掉 cutover 后未迁移旧 records 会被直接作为 v2 上传，可能 schema拒绝、永远重试、ID 内容冲突/重复归档；旧 stage replay 会重新制造旧事件；旧凭据/目标/能力缓存可能影响当前 sync；现有迁移本身有意丢弃未 ACK及待 OCR材料；重构必须明确保留/丢弃策略，不能声称无损。

关联测试：[IngressV2ProtocolTest.kt:65](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/IngressV2ProtocolTest.kt#L65)。


<a id="android-04"></a>

### ANDROID-04 保留旧用户默认完整内容采集，新安装默认只采应用活动

位置：[Settings.kt:76](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L76) · [Settings.kt:103](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L103) · [AppCollectionRules.kt:24](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AppCollectionRules.kt#L24)。

兼容对象：缺 appCollectionRules 但存在 interval 或 enabled 的旧 mote preferences。

触发条件：Settings.read 发现 mote preferences 没有 appCollectionRules 时进入初始化；其中只要已有 interval 或 enabled 任一键，就采用 LEGACY_DEFAULT(content)，两键都不存在则采用当前新安装 DEFAULT(activity)。设置被手工删键或损坏后的重建也会触发，现行保存的完整配置不触发缺键分支。

现行依赖：读取时一次性持久化 appCollectionRules；旧默认 content，新默认 activity；现行保存也持续写 interval/enabled。

链路：Settings.read ->检测缺失 appCollectionRules ->按旧安装痕迹写 LEGACY_DEFAULT -> CapturePipeline collectionRules.decide /采集调度。

删除前：先给全部已安装用户持久化明确 appCollectionRules，或产品决定升级后强制 activity 并展示明确变化；只移除缺键的 legacy选择分支，不要移除用户明确选择 content 的合法值；更新 fresh/upgrade 默认差异 fixtures。

风险（中）：直接改成统一 activity 会让旧用户升级后停止图片/正文采集，功能变化但通常降低采集量；直接统一 content 会把新用户默认扩展到内容采集，隐私风险高；缺键也可能是设置损坏或手工删除，故仍需清楚的默认策略。

关联测试：[PowerOptimizationInstrumentedTest.kt:111](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/PowerOptimizationInstrumentedTest.kt#L111) · [PowerOptimizationTest.kt:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/PowerOptimizationTest.kt#L34) · [AppPolicyAndActivityTest.kt:51](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/AppPolicyAndActivityTest.kt#L51)。


<a id="android-05"></a>

### ANDROID-05 旧独立 central-owner-session.enc 一次性导入统一登录

位置：[CentralClient.kt:93](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CentralClient.kt#L93)。

兼容对象：旧 SecretBox 文件 central-owner-session.enc {server,token,signedOut,expiresAt}；尚未过期、server匹配且当前config.token为空时。

触发条件：UnifiedCentralSession 初始化发现 central-owner-session.enc 存在即读取并最终删除；仅在解密/JSON 可读、当前 config.token 为空、保存的 server 等于当前 server、signedOut=false 且 expiresAt 晚于当前时间时导入 token，否则只清理残留文件。

现行依赖：当前凭据由 Settings.save/signIn持久化到 mote/token/auth*；CentralSession为进程统一generation。

链路：CentralAccess.resolve/requireClient -> CentralSession.get -> UnifiedCentralSession.init ->可选恢复旧token ->删除旧session文件。

删除前：先跑一次导入或明确要求尚未迁移用户重新登录；凭据可重新登录恢复，不必保留双读；保留统一generation/401退出/进程会话/endpoint限制；仅删除 init 旧文件处理；决定旧残留文件如何安全清理，不从它再次恢复退出会话。

风险（中）：尚未迁移用户需要重新登录；如果删除清理分支，旧凭据文件仍可能滞留存储；不要把正常session active fencing与旧迁移一起删除。

关联测试：[NativeCentralInstrumentedTest.kt:247](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/NativeCentralInstrumentedTest.kt#L247)。


<a id="android-06"></a>

### ANDROID-06 服务器未返回 node.protocol 时按旧协商前 v1 接受

位置：[ProtocolCompatibility.kt:14](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ProtocolCompatibility.kt#L14) · [ConnectionClient.kt:79](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ConnectionClient.kt#L79)。

兼容对象：GET /api/connections/self 无 node 或无 protocol；与显式 JSON null 区别，缺字段接受，null拒绝。

触发条件：连接、恢复或测试执行 verifySelf 后，传给 requireCompatible 的 node.protocol 为 Kotlin null（缺 node 或缺 protocol 字段）时接受本端 v1 范围；显式 JSON null 为 JSONObject.NULL，进入响应错误而非该兼容分支。

现行依赖：请求主动带 X-Mote-Protocol-Version:1；当前中央应返回 range {min,max}。独立于 ingress v2。

链路：ConnectionClient.connect/resume/test -> verifySelf -> requireCompatible(node?.opt(protocol)) ->缺字段返回[1,1]。

删除前：跨客户端/中央统一最低 API 协商版本、共享 protocol contract/fixtures；先保证旧节点升级；移除 missing field接受，并在UI清晰返回需升级/响应不符合协议；保留range类型/边界/交集校验。

风险（中）：旧节点无法连接/检查；缺字段故障会从被接受变成硬失败；改动共享 fixtures时要同步TS/Desktop，避免多端协议不同。

关联测试：[ProtocolCompatibilityTest.kt:14](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/ProtocolCompatibilityTest.kt#L14) · [ProtocolCompatibilityTest.kt:22](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/ProtocolCompatibilityTest.kt#L22)。

补充：父审计已确认owner仍是当前合法主路径，collector旧凭据另由服务端isOwner映射；Android owner/collector宽松scope与无deviceId不可整体删。


<a id="android-07"></a>

### ANDROID-07 上传 bundle -> JSON batch -> individual 老端点回退与24小时能力缓存

位置：[UploadWorker.kt:176](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/UploadWorker.kt#L176) · [UploadNegotiation.kt:5](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/UploadNegotiation.kt#L5) · [IngressV2Protocol.kt:22](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/IngressV2Protocol.kt#L22)。

兼容对象：bundle或batch返回404/405，记录 bundle-capability server/at 24小时；回退/api/captures/batch(max25)，再/api/captures(1)。

触发条件：packedUpload=true 时，bundle 返回 404/405 会登记当前 server 的能力时间并回退 JSON batch；同 server 的缓存时间在过去 24 小时内则直接跳过 bundle。batch 返回 404/405 再回退单条。packedUpload=false 时直接单条是现行主动配置路径，也进入共用单条处理，但不属于旧端点触发。

现行依赖：当前接口都仍用 ingress v2、严格receipt；packedUpload=false 本来就是当前主动单条模式。413自动缩批是独立当前负载适配。

链路：UploadWorker work ->读能力cache ->CaptureBundle encode -> 404/405 -> jsonBatch ->404/405 -> individual ->严格v2ACK ->queue.acknowledge。

删除前：确认所有受支持中央均支持bundle和batch；移除404/405兼容fallback及bundle-capability存储；保留用户 packedUpload=false单条路径，或同时正式移除该产品设置/配置归档字段；保留413缩批/同步条件重检查/严格ACK，不能按成功状态直接清队列。

风险（中）：老端点或反代不支持bundle的部署将无法上传，队列保留并重试；若连单条合法模式一起删除，现有用户配置改变；不可误称本分支支持退休 ingress v1；v1 ACK仍被拒绝。

关联测试：[OfflineSyncInstrumentedTest.kt:211](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/OfflineSyncInstrumentedTest.kt#L211) · [UploadNegotiationTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/UploadNegotiationTest.kt#L1) · [PowerOptimizationTest.kt:31](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/PowerOptimizationTest.kt#L31)。


<a id="android-08"></a>

### ANDROID-08 更新器支持旧 v* 统一 release feed 和无 component 的混合清单

位置：[AppUpdateStore.kt:30](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AppUpdateStore.kt#L30) · [AppRelease.kt:63](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AppRelease.kt#L63)。

兼容对象：旧tag v<version>，manifest顶层没有component，assets可混合android/desktop/server，images可带server镜像。优先android-v*，只在没有自身release时才回旧列表。

触发条件：更新检查按渠道扫描 release feed，只有找不到有效自身 android-v* release 时才选择有效 v* 旧标签；清单验证遇到顶层 component 缺失时按旧混合清单规则校验。选中或重新验证已保存旧候选也可触发后者，有 component=android 的当前清单不走缺字段兼容。

现行依赖：独立Android流tag android-v*、component=android，仅Android资产/空images。

链路：AppUpdateStore/worker ->UpdateNetwork.check分页feed -> own.ifEmpty legacy ->AppReleaseVerifier.verify无component兼容 ->Package APK验证 ->installer。

删除前：先确认stable/preview仓库已有有效签名 android-v* 清单和APK；删除v* feed分支、要求component=android/严格Android资产；同步release共享fixtures；保留签名、hash、packageName、versionCode、证书验证与安装保留数据契约。

风险（中）：自定义仓库只有旧统一release者再也找不到更新；存储的旧候选manifest重新验证可能失败；不能变更包名/签名绕过升级验证，否则成为新安装导致旧应用数据不可见。

关联测试：[AppReleaseTest.kt:44](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/AppReleaseTest.kt#L44) · [AppReleaseTest.kt:54](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/AppReleaseTest.kt#L54) · [AppUpdateInstrumentedTest.kt:137](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/AppUpdateInstrumentedTest.kt#L137)。


<a id="android-09"></a>

### ANDROID-09 文件 transport 索引版本不匹配时重建，兼顾旧版与新来源

位置：[FileArchiveQueue.kt:46](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/FileArchiveQueue.kt#L46) · [FileArchiveQueue.kt:184](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/FileArchiveQueue.kt#L184)。

兼容对象：旧 state无transportQueueVersion（queueIndexed旧标记），todo-*旧索引将处理等待与transport混用，pending wire manifest必须保持不变。

触发条件：任何 configure/pendingCount/pendingPage/next/prepare 路径调用 indexed，若该来源 state.optInt(transportQueueVersion) != 2，则重建 todo markers 并从已有 pending 行恢复 activeKey，随后保存版本 2。缺键默认 0，因此全新来源初始化和旧 state 升级共用该条件；实际判断是“不等于 2”，并非仅小于 2。

现行依赖：新state version2；mark仅dirty transport，恢复activeKey指向pending。该branch也初始化全新源state。

链路：configure/pendingCount/pendingPage/next/prepare ->indexed ->逐row mark ->恢复 activeKey ->saveState version2。

删除前：对每个源重建todo markers/activeKey并提交version2；完整保留pending immutable manifest/spool；删除旧升级分支前另写fresh-state初始化，不能直接删 indexed 全函数；保持marker先于journal的崩溃顺序。

风险（中）：漏掉旧索引升级可让待传文件看不见、错误将解析等待计入上传，或重复处理；整段删除会同时破坏新安装初始化。

关联测试：[FileArchiveQueueTest.kt:43](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/FileArchiveQueueTest.kt#L43)。


<a id="android-10"></a>

### ANDROID-10 旧 exact 截图签名 WxH:hash 的解析

位置：[ScreenshotDedupeHelper.kt:194](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ScreenshotDedupeHelper.kt#L194) · [CapturePipeline.kt:27](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CapturePipeline.kt#L27) · [CapturePipeline.kt:126](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CapturePipeline.kt#L126) · [CapturePipeline.kt:163](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CapturePipeline.kt#L163) · [CapturePipeline.kt:214](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CapturePipeline.kt#L214)。

兼容对象：旧字符串 <width>x<height>:<exactHash>；无 v2|前缀 ->parseLegacyExactSignature，补零dHash/thumbnail。

触发条件：parseSignature 收到非空签名且去除首尾空白后不以 v2| 开头时，尝试旧 WxH:hash 解析；只有冒号位置、两段可解析尺寸和非空 hash 合法才接受。当前生产 CapturePipeline 只提供进程内新 v2 签名，未发现持久旧签名输入，故旧格式分支需显式旧输入或未来调用才会接受。

现行依赖：所有生产调用只来自CapturePipeline进程内dedupeSignature/earlySignature；当前写方toSignature输出 v2|WxH|exactHash|dHash|thumb，没有持久化旧签名读方。

链路：CapturePipeline ->shouldSkip ->parseSignature ->parseLegacyExactSignature。

删除前：删除parseLegacyExactSignature及无v2前缀分支，把未知签名返回null；可加入生成fixture验证旧签名拒绝和v2正常；保留当前v2尺寸/hash/thumb校验与匹配逻辑。

风险（低）：如未来/隐藏调用传旧签名，将多保留一帧而非丢数据；仓内当前链路不跨进程保存旧签名，风险低。

关联测试：[ScreenshotDedupeTest.kt:15](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/ScreenshotDedupeTest.kt#L15)。

补充：现有测试覆盖无效/v2签名，没有专门旧格式案例。


<a id="android-11"></a>

### ANDROID-11 本机随手记旧 mood 字段隐藏读写

位置：[MainActivity.kt:538](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L538) · [MainActivity.kt:582](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L582) · [NoteDraftStore.kt:8](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/NoteDraftStore.kt#L8) · [QuickNotes.kt:19](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QuickNotes.kt#L19)。

兼容对象：旧本机note-draft/draft.enc mood (<=80字符)，页面不再显示mood编辑框，但隐藏EditText恢复并保存原值。

触发条件：每次打开本机随手记页面都会把当前 draft.mood 恢复到隐藏控件，并在正文或 mood 的可保存编辑发生时随 text 一起写回；提交时 mood 非空才加入 capture，已 prepared 的事件保持原内容。此共用读写也处理当前空 mood 草稿，不是只在旧存量存在时运行；旧非空 mood 才体现历史保留效果。

现行依赖：NoteDraftStore仍每次写text/mood；QuickNotes把非空mood发capture；CentralScreens中央随手记322仍有正常可见mood，因此不要全系统删除mood。

链路：MainActivity buildNotes ->隐藏mood控件 setText旧draft ->draftWatcher/write -> QuickNotes.save ->event.mood。

删除前：决定保留旧mood为只读元数据或一次迁移为普通笔记字段；清理隐藏UI可直接持有draft.mood避免隐式丢字段；若删除LocalDraft mood，在迁移旧draft/prepared事件前保证ID和不可变内容不被改变；仅改本机notes，中央notes当前mood功能另作产品决定。

风险（低至中）：直接移除字段会丢失旧心情元数据；prepared同ID已带mood时改内容可能触发冲突；当前草稿reader getString(mood)仍强制存在，改writer必须同改reader/导入处理。

关联测试：[NoteDraftStoreTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/NoteDraftStoreTest.kt#L1) · [IngressV2ProtocolTest.kt:95](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/IngressV2ProtocolTest.kt#L95)。


<a id="android-12"></a>

### ANDROID-12 旧本机延迟OCR及OCR补上传队列

位置：[CaptureOcr.kt:35](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CaptureOcr.kt#L35) · [DurableQueue.kt:568](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/DurableQueue.kt#L568) · [UploadWorker.kt:142](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/UploadWorker.kt#L142) · [Settings.kt:107](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L107) · [MainActivity.kt:509](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L509) · [MoteApplication.kt:67](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MoteApplication.kt#L67) · [RuntimeSettings.kt:135](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/RuntimeSettings.kt#L135) · [QueueArchive.kt:83](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QueueArchive.kt#L83)。

兼容对象：旧capture ocr.status=pending/_ocrResult/_ocrAttempts/_ocrUploaded；ocrChargingOnly仅老后台队列使用。

触发条件：后台 OCR 调度仍会建立当前 WorkManager 任务，但只有队列存在 awaitingOcr、未 blocked 且 origin 匹配的记录才实际处理，并受停止/重配置/仅充电条件限制。补上传要求 capture 已上传、已有 _ocrResult、尚未 _ocrUploaded、未 blocked 且 origin 匹配，且当前上传轮次 OCR 配额可用。旧备份 restoreOcr 也可重新引入该状态；新 CapturePipeline 的 disabled screen 不产生此 backlog。

现行依赖：CapturePipeline 154–172明确新screen OCR disabled，Gate OCR仍当前活跃但内存；新图片归中央OCR。Ingress cutover会删旧pending OCR，但备份/保留目录导入及fixture仍可出现。

链路：MoteApplication或RuntimeSettings ->CaptureOcrWorker.schedule ->pendingOcr ->本机MLKit ->completeOcr ->UploadWorker nextOcrUpdate -> /api/capture-browser/:id/ocr ->acknowledgeOcr；QueueArchive.prepare/restore ->restoreOcr ->completeOcr 可引入旧结果。

删除前：先盘点所有待本机OCR/未补传结果，选择完成上传、转换为中央处理或明确保留失败状态；修改旧backup接受策略/迁移器，确保删worker后旧pending不永远占reservation/阻止retention；取消既有WorkManager名mote-capture-ocr/mote-capture-ocr-recovery并移除调度、settings/UI/导入字段；保留CaptureOcr.recognize：当前UploadGate仍需要本机文字审查；只删旧worker链。

风险（旧队列处理方案确定前为高风险）：只删worker会留下永久waiting/reserve占用；只删上传分支会丢已识别文字结果或保留无法清理的记录；把CaptureOcr整个删除会同时破坏当前本机隐私文字审查；现有v2首次迁移已丢弃部分旧pending，并不代表所有backup再导入都干净。

关联测试：[DeferredOcrQueueTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/DeferredOcrQueueTest.kt#L1) · [QueueStatsTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/QueueStatsTest.kt#L1) · [OfflineSyncInstrumentedTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/OfflineSyncInstrumentedTest.kt#L1)。


<a id="android-13"></a>

### ANDROID-13 旧未记dataOrigin的设置从server推导节点绑定

位置：[Settings.kt:188](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L188) · [Settings.kt:252](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L252) · [ConnectionGuard.kt:42](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ConnectionGuard.kt#L42)。

兼容对象：旧mote preferences已有server但无dataOrigin；旧event亦可能无_archiveOrigin，采用原server建立后续sticky绑定。

触发条件：dataOrigin() 在 mote preferences 缺 dataOrigin 键时读取当前配置；若仍有 server 键且 server 非空，则从原 server 推导绑定，否则返回空。ensureDataOrigin 也对缺键执行首次持久化；当前全新离线采集的空绑定、旧设置缺键以及手工删键均可触发，不能把所有缺键都视为已绑定旧数据。

现行依赖：save/ensureDataOrigin将dataOrigin持久化；新事件先调用ensure；断开也不解绑；切换节点前pinRetainedOrigin。空绑定也用于当前离线首次采集。

链路：Settings.dataOrigin ->缺键read.server回退 ->Context.queue.archiveOrigin ->matchesOrigin/ConnectionGuard/originAfterChange/QueueArchive校验。

删除前：保留旧server ->dataOrigin单次迁移，在允许改节点前持久化；为无_archiveOrigin保留记录写明确origin；若移除兼容回退，明确区分新离线空绑定与旧已绑定缺键，不能统一当unbound；保留当前disconnect不能解除绑定与retained origin隔离。

风险（高）：直接把缺键当空会使旧待传材料被绑定到新节点，可能把个人资料发错服务器；改成强制键存在又会阻止新安装/离线采集；需要当前初始化替代。

关联测试：[RetainedOriginTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/RetainedOriginTest.kt#L1) · [ConnectionAndOperationsTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/ConnectionAndOperationsTest.kt#L1)。


<a id="android-14"></a>

### ANDROID-14 旧本机来源配置缺新增字段时补默认

位置：[LocalSources.kt:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/LocalSources.kt#L34)。

兼容对象：旧config.enc来源对象没有lightweightIndex/allowRead（git 2430706d父版本写方可证明），更早配置可能缺initialSync/maxFileMiB等。

触发条件：LocalSource.from 解析来源对象时，lightweightIndex 或 allowRead 缺失会通过 optBoolean 默认 false；其他 opt 字段缺失也采用各自默认。旧 config.enc、旧配置导入或任何现行不完整输入都可触发。calendarId/uri 的按来源类型合法缺失是共用当前逻辑，不属于这一历史字段兼容判定。

现行依赖：LocalSource.json 28–30全写字段；from持续opt默认；旧配置默认lightweightIndex=false/allowRead=false。calendarId/uri本来按source kind可选，不算旧兼容。

链路：LocalSourceStore.sources ->LocalSource.from ->optBoolean/optInt defaults ->SourceAdapters.validate/FileSources/Workers。

删除前：读取旧config.enc再按当前 LocalSource.json 重写所有源，带明确 schema/version 或迁移标记；只有必需新字段可改get*强读；保留按kind合法可选calendarId/uri；逐项保留原隐私/initialSync语义；allowRead缺失应保持false。

风险（中）：改强制字段导致老来源配置无法加载/源同步全部停；错误默认allowRead=true或initialSync=all可能扩大文件读取/历史上传范围。

关联测试：[LocalSourcesTest.kt:1](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/test/java/dev/mote/collector/LocalSourcesTest.kt#L1)。

补充：仅lightweightIndex/allowRead已由本地git旧writer实证，其余opt默认属于宽松旧/缺字段支持，没有逐个历史版本实证。


<a id="android-15"></a>

### ANDROID-15 AskActivity 旧入口class保留但已成为当前导航依赖

位置：[AskActivity.kt:3](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AskActivity.kt#L3) · [MainActivity.kt:1252](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L1252) · [NativeUi.kt:152](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/NativeUi.kt#L152) · [AndroidManifest.xml:26](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/AndroidManifest.xml#L26)。

兼容对象：旧AskActivity独立入口；现在继承CentralActivity共用中央UI和session。

触发条件：当前 MainActivity 或 NativeUi 的问答导航启动显式 AskActivity Intent 时即进入该别名，随后继承 CentralActivity 显示 ask 页面；Activity 恢复同类入口也依赖类及 manifest 注册。此条件是当前日常导航，不需要旧安装或旧存量存在。

现行依赖：当前主导航仍显式启动AskActivity；manifest exported=false，没有外部公开深链契约。

链路：MainActivity/NativeUi ASK tab ->AskActivity ->CentralActivity with page=ask。

删除前：先把所有当前Intent改CentralActivity并明确page=ask，再删class和manifest；验证导航标签、返回栈、共享登录、restore/rotation行为；更新ActivityScenario测试。

风险（低）：直接删class/manifest而不改导航会造成问答入口崩溃；使用同class后栈复用/Activity复原可能变化。

关联测试：[NavigationInstrumentedTest.kt:95](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/NavigationInstrumentedTest.kt#L95) · [NativeCentralInstrumentedTest.kt:164](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/androidTest/java/dev/mote/collector/NativeCentralInstrumentedTest.kt#L164)。


## SQL 结构升级逐文件索引

以下列出生产代码的显式 ALTER TABLE、PRAGMA table_info 或等效结构升级位置。这些代码可能同时补新安装的缺列，不能凭“旧库升级”删掉整段。先把 CREATE 定义提升为完整当前基线，再把旧库转换移到受控的一次性步骤，最后验证旧备份导入边界。

| 文件 | 结构检查或修改所在行 |
| --- | --- |
| [evidence-archive.ts:21](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-archive.ts#L21) | 21, 56, 57 |
| [evidence-store.ts:114](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts#L114) | 114, 118, 119 |
| [execution-engine.ts:60](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/execution-engine.ts#L60) | 60 |
| [file-schema.ts:31](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/file-schema.ts#L31) | 31, 32, 33, 34, 35, 36, 37, 38, 39 |
| [material-memory-work.ts:28](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-memory-work.ts#L28) | 28, 33, 49, 50, 51 |
| [material-organizers.ts:494](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-organizers.ts#L494) | 494 |
| [materials.ts:169](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/materials.ts#L169) | 169, 170, 171, 172, 173, 174, 177, 178, 179 |
| [memory-deletions.ts:20](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-deletions.ts#L20) | 20, 21 |
| [memory-extraction-drafts.ts:12](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-extraction-drafts.ts#L12) | 12 |
| [memory-input-authorization.ts:24](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-input-authorization.ts#L24) | 24, 25, 26 |
| [operation-projection.ts:9](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/operation-projection.ts#L9) | 9, 10 |
| [processing-runtime.ts:53](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/processing-runtime.ts#L53) | 53 |
| [read-models.ts:5](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/read-models.ts#L5) | 5, 7, 8 |
| [source-archive.ts:42](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-archive.ts#L42) | 42, 44, 48 |
| [source-pipelines.ts:74](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-pipelines.ts#L74) | 74, 75, 76, 77, 78, 79 |
| [storage-ledger.ts:30](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/storage-ledger.ts#L30) | 30 |

## 容易误判的旧名与当前功能

以下是重点排除和另行清理候选。当前恢复、支持旧 OS 或第三方协议不会因为本次退役 Mote 旧版本而自然失去必要性；功能退休代码需要单独决定产品范围。

- **共享与脚本：packages/diagnostics/src/index.ts**。旧诊断文件不可读的catch是损坏恢复，不是接受旧schema；PID orphan cleanup是现行崩溃恢复 位置：[index.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/diagnostics/src/index.ts)。

- **共享与脚本：packages/agent/src/usage.ts**。SDK流式/聚合usage两种事件是现行外部SDK契约，不足以证明Mote旧版本迁移 位置：[usage.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/usage.ts)。

- **共享与脚本：packages/agent/src/codex-protocol.ts**。外部App Server字段与usage分桶，不是Mote旧逻辑 位置：[codex-protocol.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/agent/src/codex-protocol.ts)。

- **共享与脚本：scripts/test-heldout-memory-replay-sequence.ts**。保留旧实验ledger/wave1可回放，仅影响测试历史；不在生产用户资料兼容链路 位置：[test-heldout-memory-replay-sequence.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/test-heldout-memory-replay-sequence.ts)。

- **共享与脚本：scripts/composed-image-disclosure.ts**。one-original是显式测试实验对照契约，不是生产旧客户端兼容 位置：[composed-image-disclosure.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/composed-image-disclosure.ts)。

- **共享与脚本：scripts/reset-backend-v2.mjs**。显式破坏性MVP重置操作，不是自动兼容迁移；审计未执行 位置：[reset-backend-v2.mjs](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/reset-backend-v2.mjs)。

- **共享与脚本：packages/shared/src/model-providers.ts**。腾讯旧provider预设/OpenAI-compatible是第三方provider支持，与Mote旧版本存储兼容不同 位置：[model-providers.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/packages/shared/src/model-providers.ts)。

- **Central：apps/server/src/actions.ts**。当前enqueue129只写action_jobs，execute也给新jobs创建engine step；admit137是现行入口，不能整个作为历史迁移移除。只有ctor历史全扫描可在另存boot checkpoint后考虑。 位置：[actions.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/actions.ts)。

- **Central：apps/server/src/actions.ts**。当前可关联proposed/dismissed/succeeded；original.nativeOperationId仅成功receipt128生成，所以未落外部日历当前proposal也没有该字段。不是保证当前总有operationId的历史兼容。 位置：[actions.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/actions.ts)。

- **Central：apps/server/src/vector-work.ts**。当前模型/坏数据一致性及索引构建，不是确认的旧Mote schema迁移；无历史vector ALTER/backfill版本分支。 位置：[vector-work.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/vector-work.ts)。

- **Central：apps/server/src/document-decoder.ts**。第三方库兼容构建名称，不能证明Mote旧业务升级。 位置：[document-decoder.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/document-decoder.ts)。

- **Central：apps/server/src/import-runtime.ts**。第三方当前runtime构建，不是旧Mote import格式。 位置：[import-runtime.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/import-runtime.ts)。

- **Central：apps/server/src/model-catalog.ts**。当前第三方provider协议适配，删掉会失去现行模型服务，不属于仅旧Mote兼容。 位置：[model-catalog.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/model-catalog.ts)。

- **Central：apps/server/src/material-organizers.ts**。列ADD属历史schema项，但现行插件首次安装/升级的发现与cursor backfill是当前功能。先把字段写fresh CREATE，不能删整个discover/backfill机制。 位置：[material-organizers.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/material-organizers.ts)。

- **Central：apps/server/src/execution.ts**。现行所有store继续以域status写投影；executionEnvelope本身仍当前API统一层，不可只因兼容旧status整段删除。 位置：[execution.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/execution.ts)。

- **Central：apps/server/src/store.ts**。现行runtime仍从store.ts导入Store；这是源码命名别名，非旧数据格式兼容。可机械重命名但没有升级数据风险/收益。 位置：[store.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/store.ts)。

- **Central：apps/server/src/evidence-reader.ts**。当前截图与authored原件仍用此路径；“legacy”命名不代表当前停止写。 位置：[evidence-reader.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-reader.ts)。

- **Central：apps/server/src/conversation-lineage.ts**。当前轻量Store/Conversations消费者也不安装完整file processing graph；是当前组合能力，不等同缺旧schema。 位置：[conversation-lineage.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/conversation-lineage.ts)。

- **Central：apps/server/src/content-encryption.ts**。当前可切换加密写策略，后缀并存是当前支持；确定历史格式是无后缀对象，见S05。 位置：[content-encryption.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/content-encryption.ts)。

- **Central：apps/server/src/files.ts**。单文件begin/revision API当前仍有效；锁排序防当前批量与单文件竞态，不能按legacy注释删除。 位置：[files.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/files.ts)。

- **Central：apps/server/src/files.ts**。当前writer始终state，metadata事务accepted，逐项72 accepted/existing/missing_original、73 rejected；兼容逻辑落桌面reader，由root报告。 位置：[files.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/files.ts)。

- **Central：apps/server/src/source-catalog.ts**。当前外部源可不提供完整index metadata；没有证明仅历史写者触发，先保留为当前可选metadata策略。 位置：[source-catalog.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/source-catalog.ts)。

- **Central：apps/server/src/memory-review.ts**。现行缓存只在冻结时间、exact inputs/ranges、host validation与snapshot吻合时可复用；旧artifact兼容字段或missing refs不是可以删掉复用安全条件的理由。 位置：[memory-review.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/memory-review.ts)。

- **Central：apps/server/src/evidence-store.ts**。当前export仍产生version1归档；version1不等于旧产品版本。backup restore、缺表bootstrap/恢复容错按现行路径保留。 位置：[evidence-store.ts](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/server/src/evidence-store.ts)。

- **Desktop：DEV manual update / DesktopUpdater**。developmentBuild仍有当前writer(package build metadata)，仅status/check/notes路由手动DEV下载；channel/download/cancel/install仍有生产IPC、所有build启动initialize和startupCompleted。不是无caller旧更新残留。签名校验、事务恢复、原App回滚是当前更新链路保护，不属于老版本格式兼容。 scripts/release/mac-package.mjs:9 当前明确写moteDevelopment；若决定完全退役自动更新，可单独删除功能而非称历史兼容；必须settle未确认helper事务与receipt恢复。 位置：[main.ts:376](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/main.ts#L376) · [updater.ts:49](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/updater.ts#L49)。

- **Desktop：central-window embedded central + central-preload**。main生产打开central-browser外部Chrome。openCentralWindow只有smoke/test-web-login类脚本调用；可作为独立死代码/产品废弃清理，不冒充数据迁移兼容。 位置：[central-window.ts:18](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/central-window.ts#L18) · [central-smoke.cjs:23](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/scripts/central-smoke.cjs#L23) · [test-web-login.cjs:130](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/scripts/test-web-login.cjs#L130)。

- **Desktop：privacy reviewLocally / shouldExclude old helper**。生产collector用graded app-collection与upload-gate；旧helper目前仅测试；privacy.maskBitmap仍有live worker调用。

- **Desktop：localOriginalBase64、processLocalFile无spool模式**。source-files无accessMarkerPath时仍写localOriginalBase64；module contract/tests仍使用。当前managed正常路径使用spool，不等于全代码无人写。

- **Desktop：Native macOS13/14 EventKit/OCR fallback**。当前minimum macOS13.3仍支持macOS13；不是Mote升级兼容。

- **Desktop：pdfjs legacy distribution、Electron current fetch workaround**。第三方包所称legacy不是Mote数据/版本兼容。

- **Desktop：capture stages checkpoint、当前 queue import/export v1**。strict current version contracts/crash recovery/portable backup current writer。ensureAdapterVersion upgraded to finding D13 as active upgrade contract; no actual obsolete built-in implementation found.

- **Desktop：paused nsfw/Qwen privacy model pipeline**。collector已不调用模型reviewLocally，但model download/import/reload仍有现行UI/IPC调用；清理属于功能决策。

- **Desktop：plaintext config token rejection、connection authorization/privacy fail-closed**。explicit ignore/reject旧明文不会读取旧token；不应作为需要删除兼容代码。

- **Desktop：Kimi wire.jsonl/context.jsonl 与 Codex session id/input 等别名**。每种日志当前仍可能存在；wire优先避免同会话两个表示双采集。未证实是Mote旧版本本机状态；移除需要声明第三方提供方最小支持日志格式，影响历史导入范围。 位置：[coding-agents.ts:37](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/coding-agents.ts#L37) · [coding-agents.ts:80](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/coding-agents.ts#L80) · [coding-agents.ts:87](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/desktop/src/coding-agents.ts#L87)。

- **Android：Android OS/OEM兼容（不是Mote旧版兼容）**。minSdk=29到targetSdk36的平台截图/Insets/投屏/权限/Parcelable/返回回调与MIUI系统栏兼容；删除需要提高minSdk/改变支持设备范围，不能当历史业务代码删。 位置：[CaptureAccessibilityService.kt:51](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CaptureAccessibilityService.kt#L51) · [CaptureAccessibilityService.kt:78](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CaptureAccessibilityService.kt#L78) · [CaptureAccessibilityService.kt:161](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CaptureAccessibilityService.kt#L161) · [ProjectionService.kt:89](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ProjectionService.kt#L89) · [ProjectionService.kt:114](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ProjectionService.kt#L114) · [NativeInsets.kt:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/NativeInsets.kt#L10) · [MainActivity.kt:1286](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L1286) · [AppUpdateInstaller.kt:47](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AppUpdateInstaller.kt#L47) · [AppCollectionRules.kt:61](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AppCollectionRules.kt#L61)。

- **Android：MOTE_PROFILE=legacy/Gradle matchingFallbacks**。legacy是当前日常包配置名称，dev/fileFixture是独立安装身份；matchingFallbacks是Gradle依赖变体适配，不是升级运行分支。改包名导致应用数据/权限/KeyStore身份改变。 位置：[build.gradle.kts:23](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/build.gradle.kts#L23) · [build.gradle.kts:46](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/build.gradle.kts#L46) · [build.gradle.kts:52](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/build.gradle.kts#L52)。

- **Android：legacyExcluded参数和旧excluded键仍是当前功能**。MainActivity仍提供包名排除编辑器，当前采集/媒体策略仍依赖；合并到apps=off是一次隐私规则转换，不能直接移除。 位置：[AppCollectionRules.kt:12](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AppCollectionRules.kt#L12) · [MainActivity.kt:623](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L623) · [MainActivity.kt:831](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L831) · [MediaObservation.kt:10](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MediaObservation.kt#L10)。

- **Android：privacyFloor检查点键及stage version守护**。注释写兼容旧key，但reviewHeld当前writer/reader都用privacyFloor；保存被审查hold授权跨stage/崩溃仍必需。stage版本变化时拒绝丢held资料是当前扩展契约，不是单纯旧实现。 位置：[DurableQueue.kt:315](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/DurableQueue.kt#L315) · [CaptureStages.kt:50](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CaptureStages.kt#L50)。

- **Android：QueueLocationStore legacy目录和迁移恢复**。首次缺pointer采取原queue目录确能接旧存储，但新安装也选择同一个当前默认目录；普通用户选择外置卡迁移/日志恢复是当前功能。只能把旧目录adoption独立拆出，不能删load/recover。 位置：[QueueLocationStore.kt:39](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QueueLocationStore.kt#L39) · [QueueLocationStore.kt:100](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QueueLocationStore.kt#L100) · [QueueStorage.kt:31](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QueueStorage.kt#L31)。

- **Android：QueueBrowseIndex metadataVersion!=4重建**。包含老derived projection升级，但同一重建也处理缺失/损坏/mtime变化以及当前统计reservation安全；改cache version可清掉旧shards再重建，不能删可重建和quota守护。 位置：[QueueBrowseIndex.kt:82](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QueueBrowseIndex.kt#L82) · [QueueBrowseIndex.kt:129](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/QueueBrowseIndex.kt#L129) · [DurableQueue.kt:629](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/DurableQueue.kt#L629)。

- **Android：FileArchiveQueue processOne缺processor补local-file v1**。虽注释legacy index waits，但当前prepare不会预置processor，当前新processing job也在首次运行时用此分支，不能删而没有新的当前写方。 位置：[FileArchiveQueue.kt:155](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/FileArchiveQueue.kt#L155)。

- **Android：ConfigurationArchive同version1稀疏字段默认**。允许partial portable settings current.copy是现行接口，不足以证明每一个字段默认都只为旧版本；改必填会破坏现有部分配置导入。 位置：[ConfigurationArchive.kt:58](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ConfigurationArchive.kt#L58)。

- **Android：原生中央分页items/entries/jobs与cursor/offset**。这是多个当前端点复用原生render的异构形状容错，是否历史别名需由服务端写方确认；不能仅凭多字段fallback判旧兼容。 位置：[CentralLibrary.kt:324](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CentralLibrary.kt#L324) · [CentralAdmin.kt:74](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CentralAdmin.kt#L74)。

- **Android：中央memory version=1、defaultModels缺失、Codex serviceTier=default**。确有缺字段宽松处理，Android单边无法证明旧版本专用；发给父审计跨服务端确认。 位置：[CentralLibrary.kt:282](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CentralLibrary.kt#L282) · [CentralAdmin.kt:212](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CentralAdmin.kt#L212) · [CentralAdmin.kt:218](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CentralAdmin.kt#L218)。

- **Android：ConnectionClient accepts owner/collector和credential可缺deviceId**。可能旧owner凭据兼容，也可能owner手动登录仍属当前官方主路径；由服务端权限契约确认。applyResponse硬记scope=owner亦需核对，但本审计不改。 位置：[ConnectionClient.kt:75](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ConnectionClient.kt#L75) · [ConnectionClient.kt:65](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/ConnectionClient.kt#L65)。

- **Android：nsfw.enabled=false及localReview/Qwen设置/代码残留**。当前采集已不走旧VLM/HTTP隐私模型链；这属于退休功能遗留与旧配置归一化，不是旧实现仍被执行来兼容；应作为另一项dead feature清理而不要混入确定老格式兼容。 位置：[Settings.kt:96](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/Settings.kt#L96) · [CapturePipeline.kt:24](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CapturePipeline.kt#L24) · [CapturePipeline.kt:154](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CapturePipeline.kt#L154) · [MainActivity.kt:670](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L670) · [MainActivity.kt:696](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/MainActivity.kt#L696)。

- **Android：404需升级文案、网络/413缩批、文件range续传、JSON可选值**。目前故障提示/负载适配/HTTP协议特性，不等于旧业务实现。 位置：[SyncRecoveryWorker.kt:47](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/SyncRecoveryWorker.kt#L47) · [UploadNegotiation.kt:6](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/UploadNegotiation.kt#L6) · [AppUpdateStore.kt:57](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/AppUpdateStore.kt#L57)。

- **Android：SecretBox仍加密当前中央原生draft/import和日历action ledger**。这些现行writer直接SecretBox，不是LocalContentCipher历史封装回读；不在七区域migrateLegacyContent范围。删除SecretBox/Keystore会毁掉现行问答草稿、notes outbox、导入文件和行动防重复账本。 位置：[CentralScreens.kt:34](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CentralScreens.kt#L34) · [CalendarActions.kt:88](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CalendarActions.kt#L88)。

- **Android：CalendarActions.related.operationId缺失时预期旧description**。描述允许[Mote:action]单marker或额外[Mote-operation:operation]；需服务端related字段契约确认，已交父审计，不将可选值擅自定为旧版本兼容。 位置：[CalendarActions.kt:111](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CalendarActions.kt#L111) · [CalendarActions.kt:31](https://github.com/utopiafar/mote/blob/8d68aef2ddd9f531d88e3337ce97215945222f14/apps/android/app/src/main/java/dev/mote/collector/CalendarActions.kt#L31)。

## 实施顺序与验收条件

1. **定义支持边界。** 分别确定 Central/Desktop/Android 的最低软件与存储格式。wire v1 与 ingress v2 是两个合同，不能用产品版本大小或删除一个 header 替代它们。若选择只支持新安装，应明确拒绝旧库，不把旧库静默当新库。
2. **统计并冻结旧写入。** 所有 profile、外部队列目录和可恢复备份都纳入清单；检查旧密文、无 marker、未 ACK、旧 wire pin、缺字段配置、旧任务/删除意图。当前写者必须先停止产生旧格式，尤其 Android raw 加密开关。统计程序只记录格式、数量和状态，不输出正文或凭据。
3. **备份并保留迁移工具。** 保存数据库一致性副本、关联原件和源归档，密钥单独保存；浏览器离线笔记、本机草稿、授权绑定和撤销信息要包含在恢复计划中。没有稳定入口的 assets/source index/content 解密迁移需要先做工具，不能把私有方法当现成可直接执行命令。
4. **先转换再缩减读取。** 保持 capture ID、source revision、payload、引用、删除意图与原节点身份；不能给已尝试过的同 ID/revision 改 payload。对无法复原的归属/时间/权限 lineage 保留 unknown/incomplete 或要求明确重新处理，不用内容关键词推测。
5. **关闭重新引入旧格式的入口。** 旧便携包、队列/目录复制、旧缓存和还原快照都能带回旧格式。可以提供最低格式拒绝或独立迁移器；若继续接受旧备份，就仍需要相应读取能力。
6. **按链路验证。** 使用生成的升级前格式 fixture 覆盖新安装、跨版本升级、迁移中断重启、ACK 丢失重试、旧备份恢复、跨节点阻断、来源授权撤销、删除后不得再生，以及完整原件/引用可读。必须走真实应用启动入口，不能只构造一个 store 就宣称升级无损。
7. **分开报告验证。** 实际实施后运行适用工作区测试；共享协议改动验证三端消费者；PR 前必须运行 `npm run check:local`。Android JVM/instrumentation、物理设备与 live-model 结果分别报告。需要新增 moteText 文案时同步英文和 Android catalog。

风险等级表示在没有满足删除前置条件时的直接后果，不是生产发生概率。本次没有检查部署或个人数据库，因此“旧存量已清零”“无外部旧客户端”“性能能提升多少”都尚未验证。
