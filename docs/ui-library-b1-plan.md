# P3-B / B1 文件、来源版本与 Material：执行方案

状态：PENDING 独立技术审查，产品方向已确定；不是再次询问产品取舍。
基线：`53bbdd2736191434cc75e3a8de8d8c58bb2ca3dd`（B0 / PR #248，冻结）。
工作分支：`codex/ui-ia-library-b1`。审查对象是本文件的 SHA-256 和上述基线；批准前仅做既有契约的合成测试准备。

依据：[唯一旅程与实施清单](ui-user-journeys.md#6-单一实施清单)、[技术边界审查](testing.md#risk-based-review)。
B1 完成才可将文件/来源纳入统一资料验收；#248 通过不代表 P3-B 整体完成。

## 1. 用户路径及保留项

“我的资料 / 我的记忆”仍为一级类别。本机 / Central 仅为位置或可读状态筛选，来源、类型、日期为按需筛选。
我的资料同时容纳采集记录、来源原件（包含文件）、正式 Material。Material 与它引用的原件是不同对象；卡片明确类型，并从详情双向查看已核实的关系，不把两个对象称作同一版本。

保留现有来源说明、内容归属、原件预览/导出、待发送原件、来源历史版本、处理与索引状态，以及记录草稿。打开列表或详情不启动采集、上传、模型任务或第三方原件抓取。
文件列表项打开版本固定的原件阅读器；“整理资料”另开指定 Material 版本。Material 详情的“原始依据”打开其实际 member，而不是按标题搜索一个看似相同的文件。

KEEP：已有写入、ACK、来源授权、导出与历史读取接口。CHANGE：统一只读投影与阅读入口。
REMOVE：B0 中“文件仍从另一个入口浏览”的临时限制，仅在下面全部验收通过后移除。
EXCEPTION：本机仅有目录信息时仍保留条目，但不标“本机原件可读”。UNKNOWN：不能确认的原件或映射显示未知，不能补造 ID。
不进入 Hold：删除/保留/传播重设计、直接编辑版本传播、记忆自动纠错、新授权或兼容迁移。

## 2. 精确身份与版本

所有键以选定 Central origin 为命名空间，另带 UI 会话 generation 防晚到响应。以下 tuple 用结构化字段编码，不拼接可歧义的字符串。

| 对象 | 逻辑身份 | 版本与可合并依据 |
| --- | --- | --- |
| 已保存来源原件 | `(origin, sourceId, externalId)` | `sourceRevision`；接收后另有实际 `captureId`，服务器核对 deviceId 与 provenance 的 sourceId/externalId/revision |
| 本机已准备文件 | 上述来源身份 | `pending.manifest.item.revision`；此时即使 row 上还有旧 captureId，也不能绑定到新版本 |
| 本机尚未准备文件候选 | `(origin-or-local-device, sourceId, externalId)` | `candidateSignature` 仅是本机候选标识，不冒充正式 revision；服务器版本不可与其合并 |
| 非文件本机来源条目 | `(origin-or-local-device, sourceId, externalId)` | LocalSources 的 current.body / pending 中真实 revision；不能用“pending 数量为 0”推导具体 Central 可读对象 |
| 远端采集/来源原件交叉入口 | `(origin, deviceId, captureId)` | 同一实际 capture 身份及 B0 原始事实 digest；来源版还须核对 provenance tuple。用于折叠 B0 与 B1 对同一原件的重复投影 |
| 正式 Material | `(origin, materialId)` | Material 自己的 `revision` / `ref=material:ID@REV`，与 sourceRevision 不可比较 |

合并规则按以下顺序执行：

1. 不同 origin、sourceId、externalId、deviceId 或不同对象 namespace 不合并。相同标题、时间、路径、大小、正文 hash 不能建立身份。
2. 本机文件只有 `LocalContentPresentation.currentReceipt(row)` 可提供当前 ACK 候选：无 pending、signature 与 candidate 匹配、captureId 非空。用服务器实际记录再核对 captureId/deviceId/provenance tuple。通过后同一 sourceRevision 合为一行，带本机信息与 Central 可读状态。
3. 本机已有新 pending revision、或 candidate 已变化时，旧 ACK 只能对应旧版本。新旧版本分别可达，主行明确“本机新版本 / Central 另一版本”，不能把旧正文当新原文。版本选择键包含 revision；重试/重复分页不得增加同版本卡。
4. 非文件来源没有持久化 captureId ACK 映射时，只用服务器返回的精确 provenance tuple 与当前 sourceRevision 匹配；不得派生 capture UUID。未证实映射时保留本机行和未知状态。
5. 同一原件同时由 B0 capture 流与 B1 source 流返回时，仅在实际 captureId、deviceId、source tuple 和 digest 一致时折叠为一个原件行；不同 digest 保持版本差异。正式 Material 永远不参与此折叠。
6. 本机 target 与当前连接不符时，不借用本机旧 ACK 声称可读。LocalSources.target 是含凭据的不可逆标识，不能当 origin 或公开字段；仅本机比较。换凭据/会话后重新向当前授权 Central 验证，不能根据 token 相同与否推断内容身份。
7. 本机未绑定来源仅保留 local-device namespace；既有连接流程绑定后才重新做上述验证。列表不写回来源/ACK。

## 3. B1 只读传输契约（请求审查的新增接口）

新增 owner-only `POST /api/library/source-view`，不更改 B0 `device-view` 的请求语义。不新增表、不持久化投影、不改变原件/Material 存储格式。
全局 owner 鉴权与请求内 credential 检查共同生效；collector / MCP 凭据不因此获得全局资料库访问。

请求：

```ts
{
  after: ISODateTime, before: ISODateTime,
  sourceId?: string, kind?: string,
  stream: 'originals' | 'materials',
  limit: number, // 1..20, default 20
  cursor?: string, // bounded opaque, <=4096
  candidates: Array<{ // <=20; originals only
    sourceId: string, externalId: string, revision: string,
    deviceId: string, captureId?: UUID
  }>
}
```

响应的两个 stream 各自分页；客户端保留各自 cursor，单次“加载更多”每流最多一页。没有全库 totalCount。

```ts
{
  stream: 'originals' | 'materials',
  items: OriginalRow[] | MaterialRow[],
  nextCursor: string | null,
  matches: Array<{
    sourceId: string, externalId: string, revision: string, deviceId: string,
    state: 'readable' | 'unavailable',
    original?: OriginalRow // 仅在精确核对且已授权时存在
  }>
}
// OriginalRow:
// type:'original', captureId, deviceId, sourceId, externalId, revision,
// libraryVersion (B0 original digest), sortAt, title, kind, layer,
// metadata/attribution 既有可呈现字段，fileArchive?:{captureId},
// materialRef?: 精确且当前有效的关联 ref。
// MaterialRow:
// type:'material', id, revision, ref, sortAt, title, kind, schemaVersion,
// origin, coverage, fidelity, retention, indexing (均沿用既有返回形状)。
```

OriginalRow 只枚举当前可见 source/file heads；file_versions 是同一原件的存储能力，不再额外生成一行。来源历史通过已有 history 接口按需展开，不把历史版本混成多个当前项。
MaterialRow 只枚举当前可见 Material；历史版本由明确 ref 读取。
服务器复用 SourceStore、MaterialStore / catalog、EvidenceReader 的可见性规则，不直接从 SQL 返回绕开 reader 的正文。matches 中缺失、已删除、身份不符统一 unavailable，不泄露被拒绝记录的标题/版本或映射。

时间规则：此新增投影按原件的 observed/capturedAt、Material 的 origin.lastAt（缺失时使用其已存储 `updatedAt`）排序并过滤。日期筛选明确为“收集/更新时间”；不覆盖来源详情中的 authored/planned/recorded 时间。相同 sortAt 用 type + 稳定 ID 打破平局。
cursor 绑定 origin实例、stream、after/before、sourceId、kind、limit；参数错配/无效 cursor 返回409，客户端清掉该流 cursor 并从第一页恢复。加载期间沿用同一 before 上界；不承诺数据库快照，重复项按完整版本键去重，手动刷新重取当前 heads。

每页最多20个原件匹配/关系查询；不递归展开 Material members，不做无界 per-source 扫描。筛选在服务器应用；客户端不能把未加载的一页当成“全库为空”。本机文件新增只读分页适配器，不能继续用 `localFileContents(20)` 冒充完整分页。

## 4. Material 与原件读取

- 原件 → Material：只接受 `EvidenceReader.currentMemoryMaterialRef(record)` 的实际 ref。服务器对关联 ref 做当前可见性检查；缺失或暂未整理时显示无已确认整理资料，不构造 materialId。
- Material → 原件：`GET /api/materials/:id/members?revision=REV&offset=N&limit=20` 返回的真实 member ref 决定 reader。member 分页须带同一 REV；不可根据 origin.sourceId/externalId 猜测全体成员。
- Material 正文：`GET /api/materials/:id/read?revision=REV&offset=N&length=4000`，或既有 `source-view?revision=REV` 解码视图。每次核对响应 material.ref；历史阅读不会偷偷切到当前 head。409失效清掉该版本正文，提示重新读取，不显示旧缓存为当前内容。
- 文件原件：先 `/api/capture-browser/:captureId` 验证身份，再 `/api/files/:captureId` 核对 captureId、实际 hasOriginal、处理状态。原件预览/导出继续走现有 `/content`；不把转写 chunks 或 Material 文本标成原始文件字节。
- 待传文件：只用 `pendingPreview` / `exportPending`，固定 sourceId/externalId/revision；provider 已撤权也不丢已保存 spool。无 spool 且仅有 candidate 时显示目录信息，原件读取沿用已有用户动作与 provider 授权，不悄悄重新采集。
- 非文件来源：从已保存的当前/待传 body 读取本机内容；远端固定 captureId。历史链接使用服务器历史返回的 captureId，验证后读取。空正文 reference 层不是读取失败，也不能自动联网取原文。
- FileContentActivity 将原件正文、转写/整理、Material 独立呈现；不再用 Material.read 覆盖“原文与出处”的原件正文。保留来源说明/归属与现有纠正入口，但不新增编辑或传播规则。

## 5. 状态、权限及生命周期

传输 ACK、原件可读、整理 coverage、索引 revision 是四种独立事实。只有索引的 revision 与当前 Material revision 相等才能显示该版本已索引；部分整理不能显示完整。
位置筛选“本机”包含本机保存的条目，但逐项区分“原件可读 / 仅目录信息”；“Central可读”仅纳入本轮授权读取已证实的版本。metadata-only 不得标本机原件可读，ACK 不等于实时 Central 可读。

401/403/connection_revoked：沿用 #248 修复，清除该 origin 所有远端正文、关系、可读标记和 cursor；本机已保存正文仍在。换 origin/generation、退出登录、旧请求晚到亦如此。普通离线保留本机内容，远端状态改未知；不以缓存的读成功继续承诺可读。
404/410：只失效对应远端版本及关系，不删除本机数据。409：按版本/流清理陈旧正文或 cursor。所有清理仅内存投影，不能写 ACK、删除原件、停止来源或修改保留策略。

Activity/进程恢复仅恢复筛选、各流已加载页数、完整版本键滚动锚点和 reader offset；从当前权限重读正文。Bundle 不存正文、token、完整源 URI 或可绕过授权的客户端。重复刷新合并/串行化；旧 generation 结果丢弃。详情返回保留筛选与锚点；取消导出不改变版本、ACK 或草稿。

## 6. 文件边界与实施顺序

1. Server：新增 `library-source-view.ts` 和对应 focused HTTP tests；在现有 source/material feature 中挂载只读入口。先完成一份生成文件的真实 upload → source tuple → 原件/Material ref 联通，不等 UI 全部写完。
2. Android：新增 `LibrarySourceProjection.kt`（纯身份与版本投影）、本机来源只读适配器、`LibrarySourceView.kt`（任务/分页/状态）；复用 B0 的 origin/generation 与拒权处理，集成到现有 LibraryCaptureView 的资料内容区域。保留 B0 capture 行，处理明确的跨流重复原件。
3. Reader：在 FileContentActivity 中加入版本固定输入和正文分区；CentralLibrary 提供现有精确 ref 的公开阅读入口。若须接 CentralActivity intent，仅增加明确定义的 original/material ref，不改 CentralContent/CentralScreens insightState 或 MainActivity HomeDiscoveryView。
4. 将我的资料中的文件/来源/正式资料入口和统一筛选接通；两处语言目录同步。最后移除 B0 临时限制文案。
5. 跑下面针对性候选，提交独立 Draft PR、精确 CI 与独审，父串行合 main。

## 7. 验收矩阵与执行门槛

| 用例 | 必须观察到的结果 | 证据层 |
| --- | --- | --- |
| 同来源同版本本机+远端、重复页/刷新 | 一份原件一行；来源说明、归属、原字节不变；阅读不写 ACK | JVM + 真 Central HTTP + 原生 |
| 同标题/时间但不同来源、origin、device 或 externalId | 各自独立，零启发式合并 | JVM + HTTP |
| 旧 ACK + 新候选/新 pending、同内容不同 revision | 新旧不同版本可达，旧正文不代新原文；未准备候选不伪造 revision | 真实文件队列 + 原生 |
| 本机只有目录信息 / 已保存 spool / reference 空正文 | 三者状态准确；权限拒绝后 spool 可读，目录信息不宣称有原件 | JVM + 原生 |
| 原件与 Material、Material 新旧版本、部分/失败索引 | ref/members/read 固定版本；原件与整理分区；错误索引 revision 不显示成功 | HTTP + 原生 |
| 正常 → 403 / 撤销、换节点、晚到响应 | 旧远端正文和关系消失；本机原件可读；不扩大采集凭据权限 | HTTP + 原生 |
| 空/离线/404/409/处理错误 | 空状态真实，分页不是全库计数；本机保留；重试不重复与不误报成功 | HTTP + 原生 |
| reader 返回、导出取消、Activity重建、进程重启 | 同筛选/版本锚点恢复；重新鉴权；保存字节和原件归属不变 | 专用合成模拟器 |
| 文件真实上传链 | 生成文件→准备→实际上传ACK→Central原件字节比对→Material成员→新版本→ACK | 专用模拟器 + 实际 Central；模型禁用 |

准备阶段只测试既有源版本、history、Material revision/members/read 契约，不把它们当 B1 新接口/UI 已完成。
实现后 focused 范围为新增 server HTTP 文件、受影响 FileArchiveQueue/LocalSources/投影 JVM 类、server types/i18n、对应 Dev build 与上表原生路径。候选 dry-run 后只扩到实际受影响接口；保留未失效成功结果，不重复全仓。
必须记录每条 native 证据的 AVD 名、serial、服务端口、revision；每次设备操作先核对 AVD 名。不得使用5580/5582或他人服务，不启动真机/真实模型，不采集私人屏幕。CI 通过不能替代上表原生结果。

## 8. 审查决议填写

待 reviewer 对本文件 hash 给 APPROVE / REQUEST_CHANGES。需要批准的是新增只读来源/Material投影契约与客户端版本映射，不是重新批准类别优先、精确去重、保留原件等既定产品方向。
批准后按第6节实现并验收；本计划提交和测试准备不构成 B1 完成。
