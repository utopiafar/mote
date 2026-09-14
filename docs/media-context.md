# 锁屏、前台与后台媒体上下文

屏幕采样与媒体观察是独立的来源。Android 可选择仅屏幕、仅媒体或同时采集；总停止开关暂停两者。媒体采集默认关闭，启用后还需要系统通知使用权。无截图权限也能仅采集媒体。先升级中央节点，再启用新版手机端媒体采集；旧中央的严格协议会拒绝新来源，待发记录保留在手机。

| 场景 | 屏幕来源 | 媒体来源 |
|---|---|---|
| 解锁、播放器在前台 | 根据应用规则截图或仅记应用活动 | 记录播放会话及可观察到的前台状态 |
| 解锁、在其他应用中操作 | 采集当前前台应用 | 独立记录后台播放器；一张截图可附当时媒体快照 |
| 锁屏或熄屏 | 不请求截图 | 通知监听连接可用时继续接收媒体状态变化及采样 |
| 仅媒体模式 | 不启动截图采集 | 记录媒体，无需截图／无障碍授权；无法判断前后台时标记未知 |
| 暂停、缓冲、会话消失 | 按屏幕设置运行 | 记录状态变化，不将暂停或缓冲计入播放时长 |
| 无权限、服务断连、系统未暴露会话 | 按屏幕设置运行 | 明确区分不可用与空会话，不推断设备没有声音 |
| 总停止、媒体或元数据开关关闭 | 遵守对应开关 | 停止后续媒体采集，清除内存会话快照 |
| 应用“不记录”或排除规则 | 原有隐私规则 | 排除该播放器，不能借其他应用的截图或心跳上传其媒体信息 |
| 应用“仅活动” | 无正文与截图 | 只保留应用、播放状态、位置／时长等事实；不保留曲目、作者、专辑、章节副标题和媒体标识 |

媒体通过 Android `NotificationListenerService` 与 `MediaSessionManager` 读取系统公开的会话，使用 `MediaController.Callback` 监听变化。只访问媒体会话，不读取普通通知正文，不录音，不使用播放控制接口。会话 ID 是本次采集进程内的标识，不保存系统 session token。平台要求通知使用权，见 [MediaSessionManager](https://developer.android.com/reference/android/media/session/MediaSessionManager) 与 [NotificationListenerService](https://developer.android.com/reference/android/service/notification/NotificationListenerService)。

采集使用工作线程，媒体变化立即观察，运行时约每 30 秒采样；不保持唤醒锁。锁屏不主动停止媒体，但 Doze、厂商后台管理、强制停止、通知权限撤销、未实现媒体会话的播放器会造成缺口。短视频、网页音频和投放设备也可能暴露媒体会话，不能仅由 `playing` 断定手机扬声器在发声。

## 记录协议与时长

每次独立媒体观察使用现有 `POST /api/captures`、加密持久队列、幂等事件 ID、同步策略、ACK 与离线重试。媒体来源为 `source: "media"`，不附图片、OCR、窗口标题、心情或来源引用。

```json
{
  "id": "d4bcac62-538f-4285-b17a-18a5f3728e95",
  "deviceId": "example-phone", "deviceName": "My phone", "platform": "android",
  "source": "media", "appId": "example.player", "appName": "Example Player",
  "capturedAt": "2026-09-15T02:00:30.000Z", "durationMs": 30000,
  "privacy": {"mode": "none", "collection": "content", "excluded": false, "redacted": false},
  "metadata": {
    "version": 1, "observedAt": "2026-09-15T02:00:30.000Z",
    "collector": {"method": "media_session"},
    "state": {"screenLocked": true, "screenInteractive": false},
    "media": {"status": "available", "sessions": [{
      "sessionId": "observation-session", "appId": "example.player", "appName": "Example Player",
      "playbackState": "playing", "appVisibility": "background", "playbackType": "local",
      "title": "提供方报告的标题或章节", "artist": "提供方报告的作者或表演者",
      "positionMs": 180000, "durationMs": 600000, "playbackSpeed": 1.25
    }]}
  }
}
```

- 顶层 `durationMs` 是截至 `capturedAt` 的观察区间，范围为 0–60000 毫秒。正数只允许对应一个与顶层应用匹配的 `playing` 会话。零表示状态观察，不表示用户听了零秒。
- 会话里的 `durationMs` 是提供方报告的内容长度，`positionMs` 是播放位置，两者都不是采样时长。跳转、倍速、远程播放及重复播放不能通过位置差额转换成听书时长。
- `metadata.media.observedAt` 单独保留媒体快照观察时间；截图／心跳附带缓存快照时不会改写它。外层设备状态的观察时间可能更晚，不能用来证明媒体刚刚仍在播放。
- `metadata.media.status` 为 `available`、`disabled`、`permission_required` 或 `unavailable`。后三者必须为空会话；`available` 的空数组只表示当次没读到允许采集的会话。缺失字段与空会话都不证明设备静音。
- `playbackState` 保留 playing、paused、stopped、buffering、connecting、seeking、skipping、error、none 或 unknown。`appVisibility` 为 foreground／background／unknown；`playbackType` 为 local／remote／unknown。
- 会话最多 16 个，标题、作者、专辑、副标题及内容标识各最多 1000 字符，全部是提供方证据。协议不含程序推断的音乐／有声书分类。
- 首次观察、重启、断连、权限或策略变化、超过观测上限的缺口不补时间；不能把最后一次 playing 延长到服务恢复。锁屏／前后台变化时保守断段，避免把旧区间归给新状态。
- 截图、活动或设备报告可附同一媒体结构，只有独立 `media` 记录的观察区间进入媒体统计，避免重复计时。

## 中央检索、统计与洞察

媒体保留在原始归档，支持删除、导入导出和增量同步。可按 `source=media` 浏览、按应用筛选、以提供方标题／作者查找，并展开原始媒体字段。检索索引取自元信息，原始 `ocrText` 仍为空。

`GET /api/media-activity` 支持 `after`、`before`、`deviceId`、`appId`、`collection`、`appVisibility`、`screenLocked`、`playbackType`。时间窗口按区间交集裁剪。采集端凭据只能访问本设备，中央所有者可跨设备比较。

返回 `totalDurationMs`、`observations`、`playingSamples`、`apps`、`devices`、`visibility`、`screenLock`、`playbackType`、`availability`，及有上限的 `evidenceIds`。同设备重叠播放片段取并集，不同设备分别相加。并发应用或不同状态的分项可能重叠，不能把它们加起来代替总时间；跨设备合计也可能超过实际钟表时间。原有 `/api/activity` 只计算屏幕与前台活动，排除媒体。

Agent 新增只读 `media_activity`，MCP 对应 `mote_media_activity`；模型自行选择统计、时间线、搜索与证据工具。统计结果不会自动授予任意 ID 的证据访问权，需先在受限时间线中发现记录。所有曲目、章节等字符串仍是不可信证据，不能改变 Agent 指令或权限。

例如可询问“昨晚锁屏时哪个应用在播放”“本周观察到哪些书籍或节目”“后台播放与前台阅读有什么同时发生的情况”。模型根据提供方内容及其他原始证据解释音乐、播客、有声书，证据不足则保留未知。播放不等于听到、注意力投入、读完一本书或完成学习任务。

## 验证

自动验证使用生成的会话、状态和时间区间，不采集真实手机屏幕或播放历史。`npm run test:media-e2e` 使用实际 Harness 和本机合成模型回复，验证入库 → 媒体工具 → 原始证据 → 引用 → 归档往返，不代表真实模型理解质量。具体本次测试结果见 [媒体验证记录](media-validation.md)。

真机仍需单独检查：首次通知授权、前后台切换、锁屏／Doze、暂停和切歌／章节、不同播放器、远程投放、权限撤销、杀进程及重启、离线补传。未经执行不能将 fixture 或编译通过当成真机验证。
