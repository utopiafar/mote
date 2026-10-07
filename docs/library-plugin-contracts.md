# 资料库与插件扩展契约

本次保留 DeepSeek fork Cordis、领域 registries、ExecutionEngine、MaterialStore 和 Harness bridge。资料库是 MaterialStore 的所有者目录投影；新插件不能另建一套资料、任务或授权权威。

## 用户流程与归属

以前，默认列表展示采集记录，Coding 上传入口另有收据、聚合正文和处理状态，用户需要在不同入口寻找同一会话。现在资料库默认打开「全部资料」，包含已发布的 Coding 会话；来源筛选来自实际来源元数据。原始采集记录、专用视图、上传与处理有明确导航。上传成功只代表接收成功，尚未发布的输入在上传与处理查看。

资料正文和不可变版本归 MaterialStore；原始来源事件归 SourceArchive；解码、组织、索引归对应 source/file recipe；后处理归 ProcessingRuntime 与既有 ExecutionEngine；Memory 的费用和历史授权仍归已有 Memory 工作流。资料库外壳仅负责浏览和展示。Coding 上传状态不再嵌入第二套正式资料浏览器，查看正文跳到同一个来源筛选列表。

## 插件链路

| 扩展 | 注册位置 | 消费契约 |
| --- | --- | --- |
| 新来源 | ConnectorRegistry + SourcePipelineRegistry | 显式 sourceKind、隐私和接收协议；不按内容关键词选模块 |
| 中央组织 | SourceRecipeExecutor | versioned reader/group/window/join/steps/aggregation/publisher |
| 命名产物 | MaterialStore.artifacts | key、state、revision、blockIds；可读产物无需等待其他产物 |
| 后处理 | moteContextProcessors + moteMaterialConsumers | 精确 kind/schemaVersion/key、processor/version/config、声明输出 key/kind |
| 目录 | moteMaterialCatalog | 类型标签、card/detail/panels/actions 注册 ID；不携带可执行代码或 URL |
| Web 展示 | WebFeatureHost | 精确 kind/schemaVersion/representation；卡片、详情、面板、操作、collection/navigation；精确依赖版本 |
| Android | CentralCatalogDescriptor | 无代码类型描述与原生通用正文回退 |

FeatureManifest 拒绝未声明或不一致的注册。可信 Fastify v1 拓扑适配器可补齐原有空 manifest；Web 在安装时从实际贡献生成完整声明。server 依赖在当前认证连接的 inventory 中核验；本地依赖由 registry 核验。无匹配、依赖缺失、歧义、卸载或展示异常时保留通用正文。操作仅在所有者展示边界内注册，查询 Agent 不获得写工具。

同 ID/version 重装不会继承旧安装实例的提交权。source pipeline、source recipe component 和 context/file processor 使用 installationEpoch，独立于持久版本和执行 lease/fence。配置/输入变更、删除及取消仍沿既有执行与证据失效机制传播。

## 有界中央流程

window/join 是本次已授权 raw group snapshot 上的可执行变换，最多 10,000 项、16 MiB，复用 source checkpoint 和持久 source-group 执行步骤。aggregation 同步产出至多 1 MiB 的值，由已有 publisher 决定如何发布。示例展示这三个实际回调被执行。

这不是任意跨来源读取、无限流 watermark 系统或独立流调度器。多个已授权正式产物可以通过 ProcessingStep.productInputs 显式输入现有 DAG；新增需要跨来源原件权限的流程必须沿已有授权机制扩展。

## 命名输入与授权

Material named product 和 EvidenceArchive artifact 各有权威，输入不能混用：

```json
{"steps":[{"name":"count","processor":"fixture.journal-statistics","productInputs":[{"authority":"material","ref":"material:mat_<64 hex>@<64 hex>","key":"body","offset":0,"length":4000}]}]}
```

artifact 输入使用 `authority: "artifact"`、id、revision。MaterialStore 解析命名 block 范围，保留实际读取范围与 lineage；旧的全资料输入仍兼容。输出可声明 `produces: [{key, kind}]`，用 `metadata.productKey` 发布，通过既有 processing job 的 `products` 字段查询。

安装 consumer 不扫描历史，也不授权执行。来源所有者显式配置 `consumers: [bindingId]` 后，新发布的资料通过既有 ExecutionEngine 创建 planning step；只准入声明 deterministic 的 extract/aggregate。semantic/memory 不从新绑定自动得到模型授权，继续由已有显式工作流和 Memory 规则负责。插件升级、重装或补处理不自动扩大历史收费授权。

## 可信部署示例

`examples/connectors/journal-connector.mjs` 与 `examples/plugins/journal-pack.mjs` 展示一个 namespaced 来源、命名 body/counts 产物、有界中央 policy、一个确定性消费者及目录锚点。配置绝对模块路径：

```dotenv
MOTE_CONNECTOR_PLUGINS=["/absolute/mote/examples/connectors/journal-connector.mjs"]
MOTE_BACKEND_PLUGINS=["/absolute/mote/examples/plugins/journal-pack.mjs"]
```

该示例不默认采集数据或扫描历史；创建来源并通过所有者 API 配置 consumers 后，使用既有 batch intake 推送生成资料。示例 card/detail ID 是可选锚点，未部署 Web 贡献时使用通用回退。`apps/web/test/library-browser.test.ts` 展示完整 card/detail/panel/action 安装与撤销，不修改公共资料库。

新来源和中央流程只新增部署模块及组合配置。新 Web 代码加入可信 bundle 组合；原生采集能力仍需要原生构建。当前不支持远程下载任意代码、不承诺所有宿主无重启安装。停用/卸载保留历史，删除和历史重算是独立操作。

## 历史约束与退出项

- 端侧负责授权、发现、隐私、暂存和传输；中央解码/OCR/ASR/组织/索引。采集内容始终是非可信证据。
- 收据、正式正文、索引、Memory 分别计状态；不制造一个全局 ready，也不让可读正文等待 Memory。
- 快照、原件、引用的授权不互相扩张；安装/升级不能触发模型消费或历史付费。
- MaterialStore / archive / ExecutionEngine / Memory 授权继续各自唯一负责。
- 退出原有资料类型下拉、records/materials 的外壳特判、Coding 页面内重复正文浏览器、丢失 requires 的 Web 贡献和只声明不执行的 window/join/aggregation。

本次新增产品行为是默认正式资料浏览、来源筛选、明确的原始/专用/处理导航，以及所有者配置后的确定性产物消费者；没有新增默认采集、付费任务、历史回填或删除历史行为。

## 验收

- `npm run check:local`：i18n、工作区构建/类型、全仓 fixtures。
- server `plugin-library-contracts.test.ts`：实际独立模块接入、命名消费、部分可读、同版本重装拦截、无自动模型授权、签名游标绑定身份/范围/目录代际。
- Web `library-browser.test.ts`：分页/筛选/身份切换/详情返回、专用卡片/详情/面板/操作安装撤销后通用历史可读。
- Electron `test-web-feature-packs.cjs` 和 `test-web-navigation.cjs --library-only`：隔离中央与真实 renderer，只使用生成资料。
- Android CentralCatalogDescriptorTest / LibraryBrowseTest + assembleDevelopment：描述回退和构建。

fixture、实际 renderer、物理设备和真实模型分别报告；构建或 fixture 通过不能代替未执行的物理设备与真实模型验证。
