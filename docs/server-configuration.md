# 服务端配置参考

中央界面的日常入口是总览、时间线、随手记、问一问与资料库；设备和来源单独管理。底部 **设置** 按「问答与回顾」「保留与容量」「检索索引」「来源与外部应用」分组，数据导入导出放在「数据与备份」，邀请和 Chatbot 凭据在「连接授权」，软件更新在「关于 Mote」。运行诊断和部署详情收在 **设置 → 开发者选项**。

每类设置将 **配置草稿** 与 **当前生效值** 分开显示。模型地址可以选 DeepSeek 或本机 Ollama 预设，也可填写自定义兼容服务地址和模型名称；预设不会发送测试请求。保留周期、容量、推理强度、同步间隔提供常用选项，保留已有自定义值。外部应用的可写来源可从已注册来源中勾选，高级选项仍可编辑来源 ID。

选择「检查配置草稿」后，可以下载 `mote-config-changes.env`。文件仅包含本次修改的非敏感环境变量，不包含已配置的令牌或密钥，也不会直接写入节点或热更新。将这些变量合并到原部署配置，保留令牌、密钥与目录等其余设置，再重启节点并刷新生效配置。**不要用变更片段覆盖整个配置文件，也不要用 shell 的 `source` 执行它。** 草稿仅在当前页面内存保留，刷新页面或断开连接后会丢弃。

「当前生效值」通过认证 API 读取正在运行的进程配置，显示配置来源。文件修改但服务尚未重启时，页面仍显示旧值。完整数据库与图片目录、日志目录、Docker 卷来源及环境变量名可在「开发者选项 → 部署与全部生效配置」展开查看。API 密钥只显示配置状态，设置新密钥仍需在部署机器操作。

在部署机器上运行 `node scripts/mote.mjs config --profile prod --home /srv/mote/profiles`，可以离线查看所选环境的配置文件与存储映射。CLI 读取磁盘上的配置，与正在运行的服务可能暂时不同。访问令牌、图片加密密钥和模型 API key 只显示配置状态，获取节点访问令牌使用单独的 `token` 命令。

## 配置在哪里、如何生效

| 运行方式 | 配置来源 | 相对路径基准 |
|---|---|---|
| CLI 命名环境 | `<home>/<profile>/mote.env`；部署元数据在同目录 `profile.json` | `mote.env` 所在目录 |
| 直接启动并指定 `MOTE_ENV_FILE` | 仅指定的文件；不存在会启动失败 | 指定文件所在目录 |
| 旧版 `npm start` | 仓库根目录 `.env` | 仓库根目录 |
| Docker CLI 部署 | 宿主机环境文件生成私有 `generated/docker.env`，注入容器 | 容器数据固定 `/data`，日志 `/data/logs` |

直接启动时，进程环境变量覆盖文件值。CLI 会清除继承的 `MOTE_*`、`COMPOSE_*`，只装入显式选定的环境；Docker 另强制使用容器监听与挂载路径。容器内 `/app/deploy/empty.env` 是启动占位文件，实际应编辑页面显示的宿主机 profile 配置文件。

编辑后按顺序执行 `stop`、`start`，然后在设置中刷新生效配置。使用 launchd 等进程管理器时，由该管理器执行停止和重启，避免两个管理器竞争。CLI 默认 `dev`；日常节点必须明确 `--profile prod`。完整操作见 [部署指南](deployment.md)。

配置文件不展开 shell 表达式：用绝对路径或相对路径，不要写 `~`、`$HOME` 或 `$(...)`。含空格或 `#` 的值用单引号或双引号包裹；不要通过 `source mote.env` 加载配置。新环境文件权限为 0600、目录为 0700。

## 数据实际存在哪里

| 内容 | 原生进程 | Docker |
|---|---|---|
| 日记、OCR、时间线、设备信息、索引、已保存的洞察 | `<MOTE_DATA_DIR>/mote.sqlite`，运行时有 WAL 辅助文件 | `/data/mote.sqlite`，持久化到所选命名卷 |
| 去重后的图片 | `<MOTE_DATA_DIR>/blobs/<hash>` | `/data/blobs/<hash>`，同一卷 |
| 结构化运行日志 | `MOTE_LOG_DIR`；为空时为数据目录下 `logs/` | `/data/logs`，同一卷 |
| 原生进程监督日志 | profile 的 `logs/central.log` 及轮转文件 | Docker logging driver，独立于 `/data/logs` |
| CLI 离线备份 | 默认 `<profile>/backups/`；`backup --out` 可指定其它目录 | 备份仍写入宿主机选定位置，不在数据卷内 |
| Mote 访问令牌、模型凭据、图片加密 key | 私有 `mote.env`；未设访问令牌的直接启动使用数据目录 `access-token` | 宿主机私有配置注入；备份不会复制凭据 |
| Tunnel 凭据 | profile 的 `secrets/cloudflared-token` | 只挂载给 cloudflared，中央容器不读取此文件 |
| 客户端截图队列、草稿、Qwen 权重 | 分别在 Mac / Android App 本地目录 | 不属于中央节点配置或中央备份 |

普通问答结果即时返回给客户端，不自动保存到 SQLite；主动生成或定时生成的个人回顾保存为洞察。

**Docker 的宿主机 profile 下 `data/` 不是容器资料库。** 数据保存在界面或 `config` 输出标出的命名卷里。Linux Docker Engine 可用 `docker volume inspect <卷名> --format '{{.Mountpoint}}'` 查询 Docker 管理的位置；Docker Desktop 的卷位于其 Linux 虚拟机，不能把虚拟机里的路径当作 macOS Finder 目录。修改 Docker profile 的 `MOTE_DATA_DIR` 不会改变 `/data` 的挂载。

原生节点可在新建时用 `init --profile prod --data-dir /Volumes/ContextData/mote` 选择另一块本地磁盘。Docker 可用 `init --runtime docker --profile prod --volume mote-personal-data` 为新环境选择命名卷。不要让两个节点共用一个资料库；dev/test 必须使用各自环境范围内的目录和卷。当前 CLI 不提供自定义 Docker bind mount，避免把宿主机目录配置误当成已生效挂载。

迁移数据时先停止并备份，在新机器或新环境初始化空目录/卷，设置原图片加密 key，再 `restore`，最后验收并更新客户端地址。只编辑目录、卷名或图片加密 key 不会自动迁移数据。SQLite 应使用本地块存储；NAS 可运行服务，但不要把活动 WAL 数据库放到 SMB/NFS 共享上。

## 网络与访问

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MOTE_ENV_FILE` | 根目录 `.env`（直接启动） | 启动时选择配置文件；CLI 自动提供，不在文件内切换其它文件 |
| `MOTE_PROFILE` | `legacy`（直接启动） | CLI 支持 `dev` / `test` / `prod` 与显式命名隔离环境；legacy 不受更新命令管理 |
| `MOTE_HOST` | `127.0.0.1` | 监听地址；Docker 强制 `0.0.0.0`，宿主机端口仍仅发布 loopback |
| `MOTE_PORT` | `47832` | 1–65535 整数；CLI dev/test 分别 47842/47852，Docker 容器内部始终 47832 |
| `MOTE_PUBLIC_URL` | 空 | 客户端使用的公开 HTTPS 基址，例如 `https://mote.example.com`；不创建 DNS、Tunnel 路由或证书 |
| `MOTE_TOKEN` | 自动生成 | 中央所有者 Bearer 令牌；命名环境生成 32 字节随机值。连接授权页可另外发放受限的独立采集／MCP 凭据 |
| `MOTE_ALLOWED_ORIGINS` | 本机 5173 开发前端两个 origin | 逗号分隔的浏览器跨域来源；CLI test 使用 5174。完整 origin，包括协议和端口，不是 API 路径 |

同域中央网页无需额外配置跨域来源。不同域的浏览器前端才需要将其 origin 加入白名单。公开 URL 与节点 Bearer 令牌分别填入客户端，令牌不放 URL。Cloudflare Tunnel 与 Caddy 是两种可选入口；详见 [Tunnel 部署](cloudflare-tunnel.md)。

## 存储与保留

| 变量 | 默认值 | 范围及行为 |
|---|---|---|
| `MOTE_DATA_DIR` | `./data` | SQLite 与图片根目录；原生相对配置文件解析；Docker 强制 `/data` |
| `MOTE_DATA_KEY` | 空 | 可选 64 位十六进制 AES-256-GCM 图片密钥；只加密图片，SQLite 原文需主机磁盘加密保护 |
| `MOTE_MAX_STORAGE_MB` | `10240` | 1–1000000 MiB；图片及记录的逻辑容量上限，达到后拒绝新增摄取（507），不会自动删除旧资料腾空间 |
| `MOTE_MAX_EXPORT_MB` | `64` | 1–256 MiB；HTTP 归档导入/导出预算，大资料库使用离线备份 |
| `MOTE_RETENTION_DAYS` | `0` | 0–36500 天；0 关闭按时间清理，非零会周期性删除超期记录及不再引用的图片 |

容量预算不是文件系统配额。SQLite 索引、WAL、日志、备份、容器镜像与客户端队列会额外占用磁盘。设置中的数据与备份页显示实际归档文件占用及逻辑预算，但不能代替宿主机剩余空间监测。备份应放到另一位置并保留足够临时空间；Docker 离线备份阶段约需两份归档空间。

## Agent 与索引模型

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MOTE_MODEL` | 空 | 支持工具调用的模型 ID；未设时归档可用、AI 功能显示未配置 |
| `MOTE_MODEL_BASE_URL` | `https://api.deepseek.com` | Chat Completions 兼容服务基址；不要携带账号密码、令牌 query 或 fragment |
| `MOTE_MODEL_API_KEY` | 空 | 中央 Agent 的模型凭据；不下发到采集客户端 |
| `MOTE_MODEL_ALLOW_UNAUTHENTICATED_LOCAL` | `0` | 显式允许无密钥的本地模型服务，正常远程服务保持 0 |
| `MOTE_MODEL_REASONING_EFFORT` | `high` | `off` / `low` / `high` / `max`；需模型提供方支持 |
| `MOTE_MODEL_MAX_TOKENS` | `8192` | 256–32768 整数；单次模型输出预算，非总请求/账户预算 |
| `MOTE_MODEL_TIMEOUT_MS` | `120000` | 5000–600000 毫秒整数；查询、洞察和记忆提取的 Agent 期限。Web 对这些操作额外等待 60000ms；普通上传和其他请求的期限不变，入口代理可能更早超时 |
| `MOTE_INSIGHT_INTERVAL_HOURS` | `0` | 0–168 小时；0 关闭定时回顾，非零会调用已配置 Agent 并产生模型用量 |
| `MOTE_EMBEDDING_MODEL` | 空 | 可选 embedding 模型；未配置时使用本地文本索引 |
| `MOTE_EMBEDDING_BASE_URL` | 空 | 启用 embedding 必填，模型请求可达的服务基址 |
| `MOTE_EMBEDDING_API_KEY` | 空 | embedding 服务凭据，独立于 Agent key |

中央模型接收查询与检索到的文本证据；启用 embedding 还会发送待索引的原文。端上 Qwen 的下载源、线程、图片预处理和 NSFW 审查策略由各客户端管理，见 [端上推理配置](local-inference.md)。这两套模型设置不混用。

## 日志与调试

| 变量 | 默认值 | 范围及说明 |
|---|---|---|
| `MOTE_DIAGNOSTICS_ENABLED` | `1` | 0/1；关闭后不积累或持久化结构化诊断事件，即时状态仍可看 |
| `MOTE_DEBUG` | `0` | 0/1；增加固定阶段事件，将非 silent 的日志级别提升为 debug；不记录原文或模型提示词 |
| `MOTE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `MOTE_LOG_DIR` | 空 | 为空使用数据目录下 `logs/`；CLI 原生新环境为 `./logs`；Docker 强制 `/data/logs` |
| `MOTE_LOG_MAX_MB` | `2` | 0.1–8 MiB，每个结构化日志文件上限 |
| `MOTE_LOG_MAX_FILES` | `3` | 1–10 整数，轮转文件总数 |
| `MOTE_LOG_MAX_ENTRIES` | `2000` | 100–5000 整数，内存最近事件上限 |

配置页面包含私有路径，不能当作安全支持包公开分享；`GET /api/configuration` 同样要求节点所有者令牌。安全诊断包仍只含固定事件、计数和耗时。Cloudflare connector 使用独立日志级别，不继承 `MOTE_DEBUG`；不要自行开启会记录 Authorization headers 的 cloudflared debug。排错流程见 [运行诊断](troubleshooting.md)。

## 部署层配置

Caddy 使用 profile 文件中的 `MOTE_TLS_DOMAIN`、`MOTE_TLS_HTTP_PORT`（80）、`MOTE_TLS_HTTPS_PORT`（443），由 `tls --enable/--disable` 管理入口。Cloudflare 使用 `tunnel` 命令维护 profile 元数据与私有 token 文件；公开 URL、协议和 origin 的对应关系见 [Tunnel 指南](cloudflare-tunnel.md)。

`MOTE_CONFIG_FILE` 由 CLI 注入，标记宿主机可编辑的环境文件；`MOTE_ENV_FILE` 是进程实际加载的文件，两者在 Docker 内可能不同。`MOTE_RUNTIME`、`MOTE_STORAGE_KIND`、`MOTE_STORAGE_SOURCE`、`MOTE_STORAGE_MOUNT` 等由 CLI 注入的字段用于说明部署映射；修改这些说明字段不会挂载磁盘。实际目录/卷必须通过部署配置设置。容器映射、备份目录和客户端本地目录不是通过网页远程修改的选项。

## 发行版本与更新

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MOTE_UPDATE_REPOSITORY` | `utopiafar/mote` | GitHub `owner/repository`；只改变发现位置，不能替换程序内置发行公钥 |
| `MOTE_UPDATE_CHANNEL` | `stable` | `stable` 正式版或 `preview` 预发行版；中央重启后生效，CLI 每次读取所选 profile |

中央不会因启动、打开配置页或发现新版本而自动安装。认证的 `GET /api/software-update` 读取最近状态；`POST /api/software-update/check` 仅允许空请求体，手动检查固定配置的 GitHub Release。同一分钟内合并检查，失败只返回固定错误代码。`release_not_found` 表示尚无所选渠道的可信发行资产，不能据此绕过签名校验。

页面为独立命名的原生/Docker 环境给出检查、更新与回退命令；`legacy` / 未知运行方式不生成可执行安装命令。HTTP 不接受任意仓库 URL、目标路径、签名密钥或 shell，不停止中央或更改资料库。已有 `/api/updates` 仍是归档条目的增量同步接口，与软件发行检查无关。

安装使用 `node scripts/mote.mjs update --profile 名称 --home /绝对路径`，原生准备独立源码目录，Docker 使用 manifest 中的固定镜像 digest；两者均先验证签名，复用备份、健康检查和显式回退。详细的凭据、连接器游标、磁盘空间及 launchd 停机操作见 [部署与更新](deployment.md#升级与回退)。

## 来源、Google Calendar 与 MCP

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MOTE_MCP_ENABLED` | `0` | 开启 `/mcp`；通过 Cloudflare Tunnel 时沿用节点 HTTPS 地址 |
| `MOTE_MCP_READ_TOKEN` | 空 | 独立随机读令牌，启用时至少 32 字符；不要复用所有者令牌 |
| `MOTE_MCP_WRITE_ENABLED` | `0` | 开放指定来源的归档写回，与内部只读查询 Agent 分离 |
| `MOTE_MCP_WRITE_TOKEN` | 空 | 独立写令牌，至少 32 字符，与读令牌及所有者令牌不同 |
| `MOTE_MCP_WRITE_SOURCE_IDS` | 空 | 允许写入的已注册来源 ID，逗号分隔；开启写入时必须指定 |
| `MOTE_MCP_ALLOW_LOCAL` | `0` | 仅开发测试时允许回环 MCP；不会开放内网任意地址 |
| `MOTE_GOOGLE_CLIENT_ID` | 空 | Google Cloud Web OAuth 客户端 ID |
| `MOTE_GOOGLE_CLIENT_SECRET` | 空 | OAuth 客户端密钥；仅保存于私有配置 |
| `MOTE_GOOGLE_REDIRECT_URI` | 空 | 完整 `/oauth/google/callback` 地址，必须与 Google 登记一致；非回环地址要求 HTTPS |
| `MOTE_CONNECTOR_SYNC_INTERVAL_SECONDS` | `900` | 已授权来源自动同步间隔，范围 60–86400 秒 |

Google 三项配置需要一起填写，然后在“来源”页完成账户授权并选择日历。令牌保存在 `MOTE_DATA_DIR/connectors/` 的私有文件中，不进入 HTTP 资料导出或诊断包；迁移外部授权时请按[连接器说明](connectors.md)操作。修改环境文件后重启中央节点。

原始资料、Shadow、快照、索引与 Memory 的保存和失效策略见[资料分层](context-layers.md)。
