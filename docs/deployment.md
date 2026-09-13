# 独立中央节点部署、备份与迁移

中央节点包含 API、SQLite 归档与索引、Agent 运行时和 Web 界面。采集 App 通过节点 URL 与令牌连接；中央可以独立部署在 Mac mini、Linux 服务器或 NAS。只部署中央不需要屏幕权限、端上 Qwen 权重、CMake 或 Android SDK。

配置字段、默认值、数据的真实存放位置见 [服务端配置参考](server-configuration.md)。家中 Mac mini 或服务器没有公网入站端口时，可用 [Cloudflare Tunnel](cloudflare-tunnel.md) 提供 HTTPS 入口；已有公网服务器也可使用下文 Caddy。

## 环境与私有目录

需要 Node.js 24。以下命令从仓库根目录执行。统一入口是 `node scripts/mote.mjs`，也可用 `npm run mote --`。默认选择 **dev**，即使 shell 继承了 `MOTE_PROFILE=prod` 也不会改变目标；正式节点必须显式传 `--profile prod`。

| 环境 | 默认 API 端口 | 默认配置 | 数据与日志 |
|---|---:|---|---|
| dev | 47842 | `.mote/profiles/dev/mote.env` | 同目录 `data/`、`logs/` |
| test | 47852 | `.mote/profiles/test/mote.env` | 同目录 `data/`、`logs/` |
| prod | 47832 | `.mote/profiles/prod/mote.env` | 同目录 `data/`、`logs/` |

`--home /absolute/profiles` 将整个环境目录放到仓库外。例如 `--home /srv/mote/profiles --profile prod` 使用 `/srv/mote/profiles/prod/`。后续命令必须使用同一个 `--home`。目录包含 `mote.env`、`profile.json`、`data/`、`logs/`、`backups/` 和 `generated/`。环境名和目录共同生成 Docker project/volume 名称，两个不同的 `--home` 也不会共享默认卷。

初始化为每个环境生成独立的 256 bit 随机令牌，私有目录权限 0700、配置权限 0600；已存在的环境会拒绝覆盖。只有 `token` 命令主动显示令牌。`profile.json` 记录运行方式、代码版本路径或镜像、卷名与升级快照，不含令牌。

CLI 清除继承的 `MOTE_*`、`COMPOSE_*` 后注入所选环境。`MOTE_ENV_FILE` 显式指定配置文件时，中央与导入脚本只读该文件；路径不存在会报错。相对 `MOTE_DATA_DIR`、`MOTE_LOG_DIR` 基于该配置文件所在目录。dev/test 拒绝 47832，并要求数据和日志路径留在各自目录内。旧安装直接运行 `npm start` 时仍沿用根目录 `.env` 与 `data/`，不会被迁移或停止。

`node scripts/mote.mjs config --profile prod --home /srv/mote/profiles` 可在启动前查看配置。运行后，中央「服务端配置」页面显示进程实际使用的值。原生新环境可用 `init --profile prod --data-dir /absolute/local-disk/mote` 选择资料目录；Docker 新环境用 `init --profile prod --runtime docker --volume mote-personal-data` 选择卷名，不能靠 `MOTE_DATA_DIR` 改变 Docker 挂载。

## Mac mini / 原生 Node.js

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
node scripts/mote.mjs init --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

编辑该环境的 `mote.env`，设置模型服务等配置，然后启动：

```sh
node scripts/mote.mjs start --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs status --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs token --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs stop --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

`start` 启动独立后台进程，并等待经过认证的健康检查；`run` 在前台等待，适合进程管理器。`stop` 只向带有本次唯一进程标记的托管进程发送 SIGTERM，拒绝误杀复用 PID 的其它进程。端口占用会报错，不会停止占用者。普通 `start` 不提供系统级崩溃重启；长期部署使用下面的 launchd 或 Docker。

原生 stdout/stderr 先经监督进程白名单化：保留固定启动/停止事件，未知 SDK 输出只记流类型与字节数，再写入有上限的 `logs/central.log`，默认每份 2 MiB、总共 3 份；包括单次大输出与反复重启。中央结构化诊断独立写入 `MOTE_LOG_DIR`，使用同样的容量配置，并限制 2000 条记录。`MOTE_DEBUG=0` 默认关闭调试级别。修改参数后重启该环境。

### 生成与安装 launchd 配置

```sh
node scripts/mote.mjs launchd --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

命令只生成 plist，返回 `generated` 路径和 `label`，不会安装、加载、停止任何系统服务。检查内容中的 Node 路径、仓库路径与环境路径。Node 必须是稳定的 Node 24 可执行文件；必要时加 `--node /absolute/path/to/node`，不要依赖交互 shell 的版本切换。保留该仓库路径作为控制入口，升级使用独立 release 目录。

下面是管理员确认 plist 后自行执行的用户级 LaunchAgent 命令。将 `PLIST` 与 `LABEL` 设置为生成结果：

```sh
PLIST='/absolute/generated/dev.mote.central.prod.HASH.plist'
LABEL='dev.mote.central.prod.HASH'
plutil -lint "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/$LABEL"
# 停止并卸载该 job；不是删除配置或数据
launchctl bootout "gui/$(id -u)/$LABEL"
```

这是登录用户的 LaunchAgent，需要该用户登录；不是无人登录也运行的系统 LaunchDaemon。启用 FileVault 后的重启解锁也需要现场处理。plist 没有凭据，中央读取所选私有环境。launchd 自身 stdout/stderr 指向 `/dev/null`，中央输出保留在上述有上限日志；启动失败可用 `run` 和 `status` 检查。不要同时用 launchd 和手工 `start` 管理一个环境。

## Linux / NAS Docker

需要 Docker Engine、**Docker Compose 2.30.0 或更新版本**与 Node 24（运行部署 CLI 和离线备份）。Compose 使用 `env_file.format: raw`，避免密钥中的 `$` 或引号被再次解释；此格式的版本要求见 [Docker 官方文档](https://docs.docker.com/reference/compose-file/services/#env_file)。镜像构建会自行安装 npm 依赖。

```sh
node scripts/mote.mjs init --profile prod --home /srv/mote/profiles --runtime docker
# 编辑 /srv/mote/profiles/prod/mote.env
node scripts/mote.mjs compose --profile prod --home /srv/mote/profiles -- build
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
node scripts/mote.mjs status --profile prod --home /srv/mote/profiles
node scripts/mote.mjs token --profile prod --home /srv/mote/profiles
node scripts/mote.mjs stop --profile prod --home /srv/mote/profiles
```

如果系统用户不能写 `/srv/mote`，先由管理员创建并交给部署用户，不要用宽泛的全盘权限修改。容器内服务以 `node` 非 root 用户运行，数据与结构化日志分别在 `/data`、`/data/logs`，来自该环境独立命名卷。服务端口只发布到宿主机 loopback。`start` 使用现成镜像；升级前必须显式构建或拉取指定镜像。

CLI 每次生成私有 `generated/docker.env`，仅将所选环境传给容器；根目录 `.env` 不参与 Compose 插值。不要把 `compose config`、`docker inspect` 的完整输出作为公开诊断，它们可以显示容器环境中的凭据。Docker stdout 日志另设每份 10 MiB、最多 3 份。

SQLite 和 blob 应使用 NAS/服务器的本地块存储或本地 Docker 卷，避免多实例共享网络文件系统上的 WAL 数据库。当前是单实例、单 owner 节点。容器中的 loopback 指容器本身；外部模型服务应使用容器可达的 HTTPS 地址。

### 可选 Caddy HTTPS

在该环境 `mote.env` 设置 `MOTE_TLS_DOMAIN=mote.example.com`，换成自己的域名。DNS 指向服务器，服务器允许公网 80/443 到达，之后执行：

```sh
node scripts/mote.mjs tls --enable --profile prod --home /srv/mote/profiles
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
```

TLS overlay 使用固定 Caddy 2.11.4 Alpine 镜像；与中央在独立 Compose 网络中通信，证书保存在该 project 的 Caddy 卷中。Caddy 根据域名配置自动 HTTPS，见 [官方文档](https://caddyserver.com/docs/automatic-https)。该节点地址填为 `https://mote.example.com`，令牌单独填写。

已有反向代理可以保持 TLS overlay 关闭，将请求代理到 `127.0.0.1:47832`。`tls --disable` 只调整配置；已有 Caddy 容器需用该 profile 的 `compose -- down --remove-orphans` 后再 `start`，保留卷即可。自定义宿主端口可设置 `MOTE_TLS_HTTP_PORT`、`MOTE_TLS_HTTPS_PORT`，但公共 ACME 验证仍需正确转发到标准 80/443。项目不会修改 DNS、防火墙或购买域名。

## 升级与回退

升级和回退会短暂停机，采集端保留未确认的本地队列。先确认新的 release 已构建或镜像已拉取，使用版本目录/不可变镜像，不要在旧 release 中直接覆盖代码。

原生示例：

```sh
# 在另一个检出目录完成 npm ci 和中央/Web 构建
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --release /srv/mote/releases/0.3.1
```

Docker 示例：

```sh
# 先 docker pull 已发布镜像，或在新代码目录构建带新 tag 的镜像
docker build --tag mote-central:0.3.1 .
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --image mote-central:0.3.1
```

升级先停止该环境、生成 `backups/pre-upgrade-*` 一致快照，再切换代码路径或本地镜像 ID，等待健康检查。失败会保留快照与选择记录，不会自动让旧代码打开可能已迁移的数据库。`profile.json` 的 `previous` 记录回退目标，镜像保存实际 image ID，避免旧 tag 被覆盖后指向新代码。

```sh
node scripts/mote.mjs rollback --profile prod --home /srv/mote/profiles --restore-data
```

回退先验证旧快照，另存当前仓库的 `pre-rollback-*` 备份，恢复升级前的数据和版本。**升级后新增资料不会出现在回退后的活动仓库中**，但会保存在额外快照，以及原生的 `data.before-rollback-*` 目录或 Docker 原来的命名卷中。CLI 不删除这些保留副本，可验收后导出需要的数据再迁入。只保留一级直接回退元数据；备份目录中更早的快照仍在。

使用 launchd 的环境：先 `launchctl bootout` 停止自动管理，再执行升级或回退；验收后用 CLI `stop` 停止临时后台实例，再 `launchctl bootstrap` 原 plist，使 launchd 重新接管新版本。不要在 job 正在自动重启时迁移数据。

## 备份、恢复和迁移

小资料库可在中央界面导出/导入 JSON；导出包含原文和图片，按私密数据保管。超过 HTTP 导出限制的仓库使用离线备份：

```sh
node scripts/mote.mjs stop --profile prod --home /srv/mote/profiles
node scripts/mote.mjs backup --profile prod --home /srv/mote/profiles --out /srv/mote-backups/mote-2026-09-13
```

CLI 复用 `scripts/backup.ts`：SQLite backup API 生成一致数据库，复制引用的 blob，写 SHA-256 manifest。原生 `server.pid` 活跃时拒绝备份；Docker 必须已停止，先复制该环境卷到私有临时目录再备份，因此需预留约两份仓库的临时/备份磁盘空间。临时复制会在结束后清理。

在另一台机器初始化新的空环境，然后恢复：

```sh
node scripts/mote.mjs init --profile prod --home /srv/mote-new/profiles --runtime docker
# 如启用图片加密，在新环境 mote.env 设置原来的 MOTE_DATA_KEY
node scripts/mote.mjs restore --profile prod --home /srv/mote-new/profiles --from /srv/mote-backups/mote-2026-09-13
node scripts/mote.mjs start --profile prod --home /srv/mote-new/profiles
```

恢复会验证 manifest、文件类型、所有 SHA-256，并二次校验复制结果；活动服务、非空数据目录/卷都会拒绝。Docker 恢复需已准备好 profile 选择的本地镜像。恢复不复制 `server.pid`、令牌、模型 API key 或数据加密 key；新节点使用自己的访问令牌。验证记录数量、原文、图片和时间线，再修改客户端 URL/令牌。保留旧节点备份直到迁移验收完成。

`MOTE_DATA_KEY` 是可选的 64 位十六进制 AES-256-GCM 图片加密密钥，必须单独备份；原文与元数据仍在 SQLite，需要 FileVault/LUKS 或 NAS 加密卷提供全盘保护。不要在已有仓库上变更加密密钥。丢失密钥不能通过重新下载模型或更换访问令牌恢复图片。

## 验证范围

0.3.1 已完成服务端配置页面、Cloudflare Tunnel 专项回归和真实 Linux Docker 验收，最新结果见 [验证记录](tunnel-validation.md)。下方同时保留既有部署能力的验证说明。

`npm run test:profiles` 在一次性临时 dev/test 目录及随机 loopback 端口运行真实 Node 中央进程，覆盖环境污染隔离、跨令牌拒绝、加密图片、文件导入状态分离、备份恢复、代码版本切换、回退、PID 防误杀、原生输出轮转与 plist 语法。本轮已在 Mac 执行通过；没有读取个人屏幕、连接正式 47832 或调用真实模型。

`npm run test:profiles:container` 在有 Docker 的主机真实构建临时镜像，并验证 Compose project/volume 隔离、凭据字面值、容器重建、卷备份恢复、镜像切换回退和 Caddy 配置；已加入 Linux CI。当前 Mac 没有 Docker，容器验证在 GitHub Linux 环境执行；源码 `12fdef7` 的 [本次 CI](https://github.com/utopiafar/mote/actions/runs/34764645477) 已实际通过上述 Docker/Compose 检查，包含同名 tag 被覆盖后的镜像 ID 回退。没有安装 launchd job，也未验证目标 NAS 权限或公网证书签发；这些属于实际部署机器验收。
