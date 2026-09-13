# 中央节点诊断与排错

中央节点把请求、入库、索引、资料读取与 Agent 执行记录为固定结构的数值事件。控制台可读取诊断快照并下载支持包；无需部署额外的日志服务。

## 先取得请求编号

每个 HTTP 响应带有 `X-Request-Id`，由中央节点新生成，不采用客户端传入的值。失败响应同时提供：

```json
{"error":"agent_response","message":"模型未返回可验证的回答，请重试或检查模型配置。","requestId":"00000000-0000-4000-8000-000000000000"}
```

使用这个编号在诊断面板中查找同一次请求的事件。模型查询中的资料读取与 Agent 阶段共享请求编号；并发请求的编号相互独立。后台索引和定时洞察拥有独立的任务编号，不等同于之前某次上传的编号。

## 配置

将配置写入实际使用的中央节点环境文件，重启后生效。显式使用 `MOTE_ENV_FILE` 时只读取指定文件；不要把开发、验证和日常资料库放在同一个数据目录。环境和部署方式见 [deployment.md](deployment.md)。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `MOTE_DIAGNOSTICS_ENABLED` | `1` | `0` 时不读取、积累或写入诊断事件；即时数值状态仍可查看 |
| `MOTE_DEBUG` | `0` | `1` 时将非 silent 级别提升为 debug，额外记录阶段开始事件，便于发现尚未完成的阶段 |
| `MOTE_LOG_LEVEL` | `info` | `debug`、`info`、`warn`、`error`、`silent`；`silent` 优先于 debug 开关 |
| `MOTE_LOG_DIR` | 数据目录下的 `logs` | 每个节点使用独立目录；不会出现在支持包内 |
| `MOTE_LOG_MAX_MB` | `2` | 单个日志文件上限，允许 `0.1`–`8` MiB |
| `MOTE_LOG_MAX_FILES` | `3` | 保留文件数，允许 `1`–`10` |
| `MOTE_LOG_MAX_ENTRIES` | `2000` | 内存事件上限，允许 `100`–`5000` |

debug 开关只增加固定事件，不记录请求正文、模型输入输出、令牌、原图、来源文本、文件路径、设备名称或原始 URL/query。模型与 SDK 异常按类型或 HTTP 状态映射为固定类别；不会通过匹配异常正文的关键词推断原因，也不会返回异常原文或堆栈。

文件名为 `central.0.ndjson`、`central.1.ndjson` 等，`0` 是当前文件。默认日志内容的磁盘上限为 6 MiB，另有一个很小的进程锁文件。日志文件权限为 `600`，新建目录权限为 `700`。只有取得该日志目录写锁的节点才会读取和轮转它；第二个活跃写入者会报告写入失败，不会覆盖另一个节点的日志。崩溃留下的失效锁和未写完的尾行会在重启时处理。

内存写入队列最多保留 1024 条待写事件，另有最多 64 条正在写入；每条最多 2048 字节。突发流量或磁盘故障时允许丢弃诊断事件，`droppedEvents` 和 `writeFailures` 会增加，业务隐私检查与入库不因此被绕过。关闭服务会等待当前日志写入结束。禁用诊断不会主动删除已经存在的历史日志文件。

## 认证 API

以下接口都需要中央节点 Bearer 令牌，并返回 `Cache-Control: no-store`。不要把令牌写到 URL 参数中。

| 接口 | 内容 |
|---|---|
| `GET /api/status` | 当前 profile、服务配置状态、存储状态及诊断摘要 |
| `GET /api/configuration` | 所有者专用：生效配置、私有目录、存储来源、变量名和密钥配置状态；此响应不属于可公开分享的诊断包 |
| `GET /api/diagnostics` | 数值快照：进程 CPU/RSS/运行时间、索引队列、设备报告的排队总量、存储统计、日志容量及丢弃/失败计数 |
| `GET /api/diagnostics/events?afterSeq=0&limit=200` | 从指定序号之后向前读取事件，单页最多 500 条 |
| `GET /api/support-bundle` | 下载 `mote-support.json`：快照和最近最多 500 条事件 |

事件分页返回 `{items,nextSeq,oldestSeq}`。下一次请求使用 `nextSeq`；`afterSeq=0` 从最早保留的事件开始。若只想显示最近 200 条，先读取快照，再以 `max(0,lastSeq-200)` 为游标。若游标早于 `oldestSeq`，更早事件已超过保留范围；若换成另一资料库或日志已被清空，应重置游标。

支持包中的 `scope` 为 `central-safe-support`。它只包含固定事件和数值，不包含 `.env`、访问令牌、模型凭据、数据库、截图、问题、答案、笔记、Agent 工具参数或任意异常文本。旧日志被读取时也按同一字段白名单过滤。支持包用于排错，不能用于恢复资料库。

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
| `embedding_http` / `embedding_invalid` / `embedding_transport` | 索引服务分别出现 HTTP、向量格式或连接问题；修复配置后使用索引重试入口 |
| `rate_limited` | 请求太频繁或任务并发额度已占用；稍后重试 |
| `storage_full` | 达到资料库存储上限；清理或调整容量后重试 |
| `conflict` / `deleted` | 资料版本或删除状态已变化；刷新资料，不能靠重放旧事件恢复已删除内容 |
| `timeout` / `internal` | 操作中断或未归入上述类别的失败；用请求编号定位最后成功的阶段 |

当设备显示离线时，先区分“最近一次客户端上报”与“中央已经保存的资料”。离线状态或旧的 `lastCaptureAt` 不能证明之后没有归档。客户端上报的队列量也可能过时。中央 `queue.index` 给出当前索引状态；`textReady` 表示文本原文已可检索，未配置 embedding 并不妨碍文本归档。

Cloudflare Tunnel 的 connector 连接状态与中央 API 健康状态分别检查：先通过本机 `status` 确认中央可用，再核对公网域名、Tunnel origin 与 connector。502、524、413 分别可能对应 origin 不可达、代理等待超时和入口上传限制。中央 UI 会显示 HTTP 状态与排查提示，不将代理返回的 HTML 作为应用内容。完整命令见 [Tunnel 排错](cloudflare-tunnel.md#排错与入口限制)。

启动与退出在终端中只输出固定 JSON 事件。`server.start_failed` 的 `data_directory_in_use` 表示另一个活跃节点持有资料库锁，`port_in_use` 表示监听端口冲突，`permission` 表示目录权限受限。`configuration` 类别会同时给出无效配置项的 `field`（例如 `MOTE_DEBUG`），不包含用户填写的值。通用 `startup` 类别需要检查所选环境文件和运行依赖；终端不会打印可能包含凭据或私人路径的底层异常。

## 验证范围

自动测试使用合成文本、合成凭据与本机 HTTP fixture，覆盖日志字段白名单、私密异常回显、认证导出、并发请求/工具桥关联、索引失败、安全分页、突发队列、轮转、重启恢复、写锁及关闭等待。测试不调用真实模型，也不采集个人截图。这里的诊断能力不提供模型答案准确率保证，真实语义评估仍需要对照原始证据。
