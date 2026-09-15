# Android 通知、设备事件与采集记录

## 来源结构和上传

通知与设备事件使用现有加密采集队列和 `POST /api/captures`，设备凭据只可写入自身设备；原始事件 ID 重试保持不变，中央端幂等确认后清理本机副本。沿用 Wi-Fi、实时/定时/批量/手动同步和存储上限，不另开上传通道。

共同字段：`id`、`deviceId`、`deviceName`、`platform=android`、`capturedAt`（观察时间）、`durationMs=0`、`privacy`。`metadata.version=1`，`collector.method=notification_listener`；`metadata.observation` 包含随机观察会话 ID 和开机后的单调时钟毫秒数。进程/连接中断不补造历史。

- `source=notification`，`metadata.notification`：`action=posted|updated|removed`、通知键 SHA-256、平台发布时间、`ongoing`、`groupSummary`、可选应用声明的 `category`。完整内容模式记录可获取的通道、标题、正文、展开正文、补充文字和最多 20 行正文。字段有长度上限；不序列化任意 extras、图片、PendingIntent 或操作按钮。移除事件只带状态和系统原因代码，不重复正文。
- `source=device_event`，`metadata.deviceEvent`：`action=screen_on|screen_off|user_present|state_observed`，以及系统报告的 `keyguardLocked`、`screenInteractive`。广播到达时观察，熄屏后一秒再检查，并在服务的 30 秒周期检查状态变化。`state_observed` 不是精确锁定时刻；`screen_off` 不表示已锁定。

平台第一次投递的通知标为 `posted`（首次观察，可能已经存在），同键后续变化标为 `updated`；进程内最多缓存 512 个键的指纹，完全相同的重复投递不重复入队。服务断开、停止和重新配置后重置观察状态。不从通知关键词推断导航、消息意图或用户行为，模型通过只读检索解释原始证据。

## 控制与权限

新增通知、设备事件两个独立开关，升级默认关闭，由用户开启并开始采集。通知使用权四类不再被 Manifest 禁用；旧系统保存的筛选可能需要用户重新授权或逐类开启。所有采集共用一条 Mote 状态通知和停止按钮。Mote 自身通知不再回流采集，避免递归。

通知遵循应用规则：`off` 完全跳过，`activity` 不读取文本 extras 或通道，`content` 保存系统实际提供的字段。设备级状态不归因于某个应用。提交前再次验证配置、采集状态、权限、节点切换和电量策略。事件必要字段独立于可选设备遥测开关。

Android/HyperOS 可以隐藏敏感通知、限制工作资料或终止服务；缺失不表示没有事件。未回放现有通知或锁屏历史。通知移除不代表已阅读，系统 category 不证明用户正在执行对应活动。

## 浏览体验

应用管理参考 Android Digital Wellbeing 的按应用选择方式：显示应用名、包名及有效记录方式，支持搜索和按状态筛选，选择后留在管理页，保存统一生效。默认方式明确作用于未单独设置和以后安装的应用。

采集记录提供网格/列表切换并记住选择。首屏立即放占位，缩略图最多 3 个并发、逐张更新、失败点按重试；缩略图短超时。12 MiB Activity 内存 LRU 缓存不落盘，配置变化和退出时清空。按日期/来源的本机索引仅缓存有界的时间和类别，翻页只解密当前页正文。初次冷启动仍需扫描队列元信息。

## 参考

- https://developer.android.com/reference/android/service/notification/NotificationListenerService
- https://developer.android.com/reference/android/content/Intent
- https://developer.android.com/about/versions/15/behavior-changes-all
- https://support.google.com/pixelphone/answer/9137850

只用生成数据验证；HyperOS 真机、真实个人通知与实时模型测试需分别记录，不以单元测试代替。

## 本次验证结果

- Android development Kotlin 与 instrumentation 测试代码编译通过；92 项 JVM 单元测试通过；lint 通过。
- 共享协议 23 项、服务端 147 项、查询代理 57 项测试通过；中央端与网页 TypeScript 类型检查通过。
- 服务端新增生成通知/设备事件测试覆盖设备凭据上传、同 ID 重试、设备隔离、正文隐私校验、检索、来源筛选以及导出恢复。
- 未执行模拟器界面测试、HyperOS 真机采集、真实模型调用或部署。没有采集个人截图/通知。
