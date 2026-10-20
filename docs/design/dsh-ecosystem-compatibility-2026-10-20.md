# Mote × DeepSeek Harness：分阶段生态兼容

日期：2026-10-20。产品方向及 A / C / B 路线由用户在本次对话确认。
基线：`cc5d30f8e84bff9276b4487ffd7254c594b154df`。
当前状态：第一阶段进行中；本 PR 提供审计、固定样本和诊断程序。
生产运行时的具体接线方案仍需按 AGENTS.md 获得独立工程评审 APPROVE。

## 产品边界

Mote 保持多端个人信息采集、汇聚、处理、记忆与检索平台的定位。
兼容上游生态，复用其开发者成果；不建设与 DSH 并行的通用应用商店。
端侧负责采集、授权、轻过滤与同步，中央负责主要语义处理。

已确认选型：

| 项目 | 决定 |
| --- | --- |
| 运行时 | `sdk-minimal`，按需组合原生插件及 Bundle |
| 安装 | 优先复用 DSH 安装器、依赖解析、Profile 与 Loader |
| 信任 | 分级信任；第一步由管理员选择固定版本可信包 |
| 范围 | Tool / Skill / MCP 优先，Model / Event / UI 分类推进 |
| 身份与资料 | Mote 管理账号、来源、版本、证据、授权与发布 |
| 持久任务 | Mote 负责持久执行与恢复，DSH 负责 Agent 推理和工具编排 |
| 界面 | 保留 Mote 的资料库、问一问、来源、活动与设置，不另造外壳 |

## 原流程与目标流程

当前多用户外部插件流程为固定 Mote release → 管理员安装 → 用户实例配置 →
实际核验 → 授权启用 → 固定快照 → worker 调用 → 正式资料/Memory 领域发布。
工厂为 `createMotePlugin` / `createMemoryProvider`，公开通用 invoke 支持 source、
processor。原生 `apply(ctx)` 以及插件自有触发器尚未从该入口开放。
依据：[当前开发入口](../plugin-authoring.md)。

目标 DSH 流程为上游市场/固定 Git 源 → 上游兼容检查与安装 → 不可变包版本 →
用户配置与授权 → 按任务装配原生 DSH Profile → 原生工具/Skill/MCP 调用 →
按需经 Mote bridge 读取资料或提交领域产物 → 统一活动状态与历史读取。

通用计算器可在不访问 Mote 资料的情况下工作。安装一个搜索工具也不会自动让它
读取整个资料库。需要个人上下文时，由本次任务显式提供获授权的引用、摘录或服务；
需要新增资料时，走 Mote 的发布接口。一次原生工具调用不自动变成持久资料。

| 分类 | 处理 |
| --- | --- |
| KEEP | 多用户隔离、只读查询、证据来源、版本、原件与正式资料、任务恢复、现有 Mote worker/provider |
| CHANGE | 增加上游 Bundle 的安装与原生执行路径，并将上游配置装配到用户/任务快照 |
| REMOVE | 要求通用第三方插件改写为 Mote 工厂或另发 Mote 专用 manifest |
| EXCEPTION | 原生客户端能力需要客户端实现；可信代码执行与 OS 沙箱分别报告；安装和授权分开 |
| UNKNOWN | 目标市场实际快照、各插件安装兼容性、原生服务依赖覆盖、真实多用户运行与 UI 支持 |

## 阶段与 PR

后续阶段的 PR 基于前一阶段已验收版本；若采用堆叠分支，PR 明确 base 与依赖。
不自动合并 main、不发布版本、不改部署、不触碰用户个人资料。

| 阶段 | 轮次 | 实施内容 | 退出条件 |
| --- | --- | --- | --- |
| 1：审计与原生实验 | R1–R2 | 当前入口审计、固定真实样本、上游 SDK 原生调用实验、Mote 入口验证 | 至少一个未修改社区插件完成原生调用，并验证 Mote 集成与原有查询权限 |
| 2：运行与安装 | R3–R5 | 共享不可变包、用户实例、上游安装器、市场发现、Tool/Skill/MCP 兼容 | UI 安装/配置/授权/执行闭环；版本、隔离、停用及卸载回归 |
| 3：业务桥接 | R6–R7 | Context/Memory/Processing bridge、模型通道、事件触发、持久任务与外部动作 | 新资料触发真实流程；证据可追溯；重启、撤权、取消、外部结果未知正确 |
| 4：体验与回归 | R8–R9 | Web/Mac/Android 入口、声明式展示、独立场景验证、升级回归与指南 | 冻结目标旅程全部断言通过，未覆盖类别有独立状态 |

### 第一阶段顺序

1. 固定 Mote commit、lockfile 与样本来源；记录 npm integrity / Git commit / 文件 blob。
2. 审计声明与已有入口，区分 host 插件、Bundle、仅客户端组件；不将依赖库全算市场包。
3. 用未修改的社区计算器跑真实 `DeepSeekHarness` + 生成的 loopback 模型应答。
4. 验证官方 Skill、MCP 与组合工具，包含停用和销毁；留出独立 held-out 插件。
5. 将上述能力通过真正 Mote 产品入口运行，保持只读查询和用户/来源授权。
6. 独立评估后结束第一阶段，再进入安装与 UI。

本 PR 的 `native-smoke.mjs` 只负责第 3 步的上游 SDK 实验。它按文件 blob 检查
计算器源码、固定 DSH 版本、核对实际工具结果及 SDK 事件；不会安装包或改变 Mote。
其成功范围明确为 `upstream-sdk-only`，Mote 入口和市场安装分别记账。

### 第一批样本

机器可读清单：[samples.v1.json](../validation/dsh-compatibility/samples.v1.json)。
10 个上游组件来自当前 lockfile，2 个社区 Bundle 来自独立仓库；这是版本与来源样本，
完整的市场 Bundle 样本和 held-out 组在取得真实市场快照后补充新修订。

| 样本 | 适合验证的场景 |
| --- | --- |
| 社区 calculator | 不联网的真实工具调用、正确结果、旧 peer 依赖核验 |
| 社区 toolkit | 多工具注册、命名冲突、独立卸载；实现源码还需审计 |
| 上游 tool-skill / skill | 既有 Skill 机制、生成材料、工具可见性与撤销 |
| 上游 mcp-client / mcp-resources | 生成 MCP 服务、资源读取、工具调用及来源关联 |
| 上游 llm-pi-ai | Mote 现有多模型接口与 loopback 模型测试 |
| 上游 attachment-local | 生成图片、工作目录和引用 |
| 上游 tool-fs / fs-local | 隔离临时工作区与只读查询边界 |
| 上游 schedule-bundle | 对接 Mote 持久任务的边界样本 |
| 上游 client-ui-theme | 客户端专用依赖识别，保持 Mote 界面定调 |

两个社区仓库的包使用 `@deepseek-ai` 名称，但来源归类为 community。
它们声明 `private: true` 和早期 DSH peer 范围；使用固定 Git 来源核验上游安装器，
不把名称转换为未经确认的 npm 安装来源，也不强制忽略 peer 检查。

## 下一阶段的有界工程评审

生产变更前提交完整 bounded plan。共享文件由单一 owner 修改：

| 所有者 | 可能影响的位置 | 评审重点 |
| --- | --- | --- |
| 运行时 owner | packages/agent 的启动 patch、tools 与 model transport | 保留真实 DSH 服务；工具准入与 Mote 只读查询的关系 |
| 安装/实例 owner | plugin-center、plugin-release、scope/plugins、ConfigService | 上游源、固定版本、构建脚本隔离、配置唯一权威、共享包/用户实例 |
| 领域 owner | Context/Processing/Memory/TaskExecution | 原授权、真实发布、模型费用与外部动作恢复 |
| UI owner | 现有 PluginCenter 与客户端展示 | 复用既有导航，不新增第二套任务页 |

重点风险：原生插件的 Node 文件/网络权限；共享进程与模型凭据；现有全局 fetch 包装
对第三方请求的影响；上游服务缺失；插件热更新与在途快照；原生 UI 与 Mote UI 差异。
这些风险通过边界测试和隔离验证解决，不在第一阶段直接删除现有 guard。

独立 Reviewer 审计划，Implementer 实施，Evaluator 读真实结果；工程评审尚未执行。
保持模型模拟与真实加载/调用分开。复用现有受影响检查，不新增 CI 权限或部署工作流。

## 证据与验收口径

每个样本单独记录：来源/包字节、安装、加载、调用、Mote 旅程、停用/升级/恢复。
每份运行结果绑定 Mote commit、包版本/摘要、配置、模型 fixture、环境与输出。
`not_run`、环境 `blocked` 与执行 `failed` 分开，未执行项不从统计分母中删除。
正常工具路径与副作用路径独立验收，批准外部动作前仍遵循原有确认要求。

数据集更改形成新修订，旧失败收据不覆盖。兼容率按 Tool/Skill/MCP/Model/Event/UI
和 Bundle/内部模块分别统计；同作者套件与已公开回归不计作独立 held-out 样本。

## 可复用的上游依据

- [sdk-minimal 原生组合与限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/README.md)
- [上游市场 format: 1 与安装身份](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/guide/plugin-market.md)
- [社区 calculator](https://github.com/omdsh-dev/dsh-tool-calculator/tree/b2007a13f06bcf75bf07b9d277ee8d434a316490)
- [社区 toolkit](https://github.com/omdsh-dev/dsh-toolkit/tree/c3319d9d3e78a18191e1381461b69e84bc547575)

上游 DSH 文档说明默认不附带市场索引源。本专项按用户指定 URL 核验，保持其第三方
来源身份；当前未取得该 URL 的实际 JSON 字节，未保存臆造的市场快照。
