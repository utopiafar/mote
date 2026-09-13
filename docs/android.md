# Android 采集端

原生 Kotlin，`minSdk 29 / targetSdk 36`。中央节点是独立服务，Android 只负责采集、隐私处理和可靠上传；节点地址可迁移到电脑、NAS 或服务器。桌面与 Android 共用 [protocol.md](protocol.md)。没有语义关键词分流、自动应用黑名单或任务识别逻辑。

## 构建和安装

需要 JDK 17+、Android SDK 36、NDK 28.2.13676358 和 CMake 3.22.1，项目内已含 Gradle 8.14 wrapper。先在仓库根目录运行 `npm run models:setup` 准备固定版本 `vendor/llama.cpp`。当前 APK 含 CPU 原生推理引擎，仅构建 `arm64-v8a`（ARMv8.2 + dotprod，面向 K90 及现代 arm64 设备；不支持 x86 模拟器或更旧 ARM CPU）。Android Studio 打开 `apps/android`；将 SDK 路径写入该目录下未纳入版本控制的 `local.properties`：

```properties
sdk.dir=/absolute/path/to/Android/sdk
```

```sh
cd apps/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

APK 位置：`apps/android/app/build/outputs/apk/debug/app-debug.apk`。Debug APK 可直接侧载，release 需用户自己的签名密钥。中国大陆小米设备不依赖 Google Play 下载 OCR 模型：中英 OCR 模型随 APK 打包，但仍需实机验证设备上的 ML Kit 运行兼容性。

## 首次连接

1. 在中央节点创建至少 32 字符访问令牌。手机填写相同令牌、节点 URL、设备名称；`localhost` 指手机自身。生产使用 HTTPS。首次局域网联调仅 debug APK 可显式允许私有 IPv4 地址 HTTP；节点也需由用户显式配置 LAN 监听。
2. 配置采集间隔（默认 30 秒）、队列上限（默认 256 MiB）、非计费 Wi-Fi 上传、排除包名、固定遮罩。未配置遮罩时不会声称自动脱敏。
3. 默认启用本机 Qwen 图片过滤。先点击“下载 / 继续”取得双模型，或分两次导入指定 GGUF 文件；未就绪时不会截图。默认先国内 ModelScope，失败再 Hugging Face。
4. 允许通知，在系统中启用“Mote 屏幕采集”无障碍服务，返回应用点击开始。服务授权与开始采集是两个独立步骤。配置页带 `FLAG_SECURE`，避免令牌被采集。
5. 应用状态显示服务连接、权限、最后一帧、队列大小及上传错误。通知和应用内均可停止。停止截图后已有队列继续同步；停止截图不是清空或取消已有上传。
6. 节点前端可按设备查看时间线、采样设备时间，并让 Agent 查询已同步证据。导入/导出使用中央节点便携归档；手机加密队列是上传缓冲区，不是长期归档格式。

修改配置前须停止采集。规则作用于新帧，不会修改已入队记录（保持重试幂等）。队列非空时阻止更换节点地址，先同步到原节点并通过中央节点导出/迁移后再改地址。更换令牌可修复认证失败。编辑已配置的节点地址会清空输入框中的旧令牌，须明确输入目标节点令牌，不会默认复用原节点凭据。

## 两种截图模式

| 模式 | 用途 | 授权与恢复 |
| --- | --- | --- |
| 无障碍 `takeScreenshot`，Android 11+ | 推荐；定期系统截图，读取当前可见窗口的包名 | 用户在系统手动启用，仅点击开始后采集。系统重新绑定服务后可恢复已启用的采集；系统是否重绑不由应用保证。 |
| MediaProjection，Android 10+ | 备用；一个会话内复用 VirtualDisplay，旋转时 resize 并换 surface | 每次新会话都需系统同意。前台服务可见；锁屏、授权撤销或进程死亡会结束会话，必须返回应用重新授权，绝不复用旧 consent token。 |

无障碍服务不读取控件文字、不遍历 UI、不点击、不滚动、不发送手势。仅查询窗口根节点的 `packageName`，没有自动交互能力。此 MVP 是用户主动侧载的个人采集器，不宣称已满足应用商店对无障碍 API 使用的上架审核。

无障碍路径在请求截图前后核对窗口信息，有变化则丢弃。显式配置排除应用后，识别不到窗口、多个应用窗口、活动系统窗口或无障碍覆盖层时暂停；命中任何用户配置包名则不入队。没有配置排除时允许未知包名，并如实标记“未知应用”。

投屏模式可用 UsageStats 标注当前应用，但 UsageStats 不能证明全部可见窗口，因此配置排除时还需启用无障碍窗口识别。屏幕流与窗口事件不是原子事务，切换、悬浮窗和系统通知仍需实机验证；固定遮罩与本机隐私模型提供另一层保护，不应把应用排除理解为操作系统级隔离保证。

锁屏/熄屏不采集。投屏模式主动结束会话；无障碍模式在系统允许时解锁后恢复。遵守系统安全窗口限制，不绕过 `FLAG_SECURE`。系统自动停止投屏后不会启动录制、更不会请求自动同意权限。

## 本机隐私流水线

```text
屏幕/窗口状态检查 → 用户包名排除 → 内存截图
→ 内存 Qwen VLM 图片审查（默认启用；拒绝/故障即跳过）
→ 归一化黑色遮罩 → 用户配置缩放（默认最长边 1280px）→ 本机中文+拉丁 OCR
→ 可选本机模型审查 → 模型追加遮罩 → 重新 OCR
→ 用户配置 JPEG（默认 75）→ Keystore 加密队列 → HTTP 确认上传 → 删除队列记录
```

遮罩格式每行 `left,top,right,bottom`，四个坐标为 0..1；例如 `0,0,1,0.08` 遮住顶部 8%。旋转后相对新屏幕方向生效，遮罩边界向外取整。配置错误不能静默忽略；OCR 失败不上传原始图片。中英 OCR 输出可能有重复段落；尚未做语义合并或纠错。

### 内置 Qwen 本机图片审查

APK 随包集成 CPU `llama.cpp` 运行时，复用用户 demo 的 Qwen3.5-0.8B GGUF + 视觉投影路径。当前固定运行时源码 revision 为 `1744c6bde8d687ce9774b3b54e688eee0bfdf5b7`，双模型见仓库 `models/qwen-manifest.json`，总计 737,504,352 字节（约 703 MiB），模型权重单独下载、不塞进 APK。构建同时复制共享 `review-system.txt`、`review-policy.txt`、`review-grammar.gbnf` 和第三方许可证到 APK assets。

- 默认启用；默认政策检查明确色情裸露或性行为，普通日常画面允许。政策为可编辑的模型指令，可扩展其它视觉审查任务；没有概率阈值、关键词判断或肤色启发式。
- 语言文件 `model.gguf` 和视觉文件 `mmproj.gguf` 使用同一固定清单。下载支持 HTTP Range、HTTPS 重定向校验、来源回退、取消/被杀保留 `.part`、WorkManager 网络约束及指数退避。两个源 revision 不同但固定 SHA 相同；不会自行推测 URL。
- 下载/导入通过跨进程文件锁互斥，完整大小和 SHA-256 通过后才原子替换目标文件；每次创建原生模型句柄都再次校验两个文件完整 SHA。损坏导入不会替换正常模型。国内源不代表速度保证。
- 自定义来源是 HTTPS **目录**，追加 `model.gguf` / `mmproj.gguf`，可以托管在 NAS 或其它服务；仍必须符合固定 SHA。系统文件选择器每次导入一个文件，通过大小/SHA 自动识别语言/视觉角色，需两个文件齐备。
- 审查图在内存中等比例缩小至默认最长边 512，再通过只读 SharedMemory 交给应用私有 `:nsfw` 进程。NativeVlm 使用 mtmd 内存解码，无截图临时文件。服务不使用网络，也不将可见图片文字作为指令。
- CPU 默认 2 线程（1–8）、输出上限 256（32–1024）、超时 60 秒（5–180 秒，含首次校验/加载）、审查图最长边 512（256–1024）。默认 no-thinking；共享语法约束输出 JSON，模型先给简短判断依据再生成布尔 allow；程序只按严格布尔决策，不根据理由文本修正答案。
- 只有模型返回完整 EOS + 有效 JSON 才能继续。缺模型、SHA 不符、输出截断/无效、超时、进程退出均跳过当前帧，未进入 OCR/存储/上传。超时中止私有推理进程，下一次重新绑定并加载；应用也有“重载推理进程”。本机模型可能误判，应按自己的内容测试，不能把模型判断视为绝对隐私保证。

### 可选额外 HTTP 隐私钩子

URL 留空仅表示不使用这个额外钩子，**不会关闭内置 Qwen**。填写后只允许手机自身 `localhost / 127.0.0.1 / ::1`；release 允许 loopback HTTP，中央节点仍必须 HTTPS。钩子可增加精确遮罩，模型服务须由用户另行运行。

请求（图片已应用静态遮罩）：

```json
{"version":1,"imageBase64":"...","imageMime":"image/jpeg","ocrText":"...","appId":"com.example.app"}
```

有效响应 HTTP 200：

```json
{"allow":true,"rectangles":[{"x":0.1,"y":0.2,"width":0.8,"height":0.1}]}
```

`allow:true` 必须显式包含 `rectangles` 数组，无敏感区用空数组；兼容旧的 `masks:[{left,top,right,bottom}]`，优先解析统一的 `rectangles`。`allow:false`、HTTP 错误、非布尔 allow、缺失审查数组、无效遮罩、超时或 OCR 重跑失败都会丢弃该帧，显示暂停原因并在下一周期重试。模型的其他内容不会作为指令执行或透传为查询工具命令。钩子不接收中央节点令牌，不自动跟随 HTTP 重定向。

## 数据、安全与可靠性

- 应用私有 `noBackupFilesDir/queue`，AES-GCM 密钥由 Android Keystore 生成；令牌也加密存储。关闭系统备份和设备迁移。卸载/清除应用数据会销毁未上传内容，不会自动恢复密钥。
- 图片按 SHA-256 内容寻址，同图多次观察共享一个加密 blob；每次观察仍保留单独事件与时间。JSON 元数据也加密，先写临时文件并 fsync，再原子重命名；启动时只回收不被有效事件引用的临时/孤儿 blob。损坏事件报错，不默删。
- 采样间隔默认 30 秒。持续显示且同一应用的连续采样才计入间隔，首次或应用切换计 0，最多计一个采样间隔；这不是用户注意力或精确前台使用时长。多设备的时间可重叠。
- JPEG 缩放/质量、本机 blob 去重、容量上限降低空间成本。达到上限暂停，不覆盖最旧未确认数据。OCR 文本最大 100,000 字符。
- 上传保持原 id、时间、元数据、图像不变；只在 HTTP 200/201 且响应 id 匹配后删除。401/409/5xx、断网、无效响应均保留记录并指数退避。单次 WorkManager 批次最多 25 条，剩余稍后继续。
- WorkManager 使用连接约束、30 秒起指数退避、15 分钟恢复巡检。采集服务每 30 秒请求心跳，包括因隐私规则暂缓的状态；停止/授权丢失也请求状态同步，实际发送仍遵守网络约束与系统调度。Wi-Fi 选项同时检查 Wi-Fi transport 和非计费网络，计费热点会等待；正在进行的网络请求不能倒转已经发送的字节。
- 队列传输与采集生命周期分开。服务未连接时心跳报告需恢复权限。断网/休眠时状态更新也会延迟；中央节点需按最后心跳时间判断离线。
- 不申请相册、相机、麦克风、设备管理员或 Root。TLS 使用平台证书验证，不信任所有证书，不自动绕过自签名错误；建议用正常受信任的域名证书。

## 随手记和开发者选项

原生界面提供随手记正文（最多 100000 UTF-16 码元）及可选心情（最多 80 UTF-16 码元；组合 emoji 可能占多个码元）。输入立即写入 Keystore 加密草稿，页面重建/应用重启后恢复。保存前先原子持久化固定 ID、capturedAt 和完整提交内容，再幂等入队、请求同步调度，最后清草稿。调度异常时明确提示记录已经本机保存，并保留原提交供安全重试；即使在入队成功与清草稿之间被杀，恢复重试也复用原 ID，不会悄悄新建重复笔记。只有明确编辑内容或“新记”才生成新提交；不按正文全局去重。已准备的提交不能直接改投其它节点。先保存节点配置，再保存笔记；正文保持原样，不用模型分析后才能保存。随手记不需截图权限、不受截图审查阻塞，使用同一加密离线队列，以 `source: note`、零时长及真正无图记录同步；重试保持 ID/时间，中央确认后清除本机上传缓冲。已同步内容在中央随手记页面管理。

可配置保存图最长边 640–2560（默认 1280）、JPEG 质量 40–95（默认 75）、仅充电时截图（默认关）、低于指定电量暂停（0 关闭，1–95）。它们与间隔、Wi-Fi、模型线程、审查图大小配合调节资源开销；不会根据画面主题自动改采集规则。

开发者诊断默认关闭，采样间隔 15–3600 秒、默认 60 秒，在界面或采集服务运行时记录，最多保留 1440 条。内容为整机电量/充电状态、可用时的 chargeCounter、整机电量变化、队列/模型/诊断占用、入队/拦截/失败累计、最近推理/OCR 耗时、已确认上传 JSON 载荷字节。整机电量变化不能归因于 Mote。原生“导出数值诊断 JSON”使用系统保存文件选择器；不包含截图、OCR、笔记、token、prompt、模型reason、设备ID。关闭后停止新增采样，不为诊断单独拉活后台。

## K90 Pro Max / HyperOS 验证指南

代码提供小米自启动页 Intent，并在该入口缺失时回退到应用详情；不假设特定 HyperOS 版本一定提供该 Activity。需要用户手动在当前固件确认：

1. 应用详情 → 通知允许；省电策略设为“无限制”（实际菜单名以设备为准）。
2. 设置 → 应用/权限 → 后台自启动，允许 Mote；应用内“自启动设置”可尝试打开入口。
3. 侧载 APK 无障碍开关如受限制，在应用详情的菜单查看“允许受限制的设置”，确认应用来源可信后由用户操作。
4. 可在最近任务页锁定 Mote。该设置和自启动不能保证进程永不被杀。
5. 用合成内容测试：联网/断网切换、上传确认、非计费 Wi-Fi、旋转、切换排除应用、通知抽屉/分屏/悬浮窗、锁屏/解锁、省电、清理后台、进程被杀和重启。每个场景检查通知、节点最后心跳、队列与事件时间。
6. 投屏模式被杀或锁屏后应明确要求重新授权；无障碍模式若系统未重绑服务，应提示服务未连接，不显示“仍在采集”。

**尚无 K90 Pro Max 真机验证，不能保证最新 HyperOS 的后台稳定性、权限页路径、耗电、截图/OCR延迟或长期续航。** Android 系统与 OEM 会限制后台行为；MVP 不用闹钟、WakeLock 或循环重启规避限制。

## 验证边界

前一交付批次的 debug APK 经过 `assembleDebug`、24 项 JVM 单元测试、lint（0 error / 38 warning）和 16 KiB ZIP 对齐校验，在专用 API35 模拟器一次组合执行 8 项 instrumentation，全部通过、无跳过（41.379 秒）。详细产物 hash 由对应根交付记录列出。当前复杂输入修复另通过 `assembleDebug` / `assembleDebugAndroidTest`、26 项 JVM 测试（无失败/跳过）和 lint（0 error / 38 warning）。最终 0.2.1 / versionCode 3 在仅改版本号后再次通过 `assembleDebug`、26 项 JVM、lint 与 16 KiB ZIP 对齐；该版本号重建未重复全套 instrumentation，下面三轮笔记与两项 Qwen 测试验证的是同一份产品代码。APK 为 31,769,972 字节，SHA-256：`efb506567320c2900504b3472e7b236683d356bc662c3cb45938803754a555b9`。JVM 测试只用生成的字节/JSON，覆盖严格排除、未知窗口 fail closed、归一化遮罩校验、HTTPS/本机模型边界、进程重建后队列幂等、图片去重、确认删除、满队列、孤儿恢复和损坏记录。

独立新建 `mote_fixture_api35` 模拟器（API35 / Android15）上的 3 个 instrumentation 测试验证 Android Keystore、生成位图的遮罩后 bundled OCR，以及实际无障碍截图→本地流水线→HTTP 确认删除。截图测试只在该名称的专用模拟器且没有节点配置/队列时运行，显示的是 debug-only `FixtureActivity` 生成文本；普通设备上跳过。该测试既可用本机协议假服务，也能通过 `fixtureCentralUrl` / `fixtureCentralToken` instrumentation 参数连接真实中央节点；连接真实节点时会查询该设备记录确认入库与 blobHash。

```sh
# 仅在新建的 fixture 模拟器上执行，绝不指向个人手机。
adb -s emulator-5580 reverse tcp:47834 tcp:47834
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.fixtureCentralUrl=http://127.0.0.1:47834 \
  -Pandroid.testInstrumentationRunnerArguments.fixtureCentralToken=YOUR_SYNTHETIC_TEST_TOKEN
```

不会采集个人真机屏幕用于自动测试。模拟器成功不等同于 K90 Pro Max、HyperOS 后台恢复、物理 Wi-Fi、MediaProjection 同意弹窗/旋转、长期耗电或真机本机模型性能验证。Qwen 的两项独立仪器测试在同一模拟器导入固定公开双权重，用生成图执行真实离线 CPU 推理、私有进程重载后再推理，以及损坏模型导入拒绝；不会用模拟器速度代表手机实测。随手记/数值诊断另有合成仪器测试。中央节点合成端到端测试另见总体验证记录。

### 多轮复杂随手记验证

`ComplexNoteFixtures` 是测试源码共同使用的生成文本，不进入生产 APK，不含个人资料。2026-09-13 在 `mote_fixture_api35` 完成三轮、每轮六条、共 18 条真实中央节点同步验证：中文多段 CRLF/LF、制表符与不换行空格、emoji/肤色/ZWJ/组合字符、80 码元心情、100000 码元上限正文、纯空白心情，以及看似 system / 工具调用 / shell 的普通笔记原文。正文逐字保持；纯空白心情按协议省略。对时间按中央节点的毫秒精度比较，不要求 Android 纳秒格式原样返回。

每轮分三个 instrumentation 进程执行，撤掉该测试端口的 ADB reverse 证明上传暂不可达，再实际 `am force-stop`，确认恢复进程 PID 改变。原生编辑框装入上限正文后 Activity 重建保留原文；本次模拟器耗时 666–713 毫秒，不能当作真机指标。额外注入一次“队列已持久化后，WorkManager 调度异常”，恢复保存仍复用同一提交 ID。接回中央节点后确认队列 ACK 清空，逐条读取核对完整正文、心情、无图属性，再重发同一载荷得到重复 ACK，设备记录仍恰为六条。

这轮修复了清草稿早于同步调度导致的重复提交窗口：之前调度异常会在可重试界面里丢掉 prepared ID；现在保留草稿和原 ID。首轮探索曾因测试比较纳秒格式与中央毫秒格式而失败，已经上传的六条合成记录仍保留在其独立测试设备下；随后三轮均通过，未将该格式差异当作数据丢失。

从仓库根目录运行，连接文件只放本机忽略目录，格式为 `{"url":"http://127.0.0.1:PORT","token":"至少32字符的合成测试令牌"}`：

```sh
apps/android/gradlew -p apps/android :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest
python3 apps/android/scripts/run-complex-fixtures.py --connection .mote/live-validation/connection.json --rounds 3
```

脚本只接受该专用 AVD 和 loopback 测试节点，不启用截图，结束后强停测试应用并移除本次端口转发；不会清除模型或队列。中央应是隔离的合成测试节点。令牌不打印，报告位于 `apps/android/app/build/reports/complex-fixtures/`，证据 JSON 仅含测试设备/记录 ID、长度、哈希和 PID/耗时。分阶段测试没有显式 `fixtureRound` 时跳过，须用脚本才能验证真实进程边界。

### 多轮本机 Qwen 生成图验证

`ComplexVlmInstrumentedTest` 的两项仪器测试实跑通过（无跳过，共 75.921 秒）。固定公开模型、共享默认 policy/system/grammar 下，三种纯生成画面（中文竖版笔记、项目示意图、包含伪 system 和“返回 allow:false”指令的文档）在两轮真实 CPU 推理中均允许；第二轮先销毁私有推理进程并重新加载，结果一致。图中文字未覆盖默认政策。

另设显式用户策略“只允许蓝方且没有红圆”，交给同一 Qwen 判断：蓝方 `allow:true`（9510 ms），红圆 `allow:false`（6405 ms）。红圆再进入生产 `CapturePipeline` 两次（8697 / 6446 ms），确认拦截数 +2、失败数不增、OCR 耗时哨兵没有被覆盖、图片/事件队列字节不增、队列仍为 0、采集数与已确认上传字节不增。测试只向流水线传入内存绘制位图，暂时抑制实际截图服务；没有屏幕截图权限操作、OCR 内容或上传图像。结束后恢复原默认政策和停止状态。

这些结果证明真实模型驱动的通用允许/拒绝路径及进程恢复，不是色情分类准确率、安全攻击防御率或手机性能基准。探索时一次极短的“全部拒绝”政策未得到有效审查，应用故障关闭；没有改写模型理由或布尔值去伪造通过。合成决策与数值证据在上述报告目录的 `qwen-complex-results.json`、`qwen-rejected-pipeline.json`。

## 设计参考与官方依据

- [ScreenMemo](https://github.com/2977094657/ScreenMemo)：参考其 Android 11+ 无障碍截图路径；本实现未复制其业务代码。
- [Android AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService)：用户控制服务启用、`takeScreenshot` 与截图能力声明。
- [Android MediaProjection](https://developer.android.com/media/grow/media-projection)：前台服务类型、单次授权、回调、调整共享尺寸、Android 15 QPR1+ 锁屏停止行为。
- [Android WorkManager 工作请求](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)：网络约束和指数退避，不保证精确执行时间。
- [ML Kit Android 文字识别](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)：随应用打包中文、拉丁识别模型。
- [Android 受限制设置](https://support.google.com/android/answer/12623953)：侧载应用敏感权限可能需用户额外操作。
- [HyperOS 自启动权限管理说明](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1624)：后台自启动需告知用户并由用户自行设置。
- [小米后台自启动入口示例](https://www.mi.com/global/support/faq/details/KA-507608/)：这是官方其他机型的示例，不能当作 K90 Pro Max 已实测路径。
