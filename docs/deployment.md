# 独立中央节点与迁移

中央节点包含 HTTP API、归档/索引数据库、Agent 运行时和 Web 静态文件；与采集程序没有进程或文件路径耦合。先在当前 Mac 运行，后续把同一服务部署到 Linux/NAS/云服务器，只需迁移数据、配置并修改采集器节点 URL。

## 本机

Node.js 24 LTS，仓库根目录执行：

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
npm start
```

首次生成 `data/access-token`，将内容填到电脑端和安卓端。Mac App 的“中央仓库”直接打开节点界面；管理时也可访问 `http://127.0.0.1:47832`。运行不会自动采集。服务默认只监听 loopback。只部署中央节点不需要千问权重、CMake 或屏幕录制权限。

根目录 `.env` 用于模型配置。`MOTE_DATA_DIR` 相对**仓库根目录**解析，也可使用绝对路径，容器中固定 `/data`。不要在已有仓库改变 `MOTE_DATA_KEY`，已有加密仓库会拒绝不同的 key。

开发：`npm run dev` 同时启动 API 47832 和 Vite 5173。`npm run desktop` 启动构建后的电脑采集器。

## 手机连接当前电脑

最方便的本地验证是 USB：安装 APK 后运行 `adb reverse tcp:47832 tcp:47832`，Android 节点填 `http://127.0.0.1:47832`，勾选 debug APK 的私有网络 HTTP。ADB reverse 断开后队列会保留并重试，生产使用 HTTPS。

局域网连接：把 `MOTE_HOST=0.0.0.0` 配到 `.env` 并重启，手机填电脑的 LAN IP，debug APK 显式勾选局域网 HTTP；需要系统防火墙放行。普通 HTTP 是开发便利，含图片和令牌的通信没有传输加密。自部署长期使用应配 HTTPS。

## Docker / NAS

```sh
docker compose up -d --build
docker compose exec mote cat /data/access-token
```

默认端口只映射服务器 loopback，适合放在 Caddy/Nginx 的 HTTPS 反向代理之后；TLS 代理与 Docker 同主机时转发到 `127.0.0.1:47832`。域名示例：

```caddyfile
mote.example.com {
    reverse_proxy 127.0.0.1:47832
}
```

使用真实域名替换示例。Caddy HTTPS 证书签发需要域名解析和外部 80/443 可达。本项目不替你注册域名或改防火墙。

卷 `mote-data` 包含 `mote.sqlite`、WAL、`blobs/` 和访问令牌。**SQLite 数据库应放本机块存储或 Docker 本地卷，不要多实例共享网络文件系统上的 WAL 数据库。** NAS 可以运行容器并把卷映射到其本地存储。当前是单实例、单 owner 节点；后续可以在 Store 接口下替换 PostgreSQL/对象存储。

`MOTE_MODEL_BASE_URL` 的 loopback 指容器内部；连接主机的模型需要可达地址和 API key。免密本地模式仅允许真正 loopback，默认禁用。

本机未安装 Docker；已在 [GitHub Linux CI](https://github.com/utopiafar/mote/actions/runs/34735449052) 实际构建本 Dockerfile，验证健康检查、认证、随手记同步及容器重启/重建后的命名卷恢复。可在装有 Docker 的环境运行 `npm run test:container` 复现；脚本只创建并清理本次合成测试的容器、卷和镜像。目标 NAS 卷权限、公网 HTTPS 与 Compose 在目标主机的配置仍需现场验收。

## 数据迁移

小资料库：Web → 资料库 → 导出 JSON。在新的空节点导入；保留事件 ID、发生时间、原始到达时间和图片校验和，相同事件再次导入不会重复。导出的 JSON **包含可读文字和图片**，不含 API key 或访问令牌；按私密备份保存。超过默认 64 MiB 或 20,000 条的 HTTP 归档请用离线备份。

完整仓库：先停止服务，再执行：

```sh
npm run backup -- --data ./data --out /absolute/backup/mote-2026-09-13
```

脚本拒绝在服务仍运行时备份，使用 SQLite backup API 生成一致数据库，复制引用中的 blob，并写 SHA-256 manifest。恢复时，把备份中的 `mote.sqlite` 和 `blobs` 放入空的数据目录，保持原 `MOTE_DATA_KEY`（如有），配置新访问令牌，启动新节点。不复制 `server.pid`。先验证图片读取/时间线/记录数量，再调整所有端点地址。不要删除旧仓库，直到验收通过。

镜像加密：设置 64 位十六进制 `MOTE_DATA_KEY`，blob 使用 AES-256-GCM。OCR/元数据仍在 SQLite 中，应使用 FileVault/LUKS 或加密 NAS 数据卷；此配置不等同全库加密。key 必须单独备份，丢失无法恢复图片。

`MOTE_RETENTION_DAYS=0` 默认保留历史；正数明确启用自动删除旧事件及不再被引用的 blob，关联洞察同时失效。容量上限触发后服务返回 507，端点继续保留未确认队列，不会默删待上传资料。

## NAS / 本地文件入口

只对用户明确选择的文件夹读取，支持 UTF-8 文本/Markdown；不递归链接或隐藏目录，不自动读取 NAS 的所有文件：

```sh
npm run import:files -- --root /Volumes/NAS/selected-notes --dry-run
npm run import:files -- --root /Volumes/NAS/selected-notes --watch
```

用 `--extensions .md,.txt,.csv` 明确扩展类型；单文件限 100 KB。每次成功确认后原子保存本地同步状态，修改版本生成新证据。原文件删除不删除历史档案。PDF/Office 解析、大文件分块、源端 pull/OAuth 连接器为后续扩展，不能把该文本入口视作已支持所有文件格式。

外部消费者可使用 `/api/updates?cursor=0` 按中央到达顺序增量读取 upsert/delete，包括离线迟到数据；事件列表则按 `capturedAt` 展示。保留 `nextCursor` 以继续消费。
