# 诊断与排错

通过请求编号、当前任务和真实回执定位问题。普通诊断是固定事件与数值，详细Agent trace是单独启用的私有记录；支持包不包含trace正文。

## 请求与处理状态

HTTP响应的`X-Request-Id`由Central生成，错误JSON同时提供`requestId`。一次查询的读取与Agent阶段共享编号；后台索引或定时工作有自己的任务编号。

| 信号 | 含义 |
| --- | --- |
| `request.completed` | 请求已结束，结合HTTP状态判断成功 |
| `ingest.completed` | 原件接收完成；count为0可表示重复确认，不表示后续解析或Memory完成 |
| `queue.snapshot` | 当前上报快照，不是累计上传次数 |
| `index.completed/failed` | 索引结果；文本就绪不依赖embedding已配置 |
| `source.completed/failed` | 读取工具的数量与耗时，不包含检索词和原文 |
| `agent.completed` | 满足接口格式，不单独证明语义质量 |

模型未配置、连接失败与回答格式错误分别处理。`agent_response`的reason可为`output_limit`、`invalid_json`、`invalid_shape`、`unretrieved_citation`、`truncated_citation`或`undeclared_citation`；普通错误不回显原始模型输出。新的失败记录保留允许的上游状态、官方判别值、进程退出和阶段信息，未知不补造。

HTTP Provider单次期限是`modelRequestTimeoutMs`，Agent实际执行预算是`agentTimeoutMs`，不计名额等待；Codex单次请求期限不由Mote控制。模型设置见[模型服务](model-providers.md)。`timeout`表明明确超时，不能仅据此定位网络、推理或工具。`rate_limited`来自上游；`storage_full`是当前容量边界；版本冲突或删除应刷新实际对象状态。

设备离线或旧的客户端上报不能证明Central没有新归档。Tunnel连接与Central健康分开检查：502、524、413可分别来自origin、代理等待或入口大小限制，见[Tunnel排错](cloudflare-tunnel.md#排错与入口限制)。

启动固定事件中的`data_directory_in_use`、`port_in_use`、`permission`分别指目录锁、端口和权限；配置错误提供字段名，不提供私有值。升级后旧网页无法加载延迟模块时刷新页面，并核对完整Web构建、代理缓存与运行目录。缺失的模块资产应返回 404，入口 HTML 只用于加载应用页面。

## 日志与调试

新profile的Central诊断默认开启，debug和trace默认关闭，显式保存的值保持有效。日志级别和trace分别控制。设置页与文件共用[配置](server-configuration.md)；enabled、debug、trace、level可立即应用，目录和容量需要重启。

| 配置 | 当前默认 |
| --- | --- |
| `diagnostics.level` | info；silent优先于debug开关 |
| `directory/maxBytes/maxTotalBytes/maxEntries` | 数据目录logs／16 MiB分段／2 GiB总量／2000内存条目 |
| `retention.error/warn/info/debug/trace` | 30天128 MiB／14天64 MiB／7天256 MiB／2天128 MiB／1天1 GiB |
| `traceExpiresAt` | 0；通过偏好开启时设置最多24小时的期限，重启不延长 |

Central文件名为`central.<level>.<firstMillis>.<lastMillis>.<id>.ndjson`，监督进程用supervisor前缀。跨UTC日期或写满只分段；过期与预算清理删除整段。总预算含监督日志，低级别新事件不挤掉高级别已有记录，实际覆盖时间可能缩短。调小配置不截断旧文件；未知历史格式不自动读删。

普通事件最多20 KiB，详细trace单条最多8 MiB且受分段预算约束。待写队列1024条，另有最多64条在写；磁盘故障或突发丢弃通过`droppedEvents/writeFailures`报告，不绕过业务校验。关闭记录不删除历史；删除/到期会清理对应缓存。

| 端 | 本机查看入口与存储 |
| --- | --- |
| Web | 运行与诊断；本站点IndexedDB，最多2000条，浏览器清理会丢失 |
| Central | 日志中心；按实际生效目录和retention.files读取分段 |
| Mac | 帮助与诊断；profile的diagnostics目录，events轮转文件 |
| Android | 诊断与支持；私有no_backup目录的mote.log及支持事件 |
| iOS实验端 | 诊断与支持；私有Diagnostics目录，不属于内容备份 |

设备日志和级别由各设备维护，不互相修改。普通日志不记录私人正文、凭据或任意异常文本；显式trace可能包含prompt、模型输出和工具内容，仅在私有环境查看。

排查 Ask 时，用日志里的 `operationId` 找到同一次问答，并用 `taskKey` 和 `attempt` 定位执行步骤及尝试。检索分支的 `agent.research_failed` 记录失败阶段。模型诊断在取得相应信息时记录 SDK 结束类型、错误码、上游 HTTP 状态及请求 ID。详细过程里的 `step` 表示同一 Agent 运行中的模型和输出校验轮次。

## 管理接口与支持包

使用管理身份访问诊断与配置，响应禁止缓存；令牌不放URL。

| 接口 | 用途 |
| --- | --- |
| `GET /api/status`、`GET /api/diagnostics` | profile、配置状态、数值快照、容量与丢弃计数 |
| `GET /api/configuration` | 私有配置视图，含路径与凭据状态，不是可分享诊断包 |
| `GET /api/diagnostics/events?afterSeq=0&limit=200` | 最多500条，返回items、nextSeq、oldestSeq；按nextSeq继续，过期游标需重置 |
| `GET /api/diagnostics/logs?file=0` | 用快照中的索引或UUID读取分段原文；原始下载最多100 MiB |
| `GET /api/diagnostics/log-pages` | file、page、pageSize及stage分页筛选；pageSize最多500 |
| `POST /api/diagnostics/cleanup-preview` | kind为trace或all，返回具体文件与覆盖时间 |
| `POST /api/diagnostics/cleanup` | 提交完整预览；文件改变返回409，核对新范围处理 |
| `GET /api/support-bundle` | central-safe-support快照与最近最多500条安全事件 |

支持包经过字段白名单过滤，不含YAML、数据库、token、模型凭据、截图、问题答案、笔记、trace正文或任意异常文本，不能用于恢复资料库。原始日志查看与安全支持包分开；分享前核对所选导出入口。验证入口见[操作手册](testing-runbook.md#diagnostic-retention)。
