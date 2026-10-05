# 编码 Agent 对话与经验记忆

> 当前提取政策见[用户表达、代办任务与项目归属](personal-memory-attribution.md)：Agent 会话不再强制输出 coding 领域；用户自身表达进入个人记忆，代办任务只保留可按需查找的资料线索。下文早期“渠道到 coding 领域”描述不再适用于新提取。

> Coding 接入已切换为 Cordis source pipeline：原始事件只存文件归档，清洁会话发布后可索引；模型处理另需已授权 Memory 任务。此路径不再走下文的原始 capture 整理链；新配置、MVP 切换与验收边界见 [Source pipelines](source-pipelines.md)。普通记录来源保留原链路。

Mac 可显式连接本机 Claude Code、Codex、Kimi Code。当前链路在中央将私有归档与 AI 可读对话分开，已授权 Memory 任务在后台统一理解对话，再独立评审 Memory；已有洞察与 Chat 通过只读工具读取派生产物和原始对话证据。不会回写外部 Agent 的配置/记忆或恢复其原生 session。

## 当前链路：清洁对话与统一理解（0.0.83）

```text
来源 JSONL / wire
  → 客户端格式解析、隐私过滤、可靠上传
  → 中央私有原始归档与 receipt
  → 按 provider / project / session 发布清洁对话 Material
      → 正文索引与有界原文读取
      → 已授权 Memory 任务 / 自动接收授权
          → 后台统一理解
          → 摘要、工作记录、可选事件、Memory 候选
          → 独立 Memory 评审与发布
  → Ask / 洞察用只读工具选择产物与证据范围
```

中央先用确定性的来源协议规则清洗，再发布 schema 6 的模型可读对话。仅保留明确归属于人类的用户发言，以及协议确认的助手正式回复：Codex 的 `final_answer` / 完成回执、Claude 的无工具调用 `end_turn` / `stop_sequence`、Kimi 的最后无工具步骤在 `TurnEnd` 确认后的文本。思考、分析、commentary、排查过程、工具参数和结果、宿主上下文、子 Agent 会话与无法确认的助手回复均不进入索引、理解、记忆或查询模型。完整 multipart 消息先组装、去除明确的宿主封装；缺片不发布正文，单条超过 12,000 UTF-16 字符则排除并声明覆盖限制，不截成看似完整的回复。

原始归档只供所有者追溯及确定性处理，任何模块的模型均不能读取它。删除先前的全会话模型摘要预处理；后台只读取已经清洗的有界证据，每次最多 12,000 字符。历史 schema < 6 正文及其依赖投影阻止进入模型，升级不自动重建或回填已有资料。规则只识别 role、channel、stop reason、原生 UUID、分片和明确封装，不判断用户意图、话题或记忆价值。用户真实发言和正式回复中引用的命令、日志或第三方文字仍是其陈述证据，不能据此独立验证工具结果。

统一理解由既有已授权 Memory 任务驱动，不是每次收到对话就调用模型。自动路径要求该来源/recipe 的 Memory 设置启用，且原始接收时已有相应授权；用户也可对选定证据显式发起 Memory 任务。升级组织器、重建历史资料或后来打开 Memory，都不会为先前未授权输入补发自动模型权限。仅新增工具原料不算新对话输入，也不续发已用完的权限。未启用 Memory 或尚未授权时，清洁资料仍照常发布、索引和读取。

后台沿用现有运行时、模型配置、配额、取消与重试机制，对已发布、固定修订的一段清洁对话统一理解。一次产出可供不同消费者使用：摘要和工作记录支持工作回顾，事件可支持“什么时候讨论/做了什么”，Memory 候选按任务所选 extract policy 生成，再独立价值评审。extract policy 指纹进入统一理解任务身份，换策略不能复用旧策略的候选产物。事件与候选都可以为空；不要求每段 coding 对话产出个人洞察。资料发布不等待模型成功，后台未完成时仍可读清洁对话。

摘要、工作记录与事件进入可读、可检索的派生正文，包含 actor、status、basis、sourceTime、不确定性与原始证据 ID。Memory 候选正文不进入这个检索/读取投影，只作为任务结构化产物交给独立评审；发布后的 Memory 使用原有 Memory 入口。因此，即使持久 Memory 为零条，也能按证据查到本次工作记录与事件。

所有产物引用清洁对话中的原始证据 ID、精确引句及绝对偏移，不能引用另一个模型摘要充当原文。工作记录区分需求、约束、决策、结果陈述、验证陈述、未完成项与产物定位，并保留说话人、状态、依据、来源时间及不确定性。助手说“测试通过”仍只是助手报告；用户确认也只支持其实际确认的范围。来源时间表示陈述时间，明确的事件发生时间另存；消息间隔不能算作劳动时长。

例如使用一段合成对话：10:00 用户说“把导入按钮改名为上传，先给我预览”；随后工具调用修改文件并运行测试；10:08 助手说“已改名，fixture 测试通过，尚未部署”；10:10 用户说“预览可以，部署先等等”。

| 环节 | 旧链路的产出 | 当前链路的产出 |
|---|---|---|
| 接收 | 对话文字、工具参数/输出及来源元数据的私有归档 | 相同可靠接收边界；采集来源保留 channel/说话人元数据 |
| Material | 对话和工具正文一起进入可读 Markdown | 三条人类/助手陈述及时间、来源 ID；工具正文和宿主上下文不进入 AI 读取面 |
| 后台理解 | 主要从完整会话提取 Memory | 一次理解得到需求“改名并先预览”、助手报告结果、用户确认预览、明确“尚未部署/部署暂缓”；每项指向其原句 |
| 事件 / Memory | 工作产物可能只存在于候选或原文中 | 可选事件“10:10 用户确认预览并暂缓部署”；这种一次性决定可以不成为持久 Memory，独立评审允许零条 |
| 查询 | 展开会话时可能读到大量工具日志 | 先检索摘要/工作记录，再按需展开相关原句；回答“预览已确认，部署暂缓”，并明确测试结果来自助手报告 |

清洗后仍较长的对话按连续、有界页处理并记录实际覆盖范围，不静默只保留最后一段。单次理解不声称覆盖整个 session，也不能以本页未见为由否认范围外的结果。派生工作记录不会覆盖原文；资料修订、隐私变更和删除继续使依赖产物失效。具体运行与证据边界见 [Source pipelines](source-pipelines.md)。

Claude 原生 UUID 用于跨文件稳定去重；compaction sidechain 不作为新的用户对话。父任务等待子任务时保留持久输入授权，子任务不因父任务暂时释放运行锁而失效；取消、暂停准入、权限撤销及原文修订仍会阻止执行。

以下保留 2026-09-17 的调研和早期实现记录。其工具正文可见及独立 coding 提取描述属于旧链路；当前行为以本节及 Source pipelines 为准。

## 调研与取舍（2026-09-17）

以下区分项目文档的已实现行为、公开问题报告和 Mote 的设计推论。没有照搬第三方源代码。

| 项目 | 记忆处理与实际风险 | Mote 的取舍 |
|---|---|---|
| [claude-code-sync](https://github.com/melihemreguler/claude-code-sync) | Git 支持的选择性原生会话同步，按路径控制范围；主要解决搬运，未提供语义提炼 | 保留来源过滤；不改原生目录 |
| [codex-session-sync](https://github.com/shonngithub/codex-session-sync) | WebDAV、备份、冲突策略；要求 Codex 关闭后冷同步，以免覆盖正在写的状态 | 只读完整 JSONL 行，未完成的尾行等待下一轮 |
| [lidongpeng36/agent-sync](https://github.com/lidongpeng36/agent-sync) | SSH 同步 session/memory，侧重原格式安全与差异 | 传输和语义分别处理；不把文件复制成功当 Memory 完成 |
| [OpenMemory](https://github.com/mem0ai/openmemory) | Claude/Codex/OpenCode 会话转换与预览，解决 session portability；不是持久记忆质量系统 | provider adapter 输出统一证据契约，不统一 Agent 内部运行状态 |
| [history-viewer](https://github.com/jhlee0409/claude-code-history-viewer/blob/main/CHANGELOG.md) | 多 provider 解析；变更记录包含 Kimi macOS watcher、UTF-8 路径及巨大工具输出卡顿的修复 | 专用 worker、分段及预算、明确不完整状态，项目路径来自元数据 |
| [sessions](https://github.com/nicknisi/sessions) | 跨 Agent 历史索引、长期 transcript archive、渐进检索；清索引不删除归档 | 原始证据与可重建派生产物分离 |
| [claude-mem](https://github.com/thedotmack/claude-mem) | hooks→worker→observation/summary→SQLite/检索。公开 [#3917](https://github.com/thedotmack/claude-mem/issues/3917) 报告高水位导致旧未同步行被跳过；[#3902](https://github.com/thedotmack/claude-mem/issues/3902) 报告告警进入 observer，反复输出告警、阻碍恢复 | 事务性逐项 inbox；空候选可正常完成；原文不是指令；系统日志不作用户经历 |
| [codex-mem](https://github.com/KeystoneScience/codex-mem) | notify、exec JSON、app-server 三种采集路径；SQLite、渐进读取、可选 MEMORY.md projection | 本期只读历史，可完整回填；无需修改 notify、hooks 或 Agent 配置 |
| [hibeekaey/agent-sync](https://github.com/hibeekaey/agent-sync) | 模型将各 Agent 记忆语义合并为 canonical 文件，校验遗漏标识符、备份、预算压缩与递归防护 | 采用模型判断可复用性；不将合并后的文本当独立原始证据，也不把所有内容注入下一次会话 |
| [shared-agent-memory](https://github.com/dan-calin/shared-agent-memory) | 中央 MCP memory store 与协作能力；依赖 Agent 主动读写 | 中央是 owner，来源仅是生产者；本期不新增外部写/查能力 |
| [cross-agent-memory-kit](https://github.com/internetyev/cross-agent-memory-kit) | Python adapter→共用 engine/prompt→mcp-memory-service；区分 artifacts 与 durable facts | 最值得借鉴的是职责分界和经验规则；不会因 Python 实现而另建一套数据库 |
| ShareMemory | 原对话只给名称，没有仓库身份；同名项目无法可靠定位 | 不把未核实的实现或问题写成已确认结论 |

### Python Memory 的实现与踩坑

重点阅读了 cross-agent-memory-kit 的 [engine.py](https://github.com/internetyev/cross-agent-memory-kit/blob/main/distill/engine.py)、[storage.py](https://github.com/internetyev/cross-agent-memory-kit/blob/main/distill/storage.py)、[prompt.md](https://github.com/internetyev/cross-agent-memory-kit/blob/main/distill/prompt.md) 与 [LESSONS_LEARNED.md](https://github.com/internetyev/cross-agent-memory-kit/blob/main/LESSONS_LEARNED.md)。

- Python 负责标准化、调模型、校验/落库及运行记录；语义政策主要在 prompt，存储经 MemoryService/SQLite-vec。并不需要“Python Memory”作为独立架构层。
- prompt 把产物与跨项目事实分开，并要求少量、可独立理解的结果。Mote 更侧重有适用条件的决策、踩坑、原则和明确偏好，省略流水账式产物目录。
- 文档记录过 venv 不一致导致写入失败、不同 OS 数据库路径、CLI 错误包装、项目 slug 漂移、同步 hook 阻塞和自采集递归等问题。Mote 使用现有中央运行时/队列，项目键由宿主生成，模型调用必须使用隔离、ephemeral 的上下文。
- engine 当前仅取 user/assistant 文本，过长取最后 80,000 字符。这可能丢掉早期约束和真正的测试结果，是代码带来的覆盖限制。Mote 在私有归档保留已授权工具证据，当前 AI 读取面仅有清洁对话；长内容逐页覆盖，不静默只取末尾。

## 分流：证据领域、适用范围、来源渠道是三个维度

渠道 claude/codex/kimi 只决定格式解码。显式 `document.coding` 标记编码对话，宿主选择 `coding-memory` profile；普通笔记、日历等仍走 `memory-extraction`。不按词、应用名称或语义猜测路由。

第一层是**有证据的编码经验候选**，不是人的生活事实、人格特征或逐条任务总结：

- `kind`: pitfall / decision / principle / preference，由模型判断。
- `scope`: session / project / shared。项目约束留在项目；跨项目仅允许 principle/preference，必须说明条件和例外。shared 指这个所有者跨项目参考，不表示对外发布。
- `validation`: observed / user_confirmed / tested / unverified。助手说“完成”不自动等于测试通过，工具调用请求不等于工具执行成功。
- `applicability`、`uncertainty`、原文精确引用和宿主保存的 UTF-16 偏移（唯一逐字匹配可省略模型偏移；多处匹配或错误显式偏移会拒绝）；session/project/provider 引用由宿主从原文分配。

每批最多三条，可以零条；仍为 proposed，确认后才 published。系统不声称能自动裁决所有矛盾、跨会话语义去重或保证经验完整。相同证据的重试由检查点去重；不同证据表达同一理念仍可能产生多个候选。本期共享原则与项目经验都直接引用原始对话，未另建无原文依据的摘要级“记忆的记忆”。

## Mac 采集和隐私边界

在“来源”点击“连接 Coding Agent”，选择实际存在的 Agent，再点击“采集所选 Agent”。沿用首次全部/仅新增、保留快照/引用、排除相对路径和字面遮盖。默认不自动连接，不跟随符号链接，不修改 Agent 文件。暂停和节点更换沿用已有队列绑定。

- Claude: `~/.claude/projects/**/*.jsonl` 的 user/assistant 和 tool_use/tool_result；保留 cwd/session 元数据，不从有损目录名称猜项目。
- Codex: `~/.codex/sessions/**/*.jsonl`，以 response_item 为唯一消息表示，session_meta 提供身份；不重复摄取 event_msg 的同义消息。历史 archived_sessions 不在本期默认根目录内。
- Kimi: `~/.kimi/sessions/**/wire.jsonl` 优先；没有 wire 时读取 context.jsonl，不能同时读取两种表示。无原始时间的 context 不伪造 authored time；没有 cwd 时范围退回本会话。
- 收集用户/助手可读文本、工具输入/结果及原始时间。系统提示、隐藏思考、遥测不收集；图片仅保留附件缺失标记，不读取个人截图或认证文件。这是可追溯的可读对话归档，不是可原生恢复的逐字节备份。
- 工具正文仍可能含个人信息，按用户设置遮盖和排除，不声称能自动清除所有秘密。正文和测试样本不进 Git。

读取以完整 JSONL 行为单位，默认每轮 200 个正文片段或 4 MiB 输入预算，单事件最多 4 MiB；长文本切为最多 8,000 UTF-16 单位的片段，避免切断代理对。超过单事件限制或格式错误会报告扫描不完整并保留位置，不丢弃后宣称完成。原生文件被截短/替换后启用新 generation，避免覆盖旧证据；本期不推断原生删除意味着中央应删除。

字节位置和待上传正文在同一次本地持久化中提交；完整匹配 ACK 才清除待传项。已确认正文不重复保存在本地索引。过滤规则改变会清除未上传旧正文并重扫。原文文件的中间原地改写不属于 append-only 契约；本期检测 inode/截短及游标前 256 字节变化，不能保证发现任意早期字节的就地修改。

## 中央与 Harness 模块化

`coding-agents.ts` 解码；通用 SourceSync 管持久队列/认证/幂等。中央来源 upsert 和通用 changes 增量日志同事务。0.0.31 起自动提取统一由 Memory 生命周期调度，有增量且达到 25 条或最长等待到达时准入（默认有效最长等待 1 小时），详见 [当前调度](memory-lifecycle.md)；高频上传不立即调用模型。不同 session/project/profile 仍不在同一提取批次；无模型时保留增量，失败保留任务和窗口并重试，不回滚原文同步。0.0.30 遗留 inbox 中的原文已存在于 changes 日志，统一游标从该日志处理，历史提取 checkpoint 避免重复提取。

`memory-profiles.ts` 声明 Skill、版本、分组及输出政策；`coding-memory/SKILL.md` 负责判断价值。现有 DeepSeek Harness 保持只读工具、范围授权和引用校验。`MemoryPipeline` 负责预算、版本检查、一次结构修复、检查点；`MemoryStore` 负责结构与证据校验、候选保存/失效。无需复制 Harness 或按渠道建立三个 Memory 引擎。

统一生命周期只在连续变更窗口成功后推进进度；失败保留原窗口、任务和配置，运行期间的新变化留到下一轮，不能用后来的成功跳过旧失败。记忆保存与完成检查点同事务。长期整理在独立的编码领域进度下复查候选与原文，仍保留项目范围和验证程度，详见 [Memory 生命周期](memory-lifecycle.md)。

Chat 和洞察继续使用原有只读来源、证据、Memory 工具；记忆页显示编码类型、适用范围和验证程度。没有新增外部 Agent recall API 或自动注入功能。
