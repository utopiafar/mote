# 开发与测试环境隔离

开发默认使用 dev 中央 47842，测试使用 test 中央 47852；正式部署 prod 使用 47832。不要用正式中央的配置、令牌、数据库、App profile 或实际屏幕做自动化测试。所有验证素材应由程序生成。

## 首次准备

```sh
npm ci
npm run build:libs
npm run build -w @mote/server -w @mote/web
node scripts/mote.mjs init --profile dev
node scripts/mote.mjs init --profile test
```

每个环境都有自己的 `.mote/profiles/<name>/mote.env`、`data/`、`logs/`、`backups/` 和 `file-sync/`。`file-sync/` 在第一次明确文件导入时创建。初始化不读取根 `.env`，不继承模型 key，不复制正式资料。模型字段初始为空，可以先验证存储、UI 与同步，再在对应私有文件中配置测试模型。

CLI 不自动初始化，已有 profile 不会被覆盖；重复 init 报错后直接使用已有配置即可。`--home /absolute/test-profiles` 可创建另一整套环境，Docker project 与 volume 也随路径隔离。不要把私有环境文件加入 Git。

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

Mac 的命名 profile 使用独立的用户数据目录、队列、草稿和连接设置。`desktop:dev` 将所选中央 URL 与令牌交给主进程；只对新 profile 引导连接，已有设置不会被后台替换。首次开始截图仍需要用户在 App 中设置并授权；这些命令本身不会采集屏幕。未命名 App 的 default profile 使用原 Electron 用户数据路径，旧存储仍受格式 3 拒绝边界约束，详见 [电脑端说明](desktop.md)。

运行 test 环境的同一套热重载界面：

```sh
node scripts/mote.mjs exec --profile test -- npm run dev:workspace
```

test Web 默认 5174。Vite 的代理读取显式 dev/test 环境的中央端口；没有所选环境或端口为 47832 时会拒绝启动。浏览器 bundle 不包含 `MOTE_*` 配置或令牌。`dev:workspace` 是内部命令，应由 `mote exec` 提供环境。

## CLI 工具使用同一连接

任意已有工具都可在所选环境执行：

```sh
node scripts/mote.mjs exec --profile dev -- npm run demo
node scripts/mote.mjs exec --profile dev -- npm run import:files -- --root /absolute/selected-notes --dry-run
node scripts/mote.mjs exec --profile dev -- npm run import:files -- --root /absolute/selected-notes
node scripts/mote.mjs exec --profile test -- npm run import:files -- --root /absolute/selected-notes
```

导入脚本只读取用户明确选择的 UTF-8 文件夹，默认 `.md,.txt`，单文件不超过 100 KB，不递归隐藏目录或符号链接。加 `--extensions .md,.txt,.csv` 明确类型；`--watch` 每 30 秒检查更改。文件状态基于实际所选节点 URL，落在该 profile 的 `file-sync/`，所以同一个源目录可以分别导入 dev 与 test；成功 ACK 后同环境再次运行会跳过不变文件。原文删除不删除中央历史。

`exec` 清除继承的 `MOTE_*` 与 `COMPOSE_*`，再加载唯一 profile；显式 `MOTE_ENV_FILE` 存在时只读所选文件。直接运行 `npm start` / `npm run import:files` 只使用进程环境，读取文件必须显式设置 `MOTE_ENV_FILE`；根 `.env` 不再自动加载。API/model 密钥不要写进命令参数、示例文件或公开诊断。

## Android 开发连接

```sh
adb reverse tcp:47842 tcp:47842
```

开发版 Android 填 `http://127.0.0.1:47842`，并显式允许调试 HTTP。开发 APK 使用独立 application ID 和本地存储，与日常版本分开；实际 Gradle 命令及 HyperOS 设备设置见 [Android 说明](android.md)。手机 loopback 默认指手机本身，USB reverse 断开后待传事件应保留，恢复网络再重试。跨设备长期部署使用 HTTPS。

## 验证命令

<a id="pr-check-scope"></a>

### PR 检查范围

PR 前使用本地与 CI 共用的依赖图和构建输入规则选择检查范围：

```sh
npm run check:affected -- --dry-run
npm run check:affected
# 指定 PR 基线；默认 origin/main，先获取最新基线
npm run check:affected -- --base origin/main
# 只核对已提交范围，适用于 CI 或明确提交的验证
npm run check:affected -- --base origin/main --head HEAD --dry-run
```

默认范围包含与基线共同祖先相比的已提交改动，以及当前暂存、未暂存和未被忽略的未跟踪文件。移动文件同时检查原位置与新位置，避免把移入文档目录的运行代码误判为纯文档。基线无法解析时命令失败，不会当作无改动跳过检查。`--dry-run` 只展示检查计划，不代表检查通过。

| 改动场景 | 自动检查 | 按实际行为补充 |
| --- | --- | --- |
| 纯文档、根 AGENTS.md、各语言 README、历史发布说明 | 不构建或测试应用；人工检查格式、语法、链接和必要的渲染 | 运行时 prompt、配置及 workspace 内资源按代码输入处理 |
| Central / Web / Agent / 中央插件 | `check:i18n`、`check:central` | 对应浏览器交互、API、导入/查询/Memory 等流程 |
| macOS / diagnostics | `check:i18n`、`check:desktop` | Desktop 构建、受影响 UI；原生助手/依赖/打包变更在 macOS 编译；权限与系统生命周期单独验收 |
| Android | `check:i18n`、发布工具回归、Gradle debug 单测（包含测试依赖的代码编译） | 对应 variant 构建、lint、instrumentation；后台与权限变化单独真机验收 |
| 共享包或协议 | 检查所有受影响消费者；目前 shared / protocol 选择三端 | 跨端契约与连接/同步生成 fixture；不要把检查范围当作发布范围 |
| 单端发布 workflow | 对应端检查及发布工具回归 | 对应 workflow 的构建、签名和产物身份检查；无关端不构建 |
| 检查范围选择器及本地检查入口 | 发布工具回归，包含本地 CLI 的隔离 Git fixture | 无需应用构建 |
| 通用发布工具、公共 workflow、根配置/lockfile、未知构建输入 | 保守检查全部消费者 | 相关部署、容器、依赖安装或发布链路 |

三端均受影响时，本地入口运行 `check:local` 和 Android 单测；只选择部分组件时运行对应组件命令。组件命令已含发布工具回归，不重复执行。`check:local` 是全量 TypeScript 集成检查，不包含 Android 测试、Desktop 原生编译、浏览器 E2E、真机或真实模型验收。新增文案需检查翻译和 Android catalog 同步；当前 shared 目录采用保守的整包消费者范围，因此修改共享翻译目录仍会选择三端。

选择器不能从路径证明运行时兼容性。例如 Central 即使没有改客户端文件，若改变了客户端使用的 API、授权或同步契约，仍应补测受影响客户端。反之，内部实现、网页样式或普通服务端修复不默认要求 macOS 编译和单测。仅变更文案通常只需翻译与显示检查；新增翻译目录之外的变化按实际输入范围处理。

追加修改后重跑受影响检查。仅修改 PR 标题/描述或补充验证说明可以复用相同代码和依赖状态的结果；代码、依赖、基线合并或环境变化使相关结果失效。全量 TypeScript 集成检查保留用于跨模块重构最终验收或影响范围不明的情况，不再作为每次单端 PR 更新的固定门槛。发布前始终验证发布组件的版本、构建与产物，以及相关安装/升级流程。

这次规则调整保留（KEEP）生成 fixture、回归场景、如实报告验证和协议消费者检查；改变（CHANGE）PR 本地检查按影响范围选择；移除（REMOVE）所有非文档 PR/更新强制全量 TS 检查；例外（EXCEPTION）根配置与未知输入继续保守扩大，跨端运行时行为需要额外验证；未知（UNKNOWN）CI 是否启用及设备/模型环境能力需实际核实，不能由选择器推断。历史验证报告保留当时执行记录，不改写成新的验证结果。

```sh
npm run typecheck
npm test
npm run test:privacy
npm run test:e2e
npm run test:profiles
```

`test:profiles` 使用系统临时目录、随机 loopback 端口和生成的 2×2 PNG，实际创建两套 dev/test 中央 Node 子进程。验证跨令牌拒绝、数据库分离、文件导入各自确认、备份 SHA、加密图片恢复、升级回退、原生日志隐私及轮转、监督进程异常结束后的接管；只清理本次创建的进程与目录。不会使用正式 47832，也不调用外部模型。

```sh
# 需要 Docker Engine 与 Compose 2.30+
npm run test:container
npm run test:profiles:container
```

第二个脚本实际构建本仓库镜像、启动隔离 Compose project，验证命名卷重建、停止后备份、空卷恢复、镜像切换回退、Caddy 配置解析。临时镜像/容器/卷以测试唯一标识命名；不会 publish 或全局 prune。脚本已加入 GitHub Linux CI。本机没有 Docker 时应明确记录未执行，不能将 TypeScript、配置静态检查或之前版本的 CI 结果当作本次容器验证。

真实 DeepSeek / Qwen 调用与实体手机测试需单独记录所用版本、输入是否合成、耗时与失败行为。macOS 权限、HyperOS 后台恢复、公网 HTTPS、launchd 登录/重启行为均不能由上述 fixture 代替。

## 调试与分享诊断

每个中央环境默认开启有上限的结构化诊断，`MOTE_DEBUG=0`。需要调试时只修改正在测试的 `mote.env`，然后重启对应环境。中央界面的运行诊断、Mac 和 Android 的支持包用于查看版本、连接类别、队列状态、数值指标与固定事件。分享前仍应查看导出内容；不要改为转发原始截图、OCR、随手记、模型 prompt 或 token。

原生 `logs/central.log` 默认只保存固定监督事件；未知 SDK/runtime 输出只保存类型与字节数。每份日志最多 2 MiB、3 份，支持包与中央结构化日志各有自身边界。完整的状态、停止、迁移和回退命令见 [部署说明](deployment.md)。

## 独立版本与发布

保留 npm workspaces。Central（server + web）、macOS、Android 分别维护版本和标签；改动一个端只发布该端。共享依赖和协议改动需要检查所有受影响端，但不会自动生成其他端的发布。操作、发布产物和迁移说明见 [发布流程](releasing.md) 与 [独立发布架构](release-architecture.md)。
