# 客户端行动优先重构验证

日期：2026-10-11。产品版本：macOS 0.0.85、Android 0.0.85（versionCode 96）。

设计依据为 [客户端行动优先 ADR](../adr-client-action-first.md)。测试只使用临时 profile、生成文件与记录，以及新建的 `mote_fixture_api37` 模拟器。Android 预览由应用自身 `View.draw(Canvas)` 生成；保留 `FLAG_SECURE`。

## 用户旅程与状态矩阵

| 旅程 | 关键组合与期望 | 验证层级 |
| --- | --- | --- |
| 首次进入 | 没有连接、没有内容；首页四个平等动作，不自动请求权限或开始屏幕记录 | 原生 UI fixture |
| 添加文件夹 | 原生选择、取消、重复范围、历史范围与保留方式确认；默认持续同步 | UI 与来源状态回归 |
| 导入文件 | 默认一次；固定字节后修改原文件、离线、重启与失败重试仍使用同一版本 | 来源状态与传输 fixture |
| 持续文件 | 明确勾选持续同步后发现新修改；原有来源保持行为 | 来源状态回归 |
| 内容阅读 | 笔记、屏幕、文件的本机原文、来源与接收凭据从内容打开；ACK 与中央整理状态分开 | UI 与中央合成响应 |
| 权限失败 | 屏幕拒绝不影响文件与笔记；来源失败定位对应范围，待传副本不删除 | 原生 UI fixture |
| 暂停 | 屏幕、单来源、全部发送各自控制；暂停发送保留策略，记录与扫描继续，恢复不改模式 | 调度与 UI fixture |
| 草稿与返回 | 页面切换、系统权限返回、Activity 重建、未保存设置确认、笔记恢复 | 原生 UI fixture |
| 中央身份 | 同节点授权恢复、跨节点待传保护、权限撤销清理中央私有视图 | 连接与会话回归 |
| 布局与键盘 | Mac 最小窗口、Android 窄屏、大字体、键盘，焦点和统一主导航 | 原生生成预览与 UI fixture |

## 实际执行结果

所有验证使用生成资料；没有调用真实模型，也没有读取个人屏幕或文件。

| 检查 | 实际结果 |
| --- | --- |
| 实现基线 `npm run check:affected` | 按共享翻译与 lockfile 的消费者范围执行全量 TypeScript 构建、类型和脚本检查：2,558 项通过、2 项显式跳过；中央监督进程 fixture 通过；Android Debug 单测通过。 |
| 追加改动的 affected 检查 | 以 `af224b4` 为基线检查桌面和 Android，以 `51d3bb4` 为基线再次检查最后的 Android 夹具改动；均通过。最终桌面为 54 个文件、422 项测试通过。 |
| 翻译 | 6,649 条双语文案及 TS/Kotlin 调用点检查通过，Android English catalog 同步。 |
| 桌面构建与 UI | build/typecheck 及 `ui-smoke`、`complex-ui-smoke`、`sync-history-smoke`、`connection-smoke`、`offline-sync-smoke`、`central-smoke` 均通过。含最小窗口、输入法、共享内容阅读、真实 main/preload IPC 和临时 Central SQLite 收据。 |
| 桌面权限撤销 | 新增 6 项回归；真实 HTTP 401/403 经 main/IPC 清空中央正文、元数据、图片并关闭详情，晚到响应不能恢复。保留本机阅读器及临时网络失败行为。 |
| Android JVM | Debug、Development 单测各 286 项、61 个测试类通过；最后的 affected 检查再次验证 Debug 消费者。 |
| Android 构建与 lint | `assembleDevelopment`、`assembleDevelopmentAndroidTest`、Debug/Development lint 通过；每个 lint variant 为 0 error、204 warning。 |
| Android 默认 UI 与本机旅程 | API 37 上默认组 61 项通过，2 项需要独立中央夹具的测试显式跳过；后续两项均在下方补充组实际通过。 |
| Android 窄屏与键盘 | 320dp、130% 字号下首屏、共享导航渲染、键盘共 3 项通过；默认尺寸稳定渲染再次通过。实际布局与生成 PNG 核对了页头、四个动作、折叠状态和键盘上方的导航。 |
| Android 中央补充旅程 | API 37 上 22/22 通过、0 跳过：生成采集记录 3、支持包 1、原生中央 11、登录生命周期 4、笔记上传 1、实际来源丢失 ACK/删除恢复 1、实际重新配对 1。独立核对中央笔记、来源版本链和队列 ACK；Crash buffer 为空。 |
| 版本与文档 | macOS/Android `release:verify` 通过；Markdown 链接、格式及 diff whitespace 检查通过。公开产物另由组件发布流水线校验身份和签名。 |

全量检查的两个跳过项分别要求显式启用 Python OS sandbox 和提供本机 Codex 二进制，并非通过记录。历史原生夹具最初因 API 35 环境名、语言、旧导航断言、未等待布局及跨组合成数据污染而失败；已保留初始日志，适配明确的生成环境并按最终入口重跑。API 37 是本轮实际执行环境；API 35 未执行。

桌面 fixture 日志保存在 `/tmp/mote-desktop-*-final.log`、`/tmp/mote-desktop-feed-auth-*.log`；Android 默认与窄屏结果在被 Git 忽略的 `apps/android/app/build/reports/action-first-ui/api37-final/`，中央补充命令、日志及证据在 `/tmp/mote-native-api37-qa/summary.json`。这些本机临时文件不作为公开附件，也不写入源码。

## 未执行的验证

物理设备屏幕采集、系统授权与 OEM 后台长期运行、真实文件提供方、真实模型输出质量与费用均需单独验收。合成资料与模拟器结果不能替代这些检查。
