# 独立中央节点部署、备份与迁移

中央节点包含 API、SQLite 归档与索引、Agent 运行时和 Web 界面。采集 App 通过节点 URL、当前账号登录和账号所属设备凭据连接；中央可以独立部署在 Mac mini、Linux 服务器或 NAS。只部署中央不需要屏幕权限、端上 Qwen 权重、CMake 或 Android SDK。

配置字段、默认值、数据的真实存放位置见 [服务端配置参考](server-configuration.md)。家中 Mac mini 或服务器没有公网入站端口时，可用 [Cloudflare Tunnel](cloudflare-tunnel.md) 提供 HTTPS 入口；已有公网服务器也可使用下文 Caddy。

## 环境与私有目录

需要 Node.js 24。以下命令从仓库根目录执行。统一入口是 `node scripts/mote.mjs`，也可用 `npm run mote --`。默认选择 **dev**，即使 shell 继承了 `MOTE_PROFILE=prod` 也不会改变目标；正式节点必须显式传 `--profile prod`。也可使用 1–32 位小写字母、数字、下划线或连字符的独立环境名；其它名字默认使用开发端口，建议初始化时显式指定空闲 `--port`。CLI 拒绝 `legacy` 环境名；直接进程的默认环境名是 `default`，两者的默认入口不同。

| 环境 | 默认 API 端口 | 默认配置 | 数据与日志 |
|---|---:|---|---|
| dev | 47842 | `.mote/profiles/dev/mote.yaml` | 同目录 `data/`、`logs/` |
| test | 47852 | `.mote/profiles/test/mote.yaml` | 同目录 `data/`、`logs/` |
| prod | 47832 | `.mote/profiles/prod/mote.yaml` | 同目录 `data/`、`logs/` |

`--home /absolute/profiles` 将整个环境目录放到仓库外。例如 `--home /srv/mote/profiles --profile prod` 使用 `/srv/mote/profiles/prod/`。后续命令必须使用同一个 `--home`。目录包含 `mote.yaml`、`profile.json`、`data/`、`logs/`、`backups/` 和 `generated/`。环境名和目录共同生成 Docker project/volume 名称，两个不同的 `--home` 也不会共享默认卷。

初始化创建权限为 0700 的私有目录和权限为 0600 的配置；已存在的环境会拒绝覆盖。当前中央使用独立账号和会话凭据，旧 owner token 不作为账号登录凭据。`profile.json` 记录运行方式、代码版本路径或镜像、卷名与升级快照，不含账号密码。正式部署在启动前通过下文的离线操作员入口初始化首个管理员，不使用开发环境的默认账号密码。

CLI 清除继承的普通 `MOTE_*`、`COMPOSE_*` 参数，只用 `MOTE_CONFIG_FILE` 选择服务端文件；设备与工具的连接信息从该 YAML 派生。普通进程环境不会覆盖 YAML，声明的密钥字段可使用 `${SECRET_NAME}`。相对路径以 YAML 所在目录解析。dev/test 拒绝 47832，并要求原生数据和日志路径留在各自目录内。直接 `npm start` 读取工作目录的 `mote.yaml`，也可显式设置 `MOTE_CONFIG_FILE`；`MOTE_ENV_FILE` 和根 `.env` 不再使用。CLI 不会自动接管或停止手动启动的进程。

`node scripts/mote.mjs config --profile prod --home /srv/mote/profiles` 可在启动前查看配置。运行后，中央「服务端配置」页面显示进程实际使用的值。原生新环境可用 `init --profile prod --data-dir /absolute/local-disk/mote` 选择资料目录；Docker 新环境用 `init --profile prod --runtime docker --volume mote-personal-data` 选择卷名，容器 YAML 使用 `storage.dataDir: /data`；命名卷选择需与 profile 的部署身份一致，在线改路径不会迁移资料。

## Mac mini / 原生 Node.js

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
node scripts/mote.mjs init --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

编辑该环境的 `mote.yaml` 设置部署参数。在仓库外准备权限为 0600 的私有 JSON 文件，内容为 `{"username":"admin","password":"replace-with-a-strong-password"}`，将示例密码替换为至少 12 字符的密码。中央保持停止，通过 stdin 初始化首个管理员；已有账号时该入口拒绝再次初始化，不重置账号或密码：

```sh
node scripts/mote.mjs exec --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles" -- npm run auth:initialize-admin < /absolute/private/initial-admin.json
```

该入口只初始化账号和存储，不启动模型、处理任务或后台服务。启动后在 Web 使用该账号登录。模型服务可在相应配置页面保存，见[模型服务配置](model-providers.md)：

```sh
node scripts/mote.mjs start --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs status --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs stop --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

`start` 启动独立后台进程，并等待公开的 `GET /api/health` 就绪检查，核对多用户模式、epoch 5 与 Wire 2 协议；健康检查成功不代表已获得私有资料访问权限。`run` 在前台等待，适合进程管理器。`stop` 只向带有本次唯一进程标记的托管进程发送 SIGTERM，拒绝误杀复用 PID 的其它进程。端口占用会报错，不会停止占用者。普通 `start` 不提供系统级崩溃重启；长期部署使用下面的 launchd 或 Docker。

原生启动脚本（包括 `scripts/dev-server.mjs`）为子进程设置 `NODE_USE_ENV_PROXY=1`，Node 下载请求会使用启动环境里的 `HTTP_PROXY` / `HTTPS_PROXY`（或小写同名变量）与 `NO_PROXY`。无需在每个 `mote.yaml` 中单独开启；代理地址仍由启动环境配置。

启动环境保留原有绕过规则并补齐 IPv4/IPv6 loopback，统一大小写代理变量。本机语音、图像处理和 worker 健康探测另使用强制直连传输，即使直接启动中央并遗漏 `NO_PROXY`，也不会通过环境代理发送本机处理原件或授权头。

原生 stdout/stderr 先经监督进程白名单化：保留固定启动/停止事件，未知 SDK 输出只记流类型与字节数，再写入有上限的 `central.log`。DEV 默认每份 100 MiB、总共 3 份，其它 profile 默认每份 2 MiB、3 份；包括单次大输出与反复重启。中央结构化诊断独立写入 `diagnostics.directory`，使用同样的容量配置，并默认限制 2000 条记录。两组日志各自轮转，所以 DEV 默认合计最多 600 MiB；容量不保证固定保留时长。`diagnostics.debug: false` 默认关闭调试级别；开关、级别与 trace 经校验热应用，目录与日志容量修改需重启。

<a id="dev-log-retention"></a>

### DEV 日志默认容量

YAML 省略 `diagnostics.maxBytes` 时按 `server.profile` 选择默认值：DEV 为 104857600 字节（100 MiB），其它环境为 2097152 字节（2 MiB）。DEV 允许显式 0.1–100 MiB，其它允许 0.1–8 MiB。所有显式数字保持用户选择，包括转换旧 env 后写入的 2097152；配置读取不会静默迁移。

已有 YAML DEV 可主动采用默认值：

```sh
node scripts/mote.mjs log-retention --defaults --profile dev
```

命令只删除主 YAML 中的 `diagnostics.maxBytes`，通过同一原子配置写入递增 revision，保留文件数、内存事件数、其它字段、密钥引用及资料。它返回变更前后容量；重复执行不改写文件。运行中的中央会显示该容量需要重启，由所有者在下一次正常重启后生效。旧 `mote.env` profile 按统一配置规则先离线准备 YAML，不由此命令自动转换。

启动、采用默认值、升级和回退都先核对目标 build/image 的 YAML 支持；超过 8 MiB 还需扩容能力。只认识 env 的旧发行版会在启动、停服务或恢复资料前拒绝。支持 YAML 但没有扩容能力的版本需要主动设置 `diagnostics.maxBytes` 为 8 MiB 或更小；不会自动降容。较小写入器可能截断超限历史日志，需要保留排错资料时先保存副本。原生预检检查目标构建模块；Docker 预检在无网络、无资料卷的临时容器中检查相同模块。

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

需要 Docker Engine、**Docker Compose 2.30.0 或更新版本**与 Node 24（运行部署 CLI 和离线备份）。Compose 使用 `env_file.format: raw`，避免密钥中的 `$` 或引号被再次解释；此格式的版本要求见 [Docker 官方文档](https://docs.docker.com/reference/compose-file/services/#env_file)。从源码运行宿主 CLI 前，先执行 `npm ci --ignore-scripts` 安装锁定的 YAML 解析依赖；普通 Docker profile 命令无需构建共享库或服务器，也无需在宿主运行服务器的原生依赖安装脚本。镜像构建会自行安装容器内的 npm 依赖。

```sh
npm ci --ignore-scripts
node scripts/mote.mjs init --profile prod --home /srv/mote/profiles --runtime docker
# 编辑 /srv/mote/profiles/prod/mote.yaml
node scripts/mote.mjs compose --profile prod --home /srv/mote/profiles -- build
# 仅初始化新空卷的文件系统所有权，不启动中央
node scripts/mote.mjs compose --profile prod --home /srv/mote/profiles -- run --rm --no-deps storage-init
# 使用上文的私有 JSON 文件，通过容器内入口初始化首个管理员
node scripts/mote.mjs compose --profile prod --home /srv/mote/profiles -- run --rm --no-deps -T mote node apps/server/dist/scope/initialize-admin.js < /absolute/private/initial-admin.json
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
node scripts/mote.mjs status --profile prod --home /srv/mote/profiles
node scripts/mote.mjs stop --profile prod --home /srv/mote/profiles
```

Docker 的管理员初始化必须在所选 profile 的容器和数据卷内执行，不要在宿主机直接加载含 `/data` 路径的容器 YAML。管理员初始化完成后再启动中央，并用账号密码登录。

如果系统用户不能写 `/srv/mote`，先由管理员创建并交给部署用户，不要用宽泛的全盘权限修改。中央与媒体容器使用配置文件所属用户的 UID/GID 运行，保留 YAML 的 0600 权限；一个无网络的初始化服务只初始化空卷根目录的所有权。已有非空卷的 UID/GID 不匹配时明确拒绝，不自动递归修改旧资料。支持本地 Unix Docker Engine；远程 Engine 与 userns-remap 会明确拒绝，rootless Engine 使用映射后的 0:0。数据与结构化日志分别在 `/data`、`/data/logs`，来自该环境独立命名卷。服务端口只发布到宿主机 loopback。`start` 使用现成镜像；升级前必须显式构建或拉取指定镜像。

CLI 将 profile 的父目录挂到中央容器 `/config`，主文件是 `/config/mote.yaml`。目录挂载使设置页的原子保存和外部替换持续可见；不会生成另一份运行配置。媒体 sidecar 只读同一个目录。YAML 的 `server.port` 同时决定容器监听与 loopback 发布端口；数据与日志路径是 `/data`、`/data/logs`；模型卷的挂载目标由 YAML 的 `media.modelDirectory` 决定，初始化默认 `/models`，CLI 导入与媒体 worker 使用同一路径。该绝对容器路径不能遮蔽根目录、`/config`、`/data` 或 `/app`；更改模型路径需重启。健康检查读取同目录的私有运行 locator（只记录当前 PID、监听地址、端口和实例身份），因此保存待重启的 `server.port` 不会误判当前容器为不健康；进程退出仅清理自己的 locator。该文件是瞬时进程状态，不是第二份配置来源。每次生成的私有 `generated/secrets.env` 仅传递 YAML 中声明的环境密钥引用，普通参数不通过环境注入。根 `.env` 不参与 Compose 插值。不要公开 `compose config`、`docker inspect` 的完整输出，其中可含声明的环境密钥。Docker stdout 日志另设每份 10 MiB、最多 3 份。

复用同为 epoch 5 的 Docker 卷且仅调整文件系统所有权时，先停止所有写入并完成完整实例备份。已有镜像的 UID 可能与新 profile 用户不一致。确认本 profile 数据/模型卷的所有使用者均已停止后，显式执行：

```sh
node scripts/mote.mjs migrate-storage-owner --profile prod --home /srv/mote/profiles
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
```

该命令只调整文件系统 UID/GID，不转换 epoch 4 或更早数据库。它仅递归调整 metadata 声明的数据卷与模型卷所有权，不启动中央、媒体或隧道，不修改 YAML 或资料内容；发现任何使用这些卷的运行容器会拒绝。请先备份，因为这是停机后的明确所有权迁移；普通 `start` 不替用户执行它。不支持远程 Docker / userns-remap 的边界仍适用。

SQLite 和 blob 应使用 NAS/服务器的本地块存储或本地 Docker 卷，避免多实例共享网络文件系统上的 WAL 数据库。当前是单实例写入、账号私有资料隔离的多用户节点。容器中的 loopback 指容器本身；外部模型服务应使用容器可达的 HTTPS 地址。

### 可选 Caddy HTTPS

在该环境 `mote.yaml` 设置 `server.tls.domain: mote.example.com`，换成自己的域名。DNS 指向服务器，服务器允许公网 80/443 到达，之后执行：

```sh
node scripts/mote.mjs tls --enable --profile prod --home /srv/mote/profiles
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
```

TLS overlay 使用固定 Caddy 2.11.4 Alpine 镜像；与中央在独立 Compose 网络中通信，证书保存在该 project 的 Caddy 卷中。Caddy 根据域名配置自动 HTTPS，见 [官方文档](https://caddyserver.com/docs/automatic-https)。该节点地址填为 `https://mote.example.com`。Web 使用当前账号登录；采集设备通过当前账号签发的一次性设备邀请取得各自的设备凭据，见[账号设备配对](design/multiuser-qr-pairing.md)。设备凭据不授予私有归档浏览或管理权限。

已有反向代理可以保持 TLS overlay 关闭，将请求代理到 `127.0.0.1:47832`。`tls --disable` 只调整配置；已有 Caddy 容器需用该 profile 的 `compose -- down --remove-orphans` 后再 `start`，保留卷即可。自定义宿主端口可设置 `server.tls.httpPort`、`server.tls.httpsPort`，但公共 ACME 验证仍需正确转发到标准 80/443。项目不会修改 DNS、防火墙或购买域名。

通过 HTTPS 反向代理访问网页登录时，在所选 profile 的私有 `mote.yaml` 中设置 `server.publicUrl` 为浏览器使用的公开 origin（例如 `https://mote.example.com`），然后重启中央节点。浏览器登录使用这个公开地址。代理到中央的内部连接可以继续使用 loopback HTTP；来源校验不会仅凭 `X-Forwarded-Proto` 信任任意代理。缺少或填错公开地址会返回 `403 origin_denied`，应检查公开地址与代理配置，不能据此判断中央版本过旧。实际 profile 配置位于被 Git 忽略的 `.mote/` 目录，不要把含凭据的配置提交到仓库。

旧 `mote.env`、JSON 设置、旧 owner token 和旧存储不会自动转换。当前主配置为 YAML version 1，中央使用 storage epoch 5、Wire 2 / Ingress 3，Desktop / Android 本机格式为 4，个人便携归档为 version 3。手改文件与设置页共用主 YAML；端口、目录、插件模块、媒体 worker 资源、TLS/Tunnel 启停仍需重启或对应明确 CLI 操作。

## 升级与回退

本次多用户版本是 MVP 代际切换。epoch 4 或更早中央库、本机格式 3 或更早客户端、旧 owner token 和 portable 2 均不迁移到当前版本。先用匹配的旧程序停止写入、备份并保留完整旧目录及必要密钥，再为当前版本选择新的空 profile，例如 `--home /srv/mote-epoch5/profiles`，初始化账号并重新连接设备。不要让新程序打开旧库，也不要通过修改版本字段或恢复旧便携包绕过边界。历史清理脚本不是本次升级步骤。完整边界见[更新说明](updating.md)。

同为当前 epoch 5 / 客户端格式 4 的普通重启和同代版本更新保留现有身份与资料，不要求清空目录。以下 `upgrade` / `rollback` 用于同代部署切换，不能执行跨代迁移。切换会短暂停机；先确认 release 已独立构建或镜像已准备，使用版本目录或固定镜像，不要覆盖正在运行的 release。

### 签名清单更新通道

当前 Central DEV 发布提供中央源码包，但不提供签名清单或 GHCR 镜像；本节说明当前签名更新契约，不能用于获取当前 DEV 版本。清单必须声明组件，并使用该组件的 `central-vX.Y.Z` / `desktop-vX.Y.Z` / `android-vX.Y.Z` 标签；旧统一 `vX.Y.Z` 标签不受支持。当前升级请使用下节的手动源码构建或自行构建 Docker 镜像，再运行 `upgrade`。

已初始化的独立 profile 可以检查并安装符合当前契约的可信签名 Release。中央「服务端配置」页面也可检查最新版本并给出当前环境的操作命令；HTTP 接口不会启动 shell、选择本机路径或直接安装。检查是手动触发，同一分钟内共享同一次结果，不在中央启动时自动联网。非 CLI 托管进程需先由管理员建立明确的独立部署；检查接口不会自动认领根目录安装。

从 Git 源码运行签名更新 CLI 前，宿主机需要 Node 24，并在可信检出目录执行 `npm ci --ignore-scripts`、`npm run build:libs` 以准备验证器及其锁定依赖。所有 profile 命令都需要宿主已安装的锁定 YAML 解析依赖；`init` 无需预先构建共享库，`check-update/update` 还需构建签名验证器。

```sh
node scripts/mote.mjs check-update --profile prod --home /srv/mote/profiles
# 可明确固定目标版本；省略 --version 时检查所选渠道最新版本
node scripts/mote.mjs update --profile prod --home /srv/mote/profiles --version X.Y.Z
```

版本号只是示例；目标必须高于当前安装的版本，已是该版本时不会重装或降级。尚无签名发行版、GitHub 限流、签名失效或包校验失败都会明确报错，不退回下载任意代码。当前原生进程的版本通过所选本机节点确认；Docker 使用该 profile 容器实际镜像的版本，不能把执行 CLI 的代码目录版本当成容器版本。

发行来源默认是 `utopiafar/mote`、`stable`，可以在所选私有 `mote.yaml` 调整 `updates.repository` 与 `updates.channel: stable|preview` 后重启中央界面服务。CLI 每次读取该文件。`preview` 接收预发行版本；更换仓库不会更换内置的发行签名公钥。

`mote-release.json` 包含 RSA-3072 / SHA-256 签名的原始 JSON payload。客户端只接受已安装程序内置的公钥与 keyId；manifest 不能自带替代公钥。验证仓库、版本、渠道、固定 GitHub asset URL、大小和 SHA-256 后才准备代码。原生源包限制压缩 128 MiB、展开 256 MiB、单文件 32 MiB，并拒绝路径穿越、符号链接、硬链接与私有配置条目。

原生更新在 profile 的 `releases/版本-哈希/` 中准备一个独立目录，执行锁定依赖的 `npm ci` 与中央/Web 构建。构建不接收 profile 令牌、模型密钥或数据路径；需要 npm 网络访问、构建依赖和额外磁盘空间。准备失败不会停止正在运行的中央。独立目录准备好之后，复用下面的停机、一致备份、切换和健康检查流程，并确认启动进程报告的版本一致。旧目录保留用于回退，不被覆盖。

Docker 更新只拉取已签名 manifest 中的 `ghcr.io/仓库@sha256:...`，验证本地 RepoDigest 后切换。不会使用漂移的 `latest` tag，也不把宿主 profile 凭据交给镜像拉取进程。公开发行依赖的 registry 可用性需要部署机器具备网络访问。

同代更新沿用所选 profile 的配置与存储身份。执行完整实例恢复或带数据恢复的回退时，历史数据和身份保留，但旧登录凭据与执行授权会撤销，后台工作保持暂停；需要重新登录、配对并明确授权后再继续。恢复行为见下文和[多用户恢复契约](design/multiuser-lifecycle.md#stopped-instance-archive-checkpoint)。服务不会自动安装、降级或回退。

### 手动准备的版本

中央发布标签为 `central-vX.Y.Z`，server 与 web 同版本部署；下载该标签的 `mote-server-X.Y.Z.tar.gz` 或检出源码后独立构建。同一协议代际内的中央版本更新无需同步升级 Mac 或 Android；本次跨越多用户基线时，各端须使用当前 Wire 2 / Ingress 3 和本机格式 4 实现。其他端的标签和版本不用于选择中央部署。

原生示例：

```sh
# 在另一个检出目录完成 npm ci 和中央/Web 构建
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --release /srv/mote/releases/next
```

Docker 示例：

```sh
# 先 docker pull 已发布镜像，或在新代码目录构建带新 tag 的镜像
docker build --tag mote-central:next .
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --image mote-central:next
```

升级先停止该环境、生成 `backups/pre-upgrade-*` 一致快照，再切换代码路径或本地镜像 ID，等待健康检查。备份准备失败、且资料和版本选择均未变更时，会恢复此前正在运行的服务；原本已停止的环境仍保持停止。切换或恢复资料开始后，失败会保留快照与选择记录，不会自动让旧代码打开不兼容的数据库。当前切换没有跨代 schema 转换。`profile.json` 的 `previous` 记录回退目标，镜像保存实际 image ID，避免旧 tag 被覆盖后指向新代码。

```sh
node scripts/mote.mjs rollback --profile prod --home /srv/mote/profiles --restore-data
```

回退先验证旧快照，另存当前仓库的 `pre-rollback-*` 备份，恢复升级前的数据和版本。**升级后新增资料不会出现在回退后的活动仓库中**，但会保存在额外快照，以及原生的 `data.before-rollback-*` 目录或 Docker 原来的命名卷中。CLI 不删除这些保留副本；验收及后续资料合并必须遵守当前同账号、同部署的个人归档契约。只保留一级直接回退元数据；备份目录中更早的快照仍在。

跨代回滚需要匹配的旧程序和完整旧备份；旧程序不能打开 epoch 5，新程序也不能打开旧库。新空 profile 的资料与旧库彼此独立，必须保留两代目录并显式选择匹配版本。

使用 launchd 的环境：先 `launchctl bootout` 停止自动管理，再执行升级或回退；验收后用 CLI `stop` 停止临时后台实例，再 `launchctl bootstrap` 原 plist，使 launchd 重新接管新版本。不要在 job 正在自动重启时迁移数据。

## 备份、恢复和迁移

个人便携归档与操作员完整实例备份是两种契约。当前个人便携归档为 `mote-portable` version 3，按登录账号导出已注册私有领域的规范数据和原件，不包含可复用凭据、活动执行授权或整个实例。导入仅接受**原部署、原账号**的当前格式归档，先校验全部领域和身份，再合并去重；不支持跨部署、跨账号或旧 version 2 映射。它不恢复旧任务、模型或外部执行权限，也不是个人时间点回滚。详见[个人归档契约](design/multiuser-lifecycle.md#personal-portable-3-import)。

### 完整实例备份

先停止中央及使用该资料库的外部 provider 写入者，然后执行：

```sh
node scripts/mote.mjs stop --profile prod --home /srv/mote/profiles
node scripts/mote.mjs backup --profile prod --home /srv/mote/profiles --out /srv/mote-backups/mote-epoch5-2026-10-18
```

当前 epoch 5 备份使用 `mote-instance-backup` version 2 manifest，保存部署与账号身份、规范 SQLite（含对话历史）、引用原件、私有配置、插件及受支持 provider 原生快照，**包括恢复所需的私有密钥材料**。它包含多个账号的敏感资料与配置，必须按整实例私密备份保管。日志、进程 PID、provider 锁和已下载模型权重不包含在内；配置中的环境密钥引用仍需另行保留原来的外部密钥来源。

备份验证停止状态、配置及文件清单稳定性、当前 schema、引用完整性、文件类型和 SHA-256，最后才发布 manifest；缺失原件、未支持的 provider 原生快照或活动写入者会拒绝。原生使用该 profile 的实际配置；Docker 需已停止，先将所选卷复制到私有临时目录再备份，因此应预留临时副本和备份的空间，临时目录在结束后清理。独立使用 `npm run backup -- --data VAULT --out NEW_BACKUP --config INSTANCE_YAML` 时，显式选择实例配置，不能只复制数据库而遗漏配置和密钥。完整校验边界见[实例恢复契约](design/multiuser-lifecycle.md#stopped-instance-archive-checkpoint)。

### 恢复当前完整实例

保持源节点和目标节点停止，选择空目标目录，并核对备份 manifest 中的原部署 ID：

```sh
npm run restore:instance -- --from /srv/mote-backups/mote-epoch5-2026-10-18 --data /srv/mote-restored/vault --deployment-id EXPECTED_DEPLOYMENT_ID
```

恢复先验证完整 manifest、身份、文件和校验和，在私有目录准备并复核后发布；拒绝非空目标或覆盖活动资料，不启动服务。返回值中的 `configurationFile` 是恢复后的 `instance.yaml`，本机资料与日志路径已重定位。启动时显式选用这个文件，并检查部署路径和外部密钥来源；不要误用新初始化 profile 的空配置替代备份配置。

恢复保留部署、账号、密码和规范历史，撤销旧登录/设备凭据、任务授权和插件授权，并暂停自动处理、Memory、连接器同步、出站 MCP 与自动化。重新登录并逐项确认授权后再恢复后台工作；已成功或结果未知的外部操作不会自动重放。先验收账号隔离、原文/原件、历史和暂停状态，再切换客户端地址并重新配对设备。保留原节点和备份，直到迁移验收完成。

托管 profile 也可使用 `node scripts/mote.mjs restore --profile prod --home /srv/mote-new/profiles --from BACKUP`。原生恢复保留操作员选择的 profile 配置，并返回已恢复实例 YAML 路径；要使用备份配置须显式选择返回文件。Docker 恢复要求目标卷为空且已有本地镜像，将资料准备到新卷、逐字节校验后原子发布 YAML 存储指针，保留旧卷且保持停止，见[容器恢复说明](validation/multiuser-container-backup.md)。不要在旧库上初始化新账号或套用旧版恢复命令；旧代备份只能交给匹配旧程序。

### 原件加密

当前内容加密是个人账号设置，默认关闭。每个账号在自己的部署/账号目录使用独立托管密钥；没有可由调用者选择的全局原件密钥。开启或关闭未来写入的加密不重写已有对象。当前设置不加密账号凭据或整个 SQLite；解析文本与元数据不属于原件加密范围。

完整实例备份包含恢复所需的托管密钥；个人便携归档包含授权账号原件的明文，不携带密钥，导入按当前账号策略写入。密钥丢失不能靠重新下载模型或重新登录恢复密文。已有原件的批量解密通过个人内容存储页面的独立任务执行，支持进度、取消和重启检查点；关闭未来加密不会代替该任务。详见[多用户内容存储](design/multiuser-content-storage.md)。

## 验证范围

以下保留既有部署与更新实现的历史验收说明，其中单 owner、epoch 4 和旧令牌用例不构成当前多用户版本的验收。本文的操作说明更新没有重新运行这些检查。当前合并回归与实际执行范围见[多用户集成验证](validation/main-multiuser-integration-2026-10-17.md)，完整实例恢复的独立证据见[恢复与生命周期接缝](validation/multiuser-recovery-lifecycle-seams.md)和[容器备份恢复](validation/multiuser-container-backup.md)。

更新专项使用 `node --test scripts/update-tests.mjs scripts/update-deployment-tests.mjs`，覆盖合成 RSA 签名、真实校验下载、安全提取、镜像 digest/实际版本、无权限 HTTP 参数，以及临时 Node 中央的实际切换/回退。进程用例复用当前编译代码作为构建 fixture，不等于从公网完成 npm 安装或发布生产 Release；Docker 用例需在 Docker 主机另行验收。没有操作日常节点、调用真实模型或使用真实 Google/Tunnel 凭据。HTTP 更新接口另由 `apps/server/test/updates.test.ts` 覆盖。

0.3.1 已完成服务端配置页面、Cloudflare Tunnel 专项回归和真实 Linux Docker 验收，最新结果见 [验证记录](tunnel-validation.md)。下方同时保留既有部署能力的验证说明。

`npm run test:profiles` 在一次性临时 dev/test 目录及随机 loopback 端口运行真实 Node 中央进程，覆盖环境污染隔离、跨令牌拒绝、加密图片、文件导入状态分离、备份恢复、代码版本切换、回退、PID 防误杀、原生输出轮转与 plist 语法。该历史轮次已在 Mac 执行通过；没有读取个人屏幕、连接正式 47832 或调用真实模型。

`npm run test:profiles:container` 在有 Docker 的主机真实构建临时镜像，并验证 Compose project/volume 隔离、凭据字面值、容器重建、卷备份恢复、镜像切换回退和 Caddy 配置；已加入 Linux CI。当前 Mac 没有 Docker，容器验证在 GitHub Linux 环境执行；历史源码 `12fdef7` 的 [该次 CI](https://github.com/utopiafar/mote/actions/runs/34764645477) 已实际通过上述 Docker/Compose 检查，包含同名 tag 被覆盖后的镜像 ID 回退。没有安装 launchd job，也未验证目标 NAS 权限或公网证书签发；这些属于实际部署机器验收。
