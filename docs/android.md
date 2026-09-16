# Android 采集端

原生 Kotlin，`minSdk 29 / targetSdk 36`。中央节点是独立服务，Android 负责本机采集、隐私处理、加密保存和按策略同步；首次使用无需节点。中央节点可运行在电脑、NAS 或服务器，待发资料已绑定的目标不能直接改投。桌面与 Android 共用 [protocol.md](protocol.md)。没有语义关键词分流、自动应用黑名单或任务识别逻辑。

## 本轮离线与同步验证（2026-09-14）

开发 APK、开发测试 APK 与开发 JVM 测试构建通过；最终 **60 项 JVM 测试，0 失败、0 跳过**。新增覆盖同步时机、批量少量记录的最长等待、独立元数据期限、首次未绑定笔记的 ID 保留，以及来源元数据等待时间的持久化。

在专用 `mote_fixture_api35` / API 35 的只读实例上，最终 **14 项 instrumentation 测试全部通过，0 跳过**（12.611 秒）：10 项本机加密保存/生成活动/首次目标绑定/手动无自动心跳/批量阈值与最长等待/定时发送/手动错误 ACK 与断连/来源错误 ACK/25 条边界最终心跳；3 项页面导航、原生数值与应用选择器及遮罩、预览；1 项加密笔记草稿重建。HTTP 只访问模拟器内的合成 loopback 服务。来源测试只向本机缓存写入生成记录，未读取实际日历或文件。

7 张 UI 预览位于忽略构建目录 `apps/android/app/build/reports/navigation-ui/`：`overview.png`、`notes.png`、`sources.png`、`settings.png`、`capture-settings.png`、`sync-settings.png`、`privacy-settings.png`。预览来自本应用的 `View.draw(Canvas)`，只含生成测试状态；`FLAG_SECURE` 一直保留，没有读取设备屏幕。只读模拟器会话结束后丢弃测试改动，原 AVD 与日常安装保持原样。

本轮未执行真机、真实个人屏幕、真实日历/文件或实时模型检查；短时 fixture 不代表 OEM 后台运行、长期 WorkManager 调度或真实系统采集权限已验证。下方较早版本验证记录保留为历史证据，不能视为本轮重新执行。

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

APK 位置：`apps/android/app/build/outputs/apk/debug/app-debug.apk`。Debug APK 可直接侧载；release 需注入签名配置，覆盖现有安装必须保持同一证书，详见下方更新说明。中国大陆小米设备不依赖 Google Play 下载 OCR 模型：中英 OCR 模型随 APK 打包，但仍需实机验证设备上的 ML Kit 运行兼容性。

## 开发环境与日常版本隔离

日常 `debug` / `release` 保持原 `dev.mote.collector` 包名与数据，不做迁移。新增 `development` 构建类型：名称 **Mote Dev**，包名 `dev.mote.collector.dev`，可与日常版本同时安装。Android UID、Keystore、设备 ID、配置、草稿、队列、WorkManager 数据库、诊断和模型目录均由系统按应用隔离。Dev 初始没有令牌、草稿或模型；不能读取日常采集权限与数据，各权限需单独启用。

```sh
apps/android/gradlew -p apps/android :app:assembleDevelopment
adb install -r apps/android/app/build/outputs/apk/development/app-development.apk
```

Dev 默认节点 `http://127.0.0.1:47842`，仅供用户显式配令牌后的本机调试。模拟器使用 `adb reverse tcp:47842 tcp:47842`；真机仍需填写可达的节点地址。日常版本保持原配置、首次地址为空。“设置 → 关于与更新 → 开发者选项”显示环境、包名与实际 `noBackupFilesDir`，方便判断正在操作哪个版本。不要用卸载或清除日常数据代替切换环境。

## 应用内更新与签名兼容

从“设置 → 关于与更新”打开“应用更新”，保存发布仓库和渠道后检查。默认仓库 `utopiafar/mote`；稳定版 `stable` 查询正式发布，预览版 `preview` 查询预发布。检查与下载由用户发起，不会自动安装；下载默认等待非计费 Wi-Fi，可自行关闭这一下载约束。APK 下载由独立 WorkManager 任务执行，取消或中断保留断点，重新打开页面可以继续；后台时机仍由 Android 调度。

更新先读取 GitHub Release 的 `mote-release.json`。APK 内置 `release-public-key.pem`，按固定 key ID、RSA/SHA-256 校验原始 payload 字节，再校验仓库、渠道、版本、tag、资产 URL 与包名。换仓库不能自动引入另一把信任公钥；本期仅适用于同一受信任发布密钥签署的发布镜像。网络只访问允许的 GitHub HTTPS 主机及发布 CDN，重定向重新检查，不发送中央节点令牌。

下载内容位于应用私有 `noBackupFilesDir/app-updates`；APK 大小与 SHA-256 匹配后，还通过 `apksig` 验证实际 APK 签名、系统 PackageManager 检查包名、versionCode 与最低 Android 版本。清单证书、APK 证书和当前安装证书必须相同，只允许更高 versionCode；日常与 Dev 通过不同包名分别选择资产。签名不符、篡改、错误包名或降级均不会进入安装。

点击“交给系统安装”才申请允许安装应用的系统设置；从设置返回后再次点击安装。应用创建 Android `PackageInstaller.Session`，要求用户确认。没有收到确认时可通过更新通知继续；系统取消或失败保留旧应用与数据，可以取消待确认的会话后重试。更新采用同包覆盖安装，**没有自动卸载或清除数据流程**；设置、设备 ID、加密队列、草稿、模型和已授予权限由 Android 保留。安装可能中断正在进行的采集；投屏会话在进程被替换后需重新授权。OEM 安装校验、权限和电池策略仍可能要求额外用户操作。

0.4.0 的日常 debug 和 Dev 包使用本机生成的同一 Android Debug 证书，SHA-256 为 `0670a89e6f9548552b90777dd1e0dc4e3efab6cf7082d436fcc60d6e9edb5076`。兼容发布沿用这个证书身份，发布用私钥以受保护签名配置保存；日常 release 构建关闭 debuggable，Dev 保持独立开发包。重新生成一把 release 密钥，即使包名相同，也不能无损覆盖这些已安装包；当前更新器会阻止这种情况，不提示自动卸载。

发布构建从环境读取以下四项，值不写入源码或更新清单：

```text
MOTE_ANDROID_KEYSTORE_PATH
MOTE_ANDROID_KEYSTORE_PASSWORD
MOTE_ANDROID_KEY_ALIAS
MOTE_ANDROID_KEY_PASSWORD
```

四项齐备时 `release` 和 `development` 都使用指定证书；普通本机 debug 继续使用本机 debug keystore。缺少配置时 `assembleRelease` 拒绝产出未签名发布包，不能把另一台机器新生成的 debug 证书当成升级凭据。构建时需同时包含仓库内的固定发布公钥；APK 签名和发布清单签名是两层独立检查。

## 从本机开始，以及可选的节点连接

应用分为“概览 / 随手记 / 来源 / 设置”。概览只显示采集状态、同步状态、开始/暂停和记录数量；设置按“连接与同步 / 采集与存储 / 隐私与应用规则 / 关于与更新”分类。诊断、HTTP 隐私钩子、模型技术参数和实际数据目录位于“关于与更新 → 开发者选项”。配置修改显示待保存提示，切换页面与旋转保留草稿；校验失败会打开对应页面并标出字段。

1. **无需先配置节点。** 地址与令牌可以留空，在“随手记”直接保存，或配置本机采集；截图、活动和笔记先进入有上限的 Keystore 加密队列。未配置完整连接时不上传、不发送自动心跳，也不反复创建失败的网络任务。离线队列是有限的本机保存区，并非无限容量的内容浏览器；长期资料浏览与导出在节点进行。
2. “采集与存储”提供间隔、图片尺寸与质量、存储上限和电量条件的常用选项，也保留范围内自定义值。“隐私与应用规则”可从已安装且系统允许查询的应用中选择级别，用示意图绘制固定遮罩。无需填写包名或坐标才能使用；精确包名和原始遮罩文本在高级展开项中保留。
3. 完整内容采集默认启用本机 Qwen 图片过滤；在隐私设置下载或导入双模型，模型未就绪时不会截图。仅应用活动不读取图片，也不要求模型。通知和无障碍/投屏授权仍由 Android 决定；在概览点击开始才启用采集。节点地址与令牌不属于采集前置条件。
4. 概览分别报告“正在本机采集 / 等待权限 / 等待本机模型 / 本机空间已满”等采集原因，以及“仅保存在本机 / 手动同步 / 等待约定时间 / 正在同步 / 同步失败”等同步状态。暂停采集保留已有记录，上传继续遵循选定策略。
5. 需要集中归档时，在中央前端生成 10 分钟有效、只能兑换一次的邀请，在“设置 → 连接与同步”打开邀请连接，可扫码、粘贴邀请 JSON / `mote://connect` URI 或选择 JSON 文件。二维码解码器随 APK 打包；只有点击扫码后请求相机权限，不保存相机画面。
6. 页面先显示地址和有效期，再由用户确认。外部 URI 只打开审阅页，不自动兑换、保存或启动采集。已有未绑定节点的本机记录时，明确确认将这些记录绑定到所显示的节点后才连接；原记录 ID、内容和时间保留。邀请只接受 HTTPS；Dev 的 loopback HTTP 例外需显式打开。`localhost` 指手机自身。
7. 邀请签发这台设备的采集及自身来源写入凭据，不授予全仓库读取/管理或 Agent 查询。客户端验证兑换响应与 `/api/connections/self` 的节点、凭据、设备身份、平台和能力后保存。“测试已保存连接”代表最后一次检查，并非永久在线保证。连接成功后也遵循所选同步策略；手动模式需主动点击“立即同步”。

所有配置页保留 `FLAG_SECURE`。从概览“采集与存储详情”查看已保存、被拦截、失败、待发和已确认数量，不把“本机保存成功”显示成“已同步”。

既有手动令牌仍可使用。生产节点使用 HTTPS；首次局域网联调仅 debug APK 可显式允许私有 IPv4 HTTP，这个历史手动配置选项不放宽邀请的 HTTPS / loopback 限制。编辑已配置节点地址会清空输入框中的旧令牌，必须明确填写目标凭据；从配对页返回后也执行这项保护。

已登记设备不能通过普通新设备邀请接管。页面可以复制本机设备 ID，在中央选择或明确绑定这个 ID 生成邀请，不需要轮换设备 ID。凭据撤销、过期配置或离线期间认证失败时，用**同一节点、绑定同一设备的邀请**确认“使用新凭据继续同步本机待上传截图/笔记/来源”；应用自动协调旧处理和连接变更，队列、已准备的随手记、设备身份和采集设置原样保留。已有记录绑定节点后，只要仍有队列、已准备的笔记或来源待发版本，就拒绝改投另一节点；先清空地址也不会解除这项绑定。首次未绑定的离线记录可在上述明确确认后绑定。连接更新完成后按原采集意图恢复；已经发出的投屏授权回调在配置变化后不会启动旧会话，需要新授权时引导系统确认。

兑换成功但身份验证或本机持久化中断时，已领取的凭据先保存在应用私有加密恢复文件；重新打开连接页可审阅原节点并确认继续。保存失败不会删除这份恢复凭据。邀请、令牌和响应正文不写入日志；网络请求不自动跟随重定向。

## 采集数量、记录详情与实际存储

“采集与存储详情”独立于开发者诊断开关，持续保存固定事件和数值。分组显示当前采集、累计结果、当前待上传、资料在哪里与生效设置；小文件用 B / KiB 显示，较大文件用 MiB / GiB。刷新在后台执行，不周期扫描全部文件。

- **请求 / 收到 / 保存 / 拦截**分别计数。已保存只表示加密入队成功，已确认上传只在节点 ACK 匹配并清除本机记录后增加；截图、仅活动和随手记分别统计。重复入队或重复 ACK 不重复计数。用户规则导致的暂停、收到画面后丢弃和实际处理失败不是同一件事。
- 最近 200 条固定结果可点按查看时间、错误阶段、HTTP 状态、耗时、字节和关联记录 ID。入队、重试和确认沿用同一 UUID，能区分某条记录还在重试还是已成功；不显示截图、笔记、OCR、应用名、模型理由或令牌。
- 当前队列直接读取本机文件。最多展示最早 100 条的 ID、类型、创建时间和加密条目字节，不含共享图片 blob 的分摊估计；无法读取或未检查的条目明确列出，不能当成零。来源同步也显示待确认数、确认数及失败数。撤销凭据导致的心跳 401 会标为认证失败，已有记录仍保留。
- 页面显示实际 `noBackupFilesDir/queue`、`noBackupFilesDir/local-sources`、`noBackupFilesDir/models`、缓存目录、字节上限和当前分区可用空间。应用私有文件总计不等于 Android 系统安装占用，不包含 APK 或系统配额；文件过多、超时或不可读会显示未完成，不跟随符号链接遍历。
- 统计从明确的起算时间开始；旧版本没有的历史数据不可补造。统计损坏后标记重新起算，写入失败会标记不完整。队列和统计文件分开原子持久化，进程恰好在两次写入间终止可能少记累计数，不能用累计数代替当前队列检查。

“导出无正文统计 JSON”仅包含固定统计、记录 UUID 和结果事件，不包含上述目录、节点地址、配置凭据或用户内容。“重置统计起点”只清统计，不删队列、模型、设置或中央资料。采集记录的长期浏览与内容导出仍在中央完成。相机解码集成参考 [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded) 与 [ZXing 发布说明](https://github.com/zxing/zxing/releases)。

## 按应用分级与设备元数据

新安装默认仅记录应用活动；升级保留原有规则。“设置 → 隐私与应用规则”可选择默认采集级别，通过搜索已安装应用添加例外，再逐行选择完整内容、仅应用活动、不记录或跟随默认。系统包可见性可能使列表不完整；高级项仍支持手工输入 `包名=content`、`包名=activity` 或 `包名=off`，原有自定义包名不会丢失。最多 200 项；按完整包名精确匹配，不按名称或正文关键词推断。旧的排除包名列表始终按 `off` 执行，优先于分级设置。内容采集时，可见键盘和系统辅助窗口也遵守同一规则，没有内置系统白名单；默认 `off` 时，只有用户明确将已识别辅助窗口设为 `content` 才允许内容样本。活动采样本来不读取任何窗口内容，无需把已识别辅助窗口设为 `content`，但未知窗口、多应用及旧排除仍暂停。

- **完整内容 / content**：按既有 Qwen、遮罩和 OCR 流水线保存截图。
- **仅应用活动 / activity**：只记包名、系统可取得的应用名、采样时间与有界时长；没有图片、窗口标题、控件文字、OCR、心情或正文，也不启动本机模型/OCR。首次、暂停后或应用/级别切换后的采样时长为零，随后同应用时长不超过配置间隔，不能视为连续观测。截图请求或活动观察入口固定单调时钟，OCR/模型处理完成时间不参与区间计算。
- **不记录 / off**：不产生截图或活动记录。多可见应用、受限辅助窗口/浮层及未知窗口都保守暂停，不把内容权限自动降为活动记录。

如果全部规则都不需要内容，即使保存的是投屏模式，也使用无障碍包名观察且不申请投屏权限；Android 10 也可只记录活动。规则仍允许某些应用完整内容时，投屏模式需要正常系统授权。保存规则后应用自动协调旧处理和新配置，不需要手动暂停再开始；若切换方式需要新投屏授权，会引导系统确认。已入队的记录保留入队时的字段与权限结果，不因后续设置改变而删除或重写。

“上传设备与运行状态元数据”默认开启，可关闭。开启后，新截图、活动、随手记与心跳附带当时实际可取得的系统版本/build、制造商/型号、架构、语言/时区、电量、是否充电/使用电池、省电/温控状态、网络类型/是否计费、屏幕交互/锁定状态及可用存储。未知数据省略；满电本身不当成“正在充电”。不采设备序列号、IMEI、MAC、SSID、定位或网络地址。截图可附保存图尺寸、OCR 开关与遮罩数量；活动只附采样间隔，手动笔记标注 `manual`。`observedAt` 表示状态实际读取时间，不是历史状态回填。

关闭开关只影响之后生成的数据，已有待传记录保持原样；文件来源经用户授权取得的文件元数据独立于此开关。系统 API 的读数及权限可用性由 Android/OEM 决定，无法取得的字段不伪造。

## 两种截图模式

| 模式 | 用途 | 授权与恢复 |
| --- | --- | --- |
| 无障碍 `takeScreenshot`，Android 11+ | 推荐；定期系统截图，读取当前可见窗口的包名 | 用户在系统手动启用，仅点击开始后采集。系统重新绑定服务后可恢复已启用的采集；系统是否重绑不由应用保证。 |
| MediaProjection，Android 10+ | 备用；一个会话内复用 VirtualDisplay，旋转时 resize 并换 surface | 每次新会话都需系统同意。前台服务可见；锁屏、授权撤销或进程死亡会结束会话，必须返回应用重新授权，绝不复用旧 consent token。 |

无障碍服务不读取控件文字、不遍历 UI、不点击、不滚动、不发送手势。仅查询窗口根节点的 `packageName`，没有自动交互能力。此 MVP 是用户主动侧载的个人采集器，不宣称已满足应用商店对无障碍 API 使用的上架审核。

无障碍路径在请求截图前后核对窗口信息，有变化则丢弃。选择默认内容规则时允许系统桌面、启动器及没有明确前台应用的画面；已知的可见应用、键盘和系统辅助窗口仍按用户分级规则处理，任一窗口为 activity/off 时跳过整张内容采样。有显式排除或限制级别且无法可靠识别窗口时仍暂停，以免绕过规则。仅活动模式始终需要可靠的单一前台应用身份，不读取辅助窗口内容。可见窗口只取类型与根节点包名，不读取键盘候选、剪贴板或控件文字。显式旧排除列表始终优先于新的应用分级规则。

两种模式均需无障碍窗口识别；UsageStats 不能证明全部可见窗口，单靠使用情况权限不会放行。投屏会话只创建一次 VirtualDisplay，起始不挂接 Surface；仅当本次窗口策略允许内容采集时才创建 ImageReader 并挂接，读取前再次核对窗口，随后立即移除 Surface。仅活动和不记录分支不请求帧、不读取图像。屏幕流与窗口事件不是原子事务，切换、悬浮窗和系统通知仍需实机验证；固定遮罩与本机隐私模型提供另一层保护，不应把应用排除理解为操作系统级隔离保证。

锁屏/熄屏不采集。投屏模式主动结束会话；无障碍模式在系统允许时解锁后恢复。遵守系统安全窗口限制，不绕过 `FLAG_SECURE`。系统自动停止投屏后不会启动录制、更不会请求自动同意权限。

## 本机隐私流水线

```text
屏幕/窗口状态检查 → 用户应用分级
├─ off / 不可信窗口：不记录
├─ activity：应用身份 + 有界采样时长 → 加密无图队列 → ACK
└─ content：内存截图
→ 内存 Qwen VLM 图片审查（默认启用；拒绝/故障即跳过）
→ 归一化黑色遮罩 → 用户配置缩放（默认最长边 1280px）→ 本机 OCR（默认中文/拉丁单引擎，可选拉丁或双引擎）
→ 可选本机模型审查 → 模型追加遮罩 → 重新 OCR
→ 用户配置 JPEG（默认 75）→ Keystore 加密队列 → HTTP 确认上传 → 删除队列记录
```

固定遮罩可在不含真实屏幕内容的手机示意图上拖动添加，点选后用百分比滑块调整，或直接选顶部 8% / 底部 12% 预设。高级项保留每行 `left,top,right,bottom`、0..1 的精确坐标，例如 `0,0,1,0.08`；未修改的原有自定义坐标保持精度。旋转后相对新屏幕方向生效，遮罩边界向外取整。配置错误不能静默忽略；OCR 失败不上传原始图片。中英 OCR 输出可能有重复段落；尚未做语义合并或纠错。

### 内置 Qwen 本机图片审查

APK 随包集成 CPU `llama.cpp` 运行时，运行 Qwen3.5-0.8B GGUF 与视觉投影。当前固定运行时源码 revision 为 `1744c6bde8d687ce9774b3b54e688eee0bfdf5b7`，双模型见仓库 `models/qwen-manifest.json`，总计 737,504,352 字节（约 703 MiB），模型权重单独下载、不塞进 APK。构建同时复制共享 `review-system.txt`、`review-policy.txt`、`review-grammar.gbnf` 和第三方许可证到 APK assets。

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

## 统一同步策略

在“设置 → 连接与同步”选择策略，截图、仅活动、随手记及来源上传共同遵守。默认实时，旧配置自动保留这一行为。

| 策略 | 自动发送时机 |
| --- | --- |
| 实时 `realtime` | 新记录触发可运行的上传任务；网络与系统调度允许后发送。 |
| 定时 `interval` | 约每所选间隔同步一次。 |
| 批量 `batch` | 待发正文达到所选条数，或最早待发内容达到等待上限；少量记录不会无限等待。 |
| 手动 `manual` | 没有自动上传或自动心跳；点击“立即同步”才发起一次操作。发送前可以等待符合条件的网络；发起后的失败保留记录，等用户再次触发。 |

间隔默认 15 分钟，可选 15–1440；批量默认 20 条，可选 1–500。“批量”的条数只统计记录正文，空来源首次注册、改名等元数据另记等待时间，也在上限到期后发送。每个来源自身的扫描间隔控制读取频率，不代替这里的上传策略。中央自行暂停的来源不会被自动恢复，本机停用也不修改中央状态。

Android WorkManager 是可延期后台任务，15 分钟周期是最小周期，并非精确闹钟。一次性延迟、非计费 Wi-Fi、Doze、省电、应用被强停和系统资源限制都可能延后发送；界面的下一次时间是估计值，不能保证分钟级准点。手动模式的中央状态是最近一次报告；没有自动心跳时，中央不能据此声称设备当前在线。

## 数据、安全与可靠性

- 应用私有 `noBackupFilesDir/queue`，AES-GCM 密钥由 Android Keystore 生成；令牌也加密存储。关闭系统备份和设备迁移。卸载/清除应用数据会销毁未上传内容，不会自动恢复密钥。
- 图片按 SHA-256 内容寻址，同图多次观察共享一个加密 blob；每次观察仍保留单独事件与时间。JSON 元数据也加密，先写临时文件并 fsync，再原子重命名；启动时只回收不被有效事件引用的临时/孤儿 blob。损坏事件报错，不默删。
- 采样间隔默认 30 秒。持续显示且同一应用的连续采样才计入间隔，首次或应用切换计 0，最多计一个采样间隔；这不是用户注意力或精确前台使用时长。多设备的时间可重叠。
- JPEG 缩放/质量、本机 blob 去重、容量上限降低空间成本。达到上限暂停，不覆盖最旧未确认数据。OCR 文本最大 100,000 字符。
- 上传保持原 id、时间、元数据、图像不变；只在 HTTP 200/201 且响应 id 匹配后删除。401/409/5xx、断网和无效 ACK 均保留原记录。自动模式指数退避；手动模式中已发起的 HTTP/ACK 失败结束本次操作，等待再次点击“立即同步”。单次 WorkManager 批次最多 25 条，成功分块后可以继续同一次用户发起的操作。
- 自动同步使用 WorkManager 连接约束、30 秒起指数退避和 15 分钟恢复巡检；所有截图、笔记、来源版本及心跳经过同一策略。采集服务最多每 30 秒请求一次调度，只有策略允许时才发送。停止/权限变化不会绕过手动模式。Wi-Fi 选项同时检查 Wi-Fi transport 和非计费网络，计费热点会等待；已经发出的字节无法撤回。
- 队列传输与采集生命周期分开。服务未连接时心跳报告需恢复权限。断网/休眠时状态更新也会延迟；中央节点需按最后心跳时间判断离线。
- 不申请相册、麦克风、设备管理员或 Root；只有主动打开连接扫码时才申请相机权限。TLS 使用平台证书验证，不信任所有证书，不自动绕过自签名错误；建议用正常受信任的域名证书。

## 随手记和开发者选项

原生界面提供随手记正文（最多 100000 UTF-16 码元）及可选心情（最多 80 UTF-16 码元；组合 emoji 可能占多个码元）。输入立即写入 Keystore 加密草稿，页面重建/应用重启后恢复。保存前先原子持久化固定 ID、capturedAt 和完整提交内容，再幂等入队、请求同步调度，最后清草稿。调度异常时明确提示记录已经本机保存，并保留原提交供安全重试；即使在入队成功与清草稿之间被杀，恢复重试也复用原 ID，不会悄悄新建重复笔记。只有明确编辑内容或“新记”才生成新提交；不按正文全局去重。已准备的提交不能直接改投其它节点。无需地址、令牌或模型即可保存笔记；正文保持原样。第一次将未绑定提交连接节点需要明确确认，之后未确认的提交不能改投其它节点。随手记不需截图权限、不受截图审查阻塞，使用同一加密离线队列，以 `source: note`、零时长及真正无图记录同步；重试保持 ID/时间，中央确认后清除本机上传缓冲。已同步内容在中央随手记页面管理。

可配置保存图最长边 640–2560（默认 1280）、JPEG 质量 40–95（默认 75）、仅充电时截图（默认关）、低于指定电量暂停（0 关闭，1–95）。它们与间隔、Wi-Fi、模型线程、审查图大小配合调节资源开销；不会根据画面主题自动改采集规则。

采集设置另有“仅充电时 OCR”（默认关），它只推迟文字识别，不停止截图。未接电时先保存隐私审查和遮挡后的图片，接电后通过 WorkManager 补做本机中英 OCR；图片、处理结果和首次上传确认独立持久保存。概览的“采集记录”入口可按天查看本机记录或此设备中央归档，点击缩略图加载大图及文字详情。参见 [OCR 与预览行为](collection-and-sync.md#ocr-节能与采集预览)。

“采集与存储”提供图片队列保存位置，支持应用内部空间和系统枚举的应用专用本机／存储卡空间，显示位置与容量。更改时迁移已有加密记录和图片，外部介质缺失时报错暂停，不改为空队列。中央已归档图片不随客户端目录设置迁移。参见 [设置与图片位置](client-settings-and-storage.md)。

开发者诊断默认关闭，采样间隔 15–3600 秒、默认 60 秒，在界面或采集服务运行时记录，最多保留 1440 条。内容为整机电量/充电状态、可用时的 chargeCounter、整机电量变化、队列/模型/诊断占用、入队/拦截/失败累计、最近推理/OCR 耗时、已确认上传 JSON 载荷字节。整机电量变化不能归因于 Mote。原生“导出数值诊断 JSON”使用系统保存文件选择器；不包含截图、OCR、笔记、token、prompt、模型reason、设备ID。关闭后停止新增采样，不为诊断单独拉活后台。

诊断开关同时控制最多 500 条固定事件，阶段包括配置、模型、OCR、隐私、队列、上传、心跳、随手记和来源同步；只含时间、固定错误类别、可选耗时及 HTTP 状态。分类依据异常类型/协议状态，不保存原始异常消息。关闭后停止新增，已记内容保留。日志损坏会重新开始诊断，但不会删改采集队列。

“导出安全支持包 JSON”通过系统文件选择器导出应用/环境版本、采集状态、非敏感数值开关、数值诊断和上述事件；不含节点 URL、设备名/ID、目录、令牌、截图、OCR、笔记、心情、策略或模型理由。读取导出时再按字段白名单投影，诊断写入失败不影响隐私或 ACK 删除条件。支持包不等同于含内容的队列备份。

## 本机日历与文件来源

在首页保存中央节点配置，再打开原生“日历与文件来源”页面。此入口不需要截图权限，也不会在打开页面时读取日历；最多保存 20 个来源。来源的原始版本、当前快照、引用与衍生记忆之间的区别见 [上下文分层](context-layers.md)，跨端连接与中央管理见 [连接器](connectors.md)。

- **日历**：点击“连接本机日历”时才申请 `READ_CALENDAR`，选择系统日历提供者中可见的一个日历。默认同步过去 30 天到未来 90 天的实例，可设过去 0–365 天、未来 1–365 天；重复日程通过系统 `Instances` 展开。仅保存计划起止、全天标记、时区和状态，实际扫描时间另记为 `observedAt`，不将日程视为参加或完成证据。没有写日历权限，不会修改日程；只存在远端、尚未同步到系统提供者的日历不可读取。
- **文件**：点击“选择一个文件”或“选择文件目录”，通过系统 SAF 选择器授予并保留只读 URI 权限。不申请全盘访问，不扫描未选择的目录。默认扩展名为 `md,txt,json,csv,ics`，可自行修改；正文仅接受有效 UTF-8，不含 NUL，最多 100 KiB 且 100000 UTF-16 码元，起始 UTF-8 BOM 会去掉，其余正文及空白原样保留。PDF、Office、图片和音视频不在本期正文解析范围；ICS 当前是文件原文，不解析为日历实例。
- **保存方式**：默认“正文快照”同步标题及正文；“仅引用”不打开文件内容流，也不查询日历描述/地点，只发送名称、URI、修改/计划时间等元数据。引用不会让中央节点获得读取手机 URI 的权限。用户主动选择的日历/文件不经过截图 Qwen 审查；需要限制上传时，应先选择引用、缩小范围或设置文件排除路径。

文件排除每行一个相对路径模式，只有 `*` 是通配符，其他字符按字面匹配，例如 `private/*`、`*.secret.txt`；匹配区分大小写，扩展名匹配不区分大小写。匹配只用于用户配置的访问范围，不按内容关键词推断主题。每次最多收集 200 项及 4 MiB 序列化内容，目录遍历最多 12 层、检查 2000 项；任何超限、读取失败、无效 UTF-8 或部分扫描都显示“不完整”，保留原快照，不把漏扫项当成删除。移动窗口外的旧日程也不会被误标为删除。文件选择器受 Android 和提供者限制，某些目录不可选择；授权失效需重新选择，隐藏/不可用的日历需在系统恢复后重试。

每个来源可设 15–1440 分钟扫描间隔，默认 60 分钟；WorkManager 约每 15 分钟检查各来源是否到期，“立即扫描并同步”可手动请求。扫描和上传独立，离线时先保存加密快照与有序待发版本，上传统一遵循“设置 → 连接与同步”的策略与 Wi-Fi 约束；无节点也可完成本机扫描。来源的扫描间隔与统一上传间隔彼此独立。应用主进程再次启动会恢复任务；Android/HyperOS 省电、强行停止和提供者不可用可能延迟后台执行，不保证准点或永久后台存活。

来源配置和状态位于各安装环境独立的 `noBackupFilesDir/local-sources`，使用 Keystore 加密、临时文件 fsync 后原子替换。总缓存上限为 64 MiB 与“采集与存储”中队列上限的较小值，单来源最多 4096 个待发版本；达到上限暂停增加，不默删未确认数据。上传严格核对来源 ID、外部 ID、revision、记录 UUID 和重复标记，再移除对应待发项；丢 ACK 后重试同一版本。同节点更新凭据保持原待发版本，当前快照可按新凭据重新确认。没有任何待发正文后更换节点会先清除旧的已同步快照状态，随后重新扫描所选来源；不会直接将旧目标已确认的本机快照改投新节点。文件附带提供者实际报告的非负大小和可取得的最后修改时间；SAF 不提供的创建、访问或元数据变更时间保持缺省。完整扫描发现文件消失时，删除版本保留最后已知大小/修改时间，并另记本次 `deletionObservedAt`；它不是文件真实删除时间。正文变化、删除、恢复形成不同的链式 revision；只有完整成功扫描才生成不带原文的删除版本，旧版本重试不会倒退中央当前指针。

修改选择范围、过滤、时间窗口或保存方式会清掉该来源旧的本机缓存和未发送内容后重新扫描，界面在保存前明确说明。停用只暂停本机检查与同步，不改变中央的启用状态；移除连接清除本机来源状态并释放未被其他连接使用的 URI 权限，两者都不会删除已经同步到中央的历史。中央暂停的来源会保留待发版本，不自动重新启用；需在中央恢复后重试。支持包仅增加来源数量、启用数量和缓存字节，不包含名称、URI 或正文。

## K90 Pro Max / HyperOS 验证指南

代码提供小米自启动页 Intent，并在该入口缺失时回退到应用详情；不假设特定 HyperOS 版本一定提供该 Activity。需要用户手动在当前固件确认：

1. 应用详情 → 通知允许；省电策略设为“无限制”（实际菜单名以设备为准）。
2. 设置 → 应用/权限 → 后台自启动，允许 Mote；应用内“自启动设置”可尝试打开入口。
3. 侧载 APK 无障碍开关如受限制，在应用详情的菜单查看“允许受限制的设置”，确认应用来源可信后由用户操作。
4. 可在最近任务页锁定 Mote。该设置和自启动不能保证进程永不被杀。
5. 用合成内容测试：联网/断网切换、上传确认、非计费 Wi-Fi、旋转、切换排除应用、通知抽屉/分屏/悬浮窗、锁屏/解锁、省电、清理后台、进程被杀和重启。每个场景检查通知、节点最后心跳、队列与事件时间。
6. 投屏模式被杀或锁屏后应明确要求重新授权；无障碍模式若系统未重绑服务，应提示服务未连接，不显示“仍在采集”。

**尚无 K90 Pro Max 真机验证，不能保证最新 HyperOS 的后台稳定性、权限页路径、耗电、截图/OCR延迟或长期续航。** Android 系统与 OEM 会限制后台行为；MVP 不用闹钟、WakeLock 或循环重启规避限制。

## 0.7.0 分级采集与元数据验证

本机 0.7.0 / versionCode 10 完成 debug、Dev 和 Dev 测试 APK 构建。49 项 JVM 测试全部通过（0 失败、0 跳过），包括显式分级、旧排除优先、键盘/系统辅助窗与未知窗口、无图活动队列重建/幂等确认、旧统计升级，以及异步处理耗时不同但观察间隔不变。lint 为 debug 0 error / 100 warning、Dev 0 error / 104 warning。两包通过实际 APK 签名与 16 KiB ZIP 对齐；继续使用兼容证书 `0670a89e6f9548552b90777dd1e0dc4e3efab6cf7082d436fcc60d6e9edb5076`。

| 本机调试产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `app/build/outputs/apk/debug/app-debug.apk` | 33,869,247 | `0349ccae3844a305c4a4a0c0f308b5e329cac7763e40eb9a6358b31b255c040f` |
| `app/build/outputs/apk/development/app-development.apk` | 33,869,559 | `c771bd096a6062b2df5e002b6df0c1ef02c7dbb610d8c5ecef7f25041b6ea66f` |

这些是相对 `apps/android` 的本机调试产物，不替代 GitHub 正式发布的签名清单。

专用 `mote_release_060` / API35 / arm64 模拟器执行 6 项仪器测试，全通过、无跳过（28.842 秒）：

- 首页保存投屏模式但全局设为活动后，实际点击开始直接启用无障碍观察，没有请求投屏授权。至少两条新活动获中央 ACK，截图请求、图像读取与截图入队计数都为零；Qwen 开关保持开启。旧排除仍阻止记录。
- 真实无障碍截图只针对 debug 生成画面，完成 bundled OCR、加密队列与中央 ACK。投屏路径接受真实 Android 系统同意后，活动仍零图像请求；内容模式在同一个 VirtualDisplay 上取得至少两帧并获 ACK，验证按需挂接 Surface 的实际行为。
- 两张内存生成图通过实际 OCR 流水线，处理间隔为 250ms，而固定观察时刻相距 15s；第二条保存的 `durationMs` 为 15000，未混入处理完成时间。首次时长为零。
- 活动队列无图片/正文，关闭元数据开关不改已经入队的原始字节；新记录不再附设备元数据。生成 SAF 提供者报告的大小/修改时间经生产 HTTP 客户端写入中央，引用模式不打开内容流、不虚构日期；完整扫描墓碑保留最后已知大小/修改时间并另记观察删除时间，部分扫描不误删。

复跑要求显式将隔离节点 `{serverUrl,token,generatedOnly:true}` 私密写入 Dev 的 `files/app-policy-fixture.json`，测试不打印令牌；对应实连项在没有文件时跳过。本轮仅用 loopback 合成节点 61317，通过 `adb reverse tcp:61317 tcp:61317` 连接。宿主在仪器测试前向专用 Dev 授予通知权限，并在测试结束后恢复；测试内部撤销权限会被 Android 直接终止进程，不能据此声称测试通过。

```sh
adb -s emulator-5582 shell am instrument -w \
  -e class 'dev.mote.collector.AppPolicyInstrumentedTest,dev.mote.collector.LocalSourcesInstrumentedTest#generatedProviderCalendarFilesReferenceAndPartialDeletion' \
  dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner
```

结束时确认采集已停止，恢复专用 Dev 的通知/无障碍测试授权，移除私密输入和端口转发并关闭本次模拟器。未操作其他 AVD 或真机，未读取个人画面、日历或文件。本轮内容链路为明确关闭图像模型的生成画面 fixture；没有新增真实 Qwen 推理或 NSFW 准确率测试。键盘/浮层边界采用合成窗口类型和包名回归，未覆盖所有 OEM 真实窗口组合；K90 Pro Max / HyperOS、物理键盘/相机、旋转与长时间后台续航仍需真机验证。本轮没有重复完整旧版本升级保留验收，前次正式升级验证不能当成本轮实测。

## 历史 0.6.0 连接与统计验证

0.6.0 / versionCode 8 的日常 debug、Dev 和测试 APK 构建通过。44 项 JVM 测试全部通过，无失败或跳过；lint 为 debug 0 error / 99 warning、Dev 0 error / 103 warning。两包通过 16 KiB ZIP 对齐及实际 APK 签名校验，继续使用上文兼容证书。下表为历史本机调试产物，构建路径已被后续版本覆盖，不能代替正式 release 的签名发布清单：

| 版本 | 文件（相对 `apps/android`） | 字节 | SHA-256 |
| --- | --- | ---: | --- |
| 日常 debug | `app/build/outputs/apk/debug/app-debug.apk` | 33,779,319 | `c61b6e48935a22d2c80b037a1e34462b123b45419185bb516ca69897732b950e` |
| Mote Dev | `app/build/outputs/apk/development/app-development.apk` | 33,779,631 | `f16e579dc28a54b76c25c661f5cd1523e1475e2499882e7b2a146b104eacb401` |

新增 JVM 验证涵盖邀请 JSON / URI 的严格解析、危险地址和过期/超限输入拒绝、生成二维码的真实 ZXing 解码、统计持久化与损坏重建，以及重复入队/ACK 不重复计数。

专用 `mote_fixture_api35` / API35 上运行 `ConnectionInstrumentedTest`，5 项全部通过、无跳过。实际通过生产 HTTP 客户端连接隔离中央：兑换、一次性邀请重放 410、采集凭据访问管理接口 403；撤销后心跳 401 正确显示认证失败，离线队列和已准备笔记保留；同源绑定邀请恢复后原设备 ID 不变，2 条生成笔记与 1 张生成 PNG 均获 ACK。诊断关闭仍有统计，同 ID 的重复入队只增加一次。另验证外部 URI 不自动连接/申请相机、活动同步阻止改节点、晚到的投屏同意不能跨连接变更启动，以及配对返回首页后手动改节点清除旧凭据。

连接测试需显式提供 Dev 私有目录 `files/connection-live-fixture.json`，内容为隔离测试服务的 `{serverUrl,token,generatedOnly:true}`；测试只接受专用 arm64 API35 AVD 的 Dev 包和 loopback 地址，没有文件时对应实连项会跳过。该次服务端口为 54008，用 `adb reverse tcp:54008 tcp:54008`，不是默认生产地址。测试前后停止采集，清理私有连接文件并恢复原设置；测试结束关闭本次专用模拟器。可复跑入口：

```sh
adb -s emulator-5580 shell am instrument -w \
  -e class dev.mote.collector.ConnectionInstrumentedTest \
  dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner
```

UI 验证仅绘制生成数据的原生统计界面，未采集个人屏幕。相机链路只验证生成二维码解码与按需授权边界，**未测试物理相机扫码、K90 Pro Max / HyperOS 真机、长时间后台调度**；本轮没有新增真实模型调用。原有截图、Qwen、来源与更新路径的历史验证见后文，不能视为本轮全部重新实跑。

## 历史 0.5.0 应用更新验证与产物

0.5.0 / versionCode 6 已完成日常 debug 与 Dev 构建、40 项 JVM 测试（0 失败、0 跳过）、两种安装包 lint（0 error / 81 warning）和 16 KiB ZIP 对齐。`apksigner` 实际验证两包签名通过，证书与上文 0.4.0 兼容身份一致。以下为历史本机调试产物，构建路径已被后续版本覆盖；正式发布的非 debuggable release 由发布流水线独立签名和校验，不能用本表代替发布资产清单：

| 版本 | 文件（相对 `apps/android`） | 字节 | SHA-256 |
| --- | --- | ---: | --- |
| 日常 debug | `app/build/outputs/apk/debug/app-debug.apk` | 32,882,579 | `7bae184cfa933c0fd3d5510c9017a6d586050b5e2613e855dac7b03e5b30e6ba` |
| Mote Dev | `app/build/outputs/apk/development/app-development.apk` | 32,459,347 | `54d90895f00f793489c48372afc231df2037c301047f387922a6e4ddb5496950` |

新增 JVM 测试使用生成的 RSA 密钥、签名清单和 HTTP 连接 fixture，覆盖原始 payload 验签、仓库/渠道/tag/版本绑定、错误签名/资产身份/来源拒绝、严格 SemVer、HTTP Range 断点恢复、文件 SHA 错误及不可信重定向。网络 fixture 不访问 GitHub，也不发布文件。

专用 `mote_fixture_api35` / Android API35 实跑 `AppUpdateInstrumentedTest`：实际已签名 APK 验证、错误包名/证书/降级/篡改拒绝、原生页面不自动请求网络或安装权限，加上显式取消场景，共 3 项通过（2.694 秒）。取消场景在真实 APK 验签完成、创建系统会话之前设置线程屏障，并在锁仍被占用时取消；另验证排队任务取消与重复点击。两个已取消请求均未创建或提交安装会话。首次测试曾把 Android 异步取消尚未移除的旧会话误计入基线，补充等待系统完成后复测通过。

覆盖更新使用私有合成 `0.5.1-dev / code7` APK，由同一 APK 证书签名，配套清单由实际内置 RSA 发布密钥签署但未发布。先在 code6 保存合成设置、设备 ID、加密待上传笔记、草稿和模型目录哨兵，再通过生产 `PackageInstaller.Session` 提交（1 项通过，2.952 秒），在系统显示的 **Mote Dev / Update** 确认页点击更新。随后 PackageManager 实际显示 code7，独立验证阶段通过（1 项，0.049 秒），五类状态指纹逐项相同；队列仍是原 ID 的无图记录。验证结束清理本次合成记录与哨兵，并撤销测试专用的安装/通知授权。未卸载应用、未清除应用数据。

code7 仅保存在 ignored 的本机测试目录，该轮结束时源码与正常构建输出曾恢复 `0.5.0 / code6`。该轮没有公开 fixture、实际 GitHub Release 下载、真实模型调用或个人屏幕采集。APK 网络下载用连接 fixture 验证，真实系统安装用私有文件验证，这两项不能合称已跑过公开 GitHub 下载到安装的完整链路。未测试 K90 Pro Max、HyperOS 安装校验、长期后台下载或正式 release 的真机覆盖行为。

## 历史 0.4.0 来源同步验证与产物

0.4.0 / versionCode 5 曾完成 `assembleDebug`、`assembleDevelopment`、开发版测试 APK 构建、36 项 JVM 测试（0 失败），两种安装包 lint 均为 0 error / 48 warning，并通过 16 KiB ZIP 对齐。开发版显示版本为 `0.4.0-dev`。以下为历史产物（路径相对 `apps/android`），构建路径现已被后续版本替换：

| 版本 | 文件 | 字节 | SHA-256 |
| --- | --- | ---: | --- |
| 日常 debug | `app/build/outputs/apk/debug/app-debug.apk` | 32,233,076 | `c5fd94cc55d4169ef1a393f80b667d516aa54b374253d57566f5ba3a79ffd71d` |
| Mote Dev | `app/build/outputs/apk/development/app-development.apk` | 32,233,368 | `0e6792f7e7c26e9860248bc0b3370b8d5ccb20e75993b526a1998baa4cee3d80` |

最终开发 APK 在专用 `mote_fixture_api35` / API35 上执行 `LocalSourcesInstrumentedTest` 三项测试，全部通过、无跳过（1.338 秒）。使用 debug 专用生成 Provider 验证日历计划时间与观察时间分离、文件 Unicode 原文、引用模式不读正文、隐藏/失败/部分扫描不误删；原生页面不提前请求日历权限。通过生产 `HttpJson` 对隔离的真实中央服务完成文件和日历注册/更新、丢 ACK 后重建加密状态并幂等重试、删除再恢复，以及三版本历史和当前正文回读。

测试没有查询个人日历或文件、没有截图、没有调用真实模型。本轮未实测真实 SAF 选择器授权、生产 WorkManager 长期调度、OEM 日历提供者兼容性或 K90 Pro Max/HyperOS 后台行为；传输与本机状态机测试不能替代这些真机检查。以下命令默认只运行生成 Provider 和 UI 测试；真实中央测试必须另行在 Dev 私有目录放置隔离节点连接文件，没有文件时该项会跳过，不能声称完整链路通过：

```sh
apps/android/gradlew -p apps/android -Pmote.testBuildType=development \
  :app:assembleDebug :app:assembleDevelopment :app:assembleDevelopmentAndroidTest \
  :app:testDebugUnitTest :app:lintDebug :app:lintDevelopment
adb -s emulator-5580 install -r apps/android/app/build/outputs/apk/development/app-development.apk
adb -s emulator-5580 install -r apps/android/app/build/outputs/apk/androidTest/development/app-development-androidTest.apk
adb -s emulator-5580 shell am instrument -w -e class dev.mote.collector.LocalSourcesInstrumentedTest \
  dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner
```

## 历史 0.3.0 环境隔离验证

0.3.0 / versionCode 4 曾完成日常与 Dev APK 构建、29 项 JVM 测试（无失败/跳过），两 variant lint 均 0 error / 38 warning，两个 APK 均通过 16 KiB ZIP 对齐校验。下表为历史记录，这些构建路径现已被后续产物替换：

| 版本 | 文件 | 字节 | SHA-256 |
| --- | --- | ---: | --- |
| 日常 debug | `app/build/outputs/apk/debug/app-debug.apk` | 31,803,132 | `2128bbf5c6ccca8fedc5ee94ba1a1845c0a7a89bef4d72a5cfd7aab51c1738da` |
| Mote Dev | `app/build/outputs/apk/development/app-development.apk` | 31,803,136 | `31a6c4d0983341a8b2c5d9d956d7af97feb998e399eec392ebdbf492e89fc741` |

专用 `mote_fixture_api35` 上实测两个包同时存在，Dev 默认节点/稳定设备 ID/私有目录独立，未继承原草稿、队列或令牌；原生 Activity 的环境/实际目录和支持导出入口已验证；支持包排除合成令牌、笔记、心情、策略、URL 和设备 ID；关闭诊断不再新增事件。并装验证前后，原日常包关键配置与私有文件 SHA 相同。只使用合成内容，没有启用截图，也没有重新运行模型或进行 K90 Pro Max 真机验证。

可重复的 Dev 专用测试（仅该专用 AVD、未配置令牌且无队列/草稿时运行）：

```sh
apps/android/gradlew -p apps/android -Pmote.testBuildType=development :app:assembleDevelopment :app:assembleDevelopmentAndroidTest
adb -s emulator-5580 install -r apps/android/app/build/outputs/apk/development/app-development.apk
adb -s emulator-5580 install -r apps/android/app/build/outputs/apk/androidTest/development/app-development-androidTest.apk
adb -s emulator-5580 shell am instrument -w -e class dev.mote.collector.ProfileSupportInstrumentedTest dev.mote.collector.dev.test/androidx.test.runner.AndroidJUnitRunner
```

## 历史采集链路验证边界

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

- [Android PackageInstaller](https://developer.android.com/reference/android/content/pm/PackageInstaller)：系统安装会话、结果回调与用户确认。
- [PackageInstaller.SessionParams](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams)：完整 APK 安装与 `USER_ACTION_REQUIRED`。
- [Android apksigner](https://developer.android.com/tools/apksigner)：APK 签名验证与证书检查；文件 SHA 校验不能替代 APK 签名验证。
- [Android Calendar Provider](https://developer.android.com/identity/providers/calendar-provider)：日历权限、日历选择与实例查询。
- [Android Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)：系统文件/目录选择与持久 URI 权限、受限目录。
- [CalendarContract.Instances](https://developer.android.com/reference/android/provider/CalendarContract.Instances)：限定时间范围查询展开后的日程实例。
- [Android AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService)：用户控制服务启用、`takeScreenshot` 与截图能力声明。
- [Android MediaProjection](https://developer.android.com/media/grow/media-projection)：前台服务类型、单次授权、回调、调整共享尺寸、Android 15 QPR1+ 锁屏停止行为。
- [Android WorkManager 工作请求](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)：网络约束和指数退避，不保证精确执行时间。
- [ML Kit Android 文字识别](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)：随应用打包中文、拉丁识别模型。
- [Android 受限制设置](https://support.google.com/android/answer/12623953)：侧载应用敏感权限可能需用户额外操作。
- [HyperOS 自启动权限管理说明](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1624)：后台自启动需告知用户并由用户自行设置。
- [小米后台自启动入口示例](https://www.mi.com/global/support/faq/details/KA-507608/)：这是官方其他机型的示例，不能当作 K90 Pro Max 已实测路径。

## 非模型侧处理开销优化

前置跳帧、单 OCR、配置快照、通知去重、锁屏调度、独立低频心跳、逐条 ACK 批量上传和验证边界见 [Android 采集开销优化](android-power-optimization.md)。既有隐私模型保持不变。
