# 中央节点诊断与排错

中央节点把请求、入库、索引、资料读取与 Agent 执行记录为固定结构的数值事件。控制台可读取诊断快照并下载支持包；无需部署额外的日志服务。

## 升级后点击专用页面失败

首页已打开时重新构建或升级中央网页，旧标签页仍可能引用上一构建的延迟加载模块。点击 Agent 视角等入口才会请求该模块；若旧文件已被替换，页面会显示加载失败。旧版可能显示“专用视图暂不可用，请查看资料库或重试。”，浏览器控制台同时出现 `Failed to fetch dynamically imported module` 或 JavaScript MIME 类型错误。

旧版已经失败的标签页需要刷新一次；只切换页面不能清除本次文档里已经失败的 `React.lazy` 导入。Agent 视角的页面代码现在随首页加载，数据仍在进入页面或切换标签时按需请求，因此已打开的新首页不需要额外模块请求、刷新按钮或自动重载。不存在的 `/assets/` 文件返回不可缓存的 404，不再返回首页 HTML。其它延迟加载页面若刷新后仍失败，查看失败模块的 HTTP 状态，确认网页已构建完整、代理未缓存旧入口，并核对正在运行的中央目录。

## 先取得请求编号

每个 HTTP 响应带有 `X-Request-Id`，由中央节点新生成，不采用客户端传入的值。失败响应同时提供：

```json
{"error":"agent_response","message":"模型未返回可验证的回答，请重试或检查模型配置。","requestId":"00000000-0000-4000-8000-000000000000"}
```

使用这个编号在诊断面板中查找同一次请求的事件。模型查询中的资料读取与 Agent 阶段共享请求编号；并发请求的编号相互独立。后台索引和定时洞察拥有独立的任务编号，不等同于之前某次上传的编号。

## 配置

将配置写入实际使用的主 `mote.yaml`，也可在设置页保存同一文件。使用 `MOTE_CONFIG_FILE` 显式选择文件；旧 `MOTE_ENV_FILE` 启动方式会拒绝，需要离线准备 YAML 后改用新选择器。诊断开关、级别与 trace 校验成功后立即生效，日志目录和容量参数需重启。不要把开发、验证和日常资料库放在同一个数据目录。环境和部署方式见 [deployment.md](deployment.md)。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `diagnostics.enabled` | `true` | `false` 时不读取、积累或写入诊断事件；即时数值状态仍可查看 |
| `diagnostics.debug` | `false` | `true` 时将非 silent 级别提升为 debug，额外记录阶段开始事件，便于发现尚未完成的阶段 |
| `diagnostics.traceEnabled` | `false` | 把详细 Agent 内容写入独立 trace 分段，可能包含个人内容 |
| `diagnostics.level` | `info` | `debug`、`info`、`warn`、`error`、`silent`；`silent` 优先于 debug 开关 |
| `diagnostics.directory` | 数据目录下的 `logs` | 每个节点使用独立目录；不会出现在支持包内 |
| `diagnostics.maxBytes` | `16777216` | 每个分段的大小上限；最大 100 MiB。写满或跨 UTC 日期只创建新分段 |
| `diagnostics.maxTotalBytes` | `2147483648` | 所有日志级别与监督进程共用的总预算 |
| `diagnostics.retention` | 见下文 | 各级别独立的时间与容量上限 |
| `diagnostics.traceExpiresAt` | `0` | 详细记录截止时间，Unix 毫秒；从诊断偏好开启时自动设置为 24 小时内 |
| `diagnostics.maxEntries` | `2000` | 内存事件上限，允许 `100`–`5000` |

debug 开关只增加固定事件，不记录请求正文、模型输入输出、令牌、原图、来源文本、文件路径、设备名称或原始 URL/query。另行开启 `diagnostics.traceEnabled: true` 后，开发诊断会在独立 trace 分段记录这些详细内容；模型与 SDK 异常按类型或 HTTP 状态映射为固定类别，不会返回异常原文或堆栈。

文件名为 `central.<level>.<firstMillis>.<lastMillis>.<id>.ndjson`，监督进程使用 `supervisor` 前缀。error、warn、info、debug、trace 的默认目标分别是 30 天/128 MiB、14 天/64 MiB、7 天/256 MiB、2 天/128 MiB、1 天/1 GiB。过期内容先删除；某类超过预算时只删除该类最旧的分段；总空间不足时按 trace、debug、info、warn、error 顺序清理。低级别的新日志不能挤掉更高级别的已有记录。容量有限时，实际覆盖时间可能小于目标。

目录写入和清理由同一短锁协调，文件权限为 `600`、目录为 `700`。调小配置不会截断已有文件。目录里不支持的历史文件不自动读取或删除，其日志/临时文件字节仍计入总预算。需要保留的历史文件可先导出到私人位置，再明确清理。详细记录关闭或到期只停止新增；已有内容继续遵守保留期限。
内存写入队列最多保留 1024 条待写事件，另有最多 64 条正在写入；单条结构化日志最多 20 KiB，超出时截断可选字段并标记 `truncated`，不会丢弃整条事件。突发流量或磁盘故障时允许丢弃诊断事件，`droppedEvents` 和 `writeFailures` 会增加，业务隐私检查与入库不因此被绕过。关闭服务会等待当前日志写入结束。禁用诊断不会主动删除已经存在的历史日志文件。

详细 trace 使用 8 MiB 单条硬上限，并且不能超过所配置的文件容量；超大 trace 写入截断摘要。其它 trace 字符串、集合和深度边界见 [服务器配置](server-configuration.md#日志与调试)。启动、分页与范围导出按行遍历日志，安全范围导出不会累积 trace 正文；原始文件下载最多返回一份 100 MiB 分段。

## 认证 API

以下接口都需要中央节点 Bearer 令牌，并返回 `Cache-Control: no-store`。不要把令牌写到 URL 参数中。

| 接口 | 内容 |
|---|---|
| `GET /api/status` | 当前 profile、服务配置状态、存储状态及诊断摘要 |
| `GET /api/configuration` | 所有者专用：生效配置、私有目录、存储来源、变量名和密钥配置状态；此响应不属于可公开分享的诊断包 |
| `GET /api/diagnostics` | 数值快照：进程 CPU/RSS/运行时间、索引队列、设备报告的排队总量、存储统计、日志容量及丢弃/失败计数 |
| `GET /api/diagnostics/events?afterSeq=0&limit=200` | 从指定序号之后向前读取事件，单页最多 500 条 |
| `GET /api/diagnostics/logs?file=0` | 按当前文件索引或稳定 UUID 读取一个分段原文；索引与 UUID 来自诊断快照的 retention.files |
| `POST /api/diagnostics/cleanup-preview` | `{kind:"trace"|"all"}`；返回具体文件、大小和覆盖时间，不执行删除 |
| `POST /api/diagnostics/cleanup` | 提交完整预览；文件变化时返回 409，重新预览后再确认 |
| `GET /api/support-bundle` | 下载 `mote-support.json`：快照和最近最多 500 条事件 |

事件分页返回 `{items,nextSeq,oldestSeq}`。下一次请求使用 `nextSeq`；`afterSeq=0` 从最早保留的事件开始。若只想显示最近 200 条，先读取快照，再以 `max(0,lastSeq-200)` 为游标。若游标早于 `oldestSeq`，更早事件已超过保留范围；若换成另一资料库或日志已被清空，应重置游标。

支持包中的 `scope` 为 `central-safe-support`。它只包含固定事件和数值；即使开发环境开启详细 Agent trace，也会排除 trace 正文，不包含主 YAML、访问令牌、模型凭据、数据库、截图、问题、答案、笔记、Agent 工具参数或任意异常文本。旧日志被读取时也按同一字段白名单过滤。支持包用于排错，不能用于恢复资料库。

## 如何判断卡在哪个阶段

| 事件或类别 | 可得出的结论与下一步 |
|---|---|
| `request.completed` | 请求已结束；结合 `statusCode` 和 `durationMs`，不能仅凭事件名称判定成功 |
| `ingest.completed` | 入库已完成；`count=0` 表示本次重复事件被正常确认 |
| `queue.snapshot` | 客户端上报的排队量或中央待索引/失败数量；这是快照，不代表累计上传次数 |
| `index.completed` / `index.failed` | 一次后台索引的结果及耗时；失败记录等待显式重试 |
| `source.completed` / `source.failed` | 某个只读资料工具的结果数量和耗时；不包含检索词和原文 |
| `agent.completed` | Agent 已交付符合接口格式的回答；引用数和工具调用数可见，但这不证明内容语义正确 |
| `model_not_configured` | 未配置 Agent；检查本 profile 的模型、地址和凭据配置 |
| `agent_response` | 模型输出未通过回答/证据格式检查；保留请求编号后重试或检查模型能力与配置 |

回答校验错误现在附带固定 `reason`：`output_limit` 表示模型明确报告输出 token 耗尽；`invalid_json` / `invalid_shape` 表示结构不合法；`unretrieved_citation` / `truncated_citation` / `undeclared_citation` 分别表示未检索资料、缩写引用或引用列表不一致。事件与 HTTP 响应只保存这些枚举，不包含原始模型输出、推理或具体引用值。新失败记录同时保留允许的 diagnostic 字段，如上游 HTTP 状态、官方错误判别值、进程退出状态及执行阶段。普通日志与任务摘要不包含异常原文；底层没有提供原因时明确记为 unknown。历史事件缺失的细节无法还原。输出超限处理见[回答截断与输出预算](query-output-budget.md)。
| `embedding_http` / `embedding_invalid` / `embedding_transport` | 索引服务分别出现 HTTP、向量格式或连接问题；修复配置后使用索引重试入口 |
| `rate_limited` | 上游服务暂时限流；按重试时间等待。中央端不设置 HTTP 请求频控 |
| `storage_full` | 达到资料库存储上限；清理或调整容量后重试 |
| `conflict` / `deleted` | 资料版本或删除状态已变化；刷新资料，不能靠重放旧事件恢复已删除内容 |
| `timeout` | HTTP 504；明确达到 Agent 本地 deadline、SDK 请求超时，或操作取消；用请求编号定位最后成功的阶段 |
| `internal` | 未归入上述类别的失败；用请求编号定位最后成功的阶段 |

模型超时分为两层：模型的 `modelRequestTimeoutMs` 是单次 HTTP Provider 请求期限（5000–600000 毫秒），`agentTimeoutMs` 是实际获准执行的模型、工具与修正时间预算（5000–3600000 毫秒或 `null`），不含等待中央执行名额。可在“系统管理 → 模型”修改，或修改主 YAML 的 `models.deployment`（预设位于 `models.profiles[].settings`）；两者保存同一配置，新请求使用新值，在途请求保留旧快照。在节点设置或 `/api/status.agent.agentTimeoutMs` 核对生效值。所有协议的 Agent 预算均可为 `null`，新 HTTP 模型预设默认一小时且不改已有显式值。Codex Server 的单次模型请求不由 Mote 暴露；没有总期限时仍可能受到入口代理、工具或 Codex 自身限制。达到本机期限或 SDK 明确抛出请求超时类时，返回 `timeout`，不会再混入回答格式错误 `agent_response`。这个分类只证明发生了超时，不能单独确定原因是模型推理、网络还是工具等待。错误响应和诊断不引用模型、SDK stderr 或请求正文；清理失败也不会覆盖已确定的原始查询错误。

当设备显示离线时，先区分“最近一次客户端上报”与“中央已经保存的资料”。离线状态或旧的 `lastCaptureAt` 不能证明之后没有归档。客户端上报的队列量也可能过时。中央 `queue.index` 给出当前索引状态；`textReady` 表示文本原文已可检索，未配置 embedding 并不妨碍文本归档。

Cloudflare Tunnel 的 connector 连接状态与中央 API 健康状态分别检查：先通过本机 `status` 确认中央可用，再核对公网域名、Tunnel origin 与 connector。502、524、413 分别可能对应 origin 不可达、代理等待超时和入口上传限制。中央 UI 会显示 HTTP 状态与排查提示，不将代理返回的 HTML 作为应用内容。完整命令见 [Tunnel 排错](cloudflare-tunnel.md#排错与入口限制)。

启动与退出在终端中只输出固定 JSON 事件。`server.start_failed` 的 `data_directory_in_use` 表示另一个活跃节点持有资料库锁，`port_in_use` 表示监听端口冲突，`permission` 表示目录权限受限。`configuration` 类别会同时给出无效配置项的 `field`（例如 `diagnostics.debug`），不包含用户填写的值。通用 `startup` 类别需要检查所选主 YAML 和运行依赖；终端不会打印可能包含凭据或私人路径的底层异常。

## 验证范围

自动测试使用合成文本、合成凭据与本机 HTTP fixture，覆盖日志字段白名单、私密异常回显、认证导出、并发请求/工具桥关联、索引失败、安全分页、突发队列、轮转、重启恢复、写锁及关闭等待。测试不调用真实模型，也不采集个人截图。这里的诊断能力不提供模型答案准确率保证，真实语义评估仍需要对照原始证据。
