# 设备配对与独立连接

所有者在中央生成连接邀请，采集端导入二维码、JSON 或 `mote://connect` 链接，确认其中显示的节点地址后兑换。邀请不包含中央所有者令牌。每次兑换生成独立随机凭据，所有者可以在连接列表中单独撤销。

## 在 App 中连接

先把中央节点升级到 0.6.0，再升级客户端。旧版手工连接仍然可用；新邀请接口要求新版中央。

1. 用所有者令牌打开中央界面的「设备」页，在「添加设备与 Chatbot」填写手机或电脑可访问的 HTTPS 地址。配置了 `MOTE_PUBLIC_URL` 时优先填入该地址；Cloudflare Tunnel 可以提供入口。手机的 `localhost` 指手机自身，二维码不会自动建立隧道。
2. 填写连接名称。首次连接使用「新设备」；旧版迁移、凭据撤销后重连或重试一次未保存成功的兑换，选择原设备身份。
3. 点击「生成连接邀请」。Android 在 App 中选择扫码，也可粘贴邀请或导入 JSON；Mac 可导入 JSON、邀请文字或保存的二维码图片。二维码在中央浏览器本机生成，不发往第三方二维码服务。
4. 在客户端核对节点地址，确认后连接。配对不自动授予截图或日历权限，也不自动开启采集。

同一节点、同一设备重新授权时，客户端说明原待同步资料将继续上传；确认后保留队列、草稿和来源版本，替换凭据。更换节点地址时若仍有待同步资料，则先阻止切换。连接时暂停或等待在途操作，避免上传途中换凭据。邀请过期只影响尚未兑换的邀请，已建立的连接继续有效。

中央列表可按连接名称单独撤销，并保留归档资料。隐藏 MCP 配置或离开页面不会撤销凭据；邀请需要点击「取消邀请」才能提前失效。若设备尚未来得及上报心跳，中央仍会从连接记录中提供该设备的重新配对选项。

采集凭据只允许本设备写入截图、随手记、心跳，以及注册、调整、写入和读取本设备的来源。它不能浏览中央完整时间线、运行中央 Agent 查询、导出资料、删除记录、读取诊断、配置节点或管理其它连接。Mac 内嵌中央浏览界面需要另外登录所有者账户；配对本身不会授予这些权限。已有手工输入的所有者令牌继续有效，因此建议完成配对后从采集端移除不再需要的所有者凭据。

## 创建与兑换

所有者认证调用：

```http
POST /api/connections/invitations
Authorization: Bearer <owner-token>
Content-Type: application/json

{"serverUrl":"https://mote.example.com","label":"我的手机","deviceId":"existing-device-id"}
```

`deviceId` 可省略。普通邀请只允许尚未在中央出现的新设备 ID；旧客户端保持原 ID 时，所有者须明确选择该设备并创建绑定邀请。绑定信息只保存在服务端，不扩展可携带的 v1 邀请格式。成功兑换绑定邀请后，该设备此前的采集凭据一并撤销；其它设备不受影响。

响应包含 `invitation` 和 `uri`：

```json
{
  "format": "mote.connection",
  "version": 1,
  "serverUrl": "https://mote.example.com",
  "code": "<32-random-bytes-as-base64url>",
  "expiresAt": "<UTC-ISO-time>"
}
```

URI 为 `mote://connect?data=<base64url-UTF8-JSON>`。邀请有效期为 10 分钟，只能兑换一次。邀请码在内存中仅保存 SHA-256，中央重启后邀请失效；最多同时保留 50 个有效邀请。邀请包含一次性授权能力，发送给预期设备前应确认接收方。

客户端无须携带任何旧令牌：

```http
POST /api/connections/redeem
Content-Type: application/json

{"code":"<invitation-code>","deviceId":"existing-device-id","deviceName":"我的手机","platform":"android"}
```

`platform` 支持 `android`、`macos`、`windows`、`linux` 和 `other`。响应为 `{serverUrl, token, credentialId, scope:"collector"}`。客户端应只将该 token 用于已确认的 `serverUrl`，不跟随重定向传递凭据。现有采集协议的通用 `other` 客户端使用 `platform:"import"`；当前 Android 和 Mac 直接使用各自平台名称。

`serverUrl` 必须是所有者显式填写的 HTTPS origin；仅 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP。地址不能包含用户名、密码、路径、查询或片段。服务端不会从 `Host` 或转发请求头猜测地址，也不会替所有者探测这个地址。

兑换按请求来源地址限制为每分钟 12 次；所有者创建、取消和撤销连接操作另有每分钟 20 次路由限制。`410 invitation_invalid_or_expired` 表示已使用、取消、过期或因重启失效；`409 device_already_registered` 要求所有者生成设备绑定邀请；`403 invitation_device_mismatch` 表示邀请绑定的设备与当前客户端不一致。

## 检查与撤销

- `GET /api/connections/self`：所有者或独立凭据可读取自身 `credential`、节点 `node:{version,profile}` 及 `capabilities:{ingest,ownSources,archiveRead}`。不返回 token 或 token 哈希，可用作客户端连接测试。
- `GET /api/connections`：仅所有者；返回 `items` 和 `mcp:{enabled,writeEnabled,writeSourceIds}`。每项只有身份、标签、创建／撤销时间、设备信息、范围和基于公开连接 ID 的遮罩提示。
- `DELETE /api/connections/:id`：仅所有者；持久撤销该凭据，重复撤销同一记录仍成功，返回 `{revoked:true,id}`。
- `POST /api/connections/invitations/revoke`，body `{code}`：仅所有者；幂等取消尚未兑换的邀请。code 不放入 URL。已兑换的邀请应通过连接 ID 撤销其凭据。

采集请求的 `deviceId` 必须与凭据一致；已存在的 capture ID、来源 ID 也必须属于该设备。来源列表和版本查询始终限制为该设备。采集接口不允许通过自造 `provenance` 冒充来源版本；来源内容走受限的 `/api/sources/:id/items`。查询 Agent 继续只有读取工具，没有新增写入能力。

## MCP 配置

所有者调用 `POST /api/connections/mcp`，body `{serverUrl,label,access:"read"|"write"}`，得到 `{credential,config}`。`config` 的结构为：

```json
{"mcpServers":{"mote":{"type":"http","url":"https://mote.example.com/mcp","headers":{"Authorization":"Bearer <independent-token>"}}}}
```

完整 token 只在创建成功时返回。之后的列表和 self 接口无法再次取出它；需要时重新创建并撤销旧连接。

读取凭据可通过标准 MCP 工具读取中央完整归档，包括笔记、截图文本、来源版本和渐进展开的派生记忆。写入凭据只注册 `mote_put_item`，不包含读取工具，也不能建立来源。其允许来源是创建时的 `MOTE_MCP_WRITE_SOURCE_IDS` 与当前配置的交集：扩大配置不会扩大已发凭据；缩小配置立即收紧已有凭据。

必须先按现有节点启动要求配置至少 32 字符的 `MOTE_MCP_READ_TOKEN`，再开启 `MOTE_MCP_ENABLED`。写入还需要至少 32 字符的 `MOTE_MCP_WRITE_TOKEN`、`MOTE_MCP_WRITE_ENABLED` 和非空 `MOTE_MCP_WRITE_SOURCE_IDS`；修改后重启中央。未开启时创建连接返回带说明的 `409 mcp_disabled` 或 `409 mcp_write_disabled`。发给聊天客户端的是新生成的独立凭据，不是这些静态配置 token。静态 token 继续遵循原设置，需要通过配置轮换，不能在独立连接列表中撤销。

这份 JSON 适用于支持 Streamable HTTP 与自定义 Bearer 请求头的 MCP 客户端。只支持 OAuth 授权的聊天产品不能直接使用此配置；本功能不提供 MCP OAuth 授权服务器。需要本地 stdio 的客户端可按 [连接器文档](connectors.md) 配置桥接：将中央下载的 `mote-mcp.json` 放到本机私有位置，在 macOS/Linux 执行 `chmod 600 /绝对路径/mote-mcp.json`，再使用 `node scripts/mcp-stdio.mjs --connection /绝对路径/mote-mcp.json`。桥接同时兼容旧的 `{url,token}` 文件，不会执行导入 JSON 中的 `command` 或 `args`；不支持的结构会被拒绝。

## 持久性与边界

独立凭据仅以随机 token 的 SHA-256 和权限元数据保存在 `data/connectors/client-connections.json`，目录权限 700、文件权限 600。与现有连接器凭据一样，它不包含在可携带的资料导出中；部署回退会通过私有连接器移交保持当前凭据和撤销状态。最多保留 500 条连接记录，撤销记录也计入上限；凭据文件同时限制在 2 MiB，超限拒绝新增，既有凭据仍可读取。

兑换和撤销通过串行、临时文件、文件同步及原子替换完成。持久化失败不会消费邀请、替换旧凭据或报告撤销成功。凭据文件无法安全读取时中央启动失败，不自动丢弃撤销记录。正在准备的采集或来源写入会在数据库事务内再次验证凭据，撤销后不能继续提交。已经成功提交的资料保留在归档中。

如果保存成功后网络在响应到达客户端前断开，邀请仍视为已兑换。所有者可在连接列表中撤销这条连接并重新邀请；服务端不会为了重试而长期保存可恢复的明文 token。

自动化测试使用生成数据，覆盖真实 MCP SDK HTTP 连接、权限、重放、过期、并发兑换、写入失败、重启与上传中撤销。真实手机相机扫码、跨公网连接及第三方聊天产品的具体配置界面需要分别验收。
