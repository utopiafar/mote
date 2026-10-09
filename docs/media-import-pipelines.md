# 中央媒体导入与 Cordis 扩展

中央导入的音频和图片现在进入 Android 文件上传使用的同一条处理链路。ZIP 是容器，展开出的媒体各自建立文件版本和持久任务；无需先让导入 Agent 编造一条文本记录，才能安排转写或 OCR。

```mermaid
flowchart LR
  A[Android 文件上传] --> F[FileStore 文件版本]
  B[中央文件 / 目录 / ZIP] --> C[归档原件]
  C --> D[Cordis 容器与格式能力]
  D --> F
  D --> T[文本解码 / 解析预览]
  T --> M[Material 发布]
  F --> E[ExecutionEngine 文件配方]
  E --> P[有版本的提取产物与定位片段]
  P --> Q[搜索与问答]
  P --> M
  M --> R[按依赖就绪的 Memory 配方]
```

## 接收与处理

- `ImportStore` 保留容器与每个原件，按格式声明确定 MIME。扩展名、签名和声明的 MIME 只用于格式识别，不判断内容语义、作者、主题或日期。
- `FileStore.archivedRevision` 引用已有归档资产，通过文件接收事务建立 `source_versions`、`file_versions`、`file_heads`、`file_jobs`，同时提交原件关联和导入进度。无需上传第二份媒体。
- 文件配方沿用 `ExecutionEngine`、`file_steps` 和产物检查点。取消、重试、配置变更和重启沿用现有提交栅栏与处理器排他机制，没有增加另一套任务引擎。
- 文件提取发布定位片段，现有组织器发布 `Material`。`MaterialMemoryWork` 和 `MemoryPipeline` 按来源、用户设置及配方依赖安排自动 Memory；导入入口不直接调用第二套记忆逻辑。
- 文件名里的日期不是录制、事件或观察时间。新媒体记录的 `observedAt` 表示这次中央接收时刻，`document.timeBasis` 为 `unknown`，不填原始录制或事件日期。

`completed / saved` 只承诺接入已提交。`dispositions.processing` 表示进入文件处理，不表示成功转写。`ImportJob.media[]` 分别提供 `captureId`、固定的格式能力、文件处理状态、`searchable` 和 Memory 状态。某个文件失败不阻塞其他文件；可重试单个文件，无需重传原件。产生零条 Memory 仍可能是有效的处理结果。

提取是否执行、采用何种处理器、是否进行说话人分离、摘要及自动 Memory，使用与 Android 相同的文件处理及来源设置。服务或模型未配置时保留原件并显示 blocked；成功的原始转写片段可以在后续步骤尚未完成时被搜索。查询无需等待所有文件或所有 Memory 完成。

## 插件切面

本期支持已安装、受信的部署模块。Cordis 管注册、依赖与资源回收，持久工作由宿主管理。

| 根服务 | 扩展内容 | 宿主契约 |
| --- | --- | --- |
| `moteImportIntake` | `registerContainer`、`registerFormat` | 容器文件/字节上限、展开取消、恢复时版本校验、格式版本固定。匹配优先级相同时显式报冲突。 |
| `moteFileProcessors` | 原件提取与说话人分离提供方 | 原件流、已选参数、超时/取消、处理器版本、设置依赖与有效检查点。 |
| `moteFileOutputs` | `parse` 校验原生产物，`project` 提供定位文字证据 | 原生 payload 保留在产物中，公共投影经 `transcriptSchema` 校验；搜索和 Material 继续消费统一证据。 |
| `moteFileRecipes` | 有版本 DAG 与可替换阶段 | 依赖拓扑、无环及规模校验、版本指纹；返回值须为该文件已发布的产物。 |
| `moteMaterialOrganizers` | 组织和命名产物映射 | 使用现有 Material 发布和失效契约。 |
| `moteMemoryStrategies` | Memory 提取、审核与配方 | 使用现有独立准入、证据固定及结果审核契约。 |

注册通过 `ctx.effect(() => service.register(...))` 与插件生命周期绑定。版本必须随处理语义或输出契约变化；不能修改实现却复用同一个版本。配方、阶段、输出类型及提供方进入配置回执。缺少配方、阶段或输出类型时显示 `file_capability_unavailable`，恢复能力后可继续处理。已完成产物不会因为安装或卸载插件自动删除。

安装、启用、历史重算分别管理。安装模块只声明能力；处理器仍由类型方案/来源设置选择。已完成历史内容不会因安装自动重算；使用现有预览和重算操作。尚未完成的工作按现有配置协调机制重新准入。

## 默认组合与自定义组合

默认配方为 `mote.file-extraction@1` 的提取，以及 `mote.audio-dialogue@2` 的提取 → 说话人分离 → 对齐 → 可选语义轮次。所有默认提取输出统一为 `mote.transcript@2`，保留录音范围内的原生词级时间差异；录音对齐只注册 `mote.align@2` 和 `mote.audio-dialogue@2`。旧转写、对齐与录音配方不再注册；当前格式的已完成文件不会自动重算。提供方可通过 `recipe: {id, version}` 选择另一条 DAG，通过 `output: {id, version}` 选择原生输出类型。

自定义阶段用 `context.dependencies` 获得依赖产物 ID，`context.readArtifact` 只能读声明的依赖。通过 `context.transform(outputType, execute)` 计算原生产物；宿主负责校验投影、持久检查点、提交和索引。需要复用默认阶段时使用 `mote.extract` 等已有注册。默认说话人阶段分别使用名为 `extract`、`diarize`、`align` 的依赖。

当前公共证据投影是带位置的文字段，支持音频时间、文档定位、图像几何等已有字段。新增原生输出结构无需改导入和任务宿主；若新类型需要完全不同的检索表示，应增加对应的公共投影契约和消费方，不把任意 JSON 当成可检索完成。

[完整插件示例](../examples/plugins/media-intake.mjs) 注册一个签名识别器、原生文字输出类型、提取提供方和两步规范化 DAG：

```sh
MOTE_BACKEND_PLUGINS='["/absolute/path/to/mote/examples/plugins/media-intake.mjs"]'
```

示例选择的 MIME 为 `application/vnd.mote.text`，类型处理器为 `community.text-extract`。旧 `MOTE_FILE_PROCESSOR_PLUGINS` 仍可加载部署模块；新模块建议使用统一变量。`GET /api/import-capabilities` 列出接入能力，文件处理设置的 `capabilities` 列出配方、阶段和输出类型。文件处理解释接口返回实际配置回执。

## 恢复与验收边界

之前零记录或缺少解析配置的导入，可对保留的原件执行“重试导入”，重新识别并接入文件处理。显式选择的 Python Source Pack 仍固定自身解析方案，不被自动格式识别静默替换。

自动用例使用生成的 ZIP/媒体字节、生成图片及脚本 ASR/OCR/Memory 提供方，覆盖 61 文件、混合形态、去重、重启、单文件失败恢复和自定义部署模块。它们验证接入、调度和发布契约，不验证真实 MP3 解码、ASR 准确率、模型语义效果或 Android 真机行为。PR 前执行 `npm run check:local`，实际模型和真机检查单独报告。
