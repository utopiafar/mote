# P4-G/M：受管行动执行合同（待独立审查）

2026-10-26。基线为 `f67ee447e0c6a6c222275208978459fb89a35581` 上已有的 8 文件能力声明/不可执行草稿改动。本文是下一批实现的审查输入，不表示批准或验收通过。产品决定以 [UI 旅程第 2 节 H 和第 6 节](ui-user-journeys.md) 为准。父任务负责独立审查与合入。

## 当前真实边界

- `ActionCapabilities` 只有声明、草稿、撤回与幂等回执；所有草稿 `executionEnabled:false`。没有授权激活、插件消费者或设备派发消费者。
- `connectionIdentity()` 保留配对 owner/collector 的设备身份；`credential()` 刻意把 owner 映射为 undefined，不能用于声明设备的身份判断。Web owner token 本身不是设备声明凭证。
- 既有 `Actions`、Mac `CalendarActions` 和 Android `CalendarActions` 已支持逐条确认、设备投递、本机 attempting 账本、结果不确定与回执。新的范围授权不能通过把 reviewDeviceIds 当执行权限来实现。
- 插件中心已有包的 source.digest、安装实例、revision 和已验证能力；没有本任务要求的行动输入/输出、风险、执行位置与授权范围合同。Mem0/Hindsight 的存储能力不等于日历执行能力。
- 声明与草稿目前 pin 设备声明 revision，尚未 pin 插件。不可执行草稿不是 grant，不能把它直接改为 active 来跳过授权界面。

## 建议切片与消费者依赖

| 切片 | 改动与消费者 | 需要协调的文件 |
| --- | --- | --- |
| G0 声明消费者 | Mac/Android 在用户连接日历后，通过本机配对身份读声明 revision，再发送权限及可写日历。权限撤回时声明 required/空列表；不弹新系统权限，不自动授权 | desktop calendar-actions.ts；Android CalendarActions.kt、CalendarActionWorker.kt |
| G1 插件范围授权 | 插件发布声明包含 capability ID/version、输入输出 schema、执行位置、风险、适用约束。owner 查看安装实例与确切来源范围后一次授权；安装/启用不授予行动权限 | 插件 manifest/注册器、PluginCenter 的受信任读取接口；共享类型；Web 行动设置 |
| G2 宿主调度与设备执行 | Central 仅对通过模型与现有证据校验的完整 calendar.create 建立派发；新设备投递接口按精确 grant 与 connectionId 核验，不开放全局 review 权限 | Actions、ActionCapabilities、Connections、两端日历执行器 |
| G3 回执和展示 | 原生发送持久回执，Central 统一历史与资料/发现详情引用同一个 action ID；失败、等待、取消和不确定分别展示 | shared ActionProposal 投影、Web 行动历史及就近入口、两端消费者 |

G0–G3 同一份当前协议；不添加旧 reader、双写或迁移。不能只改 Central 而让旧 native consumer 获得新的执行授权。父协调共享文件和原生模块所有权后再动这些接口。本工程目前不补其他分支、不覆盖他人共享文件。

## 待审查的精确合同

1. **Grant** 独立于 draft：owner 命令绑定 operationId/expectedRevision、插件 packageId + source.digest + instanceId + instance revision、capability ID/version + declaration digest、设备 connectionId + deviceId + declaration revision、calendarId，以及 sourceId/kind/deviceId/platform 集合。授权包含既有归档/未来输入选择。Central 为未来输入记录授权时的接收游标；不用 capturedAt 猜测资料是授权前还是授权后到达。
2. **升级**：新增敏感能力和改变 schema/执行位置/风险不得沿用授权。第一批保守 pin 整个安装实例版本与发布 digest；任何不匹配均不新派发，并显示需重新核对。相同能力名不证明相同权限。第三方脚本可自行联网仍只记已知问题，不宣称宿主 grant 是网络沙箱。
3. **宿主校验**：模型仅提出价值、意图与候选，不选择或扩大权限。创建执行前核对全部 evidence 的真实来源、当前版本、可读状态、范围、输入游标、完整事件与未过期时间；多来源候选必须全部被 grant 覆盖。不能只检查一条引用，也不能按关键词推断行动。
4. **派发事务**：任务固定 proposal ID/version、输入 fingerprint、grant revision、插件/设备绑定、calendarId、operationId。每个 proposal version 只能产生一次操作。枚举/领取只向目标有效连接返回最小所需事件，不暴露其他来源资料。重配对不继承旧连接授权。
5. **状态**：未领取为 waiting_device；只有已授权且在线请求的目标设备可原子领取成为 executing。排队与领取再次检查授权与声明。断网保留 waiting_device，不宣称执行。成功须持久外部 ID/原生回执；错误与 uncertain 不映射成功。重复回执只能返回同一结果。
6. **取消与撤权边界**：领取前取消阻止新写入；领取后取消表示 cancel_requested，不能声称已阻止系统调用或自动删除日历事件。原生必须在写前持久 attempting；已开始的操作只能回报或 reconciliation，不能重领后盲写。撤权阻止新操作；已在途回执的接收范围限于原 operationId/connectionId，不恢复读取或写入权限。连接已撤销的设备不能借回执重新认证；Central 显示待核实。
7. **恢复与历史**：重启保留待派发/取消/attempting/回执，不能重置为可新写状态。沿用现有操作标记与就近/统一历史 action ID；不复制第二份行动记录。反馈携带来源身份；撤销仅在已有真实支持时提供，不实现 Memory 自动纠错、记录版本传播或新删除政策。
8. **保留原功能**：范围授权只覆盖 calendar.create 第一批；update/cancel/complete 保留既有逐条确认。无匹配 grant 的创建也保留逐条确认；不删按钮冒充自动执行。发邮件、购买、邀请参与者、不可信插件执行均不在本批。

## 最短集成与精确验收计划

先连 G0 + G1 + G2 最短链：真实隔离 Central HTTP → 合成配对设备声明 → owner 授权 → 现有提议校验 → 指定原生执行消费者 → 合成平台日历适配器实际返回外部 ID → Central 回执 → 同 ID 历史/就近 UI。模型输出与系统日历边界用明确 fixture；不能据此声称真实模型判断或真实外部日历写入。

- 正常/空/加载：无 grant 不执行；空日历不可授权；授权页面无伪成功；完整 grant 仅执行一次，UI 两处显示同一回执。
- 身份：owner 网页不冒充本机；owner 配对设备能自声明；collector 不能编辑 grant；其他设备/过期或撤销连接/MCP 不可读取或领取。
- 边界：插件 digest/实例/敏感能力变化、声明权限/日历变化、来源身份/证据版本变化与跨范围证据均阻止新执行。
- 时间/离线：未来输入按接收游标；过期事件不执行；设备离线保留等待；回复网络错误不产生假成功。
- 重复/恢复：并发授权和领取、operationId 冲突、丢回执、Central 与原生进程重启、attempting 后崩溃，验证不重复外部副作用。
- 取消：领取前取消、领取后取消、撤权与领取竞争、晚回执、撤销连接后的回执拒绝；UI 返回不丢未提交范围草稿。
- 存储：配额失败原子回滚，不消费命令 ID；日志与提交无令牌/真实数据。
- 选定客户端实际隐藏 renderer 验证授权/拒绝/等待/取消/结果；Android 如参与用独立模拟器端口，绝不接管 5580。真机、真实云模型、真实外部邮件/日历/购买本轮不执行。

每片只跑受影响检查与必要接口；收敛后读取 affected dry-run，父独审后再进行 Draft PR/CI 与串行合入。当前未得到此执行合同的独立 APPROVE，不把本文当作批准。
