# Mote 电脑采集器

此工作区交付 macOS Electron 采集程序、Swift 本地助手、中文配置界面和持久队列。中央节点是独立服务：本期可以运行在同一台 Mac，之后只需迁移中央仓库并修改节点地址，无需更换端点协议。

## 构建与运行

最低 macOS 13.3（当前验证为 Apple Silicon Mac）。构建需要 Node.js 24、npm 11、CMake 3.22+ 和 Apple Command Line Tools（`xcode-select --install`）。在仓库根目录执行：

```sh
npm install
npm run models:setup
npm run build -w @mote/local-inference
npm run build -w @mote/diagnostics
npm run build -w @mote/desktop
npm run start -w @mote/desktop
```

开发迭代可用 `npm run dev -w @mote/desktop`。构建会编译 TypeScript、复制界面资源，用 `swiftc` 生成当前 Mac 架构的 `native/bin/mote-helper`，并从固定 `vendor/llama.cpp` 编译 CPU 静态链接的 `native/bin/mote-qwen`。首次原生编译需要几分钟；可用 `MOTE_CMAKE`、`MOTE_NINJA`、`MOTE_BUILD_JOBS` 指定构建工具与并发度。不需要辅助功能权限，不查询或存储窗口标题。

生成可运行应用目录：

```sh
npm run package -w @mote/desktop
```

当前 0.3.0 安装包为 `apps/desktop/release/mote-desktop-macos-arm64-0.3.0.zip`，解压后即是独立 Mac App。应用目录在 `apps/desktop/release/mac-arm64/Mote Collector.app`（Intel 为 `mac/`）。默认使用 ad-hoc 签名，不调用本机个人开发证书；这是本机测试构建。发行版仍需显式设置 Apple Developer ID 签名、公证和对应架构构建。生成安装镜像可在 `apps/desktop` 目录执行 `npx electron-builder --mac dmg`。

0.3.0 ZIP 大小为 112,480,649 字节，SHA-256：`7dcad06c29775e86863ab2c0c53794385fd93c1f2026ca5a2501985afc806206`。

Windows/Linux 可编译 TypeScript、运行界面和队列逻辑，但采集按钮被禁用。MVP 尚未接入其可靠前台/可见窗口身份与 OCR，不能以无过滤截图代替。

## 环境隔离与启动 profile

不设置 `MOTE_PROFILE` / `--profile` 时保持 **legacy**：直接使用之前的 Electron `userData`，不搬移、不复制、不清空已有内容。首次默认节点仍为 47832，已有设置优先。开发命令 `npm run desktop:dev` 使用独立 dev；直接工作区 `npm run dev -w @mote/desktop` 也显式选 dev。

命名 profile 使用 `<原 userData>-profiles/<短名>`，在 Electron 实例锁和 session 创建之前设置；dev 默认端口 47842，test 为 47852，prod 为 47832，其他命名环境为 47842。短名仅接受 1–32 个小写字母、数字、下划线和连字符。可同时运行不同 profile，同名进程只能有一个。窗口顶部、标题和菜单栏显示当前 profile，界面显示实际数据目录。

```sh
# 由统一启动器读取选定环境，注入匹配的节点与令牌：
node scripts/mote.mjs exec --profile dev -- npm run start -w @mote/desktop
# 显式保留日常旧目录：
npm run start -w @mote/desktop -- --profile=legacy
# 打包应用可以指定环境，不需要浏览器：
open -n "apps/desktop/release/mac-arm64/Mote Collector.app" --args --profile=dev
```

`--profile` 优先于 `MOTE_PROFILE`。命名环境仅在 `MOTE_PROFILE` 精确匹配时才接受启动器注入的 `MOTE_URL` / `MOTE_TOKEN`；缺 profile 的 ambient 节点/令牌或切换 CLI profile 后遗留的凭据均不继承。它们只用于新环境首次配置，已有节点和已加密凭据始终成对保留。`MOTE_ENV_FILE` 由统一启动器读取，采集器不另行寻找 `.env`。非 prod 命名环境的自动配置拒绝回环 47832；确需连接另一节点，用户仍可在原生设置中显式填写地址与新令牌。

每个 profile 独立保存设备 UUID、Keychain 加密令牌、原生草稿、队列、模型、数值/事件诊断，以及中央窗口 Web session。新环境不自动复制模型或用户资料，可手动导入公开模型。支持包不跨环境读取。普通启动不会自动把 dev 变成日常环境；Finder 无参数启动仍进 legacy。

命名 profile 不注册系统默认登录项，避免 macOS 丢失启动参数后进入 legacy；界面给出提示。需使用明确带 profile 的启动命令。legacy 的原登录项开关继续保留。该限制依据 [Electron 登录项文档](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings)：`args` 选项仅支持 Windows。本轮没有更改本机真实登录项。

## 首次使用

1. 启动中央节点，在采集器填写节点地址与访问令牌。legacy 默认是 `http://127.0.0.1:47832`，dev 是 47842；远程只能使用 HTTPS，且令牌至少 32 字符。令牌通过 Electron `safeStorage` 交给 macOS Keychain 加密，前端只收到是否已配置，无法读取已有令牌。
2. 配置排除应用、遮挡区域、空闲阈值和队列上限，然后保存。排除 ID 可用 `osascript -e 'id of app "应用名"'` 查询。规则是用户指定的精确 Bundle ID，不做语义猜测。
3. 默认开启千问本地视觉审查，先点击「下载 / 继续下载」或导入对应 `model.gguf` 与 `mmproj.gguf`（可一次选两个）。两个文件都通过 SHA-256 后才能开始。初期模型约 703 MiB，不随 App 重复捆绑；下载仅传输公开模型文件，不发送截图。
4. 点击「开始采集」。首次使用需在系统设置的「隐私与安全性 → 屏幕与系统音频录制 / 屏幕录制」允许 Mote。开发模式权限可能显示 Electron。macOS 要求重启应用时，授权后退出并重新打开。
5. 确认菜单栏状态、待上传数量和最近采样时间，点击「打开中央仓库」，在独立 Mac 窗口查看时间线、查询和随手记。首次采样及应用切换后的首次采样时长为 0；连续两次同一前台应用才累计两次采样之间、最多一个采样间隔的时长。

「停止采集」立即取消当前处理、释放本地模型进程并停止新采样，已入队记录继续上传。「关闭窗口」隐藏到菜单栏，不退出程序。彻底停止采集与网络传输请在菜单栏选择「退出 Mote」。登录自动打开是可选项，应用重新启动后始终等待手动开始采集；已有脱敏队列自动恢复上传。

## 隐私与采样流水线

每个周期执行以下顺序：

1. 检查锁屏、休眠、系统空闲时间、屏幕权限和队列上限。锁屏与休眠始终暂停；默认连续空闲 300 秒后暂停，可设为 0 关闭空闲检测。
2. Swift 使用 AppKit 获取前台 Bundle ID，并枚举主屏范围内、非透明且非背景层的屏幕窗口。任何可识别窗口属于排除列表时，跳过整张截图。有排除配置且普通应用层窗口无法识别时也跳过。
3. 在内存中采集主屏，最长边默认 1600 像素，可在开发者设置中调整为 640–2560。再次读取前台与可见窗口身份；身份变化或命中排除规则时丢弃。
4. 对用户配置区域进行黑色遮挡。坐标是相对主屏的 `x, y, width, height`，范围 0–1，边界向外取整。原始图像从不写入临时文件或上传中央节点。
5. 默认先将遮挡图在内存缩至最大边 512（可配 256–1024），通过匿名管道交给独立 `mote-qwen` 进程。千问 GGUF + 视觉投影按你的策略返回严格 JSON；禁止、超时、崩溃、生成未结束或格式错误都跳过。没有概率阈值和语义关键词规则。
6. 如配置本地隐私模型，将经过固定遮挡的 JPEG 发到明确配置的回环服务。拒绝、超时、失败、格式错误都丢弃本次采样；通过后执行模型返回的额外遮挡。
7. 最终 JPEG（默认质量 75，可配 40–95）通过 stdin 交给 Apple Vision 做中英文 OCR。OCR 只读最终遮挡图；启用 OCR 后执行失败会跳过采样。关闭 OCR 时仍会归档图像，但本期中央 Agent 主要读取 OCR 与应用元数据，图像中的文字不会自动进入检索。
8. 将最终图像及元数据原子写入本地队列，再后台上传。

固定区域示例（右上角 30% × 15%）：

```json
[{ "x": 0.7, "y": 0, "width": 0.3, "height": 0.15 }]
```

应用排除不等于万能隐私检测：系统通知可能由系统进程承载，无法从窗口 owner 推断原应用；窗口枚举与截图也无法构成操作系统级原子快照。最保守的使用方式是关闭敏感通知、配置其位置遮挡，并在敏感操作前停止采集。窗口枚举可能保守地报告被其他窗口遮住的应用，导致整帧跳过。内置千问默认识别露骨内容并整图过滤；它不会自动定位所有个人信息或替代遮挡服务。模型判断存在误拦和漏检，不能视为隐私保证。

采样数据是观察证据，不是执行指令。电脑端只负责明确配置的过滤、传输和时间测量；主题理解、任务识别和检索工具选择由中央 Agent 完成，不在端点写关键词路由。

## 千问离线视觉审查

与 Android 共用 `models/qwen-manifest.json`、`review-policy.txt`、`review-system.txt` 和 `review-grammar.gbnf`。模型为 Qwen3.5-0.8B Q4_K_M + F16 视觉投影，两文件总计 737,504,352 字节。默认国内 ModelScope 固定版本优先，失败自动回退 Hugging Face；也可选择单个来源，或提供包含固定 `model.gguf` 和 `mmproj.gguf` 的自定义 HTTPS 目录（NAS 等）。文件分别按固定大小和 SHA-256 验证，取消后保留断点。应用也支持 SHA 匹配的单文件或双文件离线导入，不接受任意替换权重。

运行采用固定 llama.cpp `1744c6bde8d687ce9774b3b54e688eee0bfdf5b7` 的 CPU 后端，默认 2 线程、60 秒超时、最多 256 生成 token。当前未启用 GPU；模型在独立常驻进程内复用，避免每帧加载。超时、主动停止或原生进程崩溃会终止进程并丢弃该帧，下次采样重新启动。重载按钮会回收进程并重新检查双模型。原始像素、模型输出均不写磁盘或日志；诊断仅保留是否通过、次数、token 数和耗时。

审查策略可由用户编辑以开展其他视觉过滤任务。共享系统提示把图像内文字设为不可信资料，并明确 `allow:true` 表示符合策略、`allow:false` 表示违反策略。生成语法约束 JSON（先 reason，再 allow，最后可选 labels），完成后额外校验类型、长度与 EOS。解析错误、非 JSON、额外字段和 token 截断均拒绝保存。程序绝不根据 reason 文本猜测或反转布尔结果。

## Mac 中央窗口与随手记

同一个可安装 Mac App 提供「采集与随手记」控制台和独立「中央仓库」窗口，不需要系统浏览器。中央节点仍是独立服务，不在 App 内隐式启动。窗口加载已配置节点的前端；迁移时保存新地址与令牌，已有窗口关闭，重新打开使用新节点。

中央窗口开启 sandbox / contextIsolation / webSecurity，禁用 Node、WebView、新窗口、跨源请求与跨源导航。窗口加载中的重复打开请求合并；窗口关闭后持久 session 保留草稿但禁止所有网络请求，清除认证能力和下载监听。真实令牌只在主进程，且仅注入该窗口主 frame、固定 origin 的 `/api/*` 请求；中央网页的会话只得到非秘密认证标记，URL 没有令牌。每个 origin 使用独立持久 session，Web 草稿与离线随手记在关窗或重启后保留，不会串到另一个节点。

控制台「随手记」可以在采集停止、未下载模型或断网时保存。输入时自动把草稿写入本机私有目录，关闭或重启可恢复。提交前先原子保存稳定 ID 与时间，入队后记录完成标记；即使在入队和 UI 清空之间崩溃，重试也沿用同 ID。用户主动新建另一笔相同正文仍可保存，不做文本去重。正文保留用户原文，心情完全由用户输入，无模型或关键词擅自分类。记录使用 `source:note`、时长 0、无图像，不经过屏幕 OCR/过滤链；写入相同的原子持久队列，固定 UUID/时间，ACK 后删除。此入口与中央 Web 随手记共用服务器协议，但各自管理本地离线记录。存在待上传记录时不能切换中央节点；先上传完成，或退出后导出并移走原队列，再重新启动。更换节点必须明确输入新节点令牌，禁止沿用旧令牌。原队列需要迁移到新节点时，可在核对新节点后手动导入。

## 开发者诊断与优化

开发者区默认关闭诊断。启用后每 15–3600 秒（默认 60）记录有界数值日志（最多 1440 样本）：主进程 RSS/累计 CPU、队列与模型字节、保存/过滤/失败计数、推理/OCR 延迟、估算上传请求体字节和设备电量。日志和导出不含截图、OCR、随手记、模型 reason 或令牌。CPU 只表示采集主进程，原生推理以延迟单独测量；电量变化是整台电脑的读数，不可归因于 Mote。电源来源由 IOKit 获取，无法读取时显示不可用。

同一开关还控制最多 500 条结构化事件，只包含时间、固定阶段与错误类别、可选耗时和 HTTP 状态；覆盖配置、模型加载/下载、采集、OCR、隐私、队列、上传、心跳、随手记和支持导出。分类只看异常类型/错误码，不保存原始异常消息。HTTP 401/403 可定位认证阶段，超时、TLS、网络、存储错误分别标记；诊断失败不改变原本隐私和 ACK 条件。关闭后停止新增，旧事件保留；崩溃遗留的已退出进程临时诊断文件会清理。

“导出安全支持包”含当前 profile/版本、采集与队列数值、非敏感配置开关、模型耗时、累计/最近数值诊断及固定事件。输出再次按白名单投影，排除截图、OCR、笔记、心情、窗口/设备名、设备 ID、节点/下载 URL、数据目录、令牌、审查策略、模型理由和原始错误。完整 1440 条数值轨迹另用“导出数值诊断”；有内容的队列备份是独立入口。

可以显式选择电池供电暂停、低电量暂停（0 关闭）、JPEG 质量和截图分辨率。已有采样间隔、空闲阈值、CPU 线程及审查图片尺寸也影响资源占用。电量策略默认不启用；启用后若电量无法确认则保守暂停。修改设置需先停止采集，避免同一帧切换隐私与资源策略。

## 可选本地隐私模型接口

只接受 `localhost`、`127.0.0.1`、`::1`，不允许跳转到其他地址。HTTP 请求最长 15 秒，不附带中央节点令牌：

```http
POST http://127.0.0.1:8787/review
Content-Type: application/json
```

```json
{
  "version": 1,
  "purpose": "privacy_review",
  "imageMime": "image/jpeg",
  "imageBase64": "经过固定区域遮挡的 JPEG base64"
}
```

响应必须同时含布尔 `allow` 与 `rectangles` 数组（无额外区域也必须返回空数组）：

```json
{ "allow": true, "rectangles": [{ "x": 0.2, "y": 0.1, "width": 0.4, "height": 0.1 }] }
```

`allow: false` 表示丢弃整张截图。所有矩形须合法且不能超出画面，最多 100 个。回环地址只约束采集器发往何处；应确保所接入服务自身使用本地模型、不会继续转发原图到云端，并按需关闭模型日志。

## 队列、断网和迁移

默认队列限制为 512 MiB / 10,000 条观测，两个上限先到即停止采集。没有覆盖最旧记录的静默丢弃。重新联网后上传继续，容量恢复后需手动重新开始采集。

队列位于 Electron `userData` 下，macOS 开发环境通常为 `~/Library/Application Support/@mote/desktop`，打包后可能为 `~/Library/Application Support/Mote Collector`；以界面的「打开数据目录」为准：

```text
config.json                 # 设备配置与 Keychain 加密的令牌
notes/draft.json             # 原生随手记草稿、已准备的稳定提交与完成标记
models/qwen/                # 已验证双模型及可续传部分
diagnostics/diagnostics.json # 可选、有界数值诊断
diagnostics/events.json      # 可选、最多500条固定阶段事件
Partitions/                 # legacy 中央 Web session
session/Partitions/         # 命名 profile 的独立中央 Web session
queue/
  events/<event-uuid>.json   # 不变的 observation、图像 hash、重试状态
  blobs/<sha256>.jpg        # 已脱敏图像，同内容只存一份
```

文件夹权限为 0700，文件为 0600。截图与 OCR 本身没有额外应用层加密，建议使用 FileVault 或加密磁盘。安全存储不可用时拒绝保存明文令牌；不把个人数据或令牌写入源码、日志、崩溃提示。

每次采样都有独立 UUID。即使图像内容相同，仍保留每次 observation 以支持时间统计；图像按 SHA-256 去重。上传失败保持相同 ID、时间、元数据与图像。只有 HTTP 200/201 且返回 ID 匹配才移除对应本地事件，最后一个引用移除后删除图像。失败重试从约 2 秒起指数退避并加入抖动，最长约 18 分钟，退避状态写入磁盘。界面显示上传错误、下次重试和队列深度，可手动立即重试。

小队列可从界面导出/导入专用 JSON 备份，含图像 hash 校验和，不含访问令牌。导入前先检查全部记录；相同内容 ID 去重，冲突拒绝。为控制内存，导出仅支持至多 256 MiB 队列；大队列应退出应用后复制整个 `queue` 目录。导入完成后上传到当前配置中央节点。电脑端队列备份格式与中央仓库导出格式不同，不能互换；中央仓库完整迁移见服务端文档。

进程被杀后，下次启动会恢复完整事件、清理未完成临时文件和孤立图像。遇到已提交事件或图像损坏时启动失败，保留损坏记录供人工备份恢复，避免静默丢失。新机器上不要依赖复制后的 Keychain 密文可解密，应复制队列并重新配置令牌。设备 UUID 随原队列事件保留，已有观测不会因迁移改写来源。

## 0.3.0 验证范围

本轮执行 63 个桌面单元测试、TypeScript/Swift/C++ 构建、0.3.0 `.app` 打包及 `codesign --verify --deep --strict`。原生 Electron profile fixture 同时启动 dev/test 两个进程，各自通过 IPC 保存合成凭据/随手记/草稿，实际 loopback HTTP 401 后保留队列，导出支持包，再重启两个进程验证设备 ID、凭据、草稿、队列与 session 路径独立稳定。支持包逐项检查没有合成私密原文、令牌、URL、策略、设备 ID 或目录。整个测试没有开始截图、下载模型或调用真实模型。

```sh
npm run test:profiles -w @mote/desktop
```

此命令只创建临时 fixture 根目录和临时 HTTP 拒绝服务，完成后清理。另完成真实 Electron 控制台 smoke：配置保存、无图随手记入队、profile/实际目录显示、保持停止状态，未读取已有用户目录。跨平台类型与持久化逻辑有测试，但本轮真实环境仍仅 Apple Silicon Mac，没有新增 Intel、Windows、Linux 或实体安卓手机验证。

## 历史采集链路验证

最终打包后的 ASAR 模块及随 App 分发的原生 helper 已用生成白图实际运行千问通过（0.2.1 的 CPU 合成白图约 4.7 秒）；ad-hoc 签名通过 `codesign --verify --deep --strict`。编译最低 macOS 13.3 是部署目标，未在 13.3 旧系统或 Intel Mac 实测。

原生随手记另已对独立合成中央节点通过「草稿落盘 → 模拟入队后中断 → 重建草稿存储 → 相同事件重试 → 服务器重复 ACK → 清空本地队列」验证，无占位图片。可复现命令：

```sh
MOTE_FIXTURE_SERVER=http://127.0.0.1:47835 MOTE_FIXTURE_TOKEN='<测试节点令牌>' node apps/desktop/scripts/note-fixture.cjs
```


此前执行：57 个桌面单元测试、TypeScript/Swift/C++ 编译、真实 Electron 控制台和中央窗口 smoke；中央窗口验证主进程注入认证、禁止外域、隔离 Node、关窗重开保留草稿以及节点存储隔离。真实 Qwen CPU 对 Android/Mac 共用生成图连续推理及强杀恢复通过：两次均 `allow:true`，本轮 Mac 冷启动约 5.4 秒、暖约 4.5 秒。这是功能性 live-model fixture 验证，不是 NSFW 准确率评测，也未采集用户真实屏幕。

```sh
npm run test:central -w @mote/desktop
# 先用 npm run models:download 或 App 导入模型。以下只处理程序生成的图：
npm run test:vision -w @mote/desktop
```


自动化使用生成的像素/协议 fixture，不读取用户真实屏幕，不启动采集。运行：

```sh
npm run typecheck -w @mote/desktop
npm run test -w @mote/desktop
npm run build -w @mote/desktop
```

`npm run test:ui -w @mote/desktop` 用独立的生成配置启动真实 Electron 窗口，验证渲染、preload IPC、保存配置、无图随手记入队和保持停止状态，并在 `apps/desktop/release/ui-fixture.png` 输出本应用生成界面的截图。此测试不会调用屏幕采集 API，不读取已有用户配置。

还可对已经启动的本机测试中央节点运行真正 Electron 图像处理 + Apple Vision + 队列 + HTTP 上传验证，只使用程序生成的图片，不申请或调用屏幕采集：

```sh
MOTE_FIXTURE_SERVER=http://127.0.0.1:47834 MOTE_FIXTURE_TOKEN='<测试节点令牌>' npm run test:fixture -w @mote/desktop
```

该测试验证遮挡区文字不再进入 OCR、可见测试标题仍可识别、两条观测复用一份图像、ACK 后队列清空以及同 ID 重传幂等。本次已在 macOS 上对生成图与本机中央节点执行通过；它不代表真实用户屏幕采集验证。

本轮额外使用完全虚构的多段中文日记、后续更正、组合 emoji、ZWJ、组合重音、JSON/HTML 字面量，以及正文 20,000 / 心情 80 个 UTF-16 字符位边界进行多轮验证。正文不做归一化或截断，空格和原始编码保持不变。超限时保留编辑内容并在正文旁显示可修正的错误；输入法组合阶段不会误提交。已修复合法长草稿经 JSON 转义后无法恢复的问题，并在正常退出前等待已接收的草稿和提交写入完成。突然断电或强杀仍只能恢复最后一次已持久化的内容。

真实 Electron 进程已完成「DOM 输入后立即退出 → 新进程恢复 → 三条无令牌离线入队 → 中央已接收但返回错误确认 ID → 再次退出重建 → 同 ID 重试 → 精确原文比对」；同时通过合成 HTTP 服务验证接收后断连、错误 ID、无效 JSON 的确认故障。测试不申请或调用屏幕采集。独立复杂输入 UI 测试可用：

```sh
# 在仓库根目录先完成 build；以下命令从 apps/desktop 目录执行。
../../node_modules/.bin/electron scripts/complex-ui-smoke.cjs

# 在 ignored 私有文件中配置本机测试中央地址与访问令牌：{"url":"http://127.0.0.1:<port>","token":"..."}
MOTE_COMPLEX_CONNECTION=/absolute/private/connection.json node scripts/complex-app-driver.cjs
# 节点重启中断时，使用上次输出的 statePath 保留原 ID 继续尚未完成的阶段。
MOTE_COMPLEX_RESUME=/absolute/private/run-fixture.json node scripts/complex-app-driver.cjs
```

2026-09-13 已从真实 App 内选择合成设备并调用中央配置的 `deepseek-flash`：日记更正问题正确回答周五 10:30、林舟、只检查图表和注释，并区分取消的安排、引文中的伪指令与非实测时间；点击行内来源打开匹配 ID 的完整原文。长文问题早期返回 HTTP 502 模型格式错误，保留失败响应后在新版中央复测通过：约 5.45 秒、3 次只读工具调用，使用 offset 18000 / length 2000 读取末尾，准确回答校验事实；唯一行内来源打开的 ID 与完整 20,000 字符位原文匹配。期间有一次测试脚本挂起尚未发模型请求，不计为模型失败；脚本现已记录 fetch 确认与异常，并为单次 UI 调用设置短超时。这些合成问答不能替代真实个人资料的效果评估。

中央内嵌窗口还用延迟响应和 HTTP 502 合成故障验证：用户切换查询时间范围时中止旧请求，忽略迟到的旧答案；切换设备后清除旧答案；失败保留问题，点击重试仍使用原设备、范围和浏览器时区。另外连续 10 轮快速切换设备后立即提交，验证新范围请求不会被误取消。此故障注入不调用模型。实际模型问答与它分开运行：

```sh
# 同样从 apps/desktop 执行，STATE 必须是上述脚本生成的 statePath。
MOTE_COMPLEX_STATE=/absolute/private/run-fixture.json MOTE_COMPLEX_PHASE=query-ui ../../node_modules/.bin/electron scripts/complex-app-phase.cjs
# 需要测试中央配置真实模型；在真实界面选择该合成设备，然后串行提问并核对行内来源与完整原文。
MOTE_COMPLEX_STATE=/absolute/private/run-fixture.json MOTE_COMPLEX_PHASE=query ../../node_modules/.bin/electron scripts/complex-app-phase.cjs
```

该链路默认将生成配置和测试状态保存在 ignored 的 `.mote/live-validation/desktop`；令牌仅从私有连接文件读取，真实 App 配置使用系统安全存储加密。它会向明确配置的本机测试中央写入三条合成随手记；不要指向已有个人使用的节点。生产应用不会自动执行这些脚本。

覆盖：精确应用过滤、可见窗口排除决策、矩形边界、本地审查失败关闭、TLS/令牌配置、队列并发与容量、进程重建恢复、图像去重但观测保留、幂等冲突、ACK 身份校验、持久重试、导入校验以及损坏后保留数据。Swift 编译验证不等于真实屏幕授权或真实截图验证。

需要用户授权后完成的 macOS 实机验收：

- 首次屏幕权限申请、拒绝、撤销、授权后重启。
- 主屏截图与排除窗口（含分屏/叠放窗口）的实际过滤、显示器切换和 Retina 比例。
- 固定区域/本地模型区域遮挡，以及遮挡后中英文 OCR 的真实效果。
- 锁屏、休眠、空闲与恢复，菜单栏停止/退出、登录启动。
- 断网入队、强制终止后恢复、真实中央节点幂等上传和磁盘满。

上述真实屏幕采集、真实个人数据上传与真实使用场景的过滤准确率尚未验证。已通过的实际千问推理只针对合成图片，不可替代这些验收。
