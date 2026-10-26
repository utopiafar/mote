# 日历范围授权与受管执行验收（2026-10-26）

本批为 G1–G3 候选，建立在 G0 `27ea7e13bf25054d3ed78d10395d9b38cbd061d7` 之上。G0 PR #249 已由协调者合入 `418693c11ac5069798eecb480f5990fb9b337b78`。本分支额外精确摘入核心依赖 `6feed3fc6b214b0a58fb4f717ae1cc4c5382b9d2` 为 `0cdc1416`，仅 app.ts featureServices 中增加 pluginCenter；最终合并不得重复该依赖。

设计输入仍为 `docs/action-capability-execution-plan.md`，SHA256 `f4dbe15bd8b17d88f199949a7299365ee53c2c5c2ddb97b2ed05bb98841a9605`；独立技术审批覆盖 calendar.create，不是本次验收批准或真实日历执行授权。

## 实现范围

- 插件声明固定 calendar.create 输入、输出、设备执行位置、风险与不邀请/不更新/不删除等约束。安装、检查、启用均不授予执行权限。授权固定发布 digest、实例与 revision、能力 digest、设备 connectionId/声明 revision、目标日历和完整来源集合。
- owner 先保存不可执行范围草稿，再明确勾选并提交授权。未保存选择在同会话导航返回后保留；服务器草稿在浏览器重载、Central 重启后保留。失败重试保留命令 identity，确认前重新核验所有固定版本。
- Central 仅对现有模型校验产生的完整、未过期、无未解决疑问的 calendar.create 派发。所有证据均须处于授权来源范围。未来输入按原件第一次 Central 接收游标，不按 capturedAt。
- 受管设备只获得自己连接的行动元数据与领取时所需事件，不获得全局建议/原文审阅权限。重配对不继承旧连接授权；旧逐条确认创建/改期/取消/完成仍保留。
- 原生持久 attempting 与回执；撤权后仅接受原 connectionId/operationId 的已有结果。崩溃后仅核实，不盲重写。领取前取消阻止写入；领取后为取消请求，迟到成功不冒称已撤销系统事件。
- 统一行动历史与资料详情复用同一 action ID，支持由资料定位该条历史。Mac/Android 消费者接入受管通道；Mac 新连接入口只声明能力，未隐式追加立即执行触发。

## 本批实际验证

| 检查 | 结果与边界 |
| --- | --- |
| `node --import tsx --test apps/server/test/action-grants.test.ts` | 4/4；真实安装/检查/启用控制面，生成 GitHub release transport；显式授权、撤回、实例变化、严格声明与配额原子回滚 |
| `node --import tsx --test apps/server/test/managed-calendar.test.ts` | 9/9；实际 buildApp + loopback HTTP + 配对 + SourceStore/模型fixture + Mac CalendarActions + 临时持久账本。系统日历API替换为合成adapter，不调用真实日历 |
| 同上生命周期矩阵 | 无授权不执行、等待设备、一次执行、丢回执、权限撤回、OS权限丢失、领取前/后取消、迟到成功、未来输入、插件停用、Central重启、双领取、异设备/collector越权、连接撤销、重叠授权、跨来源证据、attempting崩溃、过期/证据变更 |
| `actions.test.ts actions-execution.test.ts actions-configuration.test.ts` | 31/31；既有手动创建/改期/取消/完成、模型证据与配置fence回归 |
| `plugin-control-journeys.test.ts plugin-library-contracts.test.ts` | 31/31；既有插件控制与检查流程回归，未验真实第三方服务 |
| Desktop `calendar-actions.test.ts calendar-capabilities.test.ts` | 9/9；原生APIfixture，重复/崩溃/手动更新取消保留 |
| Android `ManagedCalendarJournalTest` + `CalendarActionRulesTest` | 9/9，编译通过；4项新增真实消费类调用的JVM账本恢复测试，5项既有时间/标记/突变许可规则。无模拟器/真机CalendarProvider调用 |
| Android `CalendarCapabilityPublisherTest` | 本轮前段2/2通过，后续未修改publisher，复用结果 |
| Web（在 apps/web 工作目录）`library-browser.test.ts resource-views.test.ts` | 58/58；两个就近结果插槽的资料/原件/跨节点导航回归 |
| `electron apps/web/test/calendar-browser.cjs` | 隐藏Chromium真实React组件，HTTP生成fixture；空/加载/保存失败重试/明确勾选/草稿返回与重载/离线等待/取消/同ID结果/读取错误。截图仅存ignored `.mote/calendar-managed/`，已人工检查 |
| 构建与静态检查 | shared构建，Web/Server/Desktop类型，8670条中英catalog同步、diff whitespace；Web生产构建见本批最终命令记录 |

首次Web详情命令误在仓库根目录运行，JSX配置错误导致 React undefined；改到 apps/web 后仅剩新端点fixture缺项2例，补齐端点并加入异常响应明确报错后58/58。浏览器首次等待失败为fixture只刷新设置区，改为同时刷新行动列表后通过。无放宽产品断言。

`check:affected --base 27ea7e13 --dry-run` 因跨三端与shared合同粗粒度选出 check:local 和全部Android测试；按所有者“小批仅受影响模块”要求不重跑全量，使用以上精确计划。G0已有测试及五项成功CI不是本批新增运行。G1–G3仍须独立代码审查与候选CI。

## 自主工程决策

1. 重叠有效grant不任意选择插件/目标，保留逐条审阅；只自动接受无模型uncertainty的完整事件。
2. 原始采集来源用结构化device/platform/source元组哈希，不能用语义关键词推断授权。
3. 插件设备能力检查只证明宿主固定合同，明确不代表OS权限或owner执行授权；不执行任意插件脚本来取得日历权限。
4. 撤权不丢已持久回执；恢复不扩大数据读取或写入权限。原生缓存位于现有私有账本，Android沿用加密存储。
5. 资料详情仅添加独立结果组件插槽，未更改原件/资料生命周期；选择/重启恢复沿用现有当前格式，不加迁移。

## 未关闭的边界与阻塞

- 自动审批拒绝（确认未执行）：拟在 `apps/desktop/src/main.ts` 的 `mote:action-calendar-connect` 处理器 `connect()` 后调用 `deliver()`，并改连接按钮文案为明确连接并同步。理由为该触发点可能产生真实日历外部写入，而本轮禁止真实建日程。未通过其他按钮、路径、执行者或工具绕过。现状连接仅声明；`syncMode=manual` 的立即受管同步入口仍未闭环，等待父针对触发点的新相关授权/产品决定。已完成的后台自动模式消费者与隔离fixture不受此项影响。
- 未进行物理设备、真实模型判断、真实第三方插件服务或真实个人日历写入；Android本批为编译/JVM证据，不冒称模拟器受管CalendarProvider旅程。
- 第三方脚本自行联网仍是所有者指定仅记录的已知问题；宿主能力授权不是网络沙箱。本批没有真实私密数据外传。
- 未部署、发版、清真实数据、扩凭据权限、修改main或占用共享模拟器5580/服务47886/47862。所有Hold范围未实施。
