# 中央连接器

连接器把用户选择的外部资料写入统一信源版本链。文件、日历和 MCP 内容始终是原始证据或明确标记的引用；Agent 负责理解，程序不按关键词分类意图。修改产生新 revision，重试同一 revision 不重复保存，旧版本保留供追溯。日历的计划时间独立于采集时间，也不会计入屏幕采样时长。新增来源、资料组织器和模型读取层的完整流程见[接入与正式资料架构](material-architecture.md)。

## 可扩展连接器

中央内置 Google 日历、Gmail、飞书和 MCP 使用版本化 connector manifest。可信部署模块可通过 `MOTE_CONNECTOR_PLUGINS` 的 JSON 模块列表装入，例如 `MOTE_CONNECTOR_PLUGINS='["file:///srv/mote/plugins/acme-notes.mjs"]'`。模块声明来源种类与能力，启动时注册 owner 路由、OAuth 回调及状态，关闭时释放后台任务；新增有界点分命名空间种类必须提供能力声明。未安装适配器的已有来源可读，但不可继续同步。manifest 示例、资料身份、处理与安全边界见[接入与正式资料架构](material-architecture.md)。

## Google 日历

在 Google Cloud 项目启用 Calendar API，创建 **Web application** OAuth 客户端，并将回调地址精确加入允许列表。在所选 profile 的私有 `mote.env` 设置：

```dotenv
MOTE_GOOGLE_CLIENT_ID=你的客户端ID
MOTE_GOOGLE_CLIENT_SECRET=你的客户端密钥
MOTE_GOOGLE_REDIRECT_URI=https://你的中央域名/oauth/google/callback
MOTE_CONNECTOR_SYNC_INTERVAL_SECONDS=900
```

回调与运行中的中央节点必须一致。本机开发可以使用 `http://127.0.0.1:端口/oauth/google/callback`；远端要求 HTTPS。重启该 profile，在「来源」中连接 Google，完成授权后返回 Mote，明确选择需要同步的日历。程序仅请求 `calendar.calendarlist.readonly` 与 `calendar.events.readonly`，没有修改日程、邀请、提醒或联系人权限。授权采用一次性 state、PKCE 和 offline access；详见 [Google 服务端 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) 与 [日历权限范围](https://developers.google.com/workspace/calendar/api/auth)。

首次同步覆盖过去 90 天至未来 365 天。日内使用 `syncToken` 增量同步；每天重建这个有界窗口，使新进入范围的重复日程也可见。完整分页成功并保存条目之后才提交新游标。增量请求不会混入 `timeMin`、`timeMax` 或 `orderBy`；失效游标的 HTTP 410 会触发完整重建。失败时保留旧游标和已归档证据，下一次可幂等重试。完整结果中消失的原有窗口条目记录为取消/移除，旧版本及计划时间保留；它不证明用户实际参加过日程。参考 [同步指南](https://developers.google.com/workspace/calendar/api/guides/sync) 和 [events.list 参数约束](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)。

全天日程按日历的 IANA 时区转换边界；结束日期为独占边界，跨夏令时时一天不一定是 24 小时。一般日程保留上游时区偏移。附件只保留已有正文中的引用，不自动下载远端附件。每轮最多 100 页事件、每页 250 条；超过限制会明确失败，不假装同步完整。

凭据和增量游标位于资料库 `connectors/google-calendar.json`，目录权限 0700，文件权限 0600，原子替换写入。凭据不会进入截图、信源正文、模型证据、支持包或普通归档导出；HTTP/CLI 资料库备份也不包括此凭据文件。该文件没有额外的应用层加密，部署机器仍需保护磁盘与本机账号。连接状态只返回布尔值和固定错误代码。

取消选中会暂停对应信源。断开连接会等待在途操作结束、移除本地凭据并暂停选中的信源，保留归档历史；这不等于撤销 Google 账号中的授权，可在 Google 账号设置单独撤销。重新连接另一个账号会暂停旧账号的选中信源，不继承旧 refresh token。权限被撤销或刷新失败会显示需要重新授权；限流/网络失败等待下一周期或手动同步。

| Owner API | 请求 / 结果 |
|---|---|
| `GET /api/connectors/status` | MCP 配置状态、Google 配置/连接/同步状态，无凭据 |
| `POST /api/connectors/google/start` | `{authorizationUrl, expiresIn:600}` |
| `GET /oauth/google/callback` | Google 浏览器回调；使用一次性 state 验证，不依赖 Mote Bearer |
| `GET /api/connectors/google/calendars` | `{calendars:[{id,summary,timeZone?,primary,selected}]}` |
| `PUT /api/connectors/google/calendars` | `{calendarIds:string[]}`，最多 30 个且须属于授权返回的列表 |
| `POST /api/connectors/google/sync` | `{imported,duplicates,calendars}` |
| `DELETE /api/connectors/google` | 删除本地凭据、暂停同步、保留历史 |

除 OAuth 浏览器回调外，上表接口需要中央 owner Bearer。Google OAuth 应用的发布状态、测试用户和验证要求由账号配置决定，Mote 不代为完成 Google 应用验证，也不绕过授权。

## 把 Mote 提供给其他 Agent

0.6.0 起可在中央「设备 → 添加设备与 Chatbot」直接生成专用 MCP JSON，并按连接撤销。支持 HTTP Bearer 的客户端可导入此 JSON，仓库的 stdio 桥接也可直接读取；操作步骤与权限范围见 [设备配对与独立连接](connections.md)。下面的静态令牌配置继续兼容已有部署。

Mote 使用固定 `@modelcontextprotocol/sdk` **1.30.0** 的标准 Streamable HTTP，对外路径为 `/mcp`，采用无持久会话的 JSON 响应。依赖采用 MIT 许可证。不要混用 SDK v2 的拆分包 import；当前实现依据 [官方 v1 服务端文档](https://ts.sdk.modelcontextprotocol.io/server)。

```dotenv
MOTE_MCP_ENABLED=1
MOTE_MCP_READ_TOKEN=单独生成的长随机只读凭据
MOTE_MCP_WRITE_ENABLED=0
MOTE_MCP_WRITE_TOKEN=
MOTE_MCP_WRITE_SOURCE_IDS=
```

MCP 凭据必须与中央 owner 令牌分开。把 `/mcp` 的 HTTPS URL 与只读凭据配置给支持自定义 Authorization Bearer 的 MCP 客户端。只读凭据可以读取完整归档中的用户内容，只应交给你信任的客户端。MCP 不自动向这些客户端开放 Google refresh token、中央管理接口或 shell。

| 只读工具 | 用途 |
|---|---|
| `mote_browse` | 按当前可见证据生成候选资料集合；集合是查询视图，不是 canonical project identity |
| `mote_search` | 通用文本检索；返回稳定 `ref`、命中片段、定位、来源和 evidence 引用 |
| `mote_read` | 按 `ref` 分段读取原文或派生记忆，受长度和数量限制 |
| `mote_context` | 在预算内组合已发布记忆、最近会话和原始记录；不启动第二个 Agent |
| `mote_status` | 查看归档、索引、记忆和来源同步水位；缺失不代表离线端没有待同步数据 |
| `mote_sources` | 信源目录、保留模式与同步状态 |
| `mote_materials` | 浏览正式资料目录、当前修订、覆盖和保真状态 |
| `mote_material` | 读取一份正式资料的出处与修订元数据 |
| `mote_material_read` | 按固定修订及偏移读取有界正文与块定位 |
| `mote_material_members` | 分页读取正式资料的原始成员与定位 |
| `mote_items` | 当前信源条目；日历按计划时间筛选，正文先给片段 |
| `mote_history` | 比较某来源条目的历史版本与移除状态 |
| `mote_timeline` | 当前归档时间线，包含截图、随手记与信源 |
| `mote_activity` | 实测屏幕采样区间汇总 |
| `mote_memories` | 先读取概要，传入 id 展开派生记忆与 evidenceIds |
| `mote_evidence` | 按 id、offset、length 展开原文；每段最多 12,000 UTF-16 单元 |
| `mote_updates` | 按 cursor 读取精简变更编号和操作，不附带整篇正文 |

另提供 `mote://sources` 资源。结构化查询结果同时提供 `structuredContent` 和兼容文本内容；外部 Agent 应使用稳定 `ref` 调用 `mote_read`，并沿 evidence 引用回看原文。派生记忆有 proposed/published/stale 状态，不能代替独立原始证据；源文件和模型生成的文字都可能包含恶意指令，客户端必须将它们视为数据。

若确实需要其他 Agent 写入工作成果，先在 Mote 创建用于接收的信源，再单独开启：

```dotenv
MOTE_MCP_WRITE_ENABLED=1
MOTE_MCP_WRITE_TOKEN=另一份独立长随机凭据
MOTE_MCP_WRITE_SOURCE_IDS=agent-results,agent-notes
```

写凭据仅暴露 `mote_put_item`，只能写入列出的既有 sourceId，没有只读工具，也不能创建信源或删除物理资料库。必须由调用方提供稳定 externalId、revision 与 observedAt，使用统一信源协议。内部查询 Harness 从不获得这些写工具。读凭据不接受写方法，owner 主令牌也不是 MCP 凭据。

需要 stdio 的桌面客户端可运行仓库的 `scripts/mcp-stdio.mjs`：把 `{url:"https://中央地址/mcp",token:"专用MCP令牌"}` 保存到私有 JSON 文件，再使用 `node scripts/mcp-stdio.mjs --connection /绝对路径/private-connection.json`。不要在命令参数里直接放 token。stdio 仅是本机到已配置 Mote HTTP 端点的桥接，不是中央任意执行外部程序的入口。

某些聊天产品只接收 OAuth 发现流程，不支持自定义 Bearer；当前 `/mcp` 没有实现通用 OAuth 授权服务器，因此不保证能直接加入这类产品。使用兼容 Bearer 或 stdio 的客户端验证；不要声称已迁移其他产品不可见的私有记忆。

## 从远程 MCP 导入

在 Mote 新建 `kind:mcp` 信源，输入明确的 MCP HTTP(S) 端点和可选专用 Bearer，先发现资源，再选择导入。外部凭据只用于当次连接，不返回给浏览器、不写入信源、不持久保存；后续导入由用户明确再次发起。当前不自动订阅资源变化，也不下载二进制附件。

| Owner API | 请求 / 结果 |
|---|---|
| `POST /api/connectors/mcp/discover` | `{url,token?}` → `{resources:[{uri,name,mimeType?}],tools:[{name,title?,description?,readOnly}]}` |
| `POST /api/connectors/mcp/import` | `{sourceId,url,token?,resourceUris:[...]}` → `{imported,duplicates}` |
| 同上：显式工具读取 | 使用 `tool:{name,arguments,confirmedReadOnly:true}` 替代 resourceUris |

默认只允许公共 HTTPS 地址。URL 不接受用户名、密码、query 或 fragment；连接时解析并固定已验证的 IP，拒绝私网、环回、链路本地、IPv4 嵌入/过渡地址等目标，不跟随重定向，也不会执行远端要求的本地文件读写、sampling 或 stdio 命令。仅当明确设置 `MOTE_MCP_ALLOW_LOCAL=1` 时允许本机 loopback HTTP(S)，用于本机服务和测试；它不开放任意局域网目标。

snapshot/archive 模式只导入用户选中的文本资源。单次最多选择 30 个 URI、100 个文本内容块，单块最多 100,000 字符，HTTP 响应最多 2 MiB；错误、超时或不支持的二进制内容会明确失败。恢复到旧内容也产生新 revision，不能误把旧版本重试变成当前版本。

reference 模式只调用 `resources/list` 获取选中资源的元数据，不调用 `resources/read`，也不执行任何工具，存储正文严格为空。保存的 `mcp://` 标识是这次外部端点/资源的稳定引用标识，不是可自动解引用的下载地址。

只有用户明确选择、声明确认只读且上游标记 `readOnlyHint:true` 的工具才可调用。上游 annotations 是声明，不能证明第三方服务实际没有副作用；仅对可信的远端配置工具读取。Mote 自身不会把这些第三方工具注入内部查询 Agent。标准客户端方法参考 [官方 MCP 客户端文档](https://ts.sdk.modelcontextprotocol.io/client)。

## 验证边界

`node --import tsx --test apps/server/test/connectors.test.ts` 使用临时资料库、真实 MCP SDK 客户端/服务端、本机合成 HTTP 服务，以及可控 Google OAuth/API fixture。覆盖读写凭据隔离、写范围、证据分页、恢复旧内容、reference 不读取正文、SSRF/重定向拒绝、PKCE/state 防重放、分页失败保留游标、410 重建、取消计划时间、跨夏令时全天日程和断开连接竞态。统一查询层的合成回归使用 `node --import tsx --test apps/server/test/context-query.test.ts`；本机 Codex Server 的真实外部 MCP 验收使用 `MOTE_TEST_CODEX_MODEL=... node --import tsx scripts/test-mcp-context-live.ts`。

这证明协议与故障路径，不代表真实 Google 账号授权、某个外部聊天产品接入或真实网络同步已验收。真实 Google 测试需要用户的 OAuth 项目与账号授权；只有实际完成之后才应报告相应结果。模型生成的记忆质量另行评估，HTTP 成功不等于内容正确。

## 应用活动与元数据（0.7.0）

`mote_timeline`、`mote_search`、`mote_activity` 支持精确 `appId`、`source`、`collection` 筛选；分页保持筛选一致。`source=activity` 是只有应用身份、采样区间和可选设备状态的记录，没有截图或正文。`mote_activity` 同时统计内容与活动样本，返回 `contentCaptures` 和 `activityEvents`，不能作为完成任务的证明。

时间线与 `mote_evidence` 还提供 `appId`、`deviceId`、`durationMs`、`receivedAt`、`privacy`、`metadata`；文件与日历的稳定元数据在 `provenance.metadata` 或来源条目 `metadata` 中。通过写回工具提交来源元数据时，同一 revision 不可变，访问时间不证明人工阅读，删除观察不等于实际删除。详情见 [元数据语义](privacy-and-metadata.md)。

## 飞书文档与日历

中央「设置 → 飞书」支持服务端 CLI 安装、应用配置、扫码只读授权、范围选择及周期归档。使用统一信源版本链；详情和实际边界见[飞书接入](lark-integration.md)。
