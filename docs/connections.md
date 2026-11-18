# 设备配对与独立连接

所有者在中央生成连接邀请，采集端导入二维码、JSON 或 `mote://connect` 链接，确认其中显示的节点地址后兑换。邀请不包含中央所有者令牌。每次兑换生成独立随机凭据，所有者可以在连接列表中单独撤销。

## 在 App 中连接

中央与客户端使用当前同代实现。MVP 允许新建空数据目录，不提供旧数据库、队列或凭据迁移。当前手工 owner 令牌入口保留。独立采集器和完整客户端有明确不同的权限，见 [单所有者决策](product.md)。

1. 用所有者令牌打开中央界面的「设备」页，在「添加设备与 Chatbot」填写手机或电脑可访问的 HTTPS 地址。配置了 `MOTE_PUBLIC_URL` 时优先填入该地址；Cloudflare Tunnel 可以提供入口。手机的 `localhost` 指手机自身，二维码不会自动建立隧道。
2. 填写连接名称。首次连接使用「新设备」；凭据撤销后重连或重试一次未保存成功的兑换，选择原设备身份。
3. 点击「生成连接邀请」。Android 在 App 中选择扫码，也可粘贴邀请或导入 JSON；Mac 可导入 JSON、邀请文字或保存的二维码图片。二维码在中央浏览器本机生成，不发往第三方二维码服务。
4. 在客户端核对节点地址，确认后连接。配对不自动授予截图或日历权限，也不自动开启采集。

同一节点、同一设备重新授权时，客户端说明原待同步资料将继续上传；确认后保留队列、草稿和来源版本，替换凭据。更换节点地址时若仍有待同步资料，则先阻止切换。连接时暂停或等待在途操作，避免上传途中换凭据。邀请过期只影响尚未兑换的邀请，已建立的连接继续有效。

中央列表可按连接名称单独撤销，并保留归档资料。隐藏 MCP 配置或离开页面不会撤销凭据；邀请需要点击「取消邀请」才能提前失效。若设备尚未来得及上报心跳，中央仍会从连接记录中提供该设备的重新配对选项。

当前邀请签发独立、可撤销的 owner 凭据，具有同步、全归档浏览、Agent 查询、导出、删除和中央管理权限。绑定设备信息用于核验连接身份，不会将 owner 的浏览权限缩小为本设备。客户端只接受当前 owner 身份；MCP 凭据不能用于原生客户端登录。

## 统一登录与浏览器接续

Mac、Android和Web登录一次后，共用该客户端的owner会话访问问答、归档和管理，不为每个功能再填一份Token。独立采集器仍是受限collector，不自动升级为完整客户端；MCP授权也独立。

网页使用当前站点的同源API，可选择本标签页、1天、7天或30天。原生到浏览器只传60秒一次性代码，不把长期Token放进URL；浏览器到原生使用10分钟请求、随机verifier/challenge和明确批准。迟到授权结果不能覆盖新会话。退出先停止本地使用，再尝试撤销；节点离线时仍可本地退出，但其他副本要等服务端撤销生效。

退出不删除归档、待传队列或草稿。同节点重连保持来源检查点，不同节点遵守原目的地绑定。会话过期、撤销或401统一停止中央访问；模型API key、外部OAuth和OS权限仍由各自服务管理。当前格式与回退要求见[更新](updating.md)。

## 创建与兑换

所有者认证调用：

```http
POST /api/connections/invitations
Authorization: Bearer <owner-token>
Content-Type: application/json

{"serverUrl":"https://mote.example.com","label":"我的手机","deviceId":"existing-device-id"}
```

`deviceId` 可省略。普通邀请只允许尚未在中央出现的新设备 ID；旧客户端保持原 ID 时，所有者须明确选择该设备并创建绑定邀请。绑定信息只保存在服务端，不扩展可携带的 v1 邀请格式。成功兑换绑定邀请后，该设备同权限类型的旧凭据一并撤销；另一权限类型及其它设备不受影响。

响应包含 `invitation` 和 `uri`：

```json
{
  "format": "mote.connection",
  "version": 1,
  "serverUrl": "https://mote.example.com",
  "code": "<32-random-bytes-as-base64url>",
  "expiresAt": "<UTC-ISO-time>",
  "platforms": ["android", "macos", "ios", "windows", "linux"]
}
```

`platforms` 声明中央允许通过连接凭据接入的客户端平台，不含采集专用标签 `other`。iOS 在兑换前检查其中是否包含 `ios`；字段缺失或列表中没有 `ios` 表示中央不支持 iOS，客户端提示升级中央且不发送任何记录。邀请格式版本仍为 v1。

URI 为 `mote://connect?data=<base64url-UTF8-JSON>`。邀请有效期为 10 分钟，只能兑换一次。邀请码在内存中仅保存 SHA-256，中央重启后邀请失效。邀请包含一次性授权能力，发送给预期设备前应确认接收方。

客户端无须携带任何旧令牌：

```http
POST /api/connections/redeem
Content-Type: application/json

{"code":"<invitation-code>","deviceId":"existing-device-id","deviceName":"我的手机","platform":"android"}
```

`platform` 支持 `android`、`macos`、`ios`、`windows`、`linux` 和 `other`。兑换响应为 `{serverUrl, token, credentialId, scope:"owner"}`；随后通过 `/api/connections/self` 验证节点、设备及必需的协议元数据，验证完成再保存凭据。客户端应只将该 token 用于已确认的 `serverUrl`，不跟随重定向传递凭据。现有采集协议的通用 `other` 客户端使用 `platform:"import"`；当前 Android、iOS 和 Mac 直接使用各自平台名称。

`serverUrl` 必须是所有者显式填写的 HTTPS origin；仅 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP。地址不能包含用户名、密码、路径、查询或片段。服务端不会从 `Host` 或转发请求头猜测地址，也不会替所有者探测这个地址。

中央不按每分钟请求数或有效邀请数量拒绝操作；授权、设备绑定和邀请有效期仍逐次检查。`410 invitation_invalid_or_expired` 表示已使用、取消、过期或因重启失效；`409 device_already_registered` 要求所有者生成设备绑定邀请；`403 invitation_device_mismatch` 表示邀请绑定的设备与当前客户端不一致。

## 检查与撤销

- `GET /api/connections/self`：所有者或独立凭据可读取自身 `credential`、节点 `node:{version,profile,protocol}` 及 `capabilities:{ingest,ownSources,archiveRead}`。不返回 token 或 token 哈希，可用作客户端连接测试。原生客户端必须验证当前 owner、设备身份和协议范围。
- `GET /api/connections`：仅所有者；返回 `items` 和 `mcp:{enabled,writeEnabled,writeSourceIds}`。每项只有身份、标签、创建／撤销时间、设备信息、范围和基于公开连接 ID 的遮罩提示。
- `DELETE /api/connections/:id`：仅所有者；持久撤销该凭据，重复撤销同一记录仍成功，返回 `{revoked:true,id}`。
- `POST /api/connections/invitations/revoke`，body `{code}`：仅所有者；幂等取消尚未兑换的邀请。code 不放入 URL。已兑换的邀请应通过连接 ID 撤销其凭据。

配对中的设备 ID 必须与绑定邀请一致，重新授权已有设备必须由所有者明确选择该身份。owner 的归档权限不会按设备隐式收窄；浏览时可显式选择设备筛选。来源版本通过 `/api/sources/:id/items` 写入，仍需符合当前 schema、版本和幂等确认。查询 Agent 继续只有读取工具，没有新增写入能力。

## 独立采集器

完整 Mac / Android / iOS 客户端选择「本人客户端 · 完整权限」，一次登录即可使用采集和归档功能。专用采集程序选择「独立采集器 · 仅同步」。所有者通过 `POST /api/connections/collector-invitations` 创建受限邀请，请求字段与普通邀请相同；响应的 `scope` 明确为 `collector`。权限保存在服务端邀请记录中，兑换方不能指定或提升权限。采集器邀请与普通邀请使用同一 v1 邀请格式和平台声明。

采集器兑换后通过 `/api/connections/self` 核验 `scope:collector` 与协议。能力为 `ingest:true`、`ownSources:true`、`archiveRead:false`。它可以上报绑定设备的心跳、采集和笔记、登记或更新该设备来源、写入来源版本，并通过 file-sync 完成分片上传、确认丢失后的重试和原件恢复。来源登记及重用必须匹配设备和平台；通用 `other` 采集器对应 `import` 平台。

允许的读取仅为自身连接元数据、过滤后的来源配置，以及上传所需的版本、哈希和分片状态。来源响应不包含所有者归属、归属版本或来源说明身份。采集存在性核对只返回本设备的 present/unavailable，不提供内容。

采集器不能浏览原件、来源正文或历史、查询/导出/删除归档、声明归属/来源说明、管理中央、签发登录凭据或调用 MCP。权限由精确的方法和注册路由白名单控制，新增 API 默认不开放。采集写入要求 `X-Mote-Ingress-Version: 2`；现有事务内的撤销检查继续有效。所有者和采集器同设备凭据分别轮换、分别撤销。

## MCP 配置

所有者调用 `POST /api/connections/mcp`，body `{serverUrl,label,access:"read"|"write"}`，得到 `{credential,config}`。`config` 的结构为：

```json
{"mcpServers":{"mote":{"type":"http","url":"https://mote.example.com/mcp","headers":{"Authorization":"Bearer <independent-token>"}}}}
```

完整 token 只在创建成功时返回。之后的列表和 self 接口无法再次取出它；需要时重新创建并撤销旧连接。

读取凭据通过标准MCP工具读取查询可见的笔记、正式资料、来源版本与派生记忆；高频截图和Coding原始事件受同一可见性策略限制，已知UUID不授予原件读取权。写入凭据只注册`mote_put_item`，不包含读取工具，也不能建立来源或执行外部Actions。其允许来源是签发时的`connectors.mcpWriteSourceIds`与当前配置的交集：扩大配置不扩大已发凭据，缩小配置立即收紧。

在私有YAML配置至少32字符的`connectors.mcpReadToken`并开启`mcpEnabled`；写入另需独立`mcpWriteToken`、`mcpWriteEnabled`与非空`mcpWriteSourceIds`，修改后重启中央。完整片段见[连接器设置](connectors.md#把-mote-提供给其他-agent)。未开启时创建连接返回`409 mcp_disabled`或`409 mcp_write_disabled`。发给客户端的是新生成的独立凭据；启动静态token需通过配置轮换，不能在独立连接列表中撤销。

这份JSON用于支持Streamable HTTP与自定义Bearer的客户端。OAuth客户端则连接节点`/mcp`，通过发现、注册、授权码/PKCE及「AI接入」批准流程获取同一权限类型的独立凭据；可请求`mote.read`或已启用的`mote.write`，写入仍只表示指定来源归档，不授予Actions。具体客户端兼容性另行核验。

需要本地stdio的客户端可按[连接器文档](connectors.md)配置桥接：将中央下载的`mote-mcp.json`放到私有位置，在macOS/Linux执行`chmod 600 /绝对路径/mote-mcp.json`，再使用`node scripts/mcp-stdio.mjs --connection /绝对路径/mote-mcp.json`。桥接只接受当前`mcpServers.mote` HTTP配置，拒绝旧的`{url,token}`文件，不执行JSON中的`command`或`args`。

### 外部 Codex 创建日程

1. 在中央启用 MCP 并设置好对话模型。在「来源」中连接云日历，选择一个自己有写权限的日历，再授权连接器写入。已有写授权的飞书连接会在启动时向飞书核验缺失的日历角色，之后的连接检查或同步可重试核验。
2. 打开「来源 → AI 接入 → 新建连接」，在「访问权限」中选「创建日程」，选定一个日历并生成配置。此步骤将一个独立凭据绑定到该日历。每个需要独立撤销的客户端使用自己的连接。
3. 点击「复制 Codex 配置」，把生成的 TOML 粘贴到用户级 `~/.codex/config.toml`。这段配置含一次性展示的完整 Bearer 凭据，应存放在自己的配置中。重新启动 Codex，用 `codex mcp list` 或交互会话的 `/mcp` 查找 `mote_calendar`。在同一台电脑可用本机回环地址，远程连接使用可访问的 HTTPS 地址。
4. 在 Codex 中明确要求实际创建一条日程，例如「请现在通过 Mote 在已授权的日历创建『项目评审』。时间是 2031 年 5 月 8 日 14:00 到 15:00，Asia/Shanghai，地点为评审室。」首次选择目标并签发凭据后，满足当前指令、有效 Memory 和日历权限的请求直接进入 Actions。
5. 在「AI 接入」打开连接详情即可撤销。撤销阻止后续请求和未领取的写入。已经领取的请求仍以「待办与日程」中的原 Action 回执为准。

也可以把独立 token 放进启动 Codex 的环境变量 `MOTE_CALENDAR_TOKEN`。变量值取自生成的 `Authorization` 字段，去掉 `Bearer ` 前缀。对应 TOML 如下。

```toml
[mcp_servers.mote_calendar]
url = "https://mote.example.com/mcp"
bearer_token_env_var = "MOTE_CALENDAR_TOKEN"
tool_timeout_sec = 120
```

日历凭据的工具清单如下。

| 工具 | 用途 |
| --- | --- |
| `mote_calendar_target` | 查看该连接的日历名称和当前可用状态。 |
| `mote_calendar_create` | 提交 `{requestId,instruction,event}`。用同一个 UUID 标识当次请求，`instruction` 原样传入最新用户消息，`event` 包含 `title,start,end,timeZone,allDay,location,description`。定时日程使用带偏移的时间戳，全天日程使用日期，结束日独占，地点或备注可用空字符串。 |
| `mote_calendar_receipt` | 按 `{requestId}` 查询该连接提交的原 Action 回执。 |

中央使用自己的对话模型，按现有当前指令和有效 Memory 语义校验候选日程，再检查连接与目标权限。连接只授予在所选日历创建事件和查询本连接的回执。需要检索归档或写回资料时另行签发对应凭据。将此连接交给会原样传递当前用户消息的可信客户端。MCP Bearer 认证客户端身份，消息的用户角色由客户端提供。

`approved` 表示已受理，`executing` 表示已领取，只有 `succeeded` 和供应方事件 ID 能确认写入。`stale` 表示执行前条件已失效。`uncertain` 表示写入结果待核实，应在原日历核查。断线或超时时先用相同 `requestId` 查回执；中央尚无回执时，可以重发完全相同的请求。更换 UUID 或连接会被视为新请求。

所有者 API 为 `GET /api/connections/mcp/calendar` 列出可选目标，以及 `POST /api/connections/mcp/calendar` 用 `{serverUrl,label,target}` 签发凭据。取列表中的完整 `target`，响应沿用 `{credential,config}`。撤销沿用 `DELETE /api/connections/:id`。这些管理路由使用所有者会话。

在仓库根目录可运行下列测试。它使用临时配置、回环 HTTP、生成的模型响应和日历回执。设置 `MOTE_CALENDAR_TEST_CODEX` 还会启动对应的本机 Codex App Server，验证工具发现、提交和回执查询。

```sh
npm run build:libs
MOTE_CALENDAR_TEST_CODEX="$(command -v codex)" npm run test:file -w @mote/server -- test/mcp-calendar-actions.test.ts
npm run test:file -w @mote/web -- test/connections-flow.test.ts
```

## 持久性与边界

独立凭据仅以随机 token 的 SHA-256 和权限元数据保存在 `data/connectors/client-connections.json`，目录权限 700、文件权限 600。与现有连接器凭据一样，它不包含在可携带的资料导出中；部署回退会通过私有连接器移交保持当前凭据和撤销状态。凭据数量和撤销历史数量不作为配对门槛；凭据文件仍限制在 2 MiB，并为已发凭据的撤销标记预留空间。达到字节容量时拒绝新增，既有凭据仍可读取和撤销。

兑换和撤销通过串行、临时文件、文件同步及原子替换完成。持久化失败不会消费邀请、替换旧凭据或报告撤销成功。凭据文件无法安全读取时中央启动失败，不自动丢弃撤销记录。正在准备的采集或来源写入会在数据库事务内再次验证凭据，撤销后不能继续提交。已经成功提交的资料保留在归档中。

如果保存成功后网络在响应到达客户端前断开，邀请仍视为已兑换。所有者可在连接列表中撤销这条连接并重新邀请；服务端不会为了重试而长期保存可恢复的明文 token。

自动化测试使用生成数据，覆盖真实 MCP SDK HTTP 连接、权限、重放、过期、并发兑换、写入失败、重启与上传中撤销。真实手机相机扫码、跨公网连接及第三方聊天产品的具体配置界面需要分别验收。
