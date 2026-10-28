# 开发与测试环境隔离

开发默认使用 dev 中央 47842，测试使用 test 中央 47852；正式部署 prod 使用 47832。不要用正式中央的配置、令牌、数据库、App profile 或实际屏幕做自动化测试。所有验证素材应由程序生成。

## 首次准备

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
npm run connectors:prepare
node scripts/mote.mjs init --profile dev
node scripts/mote.mjs init --profile test
```

每个环境都有自己的 `.mote/profiles/<name>/mote.yaml`、`data/`、`logs/`、`backups/` 和 `file-sync/`。`file-sync/` 在第一次明确文件导入时创建。初始化不读取根 `.env`，不继承模型 key，不复制正式资料。默认模型预设使用 Codex；仅验证存储、UI 与同步时，可在该私有 YAML 将 `models.deployment.model` 留空。

CLI 不自动初始化，已有 profile 不会被覆盖；重复 init 报错后直接使用已有配置即可。`--home /absolute/test-profiles` 可创建另一整套环境，Docker project 与 volume 也随路径隔离。不要把私有 YAML 加入 Git。旧 `mote.env` profile 会被拒绝；先停止旧版本、保留原目录，再离线手工填写新 YAML，CLI 不自动迁移。

## 日常开发

已构建中央服务并配置命名 Tunnel 的本机 DEV，可用一个命令前台运行两者：

```sh
npm run up
```

该命令使用 DEV 中已有的 Tunnel 凭据并自动启用隧道，先启动中央服务再启动 cloudflared；按 Ctrl+C 同时停止两者，任一进程退出也会停止另一个。已有中央或隧道实例时会拒绝重复启动。它不执行构建、不启动屏幕采集，也不创建 Cloudflare 域名路由。中央日志仍在 `.mote/profiles/dev/logs/central.log`；cloudflared 原始输出仍由运行器抑制。其他原生 profile 可使用 `node scripts/mote.mjs run-all --profile NAME`。

```sh
npm run dev
```

此命令先构建共享库，再通过 `mote exec --profile dev` 启动 API 热重载和 Vite。API 是所选 dev 端口，Web 默认 `http://localhost:5173`。如果先前用 CLI 后台启动过 dev 中央，先 `node scripts/mote.mjs stop --profile dev`，避免两个进程争用同一个环境。

```sh
# 构建完成后启动独立 Mac App，绑定独立 dev profile
npm run build -w @mote/desktop
npm run desktop:dev
# 获取 dev 访问令牌，只填入自己的测试客户端
node scripts/mote.mjs token --profile dev
```

Mac 的命名 profile 使用独立的用户数据目录、队列、草稿和连接设置。`desktop:dev` 将所选中央 URL 与令牌交给主进程；只对新 profile 引导连接，已有设置不会被后台替换。首次开始截图仍需要用户在 App 中设置并授权；这些命令本身不会采集屏幕。未命名 App 的 default profile 使用原 Electron 用户数据路径，旧存储仍受格式 4 拒绝边界约束，详见 [电脑端说明](desktop.md)。

运行 test 环境的同一套热重载界面：

```sh
node scripts/mote.mjs exec --profile test -- npm run dev:workspace
```

test Web 默认 5174。Vite 的代理读取 `MOTE_CONFIG_FILE` 选择的 dev/test YAML 中 `server.port`；没有所选环境或端口为 47832 时会拒绝启动。浏览器 bundle 不包含 `MOTE_*` 配置或令牌。`dev:workspace` 是内部命令，应由 `mote exec` 提供环境。

## CLI 工具使用同一连接

任意已有工具都可在所选环境执行：

```sh
node scripts/mote.mjs exec --profile dev -- npm run demo
node scripts/mote.mjs exec --profile dev -- npm run import:files -- --root /absolute/selected-notes --dry-run
node scripts/mote.mjs exec --profile dev -- npm run import:files -- --root /absolute/selected-notes
node scripts/mote.mjs exec --profile test -- npm run import:files -- --root /absolute/selected-notes
```

导入脚本只读取用户明确选择的 UTF-8 文件夹，默认 `.md,.txt`，单文件不超过 100 KB，不递归隐藏目录或符号链接。加 `--extensions .md,.txt,.csv` 明确类型；`--watch` 每 30 秒检查更改。文件状态基于实际所选节点 URL，落在该 profile 的 `file-sync/`，所以同一个源目录可以分别导入 dev 与 test；成功 ACK 后同环境再次运行会跳过不变文件。原文删除不删除中央历史。

`exec` 清除继承的普通 `MOTE_*` 与 `COMPOSE_*` 参数，设置所选 `MOTE_CONFIG_FILE`，并从同一 YAML 派生设备/工具连接 URL 与令牌。普通进程环境不能覆盖服务端 YAML；只有声明的敏感字段支持 `${SECRET_NAME}` 引用。直接运行 `npm start` 默认读取工作目录的 `mote.yaml`，或显式设置 `MOTE_CONFIG_FILE=/absolute/mote.yaml`；导入工具同样支持该文件选择。`MOTE_ENV_FILE` 已拒绝，根 `.env` 不参与加载。API/model 密钥不要写进命令参数、示例文件或公开诊断。

## Android 开发连接

```sh
adb reverse tcp:47842 tcp:47842
```

开发版 Android 填 `http://127.0.0.1:47842`，并显式允许调试 HTTP。开发 APK 使用独立 application ID 和本地存储，与日常版本分开；实际 Gradle 命令及 HyperOS 设备设置见 [Android 说明](android.md)。手机 loopback 默认指手机本身，USB reverse 断开后待传事件应保留，恢复网络再重试。跨设备长期部署使用 HTTPS。

## 验证与审查

开发时使用[定向测试](testing.md#daily-feedback)，尽早接通跨模块真实路径；计划收敛后再完成候选检查。检查范围、日志和风险分级见 [testing](testing.md)，自动 PR 检查见 [CI](ci.md)。

<a id="background-testing"></a>
后台 UI、生成素材和模拟器操作见[后台测试](testing.md#background-testing)。

<a id="pr-check-scope"></a>
受影响候选计划和结果复用见[候选检查](testing.md#early-integration-and-candidate-checks)。对话结束、交接和 Draft PR 更新不扩大测试范围。

## 调试与分享诊断

每个中央环境默认开启有上限的结构化诊断。精确的 `dev` profile 在省略配置时启用 debug，其他 profile 默认关闭；显式 `false` 或 `silent` 保持有效。需要调试时只修改正在测试的 `mote.yaml`；enabled/debug/traceEnabled/level 经校验热应用，日志目录与容量参数需要重启。中央界面的运行诊断、Mac 和 Android 的支持包用于查看版本、连接类别、队列状态、数值指标与固定事件。分享前仍应查看导出内容；不要改为转发原始截图、OCR、随手记、模型 prompt 或 token。

原生 `logs/central.log` 默认只保存固定监督事件；未知 SDK/runtime 输出只保存类型与字节数。新 DEV 的 YAML 省略 `diagnostics.maxBytes`，每份最多 100 MiB、3 份；结构化 `central.N.ndjson` 与监督日志分别轮转，各最多 300 MiB。其它 profile 保留每份 2 MiB、3 份。已有 DEV 的显式数值保持不变，主动采用默认值见 [部署说明](deployment.md#dev-log-retention)。支持包、内存事件数和单条日志仍各有自身边界。

## 独立版本与发布

保留 npm workspaces。Central（server + web）、macOS、Android 分别维护版本和标签；改动一个端只发布该端。共享依赖和协议改动需要检查所有受影响端，但不会自动生成其他端的发布。操作、发布产物和迁移说明见 [发布流程](releasing.md) 与 [独立发布架构](release-architecture.md)。
