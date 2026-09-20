# 原始日志与日志中心

Web、桌面、Android 日志查看器直接读取文件文本，不解析 JSON、不翻译字段、不重新排序。损坏或未完成的文本也保留显示，便于排查写入问题。支持手动刷新、选择文本、全选、复制全部和切换自动换行。剪贴板不可用时，Web/桌面会全选并提示键盘复制。

- Web：开发者选项 → 日志中心；选择 `central.0.ndjson` 当前文件或编号更大的历史轮转文件。API 为 `GET /api/diagnostics/logs?file=0`，只允许管理身份，返回 `text/plain`，禁止缓存。固定文件编号与单文件大小上限限制读取范围。
- 日志中心支持按阶段筛选并分页；阶段是新增的兼容字段，旧日志会按事件名前缀回退推导。分页 API 可追加 `stage=system|request|ingest|index|agent|source|maintenance|file|unknown`，省略或使用 `stage=all` 保持原行为。
- 桌面：开发者选项 → 查看本地日志；读取 `events.json`，上限 256 KiB。
- Android：本地日志查看器；读取应用私有 `support-events.json`，上限 256 KiB，长按选择复制。

日志在写入端带级别：阶段开始为 debug，成功/停止/正常过滤为 info，等待调度或缺少权限/模型等状态为 warn，操作失败为 error。中央节点的 4xx 阶段失败为 warn，5xx 为 error；debug 事件需要开启中央调试日志。

本次补充了中央请求开始及来源/配置等路由标识、桌面模型审查/OCR/隐私审查/入队/上传阶段，以及 Android 模型审查/OCR/隐私审查/入队阶段。已有请求完成、失败、服务生命周期、索引、查询与维护日志继续保留。

原始展示和支持包是两个不同入口：日志查看器保留文件原文；安全支持包继续使用固定字段白名单。日志生产端仍不记录截图、OCR 原文、令牌、模型对话或任意异常文本。端点诊断开关和既有保留上限继续生效；旧日志不会在查看时重写或补级别。

## 验证

使用合成数据验证原文（含空白、中文、损坏 JSON 和 HTML 字符）保真、读取上限、级别持久化、鉴权、日志轮转和复制/选择行为。Android 编译与 JVM 单元测试不等同于 Android 真机界面验证；未进行真机采集或真实模型调用。

## 0.0.23 新主线复查

- 中央文件 API：`file_upload`、`file_part`、`file_commit`、`file_revision` 有开始/完成/失败事件；请求另含 HTTP 方法和固定路由类别。
- 中央文件处理：`file.started/completed/failed` 含文件任务 UUID、批次请求 UUID、尝试次数与耗时。可重试失败记录 `retryAfterMs`；达到尝试上限不会声称还有下一次重试。`file.step.*` 区分 extract、diarize、align、turns、summary；`file.cached` 表示复用已完成检查点。
- `file.blocked` 使用固定原因（未配置、仅归档、不支持格式、每日预算、本地处理禁止云摘要等）；配置更改或停机导致的取消记录 `file.cancelled`，不作为模型故障。
- Android：后台界面任务、文件扫描/准备/上传/分块/提交和批量去重记录固定阶段、耗时与结构化失败类别，不记录 UI 标签、文件路径、文件名或服务响应。
- 桌面：来源扫描与设置、连接、更新等后台操作增加阶段日志。HTTP 失败保持 AUTH/CONFLICT/SERVER 等传输类别。
- 复查并修复 `UiTask` 的执行器拒绝分支：拒绝结果走正常界面完成回调，清除忙碌状态；新增合成仪器回归。原日志分页/级别筛选测试更新为原文保真和文本选择测试。

端点日志须启用本机诊断开关；中央 debug 开始事件须开启 debug 级别。Android 实际日志文件为应用私有 `support-events.json`。
