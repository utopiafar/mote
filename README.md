# Mote

**自己的上下文，自己的资料库。** Android 与 Mac 独立 App 持续采集经过本地隐私处理的屏幕，离线保存并补传到独立中央节点；回看时间线、查看采样时长，通过 DeepSeek Harness 检索和生成有原始证据的回顾。

这是第一版可运行 MVP。中央节点可以先在本机运行，后续迁移 NAS/Linux/云服务器；采集端只依赖版本化 HTTP 协议，不绑定服务位置。

## 四个交付端

| 端 | 实现 | 入口 |
|---|---|---|
| 电脑采集器 | Electron + TypeScript；macOS Swift/AppKit/Vision 本地助手 | `npm run desktop`，详见 [电脑端](docs/desktop.md) |
| Android | Kotlin；无障碍截图 / MediaProjection；离线中英 OCR、WorkManager | [安卓说明与 HyperOS 验收](docs/android.md) |
| 中央节点 | Node.js 24 + Fastify，SQLite/FTS、内容寻址图像库、DeepSeek Harness | `npm start`，详见 [部署与迁移](docs/deployment.md) |
| 中央节点前端 | React + Vite；随手记、时间线、问答、洞察、设备状态、导入导出 | Mac App 内「中央节点」；也保留自部署管理入口 |

## 先跑起来

需要 Node.js 24 LTS；编译 Mac 助手需要 Xcode Command Line Tools、CMake 和 Ninja。`models:setup` 拉取固定版本的 llama.cpp 源码，模型权重单独下载。

```sh
npm ci
npm run models:setup
npm run build
npm start
```

首次启动会在仓库 `data/access-token` 生成访问令牌。将其填入电脑采集器和安卓配置；Mac App 内可直接打开中央节点，无需另开浏览器。自部署管理页仍可通过 `http://127.0.0.1:47832` 访问。令牌属于你的私人资料访问凭证，不需要发到聊天里。

在另一终端运行 `npm run desktop`。配置节点地址和排除应用/遮罩，在客户端下载或导入千问语言模型和视觉投影器，授权系统屏幕录制，点击开始。不会随服务器启动自动截图。Android 同样先在配置页下载或导入模型；本机视觉审查默认开启，模型未就绪时不会放行截图。

Android：安装构建产物 `apps/android/app/build/outputs/apk/debug/app-debug.apk`。USB 初次验证可执行 `adb reverse tcp:47832 tcp:47832`，手机填 `http://127.0.0.1:47832` 并勾选 debug HTTP。长期连接使用 HTTPS 的中央节点。HyperOS 推荐显式启用无障碍截图模式；详见 [Android 说明](docs/android.md)。

如果尚未采集，可选择填入**标注为合成数据**的演示资料，验证 Web；该命令不截取你的屏幕：

```sh
npm run demo
```

## AI 原生约束

没有“搜索待办关键词 → 返回固定结果”这类意图路由。所有自然语言问题原样交给 Agent。DeepSeek Harness `0.1.5-rc.2` 实际运行，只装配 Mote 的 `search_context`、`timeline`、`evidence`、`activity`、`devices` 五个只读工具；模型自行选工具、生成检索表达式、推理与引用。采集内容被标为不可信证据，不能变成系统指令。

确定性代码仅负责你要求的应用排除/遮挡、权限、传输、配额、去重、数据保留和采样时间计算。界面明确区分采样时间与真实专注时间；不会推断“刷了某个 App 就是在浪费时间”。

将 `.env.example` 复制为根目录 `.env`，填写模型并重启：

```dotenv
MOTE_MODEL=你的工具调用模型ID
MOTE_MODEL_BASE_URL=https://api.deepseek.com
MOTE_MODEL_API_KEY=你的密钥
```

支持用户配置的兼容 API / 本地模型，具体约束见 [Agent 配置](docs/agent.md)。缺少配置时采集、归档和时间线仍可运行；AI 页面明确显示尚未配置，API 返回 503，**不会伪造回答或使用关键词替代 Agent**。

默认索引是本地全文/子串检索原语，由 Agent 自主组织查询。可选 `MOTE_EMBEDDING_*` 开启持久向量索引与混合检索；此时已脱敏 OCR 文字会发送到你指定的 embedding 服务。默认不向模型发送原始截图。OCR 为空的图片仍可回看，但无法假定 Agent 已看懂其中内容。

## 已实现的链路

- 显式开始/停止、排除指定应用、归一化像素遮挡、锁屏处理、权限状态、可配置采样间隔。
- 两端内置离线千问视觉审查：固定 Qwen3.5-0.8B 模型、独立 llama.cpp CPU 推理进程，可配置审查指令、线程、超时和输入/输出预算；先判断再 OCR/落盘/上传，未就绪或失败跳过截图。模型下载支持 ModelScope 优先、Hugging Face 回退、断点续传、重试、SHA-256 校验和离线导入。
- 可叠加本机视觉模型审查与遮罩，失败则跳过。Mac 凭证使用系统 safeStorage，Android 使用 Keystore；Android 本地队列加密。
- 持久离线队列、失败重试、匹配事件 ID 的确认后清理、容量满时暂停；相同画面复用图片但保留每次观察。
- 独立中央节点、Bearer 认证、图像校验、幂等 ID 冲突保护、按时间/设备浏览、跨设备采样时长。
- 随手记保留原文和用户显式标注的心情；本机草稿、离线待同步队列、幂等上传，并能作为 Agent 证据。
- 默认关闭的开发者诊断，记录有界的进程资源、队列/模型存储、采集/推理耗时和设备电量样本；可配置图片质量、尺寸、充电/低电量策略。设备电量变化不被冒充为 App 独占耗电。
- Agent 查询、可追溯引用、手动洞察和可选周期回顾（`MOTE_INSIGHT_INTERVAL_HOURS`，默认关闭）。
- JSON 导入导出、校验和、完整离线备份、图片可选 AES-GCM 加密、按需保留期限、关联删除；增量 changes 游标。
- 显式选择的 NAS/本地 UTF-8 文本文件夹导入与增量扫描；扩展源复用同一 [协议](docs/protocol.md)。

两份千问模型文件合计约 703.34 MiB，下载后完全离线运行，无需 API key 或另启模型服务。可在客户端选择下载来源，也可执行 `npm run models:download`，再将 `.mote/models/qwen/model.gguf` 和 `.mote/models/qwen/mmproj.gguf` 在两端配置页离线导入。默认策略审查露骨色情内容，可修改模型指令以配置其他前置审查任务；默认 CPU 2 线程、最多 256 个输出 token、60 秒超时、审查图像最长边 512 像素。国内来源、配置与 demo 移植细节见 [端上推理](docs/local-inference.md)。模型可能误判或漏判，不保证拦截全部敏感图像。

内置千问以严格 JSON 返回 `allow` 决定及简短原因，属于通用视觉模型的一个前置任务适配器。当前没有自动框选任意敏感区域的保证；明确不该采集的应用可直接加入排除列表。另保留可选的 HTTP 视觉审查与遮罩网关：使用其他兼容视觉模型时，可运行 `MOTE_PRIVACY_MODEL=<模型ID> npm run privacy`，将采集器地址设为 `http://127.0.0.1:47833/review`。Android 的 loopback 指手机本机；这个可选网关需要自行提供模型服务。

## 验证

```sh
npm run typecheck
npm test
npm run test:privacy
npm run test:e2e
cd apps/android
./gradlew assembleDebug testDebugUnitTest lintDebug
```

`test:e2e` 使用真实中央服务、SQLite、加密图片存储、真实 DeepSeek Harness 运行时和合成模型响应，验证工具循环与原始证据；这不等同于真实模型质量验证。具体已执行结果和未验证项见 [验收记录](docs/validation.md)。

当前范围：Mac 采集优先，Android 已有可安装 debug APK；Windows/Linux 的采集适配并未完成。K90 Pro Max/最新 HyperOS 的真机授权、长时后台稳定性与耗电要按清单验证，不能用模拟器结果替代。Docker 镜像构建、认证、笔记同步与重启持久化已在 [Linux CI](https://github.com/utopiafar/mote/actions/runs/34735449052) 通过；目标 NAS/公网部署仍需验收。无正式签名/公证分发，也未进行个人数据的长期测试；实际模型运行、审查质量与长时稳定性分别记录在验收文档中。

## 架构与参考

[架构边界](docs/architecture.md) · [调研与许可证](docs/research.md) · [部署/备份](docs/deployment.md) · [采集协议](docs/protocol.md)

参考了 [ScreenMemo](https://github.com/2977094657/ScreenMemo) 的 Android 采集与存储设计、[Memex](https://github.com/memex-lab/memex) 的 Agent 整理与证据关联，以及你之前的 [Context Gateway 讨论](https://chatgpt.com/g/g-p-6a02a30fda548191a3937908bc0bdc05-ji-zhu/c/6aa117d3-e6f8-83e8-b306-77c2bb7fcce7)。实际 Agent 依赖为 MIT 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，不是同名自研替代。
