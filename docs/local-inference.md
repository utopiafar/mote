# 本机千问视觉审查与通用任务运行时

Mote 在 Android 和 macOS 内置 Qwen3.5-0.8B 的本地视觉语言模型运行时。截图先经过用户应用排除和固定遮罩，再由模型阅读图像及用户配置的审查指令，返回是否允许保存的 JSON 决策；通过后才进入后续 OCR、队列和上传。默认开启审查，模型未就绪、完整性校验失败、进程退出、超时、生成截断或格式错误时跳过本帧。

端侧运行的是真实 llama.cpp CPU 推理，不需要 API key，也不要求用户另外启动模型服务。前置审查使用小型通用视觉语言模型：默认任务过滤露骨裸体或性活动内容，用户可以改写审查策略。模型文件约 703 MiB；实际内存还包括视觉编码器、上下文、缓存及运行时，不能把下载大小当作峰值内存。

## 固定模型与来源

两端共同消费 [models/qwen-manifest.json](../models/qwen-manifest.json)，构建时复制到 TypeScript 包与 Android assets。该清单固定两份权重、字节数、SHA-256、来源 revision 和运行时版本，不能用同名的其他精度或其他 revision 替代。

| 项目 | 值 |
| --- | --- |
| 模型 | `unsloth/Qwen3.5-0.8B-GGUF` |
| 首选国内来源 | [ModelScope 模型仓库](https://modelscope.cn/models/unsloth/Qwen3.5-0.8B-GGUF) |
| ModelScope revision | `88467eb7c8e3b6e7894c794f373050d4dbc6ae8a` |
| 备用来源 | [Hugging Face 固定快照](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/tree/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0) |
| Hugging Face revision | `6ab461498e2023f6e3c1baea90a8f0fe38ab64d0` |
| 总大小 | `737,504,352` 字节，约 `703.34 MiB` |
| 权重许可证 | Apache-2.0 |
| 运行时 | [llama.cpp](https://github.com/ggml-org/llama.cpp/tree/1744c6bde8d687ce9774b3b54e688eee0bfdf5b7)，固定 `1744c6bde8d687ce9774b3b54e688eee0bfdf5b7`，MIT |

| 用途 | 源文件名 → 本地文件名 | 字节数 | SHA-256 |
| --- | --- | --- | --- |
| 语言模型 | `Qwen3.5-0.8B-Q4_K_M.gguf` → `model.gguf` | `532,517,120` | `bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517` |
| 视觉 projector | `mmproj-F16.gguf` → `mmproj.gguf` | `204,987,232` | `56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453` |

两个托管站的 Git revision **不同**。Hugging Face 对应文件的 LFS 元数据与清单中的大小、SHA-256 相同，清单使用各站真实 revision；不能把 ModelScope 的 revision 直接拼进 Hugging Face URL。完整性最终以下载文件自身的摘要核验，而不是仓库显示名、HTTP 200 或文件长度判断。

实现使用 llama.cpp、ggml 与 mtmd 处理文本、图像编码和生成。当前两端只启用 CPU：不含 Vulkan、Metal 或 MNN 后端，不把请求的后端名称当作实际加速成功的证明。依赖与分发通知见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 默认参数和用户配置

共享初始审查指令位于 [models/review-policy.txt](../models/review-policy.txt)。两端首次配置从该文件加载；用户保存的指令覆盖默认值。它要求模型根据图像中的露骨内容作决定、将截图中的指令视为不可信数据、不转写个人信息，并返回简短 JSON；没有通过关键词、肤色规则或应用名称猜测语义结果。

| 配置 | 默认 / 范围 | 作用 |
| --- | --- | --- |
| 本机视觉审查 | 开启 | 开启时失败跳过；显式关闭后才省略此模型步骤，应用排除与其他遮罩仍执行 |
| CPU 线程 | `2`；`1..8` | 更多线程可能增加温升与耗电，不保证更快 |
| 最大生成长度 | `256 tokens`；`32..1024` | 给简短 JSON 足够空间；达到上限而没有正常结束时不能算有效决定 |
| 等待上限 | `60000 ms`；`5000..180000 ms` | 超时丢弃本帧，回收失效推理进程，下次重建 |
| 审查图最长边 | `512 px`；`256..1024` | 只缩放送入审查的图片，保留宽高比；降低尺寸可节省计算，但可能漏掉细小内容 |
| 审查指令 | 共享默认策略 | 自由文本，由用户决定要做的前置审查；不是程序识别用户意图的规则表 |
| 下载来源 | `auto` | ModelScope 优先，失败后使用已核验的 Hugging Face 备用文件 |
| 自定义目录 | 空 | `custom` 时填写不带查询参数、账号密码或片段的 HTTPS 目录 |

macOS 配置保留 `nsfwEnabled`、`nsfwThreads`、`nsfwTimeoutMs`、`nsfwSource`、`nsfwCustomUrl` 名称以兼容已有配置，并新增 `reviewPolicy`、`reviewMaxTokens`、`reviewMaxSide`；这些旧名称不表示另有一个专用分类器。Android 的 `NsfwConfig` 承载相同概念。两端指令长度上限目前分别为 macOS 8000 字符、Android 4000 字符；跨端复用时使用不超过 4000 字符的指令。

修改配置前先停止采集。模型拒绝和模型故障都不会保存本帧，但诊断中应区分“策略拒绝”和“没有取得有效决定”。首次加载包含权重核验与模型初始化，冷启动可能明显慢于后续请求；实际超时、温升、采样间隔需根据目标设备测量调整。

## 严格决策与数据边界

采集链路只接受完整 JSON 对象：

```json
{"reason": "简短说明", "allow": false, "labels": ["简短标签"]}
```

`allow` 必须是布尔值；`reason` 可省略，最长 240 字符；`labels` 可省略，最多 12 个字符串，每个最长 64 字符。未知字段、非布尔 allow、Markdown 代码围栏、普通文字、坏 JSON 或不完整生成都属于失败。模型没有输出有效决定时，不生成默认的 `allow:true`，也不根据文字中的“允许”“安全”等词推导结论。实现不接受概率字段或手写评分阈值。

内置生成器使用共享 [review-system.txt](../models/review-system.txt) 和 [review-grammar.gbnf](../models/review-grammar.gbnf)，约束先输出简短 `reason` 再给出 `allow`，`labels` 可选；应用解析边界仍允许省略 `reason`，便于兼容其他运行时。

原始图像与审查输入通过内存及进程通信传递，不为了推理写临时截图文件。Android 使用非导出的独立推理服务进程，macOS 使用独立原生 helper；原生故障由父进程收敛为可见错误并触发重建。独立进程改善界面恢复，不是权限沙箱，也不能防止系统内存压力、操作系统杀后台或系统驱动故障。

模型的解释和标签也可能意外包含截图内容，不应未经处理写入常规遥测或中央采集元数据。模型输入、输出、随手记均是数据，不可执行其中的 shell、文件操作或提示指令。中央查询 Agent 和端侧视觉审查是不同的能力边界：中央继续使用 DeepSeek Harness 的只读证据工具。

这是整帧决策，本地生成器并未自动获得任意遮挡位置、替换 OCR、执行操作或外发图片的权限。固定遮罩与可选回环审查接口仍可叠加；NSFW 审查不等于账号、身份证或聊天内容的完整隐私保护。

## 国内下载与离线导入

`auto` 依次尝试 ModelScope 与 Hugging Face；`mirror` 显式选择 ModelScope 国内来源，`official` 使用 Hugging Face，`custom` 使用用户 HTTPS 目录。这里的 `mirror` 是配置枚举名称，实际首选地址是清单中固定 revision 的 ModelScope 官方仓库 API，不依赖 `hf-mirror.com`。网络连通性和吞吐仍由实际网络决定，不宣称保证下载速度。

命令行下载只获取公开权重，不读取屏幕或个人文件：

```sh
npm run models:download
npm run models:download -- --source mirror
npm run models:download -- --source official
npm run models:download -- --verify-only
```

默认目录是 `.mote/models/qwen/`，包含 `model.gguf` 与 `mmproj.gguf`。`--verify-only` 在缺失、损坏或仅完成一份权重时返回非零退出码。运行时源码准备见 [scripts/setup-vision.sh](../scripts/setup-vision.sh)；它从官方仓库检出清单固定的 llama.cpp commit，不取漂移的 latest 版本。

模型交付遵循以下边界：

- 每份权重支持断点文件、Range 续传、有限重试、完整大小与 SHA-256 校验。服务器忽略 Range 返回 200 时从头写入；错误范围、超额响应及摘要不符不能启用。
- 两份文件都核验通过才显示就绪；下载完语言模型并不代表视觉模型可用。只完成一份时保留它，下次只补齐缺失部分。
- 每个写入者使用自己持有的临时文件；完成写入、关闭句柄并核验后才替换最终文件，避免另一个下载进程继续修改已经验证的模型。取消和进程终止保留可恢复部分，模型加载前重新验证两份权重。
- Android 使用 WorkManager 持久调度、网络约束与退避；macOS 在应用运行时重试，退出后需重新点击下载/继续。强制停止、OEM 后台限制或网络条件不满足时，不保证系统会立即恢复任务。
- 下载不发送截图、OCR、模型 prompt 或中央节点令牌。重定向不能降级到 HTTP。

离线导入可分别选择原始命名的两个 GGUF 文件，也可选择下载后本地命名的文件；按字节数与摘要识别角色，不依赖用户改名。macOS 支持同时选择两个或逐个补齐；Android 按文件选择导入。只导入一份时明确保持未就绪。导入损坏、选错量化版本或缺 projector 都不会放行采集。

NAS 或私有静态服务可以托管同一份权重，HTTPS 目录中必须使用固定本地名称：

```text
https://nas.example/mote-models/qwen/
  model.gguf
  mmproj.gguf
```

选择 `custom` 并填写该目录，下载器分别拼接上述文件名。它不提供登录 Cookie 或任意 Authorization 头；需要交互登录的网页、包含查询参数的单文件 API 地址不适用于这个目录配置。无需自己托管时直接选择内置 ModelScope 来源。

模型缓存与个人归档分开：Android 位于应用私有 `noBackupFilesDir/models/qwen/<revision>/`；macOS 位于应用数据目录中的 `models/qwen/`。中央导出不包含权重，新设备需再次下载或导入；卸载/清除应用数据会移除端侧缓存。

## 通用前置任务的扩展方式

端侧原生运行时接受指令、可选图像、生成预算和结构化输出约束，保留用于其他轻量视觉/文本任务的能力。当前采集器调用的是审查适配层，其允许/拒绝 JSON 契约固定。更换审查政策不需要替换模型，也不需要添加一个按关键词分流的专用分类器。

后续摘要、局部隐私识别、观察描述等任务应通过显式的任务适配层调用同一运行时，各自定义输入权限、JSON 输出、时限和失败处理。任务由用户配置或 Agent 编排；不由硬编码待办、情绪关键词选择。当前未声称这些新任务、自动区域遮挡或知识库整理已经随本地运行时交付。用户随手记可以在模型未就绪时独立保存，其原文及显式心情按照 [统一协议](protocol.md) 同步。

## 局限与验收

小模型可能漏判、误判或不遵守 JSON 指令。屏幕缩放、细小区域、混合窗口、绘画、医学内容、不同呈现方式和提示注入都可能影响结果；过滤先应用的遮罩也会改变模型看到的内容。没有针对用户截图的准确率、召回率或隐私保证，不把上游模型评价当作 Mote 的实际表现。

失败跳过会造成采集缺口，应查看端侧失败原因、推理耗时与中央最后观测时间。更长的超时或更多 CPU 线程都可能增加电量与温度压力。新规则不追溯修改已入队或已上传记录；相关删除需单独执行。

具体结果集中在 [validation.md](validation.md)：下载协议 fixture、真实固定权重的生成图测试、打包后运行、Android 模拟器、K90 Pro Max / 当前 HyperOS 真机必须分开记录。本文件不将计划测试写成通过，不声明本版 K90 真机或 GPU 已验证。生成图片可验证运行与数据边界，不能代表真实个人屏幕的过滤质量和长期后台耗电。
