# 飞书文档与日历（服务端只读）

入口：中央网页 → 设置 → 飞书。实现沿用现有 `SourceStore` 的来源、稳定 externalId、不可变 revision、历史版本、全文索引和只读查询工具，不增加通用 shell 或任意飞书 API 给查询 Agent。

本期实现持续同步归档。按需实时远端查询和飞书写操作尚未提供。模型只读取已经归档的证据；文档和日程正文属于不可信输入。日程的计划时间保存在 `calendar` 字段，采集时间是本次观察时间，durationMs 固定为 0。

## 首次连接

1. 页面检测服务端 PATH 中的 `lark-cli`。可复用本机安装；也可点击安装，将官方 npm 包 `@larksuite/cli@1.0.57` 安装到当前资料库的 `connectors/lark-runtime/package`。安装依赖服务端可访问 npm 与官方 CLI 下载源，且运行账号可写该目录；不会全局安装或使用 sudo。
2. 点击「创建飞书应用」，在页面显示的链接或二维码完成官方创建流程。也可填写已有应用 App ID、App Secret 和飞书 / Lark 区域。Secret 通过子进程 stdin 传递，不出现在 argv 或 API 响应中。已有应用必须开通所需权限。
3. 点击只读授权。页面展示 CLI 返回的原始 URL 和本地生成的二维码；打开受限时可复制原始链接到浏览器。设备码只留在服务端当前任务内存，后台 CLI 轮询直到完成、取消或过期。刷新页面仍可查看任务；服务重启后未完成的授权需重新发起。跨设备使用不依赖 localhost OAuth 回调。
4. 粘贴明确选定的 docx / wiki 文档链接或 token，加载并选择可读取详情的日历，设置过去 / 未来天数、全天日程默认 IANA 时区。先保存范围，再立即同步；可选择后台周期同步，使用 `MOTE_CONNECTOR_SYNC_INTERVAL_SECONDS`（默认 900 秒）。关闭网页不停止后台周期。

登录仅请求 `docx:document:readonly`、`wiki:wiki:readonly`、`calendar:calendar:readonly`；CLI 自身会处理登录持续访问所需的 OAuth 参数。Mote 不申请文档编辑、日程写入或消息发送权限。应用后台权限与用户授权是两层，组织管理员可能需要先批准应用权限。

安装、应用配置、登录及同步都是异步任务。同一连接只运行一个任务。页面展示进行中、等待授权、完成、取消和失败，并支持取消；服务关闭会终止运行中的子进程。后端使用固定参数数组与 `shell:false`，不接受来自网页的命令、脚本、可执行文件路径或任意安装包。

## 配置、凭据与断开

- `connectors/lark.json` 保存范围、账号指纹、启用状态和上次成功时间，目录 0700，文件 0600，原子写入。
- `LARKSUITE_CLI_CONFIG_DIR` 指向当前资料库的 `connectors/lark-runtime/config`；不读取或切换日常 CLI 默认 profile。启动子进程时清理继承的其他 Agent / Lark 身份环境变量。
- **CLI 配置隔离不等于操作系统钥匙串隔离。** macOS 官方 CLI 使用当前系统账号的 Keychain 和 `~/Library/Application Support/lark-cli`，按 appId / userOpenId 保存凭据；Linux 使用设置的 `LARKSUITE_CLI_DATA_DIR`。建议 Mote 使用专用飞书应用、独立服务系统账号。不要把同一个 appId 的配置隔离宣传为独立凭据保险箱。未执行钥匙串降级。
- 连接器目录不属于普通归档导出或资料库备份的内容；服务迁移需重新配置 / 授权。普通运行诊断只接收固定错误码，不保存原始 CLI 输出、正文、App Secret、设备码或 token。
- 断开连接会取消任务、关闭自动读取并暂停来源，保留历史资料及 CLI 登录凭据；它不等于删除凭据或撤销飞书授权。用户可在飞书端单独撤销。此行为避免删除同一系统账号下其他 CLI 配置共享的凭据。
- 换账号 / appId 会暂停旧来源并清空范围，不将旧范围继承给新账号。

所有管理 API 要求节点 owner Bearer；设备与 MCP 凭据无法安装软件、登录、配置或同步。响应禁止缓存。远端节点继续遵循 Mote 已有 TLS 和强访问令牌部署要求。

## 同步边界

- 文档：最多 30 个显式选择，读取 Markdown 正文，单篇上限 100,000 字符，保留 document_id 与 revision_id；未给出文档作者时间时标记 unknown，不伪造创建时间。嵌入表格、图片、附件仅保留正文中的引用，当前不下钻或下载。
- 日历：最多选择 10 个；列表最多 30 页，每页 100 个；只允许 reader / writer / owner 详情权限。过去 0–180 天，未来 1–180 天，每次 API 窗口最多 30 天。保留实例 ID、起止时间、全天、时区和显式取消状态；原生 instance_view 的全天结束边界为独占边界，不使用 +agenda 格式化后的包含日期。
- 本期使用有界全量重读与内容去重，未实现飞书增量游标或 Webhook。API 返回过多实例等错误时明确失败，不将结果宣称完整。空结果 / 权限丢失 / 窗口外消失不推断为删除，旧资料仍是其观察时点的归档。
- 不变内容幂等，修改保留历史，内容 A → B → A 也形成新版本。失败保留已成功入库的资料及上次成功时间，可重新同步；任务展示本次已入库与重复数量。同步归档成功不等于 Memory 提取完成。
- 来源页手动暂停的来源不会被周期同步自动重新启用。重新保存范围或重新授权会启用选中的来源。

## 接口

| 方法与路径 | 用途 |
|---|---|
| GET /api/connectors/lark | 获取安全状态与当前任务；不执行 CLI |
| POST /api/connectors/lark/check | 检测版本、应用配置和用户登录 |
| POST /api/connectors/lark/install | 安装固定官方 CLI 版本到专用目录 |
| POST /api/connectors/lark/setup | 创建应用，返回异步任务 |
| POST /api/connectors/lark/configure | `{appId, secret, brand}`；secret 通过 stdin |
| POST /api/connectors/lark/login | 最小只读范围设备码授权任务 |
| POST /api/connectors/lark/cancel | 取消当前任务 |
| GET /api/connectors/lark/calendars | 列出可读日历 |
| PUT /api/connectors/lark/selection | `{documents, calendarIds, pastDays, futureDays, timeZone, autoSync}` |
| POST /api/connectors/lark/sync | 启动读取与归档任务 |
| DELETE /api/connectors/lark | 停止读取、暂停来源、保留历史与凭据 |

接口依据与本机匹配的 [官方 CLI v1.0.57](https://github.com/larksuite/cli/tree/v1.0.57)，其中 `auth status`、设备码流程、`docs +fetch`、原生日历 instance_view 均按该版本输出结构实现。

## 验证

`apps/server/test/lark.test.ts` 使用合成 CLI 响应测试只读命令边界、登录取消 / URL 和设备码隔离、来源版本与重复同步、账号变化、日历取消和 DST、管理接口授权。另覆盖连接器重启后的范围恢复、来源暂停不被重新启用及设备码过期。`apps/web/test/lark-settings.test.ts` 使用实际 React DOM 验证安装状态、扫码与链接、取消、范围保存、日历选择、断开确认及错误状态。

真实账号扫码、租户权限审批、远程部署的 CLI 下载和操作系统钥匙串交互需要在目标服务账号下完成，自动化 fixture 验证不能代替这些检查。

本次检查结果：服务端全套 299 项、网页 55 项、共享协议 34 项通过；Agent 80 项通过，1 项既有测试跳过；最后补充的重启与过期回归通过，飞书专项合计 14 项通过。全工作区 TypeScript 检查、服务端与网页生产构建及中英文目录校验通过。已实际运行专用临时目录中的官方 CLI 安装并核验 1.0.57 版本、独立未登录配置；浏览器已检查设置入口与初始环境 / 授权界面。完整桌面打包因本工作树缺少固定 llama.cpp 源码而未完成，未执行真实飞书账号授权或读取。
