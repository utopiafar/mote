# 插件中心与 Memory 方案

插件中心位于「设置 → 插件」，包含已安装、发现和记忆方案。它管理当前 Central 的包、配置实例、运行能力、自动准入和正文绑定；GitHub 资料连接器仍在来源中管理。Web 与 Android 使用同一声明式状态合同；Android 使用原生页面。实际执行记录见 [一期验证方案](design/plugin-center-phase-one-validation-2026-10-12.md)，架构选择见 [ADR](adr-plugin-center-memory-replacement.md)。

## 安装、配置、启用和绑定

这四步分别进行：

1. **预览并安装固定 release**：解析仓库/tag，核对确切 commit、制品 SHA-256、能力、访问声明和依赖；持久下载完成后登记包。安装不创建默认实例、不启用、不调用模型或扫描历史。
2. **创建配置实例**：按包的字段 schema 填写服务地址、模型预设与已有凭据引用。凭据本身保存在 Central 私有模型配置，不填入插件表单。配置保存与连接核验分开。
3. **核验并启用**：实际供应方探测成功后才开放启用和可用方案。期望启用与实际 ready/enabled/blocked/failed 分别显示。缺依赖或错误配置不会静默改用另一供应方。
4. **准备并应用 Memory 方案**：选择已授权历史范围，确认实际模型/Embedding 费用；迁移与核验完成后另行应用。安装或启用不会自动接管当前方案。

当前整体方案支持内置、Mem0 正文+检索组合及受控 Hindsight 引擎。高级面板显示实际模块和绑定；同正文权威单独更换 retrieval、任意模块组合编辑尚未提供用户操作。

一期控制目标是 `default` 空间。owner token 或现有配对 owner 会话可以管理；collector、MCP token 和只读查询 Agent 没有管理权。操作带 `operationId` 与 `expectedRevision`。断线重试保留同一请求身份和原始 body；revision 冲突需读取当前事实再作选择，不能把旧请求自动改为新授权。

未配置实例只表示已安装。未知或不通过的能力阻止对应方案生效。节点重启要求和外部结果未知如实展示；页面刷新不是服务重启或任务完成。

## 支持的固定上游配方

| 方案 | 安装来源与运行方式 | 必需配置与限制 |
| --- | --- | --- |
| Mote 内置 | 随 Central 分发；内置正文与检索 | 保留原提取、独立审核和整合；可与已核验模块方案互相迁移 |
| Mem0 OSS 模块 | `mem0ai/mem0` 的 `ts-v3.3.1` 固定上游源码；本 Mote 构建分发受控适配器与精确锁定 `mem0ai@3.3.1`、SQLite 依赖 | Embedding endpoint、model、dimension；受保护端点使用 `model:<已有预设 ID>` 凭据引用。接管正文与检索，保留 Mote 提取/审核/整合；不包含托管平台专属能力 |
| Hindsight 完整引擎 | `vectorize-io/hindsight` 的 `v0.10.2` 固定官方 API source wheel（ZIP）；Mote 管理的 Docker API/DB 和独立受控 worker | 选择可用模型预设；服务器需可用 Docker。接管提取、整合、正文和检索；独立审核、原件授权和发布仍归 Mote。只有实际实例探测通过才可准备 |

这两个上游 release 不要求上游发布 Mote manifest：当前 Mote 的兼容配方提供适配器，固定源码制品用于来源身份与完整性记录，不执行上游 bootstrap/npm lifecycle 脚本。其他原始仓库或未支持的 tag 没有兼容 manifest 时明确拒绝；不能由包名推断兼容。

Mem0 使用持久存储与不可变完整版本，显式 opId journal 对账；它不把原生 add/update 当成宿主幂等。原生删除可能保留 history 字节，物理擦除保持未确认。远程 Embedding 连接需 TLS 和已有凭据引用，loopback HTTP 可用于本机服务；真实费用来自服务用量，未知不记零。

已固定配置的 Mem0 本地历史不依赖继续持有 Embedding 凭据：删除模型预设或清空凭据后，原配置的 literal read/export/remove 仍可使用已有 SQLite 历史，不发送 Embedding 请求。新的 put/search/recover 必须重新检查准确预设，缺失或空凭据时失败，health 不再 ready；没有原生历史的新实例不能通过此路径启动，也不会改用默认预设。

Hindsight 安装来源是同一固定 release 的 `hindsight_api_slim-0.10.2-py3-none-any.whl`，核验实际 ZIP 字节摘要；不下载包含大体积文档/构建工具的整个仓库源码，也不执行 wheel。通用 ZIP 下载、展开和路径边界保持不变。

Hindsight 固定运行镜像为 `ghcr.io/vectorize-io/hindsight@sha256:d1840062a5b79940ab7a9f4809ceb90fc776d4ad737cd9329e9b5836cc64ab70`。Central 为配置实例创建私有 volume、认证和 loopback API；禁用内嵌 worker，由宿主只对准确获准的 banks 启动受控 worker。首次能力检查会启动实际服务、加载本地 embedding/reranker，并可调用已选择模型，因此检查耗时与模型用量不等于零。

Hindsight 原生 retain/显式整合只生成隔离提案，经 Mote 独立审核后才发布；正文迁移使用 literal import，不能重提取历史。完整 reflect 只读取宿主固定可见的精确版本和原件摘录构成的独立 read bank，不能凭 tag 过滤访问 staging、退休版本或越权 facts。原生 cancelled 状态不证明停止写入；宿主控制 owned worker，并将迟到输出隔离在发布边界之外。更换模型语义配置需重新配置、核验与准备，旧历史不能被静默换模型解释。 原生 Reflect 属于已核验的适配器能力；当前 Ask 仍通过 scoped recall 与 Mote 只读 QueryAgent，尚无原生 Reflect UI。

## 通用兼容 release 与 worker ABI

受信维护者可以发布兼容 ZIP 和 `mote-plugin.json` release asset。当前通用 worker ABI用于正文与检索模块；完整引擎另需实际受支持的 prepare/reflect/自治任务合同，不能用 storage health 代替引擎核验。

Manifest `schemaVersion: 1` 声明：

- `id`、`name`、`version`；`runtime: "worker"` 与 ZIP 内相对 `entry`。
- `archive: {asset, sha256}`，asset 为同一固定 GitHub release 的 ZIP，摘要为实际 ZIP 字节的 SHA-256。
- `capabilities`；声明不等于已核验能力。
- `configuration`：无代码字段，支持 text、number、boolean、select、model-profile、secret-reference；字段可声明 required/options/description。
- `dependencies` 与 `access`：供所有者审阅；依赖必须已随制品/宿主分发，安装器不调用 npm、shell 构建或任意安装脚本。

解析器要求 HTTPS GitHub repository/release 身份和选定 release 内 assets，检查摘要、ZIP 路径与资源边界；缓存重用再次核验固定 archive 与实际展开文件。具体 schema 在 [plugin-release.ts](../apps/server/src/plugin-release.ts)，正文合同在 [memory-provider-contract.ts](../apps/server/src/memory-provider-contract.ts)。

入口模块导出 `createMemoryProvider(configuration)`，返回实现 `health`、`put`、`read`、`remove`、`search`、`export`、`close` 的对象。宿主通过独立子进程 JSON-lines 调用，并验证返回结构、namespace、精确键和写回执摘要。namespace 是宿主发出的 `ownerId / instanceId / bindingRevision`；精确键是 `memoryId / version / fingerprint`。实现必须提供持久不可变正文、作用域隔离、精确版本/允许 keys 检索与幂等恢复；能力探测和后续运行仍由实际合同验证。

一期仍在宿主 `memories.json`、reviewed output 和 exact put journal 保留完整正文作控制投影、事务审查与恢复；未进行 metadata-only SQL 清理。外部 binding 的正式正文读取仍从供应方完成，不能使用 SQL 副本隐藏缺失或篡改。

不可变正文完整性与宿主有效性投影分开：供应方按固定键保存正文、证据、版本、createdAt 和 fingerprint；回执/native JSON 的完整性自检仍严格核验全部字段。原件失效可能在不增加正文版本的情况下更新宿主 `status / staleReason / updatedAt`，读取和导出先核验实际原生正文/证据/版本，再覆盖这三个宿主字段；不能把正文缺失或被改写解释为普通 stale。

worker 和声明不是恶意代码沙箱：可信代码拥有中央宿主权限，访问声明不构成强制文件/网络隔离。动态包不注入任意远程 React/HTML；Web 和 Android 只渲染宿主支持的声明式字段/动作。端侧原生采集能力仍需要原生构建。

## 自动暂停与切换

全暂停关闭自动提取/整合的新准入，已登记 queued/running/checkpointed 工作按原授权、原 generation 排空。原件归档、可读资料、已有 Memory 和只读查询继续。独立洞察与工作摘要保留自己的设置。立即停止另行撤销未完成自动发布权并请求取消；外部结果未知与清除待确认保持可见。恢复产生新准入 generation，不补授暂停期间的输入；显式历史工作另行选择范围。完整规则见 [Memory lifecycle](memory-lifecycle.md#pause-drain-stop-and-resume)。

repository 更换迁移全部 Mote 保留记忆正文及更正/替代状态、规范修订和删除意图，并核验索引。外部原生审计历史、额外旧版本和引擎图保留在旧实例及运行备份中，不承诺跨引擎迁移。准备保留旧 binding；切换屏障冻结旧写入准入并排空/对账尾部，核验成功仍未生效，另用 CAS 应用新绑定。取消准备释放临时屏障，保留所有者的暂停选择，并保留已按迁移授权复制的合法规范正文；这不会发布目标绑定，也不会把“取消迁移”当作删除数据。来源精确删除或撤权仍沿依赖清除相应副本与操作正文，未知外部写继续对账清除。失败保旧，没有自动 fallback。既有查询固定旧 binding 与不可变版本，返回前仍检查当前授权和隐私。

绑定、准备、排空、已有查询或外部未知写/清除引用的安装包不能卸载。解除读写引用后可卸载包，数据删除是另一步；外部正文需先迁移或保留可用 reader。缺失外部正文明确报错，不能用 SQL 旧副本伪装成功。卸载保留只供历史清除使用的私有 retired 元数据；不在插件列表复活实例或恢复启用。逻辑删除立即 fence，本地 tombstone 与外部 pending erase 分开，不能把 endpoint accepted 当成物理擦除。

来源删除或撤权会在同一宿主事务中沿操作依赖登记退役，并清理 publication、reviewed output、write intent 与 owner mutation journal 的完整正文。结果仍未知的外部写保留 namespace、精确键、opId 和 body digest，只允许观察与清除，不重新 put。已提交的 owner publish/correct 回放也重新检查当前宿主与实际供应方正文、原件及返回前授权，不直接返回旧回执中的正文。这里的逻辑退役不承诺 SDK 原生历史或数据库/WAL 已物理擦除。

原生引擎输出首先是未审查提案，可以超出规范 Memory 卡片数量或尚未具备正式 admission 字段。共享 reviewer 仅在显式 native-engine origin 下跳过草稿的规范卡片校验；空原生提案仍必须独立审查。审查结果及缓存结果继续完整校验，缓存身份区分原生和 Mote 草稿；不能把这个边界扩展为跳过正式发布校验。

原生 staging 清理使用独立持久任务：合法的独立审查结果先保存宿主 checkpoint，再清理产生它的原生临时空间。清理暂时失败不撤回已合法审查的正文，但未确认清理会阻止迁移和卸载；重启后只重试同一供应方配置与操作身份的清理，不重新 native prepare 或再次审查。来源撤权、取消和终止的未采用 proposal 同样登记清理，并立即失去发布权。

旧提取任务若需要所有者确认归属，却没有正式 Material 引用，会保留已审核结果并显示 `memory_owner_material_required` / 等待输入。该任务不能自动继续，也不显示资料处理中；所有者仍可手工重新检查既有结果或取消任务。立即停止会沿真实生命周期 checkpoint 撤销未完成的自动 child，独立手工任务及所有者后续明确授权的回复不随之撤销。

受控 Hindsight 的正文 literal read/export 启动不发起语言模型请求；能力「核验」仍显式调用实际模型，原生提取、整合与 Reflect 也属于模型操作。不能把启动成功当成语义能力已核验，或把当前 API 不可见当成 PostgreSQL volume/WAL 已物理擦除。

## 控制 API 与验证

| API | 控制对象 |
| --- | --- |
| `GET /api/plugins`、`POST /api/plugins/resolve` | 包/实例/catalog 投影；固定 release 预览 |
| `POST /api/plugins/install`、`POST /api/plugins/:id/uninstall` | 安装/卸载；预览 ID 绑定私有固定制品 |
| `POST /api/plugin-instances`、`PATCH /api/plugin-instances/:id` | 创建/更新配置，更新以实例 revision 为前提 |
| `POST /api/plugin-instances/:id/check`、`.../enable`、`.../disable` | 实际核验与期望运行选择 |
| `GET /api/memory-spaces/default/binding` | 当前方案、能力、准入与准备状态 |
| `POST /api/memory-spaces/default/binding/pause`、`.../resume`、`.../stop` | 全自动 Memory 控制 |
| `POST /api/memory-spaces/default/binding/prepare` | targetPlanId、已授权 scope、费用确认与当前 revision |
| `POST /api/memory-spaces/default/binding/activate`、`.../retry`、`.../cancel` | 准备 ID、当前 revision 和新命令意图 |

fixture 入口包括 `plugin-control-journeys.test.ts`、`memory-automation.test.ts`、实际 SDK/worker 与读取消费者测试，Web `plugin-center.test.ts` 和 Android `PluginControlClientTest`。生成 ZIP 与 provider 只验证宿主边界，不证明真实上游语义。实际 GitHub/供应方/模型、真实 renderer、原生 UI、物理设备和最终受影响检查分别记录在 [验证方案](design/plugin-center-phase-one-validation-2026-10-12.md)；存在代码或编译成功不代表这些检查全部执行。
