# 服务端配置参考

多用户生产路径已在 M04 拆分实例 YAML 与各账号的私人 YAML，真实 API、共享模型只读引用和凭据边界见 [M04 配置合同](design/multiuser-configuration.md)。下文的单所有者页面与各领域运行时说明仅适用于原有隔离算法 fixture；尚未完成的多用户能力继续拒绝，不能据此启用旧全局路由。M13 负责消费新合同的设置 renderer。

中央使用一份私有 `mote.yaml`。网页设置与手改文件更新同一来源，ConfigService 按领域校验、准备资源、原子保存并应用。选型与边界见 [统一配置 ADR](adr-unified-configuration.md)，任务快照和授权见 [配置归属](configuration-ownership.md)。

中央一级入口为今天、资料库、问一问、行动、连接。系统管理包含模型、费用、处理任务、存储和诊断；模型入口为 `#/system/models`，诊断为 `#/system/diagnostics`。已有设置页面仍提供草稿、保存与当前生效值。页面没有覆盖的配置可直接编辑文件。

## 文件启动和编辑

| 运行方式 | 配置来源 | 路径基准 |
| --- | --- | --- |
| CLI 命名环境 | `<home>/<profile>/mote.yaml` | YAML 所在目录 |
| 直接启动 | `MOTE_CONFIG_FILE` 指定的文件；未指定时为当前目录 `mote.yaml` | YAML 所在目录 |
| Docker CLI 部署 | 同一宿主 profile 目录挂载为 `/config`，中央读取 `/config/mote.yaml` | 按 YAML 中明确的容器路径 |

```sh
# 只展示操作方式；不要对正在运行的日常环境执行测试初始化或重启。
node scripts/mote.mjs init --profile dev
node scripts/mote.mjs config --profile dev
node scripts/mote.mjs start --profile dev
# 直接启动已准备的文件
MOTE_CONFIG_FILE=/absolute/private/mote.yaml npm start
```

CLI 默认选 `dev`，日常节点明确使用 `--profile prod`。环境隔离、安装、停止与部署命令见 [开发指南](development.md) 和 [部署指南](deployment.md)。`profile.json` 保存发行版本、容器镜像/卷与 Tunnel 生命周期选择，不提供运行时普通参数覆盖。

普通 `MOTE_*` 环境变量不再覆盖 YAML。仅 `MOTE_CONFIG_FILE` 选择文件，凭据可在指定敏感字段中写 `${NAME}` 引用，例如 `server.token: "${MOTE_TOKEN}"`；引用的环境变量缺失会报配置错误。普通字段不展开 shell、`~`、`$HOME` 或命令替换。不要通过 shell `source` 执行 YAML。新配置文件为 0600，父目录为 0700；私有配置副本也可能包含密钥。

最小配置可省略没有自定义值的领域：

```yaml
version: 1
revision: 0
server:
  profile: dev
  host: 127.0.0.1
  port: 47842
storage:
  dataDir: ./data
execution:
  interactiveConcurrency: 2
  agentConcurrency: 8
  llmConcurrency: 4
  memoryConcurrency: 3
perception:
  allowQueryImages: false
  allowExternalProcessing: false
```

只有旧 `MOTE_ENV_FILE` 而未提供明确新文件选择器的启动命令会被拒绝，避免误启动当前目录的另一环境；使用 `MOTE_CONFIG_FILE` 或 CLI 明确选定 YAML。

启动会验证配置；缺失、无效或不可读的文件导致启动失败。运行中无效文件保留最后有效值，并在已认证配置视图显示固定错误码，不回显私有输入。

手改文件时保留读取到的 `revision`，服务在接纳真正变更后递增它。网页命令同样携带读取到的全局 revision；陈旧草稿或并发文件编辑返回冲突，先刷新后重做修改。相同内容不增加 revision；网页自己的写入监听事件不再次保存。编辑器原子替换、短暂写入与对象键顺序变化均经稳定读取和真正 diff 处理。

配置视图区分 **已保存值**、**当前有效值** 和 **生效方式**。`applied` 表示领域已应用；`restart-required` 保留本次启动的有效值；`invalid` 表示候选应用失败。准备失败不替换当前配置；应用失败会回滚有效值，已保存候选保留为失败状态，便于修复。写入结果无法确认时报告 `config_commit_uncertain`，不要据此反复覆盖文件。

## 生效方式与领域

| YAML 领域 / 字段 | 当前行为 |
| --- | --- |
| `models.deployment`、`models.profiles`、`models.defaults`、`models.defaultModels` | 准备成功后新模型请求使用新快照；在途请求继续使用旧运行时 |
| `execution.*Concurrency` | 后续准入生效；降低名额不会终止正在运行的任务 |
| `diagnostics.enabled/debug/traceEnabled/level` | 立即调整同一个日志写入器 |
| `connectors.syncIntervalMs` | 立即调整同步调度；不会自行重新授权来源 |
| `processing.settings/policy` | 按现有服务、处理器、任务指纹与撤权语义应用；完成结果需显式重处理 |
| `perception` | 图片行为和权限运行时应用；concurrency 作用于后续准入；端点、处理器及选中方案由 `processing.policy` 投影 |
| `workflows` | 普通 DAG 各通道启用与并发；新名额作用于后续准入，停用阻止旧在途结果发布；任务与输入授权仍在领域数据库 |
| `actions.enabled/timeZone` | 运行时应用；审核设备授权仍由领域 API/数据库维护，不能由 YAML 授权 |
| `memory` | 新接纳窗口使用新调度与预算，在途窗口使用冻结设置；历史授权和不可变策略版本不改变 |
| `server`；`updates`；`media` | 需要重启；保存不会重启服务或部署媒体 Worker |
| `models.embedding/codex`；日志目录及轮转上限；连接器模块/OAuth/MCP 配置；插件模块列表 | 需要重启 |
| `storage.dataDir/dataKey` | 需要显式迁移；保存不移动数据库、原件或转换密文 |
| `storage.contentEncryptionEnabled` | 立即改变后续原件写入格式，已有文件保持原格式且可读取；批量解密仍需明确发起 |
| `storage` 的其余启动参数 | 本轮需要重启，包括容量、保留周期及导出预算 |
| 插件配置 | 注册 schema、敏感字段与 handler 后应用；模块安装、实例、启用及历史授权仍走原插件领域 |

不是所有字段都已支持热更新。当前监听地址、数据目录、embedding、Worker 进程、模块安装没有通用无中断重建机制。字段生效元数据来自领域注册，以已认证配置视图为准。需要重启时由用户选定的 CLI 或进程管理器执行停止、启动，再核对有效值；不要让多个管理器竞争。

## 常用参数

数值类型使用 YAML 数字，开关使用 `true` / `false`，列表使用数组，容量和时间单位由字段名与配置元数据标明。

| 字段 | 默认 / 范围 | 用途 |
| --- | --- | --- |
| `server.host/port` | `127.0.0.1` / `47832` | 监听；CLI dev/test 使用独立端口，远程长期部署通过 HTTPS 与强令牌 |
| `server.publicUrl/allowedOrigins` | 空 / 本机开发 origins | 公开基址声明与浏览器 CORS 白名单，不创建 DNS、TLS 或 Tunnel |
| `server.token` | 私有随机凭据 | 所有者令牌；敏感值不回显 |
| `storage.dataDir` | `./data` | SQLite 与原件根目录，相对 YAML 解析 |
| `storage.maxStorageBytes` | 10 GiB | 逻辑资料容量；满后拒绝新增摄取，不自动删旧资料 |
| `storage.maxExportBytes` | 64 MiB，最高 256 MiB | HTTP 归档预算；大库使用离线备份 |
| `storage.retentionDays` | 0，最高 36500 | 0 关闭按时间删除；正数按既有保留规则清理 |
| `storage.contentEncryptionEnabled/dataKey` | false / 空 | 原件内容加密与私有密钥；SQLite 原文不因该项加密 |
| `execution.interactiveConcurrency/agentConcurrency/llmConcurrency/memoryConcurrency` | 2 / 8 / 4 / 3 | 分离通道和处理池的执行名额 |
| `diagnostics.enabled/debug/traceEnabled/level` | true / false / false / info | 固定结构化诊断和显式详细 Agent trace；CLI dev 可设置 trace 为 true |
| `diagnostics.directory/maxBytes/maxFiles/maxEntries` | 数据目录 logs / DEV 100 MiB，其它 2 MiB / 3 / 2000 | 日志目录、文件轮转和内存保留上限 |
| `connectors.syncIntervalMs` | 900000，60000–86400000 | 自动拉取已授权来源的间隔 |
| `media.ocrEndpoint/asrEndpoint` | loopback 9010 `/ocr` / 9009 `/transcribe` | 受管理媒体服务；与已保存的自定义处理服务区分 |
| `media.modelDirectory/python/ocrPort/asrPort/workerToken` | 数据目录 media-models / python3 / 9010 / 9009 / 空 | 媒体目录、进程与私有 Worker 凭据；CLI 新环境配置 profile 独立资源 |

模型协议、推理参数、截止时间与高级对象见 [模型服务配置](model-providers.md)。字段采用原 ModelSettings 名称；API key、headers 和 extraBody 都按敏感数据保护。模型目录和“测试连接”只在用户明确请求时访问 Provider，连接测试可能产生费用。

文件策略使用 `processing.policy.services/profiles/rules`，结构与现有设置页面一致；受安装处理器支持的参数由插件注册信息校验。服务地址变化不能隐式继承旧密钥，页面要求重新填写、清除或按模型领域明确确认复用。图片页修改端点/方案与行为开关使用同一配置事务。

普通 DAG 通道参数属于 `workflows`；Action 开关和时区属于 `actions`，审核设备列表是业务授权而不是文件配置。授权变更仍走原领域 API，跨文件和数据库的部分失败会明确报告并要求刷新，文件热更不能授予设备新权限。

Memory 运行参数属于 `memory`，选中策略、不可变版本、来源授权、插件实例和任务回执属于领域数据库。它们不是 YAML 运行设置的覆盖层，不能通过文件热更新扩大历史任务权限。设备本地截图隐私和客户端存储不并入中央文件。

## 日志与调试

省略 `diagnostics.maxBytes` 使用 profile 默认值：`server.profile: dev` 为 104857600 字节（100 MiB），其它为 2097152 字节（2 MiB）。DEV 显式范围为 0.1–100 MiB，其它为 0.1–8 MiB；`maxFiles` 允许 1–10，`maxEntries` 允许 100–5000。所有显式数字均保持原值。已有 YAML DEV 可用 [默认容量命令](deployment.md#dev-log-retention) 删除容量覆盖，文件数和内存事件数保持原值，容量在下次正常重启后生效。

结构化日志与原生监督日志分别轮转，DEV 默认各最多 300 MiB、合计 600 MiB。UTC 日期或大小轮转会删除最旧文件，不保证固定保留小时数。Docker stdout 保持部署层自己的上限。开启详细 Agent trace 时可能包含 prompt、个人资料、模型输出和工具过程；支持包仍排除 trace 正文。

普通事件最多 20 KiB；详细 trace 单条最多 8 MiB，同时不超过日志文件容量。字符串、集合与深度边界保持既有规则，DEV 扩容后允许 2–8 MiB 的 trace。大日志启动、分页和安全范围导出按行遍历；安全导出先排除 trace 正文，原始文件下载仍可能返回整份 100 MiB 文件。完整诊断接口和限制见 [运行诊断](troubleshooting.md)。

## 存储、秘密与升级

| 内容 | 位置 / 边界 |
| --- | --- |
| SQLite、WAL、业务数据和任务 | `<storage.dataDir>/mote.sqlite` 与领域表 |
| 原件资产 | `<storage.dataDir>/files/objects/<sha256>/<part>.plain|.aes`，片大小遵循资产协议 |
| 模型、处理、运行设置与私有配置 | `mote.yaml`；不进入安全支持包或普通资料导出 |
| 有效摄取配置投影 | SQLite 派生键；启动和同步发布时从 YAML 重建，不作为读取来源 |
| 连接器账户、插件/来源实例、配对与撤销状态 | 各领域私有存储 |
| Tunnel token | profile 的私有 secrets 文件，仅交给 Tunnel 进程 |
| 客户端队列、设备隐私和草稿 | 各设备本地存储 |

CLI `config` 离线读取 YAML 并隐藏敏感字段，不执行请求或运行迁移。在线配置 API 只允许所有者，且包含私有路径；不要公开分享它作为安全诊断包。详细 Agent trace 可能含 prompt、个人内容、模型输出和工具过程；安全支持包仍排除这些正文，见 [运行诊断](troubleshooting.md)。

Docker 使用明确的 `/data`、`/data/logs`、`/models` 和 `/config` 路径及所选命名卷；宿主 profile 下的 `data/` 不能当作容器资料库。挂载配置的父目录使原子 rename 对中央可见。配置身份/权限与容器用户检查失败时停止，而不是放宽私有文件权限。

此次仅破坏旧内部配置格式，不改变业务数据库 epoch。`mote.env`、`model-settings.json`、`file-processing.json` 和旧 SQLite 运行配置键停止作为权威来源，旧文件/行不自动删除、转换或覆盖新 YAML。升级前保留私有配置与密钥备份，在离线环境明确准备 `mote.yaml`；CLI 遇到仅有旧 env 的 profile 提示手工转换。无需也不应因配置升级重置已有资料库。

实际数据目录或加密密钥迁移仍需停止、备份、按同一存储代际恢复和验收；只编辑 YAML 不迁移数据。SQLite 使用本地块存储，活动 WAL 不放 SMB/NFS。离线备份是否包含私有配置以相应备份契约为准，单独保护凭据副本。没有自动重启、生产迁移、部署或降级转换。
