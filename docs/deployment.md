# 独立中央节点部署、备份与迁移

中央节点包含 API、SQLite 归档与索引、Agent 运行时和 Web 界面。采集 App 通过节点 URL 与令牌连接；中央可以独立部署在 Mac mini、Linux 服务器或 NAS。只部署中央不需要屏幕权限、端上 Qwen 权重、CMake 或 Android SDK。

配置字段、默认值、数据的真实存放位置见 [服务端配置参考](server-configuration.md)。家中 Mac mini 或服务器没有公网入站端口时，可用 [Cloudflare Tunnel](cloudflare-tunnel.md) 提供 HTTPS 入口；已有公网服务器也可使用下文 Caddy。

## 环境与私有目录

需要 Node.js 24。以下命令从仓库根目录执行。统一入口是 `node scripts/mote.mjs`，也可用 `npm run mote --`。默认选择 **dev**，即使 shell 继承了 `MOTE_PROFILE=prod` 也不会改变目标；正式节点必须显式传 `--profile prod`。也可使用 1–32 位小写字母、数字、下划线或连字符的独立环境名；其它名字默认使用开发端口，建议初始化时显式指定空闲 `--port`。CLI 拒绝 `legacy` 环境名；直接进程的默认环境名是 `default`，两者的默认入口不同。

| 环境 | 默认 API 端口 | 默认配置 | 数据与日志 |
|---|---:|---|---|
| dev | 47842 | `.mote/profiles/dev/mote.yaml` | 同目录 `data/`、`logs/` |
| test | 47852 | `.mote/profiles/test/mote.yaml` | 同目录 `data/`、`logs/` |
| prod | 47832 | `.mote/profiles/prod/mote.yaml` | 同目录 `data/`、`logs/` |

`--home /absolute/profiles` 将整个环境目录放到仓库外。例如 `--home /srv/mote/profiles --profile prod` 使用 `/srv/mote/profiles/prod/`。后续命令必须使用同一个 `--home`。目录包含 `mote.yaml`、`profile.json`、`data/`、`logs/`、`backups/` 和 `generated/`。环境名和目录共同生成 Docker project/volume 名称，两个不同的 `--home` 也不会共享默认卷。

初始化为每个环境生成独立的 256 bit 随机令牌，私有目录权限 0700、配置权限 0600；已存在的环境会拒绝覆盖。只有 `token` 命令主动显示令牌。`profile.json` 记录运行方式、代码版本路径或镜像、卷名与升级快照，不含令牌。

CLI 清除继承的普通 `MOTE_*`、`COMPOSE_*` 参数，只用 `MOTE_CONFIG_FILE` 选择服务端文件；设备与工具的连接信息从该 YAML 派生。普通进程环境不会覆盖 YAML，声明的密钥字段可使用 `${SECRET_NAME}`。相对路径以 YAML 所在目录解析。dev/test 拒绝 47832，并要求原生数据和日志路径留在各自目录内。直接 `npm start` 读取工作目录的 `mote.yaml`，也可显式设置 `MOTE_CONFIG_FILE`；`MOTE_ENV_FILE` 和根 `.env` 不再使用。CLI 不会自动接管或停止手动启动的进程。

`node scripts/mote.mjs config --profile prod --home /srv/mote/profiles` 可在启动前查看配置。运行后，中央「服务端配置」页面显示进程实际使用的值。原生新环境可用 `init --profile prod --data-dir /absolute/local-disk/mote` 选择资料目录；Docker 新环境用 `init --profile prod --runtime docker --volume mote-personal-data` 选择卷名，容器 YAML 使用 `storage.dataDir: /data`；命名卷选择需与 profile 的部署身份一致，在线改路径不会迁移资料。

## Mac mini / 原生 Node.js

<a id="native-environment-checks"></a>

### 本机环境检查

先实际执行以下命令；只找到可执行文件不代表其动态库完整：

```sh
command -v node
node --version
npm --version
```

本文使用 Node.js 24。macOS 使用 Homebrew 时，`node` 可能指向另一个主版本；即使已经安装 Node 24，终端或 Agent 也可能选错。尚未安装时可执行 `brew install node@24`，已安装则直接在当前终端选择它：

```sh
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
npm --version
```

确认 Node 输出 `v24.`，再在同一终端执行下方 npm/CLI 命令；npm 的子命令也必须使用同一个 Node。该 PATH 设置只影响当前终端。长期服务按下文 `launchd --node` 固定可执行路径。[Homebrew 的 Node 24 配方](https://formulae.brew.sh/formula/node@24)为 keg-only，不会自动替换默认 `node`。

如果启动即出现 `dyld: Library not loaded: ...libsimdjson...dylib` 等错误，说明所选 Homebrew Node 的动态库链接失效，尚未执行 Mote。先用上面的命令选择可运行的 Node 24；如果 Node 24 本身也无法加载，再通过原安装方式修复或重装它（Homebrew 为 `brew reinstall node@24`），不要手工伪造缺失 dylib 的符号链接。切换 Node 主版本后，`better-sqlite3` 必须匹配当前 ABI；在选定的源码目录重新执行 `npm ci`，或定向执行 `npm rebuild better-sqlite3`。

从源码安装 npm 原生依赖或 Python 源码包时，macOS 还需要 Xcode Command Line Tools。用 `xcode-select -p` 检查；缺失时执行 `xcode-select --install` 并完成系统安装提示。仅运行 Central 不需要完整 Xcode、Android SDK、屏幕或麦克风权限。

Native OCR/语音在设置中显式准备后，会把固定版本的 uv、Python 3.11、角色依赖和语音 FFmpeg 安装到 `media.modelDirectory/runtime/<role>/`，无需全局安装 Python、uv 或 FFmpeg。首次准备需要访问 GitHub Release、PyPI 和语音依赖使用的官方 PyTorch CPU wheel 源；模型下载另需当前 catalog 的固定来源。运行依赖准备完成与模型/Worker 就绪分别报告，旧 Whisper 模型不能替代当前 FunASR 四组件。普通重启不会隐式安装缺失依赖。

如果语音准备在 `dependencies` 阶段失败并报告 `command_failed`，仅凭这个错误码不能断定是缺系统软件。已知旧安装器会因 uv 的首索引策略把 PyTorch CPU 索引中的旧版通用依赖当作唯一候选，导致明明在 PyPI 存在的固定版本无法解析；修复后的语音安装器使用固定官方源之间的版本回退。应使用含修复的版本重试准备，保留已有 profile 和模型；不要靠全局 pip 安装、改版本锁或删除模型目录绕过。代理、下载失败或编译错误仍需按实际失败命令排查，不应只据此错误码归因。

### 安装与启动

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
npm run connectors:prepare
node scripts/mote.mjs init --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

编辑该环境的 `mote.yaml` 设置部署参数，然后启动。模型服务也可以启动后在 Web“系统管理 → 模型”中保存并立即应用，见[模型服务配置](model-providers.md)：

```sh
node scripts/mote.mjs start --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs status --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs token --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
node scripts/mote.mjs stop --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

`start` 启动独立后台进程，并等待经过认证的健康检查；`run` 在前台等待，适合进程管理器。`stop` 只向带有本次唯一进程标记的托管进程发送 SIGTERM，拒绝误杀复用 PID 的其它进程。端口占用会报错，不会停止占用者。普通 `start` 不提供系统级崩溃重启；长期部署使用下面的 launchd 或 Docker。

原生启动脚本（包括 `scripts/dev-server.mjs`）为子进程设置 `NODE_USE_ENV_PROXY=1`，并原样转发启动环境里的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（或小写同名变量）与 `NO_PROXY`。Node 下载请求在 `NODE_USE_ENV_PROXY=1` 下使用 `HTTP_PROXY` / `HTTPS_PROXY` 与 `NO_PROXY`；无需在每个 `mote.yaml` 中单独开启，代理地址仍由启动环境配置。

启动环境保留原有绕过规则并补齐 IPv4/IPv6 loopback，统一大小写代理变量。`launchd` 生成的 plist 会把生成时进程环境中已存在的代理变量原样写入 `EnvironmentVariables`，缺失的变量不会补造；运行仍由 `mote run` 补齐 `NODE_USE_ENV_PROXY=1`。本机语音、图像处理和 worker 健康探测另使用强制直连传输，即使直接启动中央并遗漏 `NO_PROXY`，也不会通过环境代理发送本机处理原件或授权头。

原生 stdout/stderr 先经监督进程白名单化：保留固定启动/停止事件，未知 SDK 输出只记类型与字节数。监督进程和中央诊断都按级别分段，使用同一目录与 2 GiB 总预算；各级别保留目标和容量见[日志保留决策](troubleshooting.md)。所有profile默认关闭debug 与详细过程记录。详细记录开启后最多持续 24 小时；开关、级别和截止时间经校验热应用，目录与容量修改需要重启。

### 日志锁与离线恢复

中央与监督进程以 `retention-mutex.sqlite` 上的 SQLite `BEGIN IMMEDIATE` 协调日志追加和清理，退出或崩溃由操作系统释放锁。该文件始终为 0 字节：不创建表、不写入数据，以 rollback 结束每次操作。`retention.lock` 是完整写入、同步后原子发布的永久协议标记，内容为 `{"protocol":"mote-retention-sqlite"}`，阻止旧版 PID 写入器绕过新互斥。两个文件在正常退出后都会保留；运行中不得移动、删除、重建或用普通文件句柄打开/关闭 `retention-mutex.sqlite`，否则可能破坏互斥。锁要求支持 SQLite 文件锁的本地文件系统。

旧版可能在创建 `retention.lock` 后、写入 PID 前退出，留下空锁。空内容、文件年龄、未监听端口或某个 PID 已退出，都不能单独证明没有写入者。遇到 `existing retention.lock requires offline recovery` 时，程序保留原文件并拒绝日志写入，不自动接管任何旧锁。

仅在维护窗口内完成以下条件后，才可手动恢复旧空锁：

1. 先停止并禁用该 profile 的 launchd、Docker restart policy 或其他自动重启管理，再正常停止中央、监督进程及所有共享该日志目录的写入者。确认没有仍在启动、退出或访问该目录的进程，且维护期间不会重启。只执行 `mote stop` 或只检查端口不充分。
2. 保留日志与 profile 的备份，核对目标确为已停止 profile 日志目录中的普通 0 字节 `retention.lock`，而非符号链接、当前协议标记或 `retention-mutex.sqlite`。无法证明全部写入者停止时，不操作锁。
3. 把这一个旧锁原子重命名到同一目录的唯一备份名，保留其 inode 和现场；不截断日志、不删除日志目录，也不批量清理其他锁。然后启动当前版本，确认经过认证的健康检查、中央与监督日志及正常停止/重启，再恢复自动管理。

代价是维护停机及一次显式的旧锁恢复；升级不会自动转换归属不明的文件。中断发生在新协议标记发布前时，可能留下独立的 `retention.<uuid>.tmp` 候选文件，它不持有互斥，其字节仍计入日志总预算；需要删除时同样先停写并保留所需现场。当前协议不支持与旧版同时使用同一日志目录；回退到旧版也须在全部写入者停止后单独处理协议标记，不得在线删锁。

<a id="dev-log-retention"></a>

### DEV 日志默认容量

YAML 省略 `diagnostics.maxBytes` 时按 `server.profile` 选择默认值：所有 profile 为 16777216 字节（16 MiB）。显式范围为 0.1–100 MiB。所有显式数字保持用户选择，包括转换旧 env 后写入的 2097152；配置读取不会静默迁移。

已有 YAML DEV 可主动采用默认值：

```sh
node scripts/mote.mjs log-retention --defaults --profile dev
```

命令只删除主 YAML 中的 `diagnostics.maxBytes`，通过同一原子配置写入递增 revision，保留各级别预算、总预算、内存事件数、其它字段、密钥引用及资料。它返回变更前后容量；重复执行不改写文件。运行中的中央会显示该容量需要重启，由所有者在下一次正常重启后生效。旧 `mote.env` profile 按统一配置规则先离线准备 YAML，不由此命令自动转换。

启动、采用默认值、升级和回退都先核对目标 build/image 是否支持当前 YAML 和分级日志存储。旧写入器会在停服务或恢复资料前被拒绝，不通过调小分段大小来绕过检查。调小当前版本的日志容量只会按策略删除完整旧分段，不会清空保留文件。原生预检检查目标构建模块；Docker 预检在无网络、无资料卷的临时容器中检查相同模块。

### 生成与安装 launchd 配置

```sh
node scripts/mote.mjs launchd --profile prod --home "$HOME/Library/Application Support/MoteCentral/profiles"
```

命令只生成 plist，返回 `generated` 路径和 `label`，不会安装、加载、停止任何系统服务。检查内容中的 Node 路径、仓库路径与环境路径。Node 必须是稳定的 Node 24 可执行文件；必要时加 `--node /absolute/path/to/node`，不要依赖交互 shell 的版本切换。保留该仓库路径作为控制入口，升级使用独立 release 目录。

plist 的 `PATH` 以所选 Node 所在目录开头，随后依次包含 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`，重复目录只保留第一次出现的位置。这样通过 `#!/usr/bin/env node` 启动的 CLI 也能找到该 Node。生成器不复制 shell 的 `PATH` 或登录、模型凭据；自定义 CLI 安装在其他目录时，在私有 `mote.yaml` 中用 `models.codex.executable` 指定可信的绝对路径。Node 路径必须是绝对路径，且不能含冒号或控制字符。

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
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
node scripts/mote.mjs status --profile prod --home /srv/mote/profiles
node scripts/mote.mjs token --profile prod --home /srv/mote/profiles
node scripts/mote.mjs stop --profile prod --home /srv/mote/profiles
```

如果系统用户不能写 `/srv/mote`，先由管理员创建并交给部署用户，不要用宽泛的全盘权限修改。中央与媒体容器使用配置文件所属用户的 UID/GID 运行，保留 YAML 的 0600 权限；一个无网络的初始化服务只初始化空卷根目录的所有权。已有非空卷的 UID/GID 不匹配时明确拒绝，不自动递归修改旧资料。支持本地 Unix Docker Engine；远程 Engine 与 userns-remap 会明确拒绝，rootless Engine 使用映射后的 0:0。数据与结构化日志分别在 `/data`、`/data/logs`，来自该环境独立命名卷。服务端口只发布到宿主机 loopback。`start` 使用现成镜像；升级前必须显式构建或拉取指定镜像。

CLI 将 profile 的父目录挂到中央容器 `/config`，主文件是 `/config/mote.yaml`。目录挂载使设置页的原子保存和外部替换持续可见；不会生成另一份运行配置。媒体 sidecar 只读同一个目录。YAML 的 `server.port` 同时决定容器监听与 loopback 发布端口；数据与日志路径是 `/data`、`/data/logs`；模型卷的挂载目标由 YAML 的 `media.modelDirectory` 决定，初始化默认 `/models`，CLI 导入与媒体 worker 使用同一路径。该绝对容器路径不能遮蔽根目录、`/config`、`/data` 或 `/app`；更改模型路径需重启。健康检查读取同目录的私有运行 locator（只记录当前 PID、监听地址、端口和实例身份），因此保存待重启的 `server.port` 不会误判当前容器为不健康；进程退出仅清理自己的 locator。该文件是瞬时进程状态，不是第二份配置来源。每次生成的私有 `generated/secrets.env` 仅传递 YAML 中声明的环境密钥引用，普通参数不通过环境注入。根 `.env` 不参与 Compose 插值。不要公开 `compose config`、`docker inspect` 的完整输出，其中可含声明的环境密钥。Docker stdout 日志另设每份 10 MiB、最多 3 份。

镜像默认 Central 进程将 `HOME` 设为持久数据卷 `/data`，因此以 profile UID/GID 运行时，官方录音 CLI 的私有状态可写且跨容器重建保留。原生部署仍使用原来的 HOME，媒体 sidecar 的命令与环境不受影响。第三方 CLI 继续自行管理凭据；可携带资料备份不会收录 `.config`、`.dws` 等厂商 HOME 文件，完整数据卷副本则可能包含它们，必须按私有授权资料保护。

复用旧 Docker 卷时，先在旧版本停止写入并完成离线备份、保留内容密钥与私有配置。旧镜像的 UID 1000 可能与新 profile 用户不一致。确认本 profile 数据/模型卷的所有使用者均已停止后，显式执行：

```sh
node scripts/mote.mjs migrate-storage-owner --profile prod --home /srv/mote/profiles
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
```

该命令仅递归调整 metadata 声明的数据卷与模型卷所有权，不启动中央、媒体或隧道，不修改 YAML 或资料内容；发现任何使用这些卷的运行容器会拒绝。请先备份，因为这是停机后的明确所有权迁移；普通 `start` 不替用户执行它。不支持远程 Docker / userns-remap 的边界仍适用。

SQLite 和 blob 应使用 NAS/服务器的本地块存储或本地 Docker 卷，避免多实例共享网络文件系统上的 WAL 数据库。当前是单实例、单 owner 节点。容器中的 loopback 指容器本身；外部模型服务应使用容器可达的 HTTPS 地址。

### 可选 Caddy HTTPS

在该环境 `mote.yaml` 设置 `server.tls.domain: mote.example.com`，换成自己的域名。DNS 指向服务器，服务器允许公网 80/443 到达，之后执行：

```sh
node scripts/mote.mjs tls --enable --profile prod --home /srv/mote/profiles
node scripts/mote.mjs start --profile prod --home /srv/mote/profiles
```

TLS overlay 使用固定 Caddy 2.11.4 Alpine 镜像；与中央在独立 Compose 网络中通信，证书保存在该 project 的 Caddy 卷中。Caddy 根据域名配置自动 HTTPS，见 [官方文档](https://caddyserver.com/docs/automatic-https)。该节点地址填为 `https://mote.example.com`，令牌单独填写。

已有反向代理可以保持 TLS overlay 关闭，将请求代理到 `127.0.0.1:47832`。`tls --disable` 只调整配置；已有 Caddy 容器需用该 profile 的 `compose -- down --remove-orphans` 后再 `start`，保留卷即可。自定义宿主端口可设置 `server.tls.httpPort`、`server.tls.httpsPort`，但公共 ACME 验证仍需正确转发到标准 80/443。项目不会修改 DNS、防火墙或购买域名。

旧 profile 不会被自动转换。配置改造本身不删除资料；当前 epoch 7 不能打开 epoch 6 的库，需要新的空数据目录。不要把旧 JSON/SQLite 设置作为新版本的覆盖来源。手改文件与设置页共用主 YAML；端口、目录、插件模块、媒体 worker 资源、TLS/Tunnel 启停仍需重启或对应明确 CLI 操作。

## 升级与回退

当前配置为YAML version 1，Central为backend epoch 7，Mac/Android本机格式4，便携JSON为version 2。MVP只支持当前格式；旧目录保留，程序不自动转换、清空或用旧配置覆盖当前设置。未来长期使用需要保留数据的升级方案。跨历史基线前先由对应旧版本停写并备份完整旧目录、凭据和密钥，再明确选择新目录；只有明确放弃旧资料才执行reset。

当前Central发布源码包，不提供签名更新清单或GHCR镜像。用独立目录构建源码（含connectors:prepare），或自行构建固定镜像，再执行同代部署切换；不能把保留的check-update/update签名机制当当前下载通道。组件独立版本，Central的server/web一起部署，客户端按协议范围判断，不要求版本号相等。

```sh
node scripts/mote.mjs upgrade --profile prod --home /srv/mote/profiles --release /srv/mote/releases/next
# Docker先准备明确的本地镜像，再选择--image mote-central:next
node scripts/mote.mjs rollback --profile prod --home /srv/mote/profiles --restore-data
```

upgrade先停该环境并生成一致快照，再切换代码/镜像和验证健康。准备失败且未改动资料时恢复原运行意图；切换开始后的失败保留快照与状态，不让旧代码自动打开不兼容库。rollback额外保留当前资料；升级后新增内容不在恢复后的活动仓库中，但保留在pre-rollback副本/原目录或卷，不自动删除。当前连接器凭据另作私有移交，游标按恢复规则重建。

launchd等自动管理须先停止接管，升级验收后恢复，避免迁移时自动重启写入。跨代回滚必须配套旧程序与完整旧备份。签名、不可变制品及客户端更新说明见[更新](updating.md)和[发布](releasing.md)。

## 备份、恢复和迁移

更换机器或恢复完整中央资料库（包括对话历史），应使用停库后的离线备份。设备本机副本和外部服务数据需另行备份；此备份不含令牌、模型凭据或内容加密密钥，使用过内容加密时须另存原密钥。备份按私密数据保管。

```sh
node scripts/mote.mjs stop --profile prod --home /srv/mote/profiles
node scripts/mote.mjs backup --profile prod --home /srv/mote/profiles --out /srv/mote-backups/mote-2026-09-13
```

CLI 复用 `scripts/backup.ts`：SQLite backup API 生成一致数据库，只对 epoch 7 的完整当前库按资产目录复制截图与文件原件（`files/objects/` 分片，仅 `.plain` / `.aes` 后缀），包含当前 `source-archive/` 批次、索引与校验；不读取旧 `blobs/`、`files/<hash>` 或旧内容包装，写 SHA-256 manifest。不复制导入脚本和临时工作目录；未完成的导入在备份中标记为需要重新分析，保留已经入库的证据 ID。恢复到新目录后按新仓库位置重建输入路径，重新生成预览并确认；已保存的记录去重，Memory 仍按实际新增证据处理。原生 `server.pid` 活跃时拒绝备份；Docker 必须已停止，先复制该环境卷到私有临时目录再备份，因此需预留约两份仓库的临时/备份磁盘空间。临时复制会在结束后清理。

在另一台机器初始化本代新的空环境，然后恢复本代完整离线备份：

```sh
node scripts/mote.mjs init --profile prod --home /srv/mote-new/profiles --runtime docker
# 如备份含密文，在新YAML设置原 storage.dataKey，或单独恢复原 content-key
node scripts/mote.mjs restore --profile prod --home /srv/mote-new/profiles --from /srv/mote-backups/mote-2026-09-13
node scripts/mote.mjs start --profile prod --home /srv/mote-new/profiles
```

恢复会验证当前备份 manifest、文件类型、所有 SHA-256，并二次校验复制结果。启动仍要求数据库 epoch 7，不能通过恢复旧快照绕过格式边界。活动服务、非空数据目录/卷都会拒绝。Docker 恢复需已准备好 profile 选择的本地镜像。恢复不复制 `server.pid`、令牌、模型 API key 或数据加密 key；新节点使用自己的访问令牌。验证记录数量、原文、图片和时间线，再修改客户端 URL/令牌。保留旧节点备份直到迁移验收完成。

内容加密默认关闭，`storage.dataKey` 本身不启用加密；主 YAML 的 `storage.contentEncryptionEnabled` 与开发者页面共用同一设置，校验提交成功后立即影响后续写入，无需重启，也不重写已有对象。`storage.dataKey` 是可选的 64 位十六进制 AES-256-GCM 图片及文件原件密钥；显式开启且未配置时会生成资料库私有的 `content-key` 文件。存在密文时必须单独备份原环境密钥或该文件，离线内容备份不携带密钥。解析文本、元数据与导入工作产物保持明文。尚有密文时不要更换原密钥；丢失密钥不能通过重新下载模型或更换访问令牌恢复内容。已有内容可在开发者页面一次性批量解密，详见[内容存储设置](content-storage.md)。

### 进阶：JSON 便携归档

中央界面的 JSON 便携归档只适用于满足当前导出条件的小资料库，不包含对话历史。库中存在文件归档、图片处理成果或来源处理档案时，当前实现会拒绝导出；JSON 不覆盖这些资料。当前导入只接受完整 version 2 包；MVP 阶段不自动转换旧格式。 JSON 导出不能替代完整离线备份，导出文件须按私密数据保管。

## 验证

部署测试使用临时profile、生成数据和独立loopback进程验证健康、身份隔离、备份/恢复与切换。`test:profiles`、`test:profiles:container`和更新测试是按需入口；Docker/NAS权限、公网证书、系统服务和实际目标机器必须各自验证。已有历史通过数量不代表当前部署已验收，见[测试规范](testing.zh-CN.md)。
