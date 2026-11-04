# Web 后台刷新稳定性回归

中央网页首次读取需要明确的加载状态；已经读取过的同一范围在后台更新时，应保持列表、详情、空状态说明与正在编辑的内容。此次审计从问一问的「正在读取」闪动扩展到资料库、内容页及设置页，区分首次读取、后台重验和用户主动切换范围。

修复范围是显示稳定性及重复读取：不冻结实际请求的时间范围，不修改轮询间隔、授权、删除语义或写操作的版本核验。`Resource.loading` 仍表示实际请求状态；显示端只在没有当前可读数据时重放首次加载。分页、防止重复提交，以及必须等待当前版本核验的操作仍可在请求期间禁用。

## 审计范围

| 页面或公共路径 | 发现并处理的问题 |
| --- | --- |
| 问一问、需要你补充 | 历史和详情后台读取重放加载并锁定输入；空补充区在轮询时反复出现；恢复已完成运行重复刷新历史。 |
| 采集记录、截图分组 | 页面版本刷新清空现有记录；记录列表刷新丢失当前页；空结果重复显示加载。 |
| 资料库全部资料、应用活动、媒体播放 | 订阅读取后立即重复刷新；媒体随页面版本重新挂载；滚动时间范围改变 URL 后丢失已读展示。 |
| 随手记、来源资料与版本、文件归档、工作问题说明 | 后台读取隐藏已有内容或空状态；累计旧页需要在切换身份或撤权后清除；保留真实分页和作用域变化的读取状态。 |
| 记忆、洞察、导入 | 列表和空状态重放首次加载；正式资料预览在重验时消失并误报版本变化；洞察完成状态触发重复读取和通知。 |
| 模型连接、文件与语音设置、诊断日志 | 非零页面版本首次进入重复读取；两个本地音频模型各自启动相同轮询；诊断后台刷新反复禁用已读日志筛选。 |

另核对了已有稳定模式：活动中心工作列表按 `loading && !data` 显示首次加载，空状态基于已读数据；连接清单、正式资料浏览器及执行队列保留已读展示；运行、感知和 Memory 设置保留未保存草稿及其原始版本。相关既有回归仍需运行。资料纠正、原件切换或权限变化时主动撤下旧正文的行为属于正确的版本与授权保护，不能为了消除闪动移除。

## 必须覆盖的状态

| 状态或转换 | 验收依据 |
| --- | --- |
| 首次进入、首次打开详情 | 请求未返回时显示加载；不提前显示「没有内容」；需要详情的操作等待首次授权读取完成。 |
| 同一范围后台刷新，结果非空或为空 | 已有 DOM、详情、说明及编辑草稿保持；问答输入可继续使用；返回更新后正常展示最新结果。 |
| 滚动时间窗口推进 | 只有调用方显式提供稳定 `rangeSelectionKey` 时保留同一逻辑时间和设备选择的展示；请求 URL 仍使用推进后的端点。记忆还需以查询、分类、层级、状态、历史时间及游标隔离。 |
| 改时间段、设备、筛选、分页、API 身份或随手记命名空间 | 不把旧范围当作新范围结果；未读页面仍有加载；分页按钮避免重复请求。未提供逻辑选择键的不同精确时间范围不得共享保留展示。 |
| 慢请求、迟到成功或失败 | 旧范围、旧身份和已卸载页面的回复不能替换当前展示；重复更新提示不能不断取消同一慢读取。 |
| 撤权、删除或版本失效 | `401/403/404/410` 撤下失效数据，包括已展开或累计的旧页；再次读取期间不能复活它们。临时传输错误保留允许展示的数据并明确报错，不伪装为空结果。跨 URL 暂存的旧展示在新请求失败后撤下。 |
| 运行完成、取消及重连 | 完成结果只触发一次必要的历史更新与通知；取消不被迟到的运行状态覆盖，也不自动重新发起任务。 |
| 首次订阅已有页面版本、版本随后推进 | 首次订阅只读一次；同次切换 URL 不额外取消再读；仍选中的资源收到后续版本时正常重验。共享读取的多个订阅者不得制造重复请求。 |
| 两个音频模型同时准备 | 每个周期共用一次模型状态读取；任一模型仍准备时继续，全部就绪后停止。 |

## 回归入口

| 测试文件 | 主要覆盖 |
| --- | --- |
| [resource-cache.test.ts](../apps/web/test/resource-cache.test.ts)、[resource-lifecycle.test.ts](../apps/web/test/resource-lifecycle.test.ts) | 缓存、订阅、轮询、慢读取、身份与逻辑时间选择隔离；记录当前页刷新。 |
| [read-state-closure.test.ts](../apps/web/test/read-state-closure.test.ts)、[owner-questions.test.ts](../apps/web/test/owner-questions.test.ts) | 问一问输入、恢复运行、空补充区、分页与撤权。 |
| [content-background-refresh.test.ts](../apps/web/test/content-background-refresh.test.ts) | 记忆、洞察、导入的首次与后台读取、滚动时间、选择和完成状态。 |
| [library-background-refresh.test.ts](../apps/web/test/library-background-refresh.test.ts) | 分组、媒体、应用活动、随手记与工作问题说明的持续展示。 |
| [settings-background-refresh.test.ts](../apps/web/test/settings-background-refresh.test.ts) | 来源资料与版本、模型连接、共享音频模型轮询、诊断筛选。 |
| [archive-pagination-scope.test.ts](../apps/web/test/archive-pagination-scope.test.ts) | 来源和文件累计分页的身份、筛选、撤权、重试与迟到回复隔离；文件空状态刷新。 |
| [resource-views.test.ts](../apps/web/test/resource-views.test.ts)、[import-ui-closure.test.ts](../apps/web/test/import-ui-closure.test.ts)、[manual-memory.test.ts](../apps/web/test/manual-memory.test.ts) | 既有详情、原件、导入、提取操作、版本核验及身份切换保护。 |

从仓库根目录运行 Web 测试及正式打包入口的隐藏浏览器检查：

```sh
npm test -w @mote/web
npm run build:central
./node_modules/.bin/electron apps/web/test/ask-loading-browser.cjs
```

[浏览器脚本](../apps/web/test/ask-loading-browser.cjs)使用生成 HTTP 回执、独立临时 profile 和随机 loopback 端口，加载实际 Web main 入口；不读取日常中央节点，不采集个人截图，不调用外部模型。通过隐藏渲染器观察慢读取期间的 DOM、焦点、草稿与加载状态，并覆盖真实路由和页面刷新。结果写入被忽略的 `.mote/web-ask-loading/`。后台执行约束见[开发说明](testing-runbook.md#background-testing)。

这份文档记录回归要求和审计范围，不代表当前提交已经通过全部检查。PR 前仍按[影响范围](testing.md#early-integration-and-candidate-checks)运行 `npm run check:affected`，并记录对应代码版本的实际测试结果。生成 DOM 测试、隐藏浏览器检查、运行中的个人部署、实体设备及真实模型验证分别报告；前两项不能证明后几项已验证。
