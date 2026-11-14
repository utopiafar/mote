# 中央文件处理：Cordis 插件与本地多人录音

本地录音的当前默认实现是 **Fun-ASR-Nano-2512 + fsmn-vad + CAM++ + CT-Punc**。当前候选仍有[集成阻断](#当前集成边界)，尚不能宣称可干净安装并完成默认完整链路；安装文件、模型健康和完整处理成功是分别验证的事实。

2026-10-15 已接受[任务恢复与按类型设计执行预算的原则](adr-task-recovery-and-execution-budgets.md)：每种任务在开发和注册时声明适合自身的宽松默认超时策略，不统一套用 600 秒；明确的资源等待不耗处理失败预算，也不因通用恢复窗口结束主流程。中央各类任务的具体策略见[任务执行策略](task-execution-policies.md)。

## 用户配置

新上传录音默认由中央本地转写并分离匿名说话人。模型缺失时先归档、等待安装；旧文件不自动补处理。在网页「设置 → 文件与语音」可关闭处理、调整单文件最长时长（默认 120 分钟，1–1440 分钟），也可按来源或类型修改录音方式。没有每日分钟限额。

- **仅归档原件**：保存原始文件，不读取内容。
- **转写接口**：调用配置的 Mote HTTP 转写接口；可接本地服务，也可接云 ASR 适配器。远端必须显式启用且使用 HTTPS。
- **本地多人录音**：FSMN 分段 → Nano 识别 / CT-Punc 标点 → 保存识别检查点 → CAM++ 匿名分人 → 共同句段归属 → 可关闭的保守消重 → 未校正记录。人数默认为未知，也可显式声明准确人数或完整范围（1–16）；证据不足明确失败。转写文字进入配置的索引、Memory 和问答；摘要、语义分组和复核使用各自所选分析模型，可以是本地或云端。

自动分离的 `SPEAKER_n` 是未经确认的匿名声纹簇，不代表真人姓名、主人身份或跨录音身份。保留全部合法标签和声学区间，沿用 100,000 个区间的有界预算；试听独立限制为最多 16 个有足够独立发言的标签。超过试听额度不丢弃后续发言。CAM++ 结果没有 WeSpeaker 的轮廓系数估计或旧分割模型 provenance；缺失归属为 `SPEAKER_UNKNOWN`，明确标记不确定，不按文本猜人。

默认语音协议是 `mote.funasr/1`：`audio.local-dialogue@5`、`audio.diarize@4`、`mote.audio-dialogue@3`、`mote.funasr-align@1`。原生输出是 `mote.funasr-transcript@1` / `mote.funasr-dialogue@1`；通用文字、图片及自选 HTTP 处理器继续使用现有 `mote.transcript@2`。旧固定版本的未完成任务明确阻塞，显式重新转写才选择当前版本；安装、重启和默认设置改变不自动重算完成历史，没有旧引擎或云端自动回退。

原件完整规范化为 PCM16 单声道 16 kHz，时长来自实际 PCM 帧数，保留尾部静音。检查点保存原始识别块、标点后的全文、同一次 VAD、句段、精度和模型/依赖身份。当前引擎使用 VAD 粒度；没有可靠词时间时省略 `words`，不插值制造时间戳。所有当前领域时间明确为毫秒，负数、倒序、反向、越界或不完整识别都拒绝；合法的重叠和短句段保留。通用外部处理器提供的原生词时间仍按其现有合同保存。

不同来源可以覆盖默认方式；精确 MIME 或 `audio/*` 等类型规则由文件策略设置。普通文件图片默认仅归档；截图的中央 OCR 由独立的「中央感知」设置处理。UTF-8 文本内置提取。Shadow 不下载内容、不创建处理任务。

本地 OCR 支持长截图：在 4000 万像素和 64 块上限内分块识别，块之间保留边界重叠，按文字框的图像坐标归并。同样的文字出现在不同位置会保留，不按文本去重。原图不缩写或覆盖；仍受请求 8 MiB 大小上限约束。模型框几何来自 [PaddleX OCR 输出](https://github.com/PaddlePaddle/PaddleX/blob/release/3.5/docs/pipeline_usage/tutorials/ocr_pipelines/OCR.en.md)。

`image.http@2` 的片段可携带 `imageLocation: {width, height, polygon}`：宽高为原图像素尺寸，polygon 为原图坐标系中的文字多边形，分块 OCR 已加回裁切偏移。共享契约接受 3–16 个有限坐标点，尺寸和坐标体积有界；轻微越过图像边缘的模型坐标原样保留，不静默裁剪。没有几何的外部处理器仍可返回纯文字；本地 worker 对缺少位置的输出给出警告，不捏造坐标。

位置随原始产物和文件证据保存，正式资料的结构化正文与定位信息也保留它，供只读模型解释布局。普通阅读视图显示文字，原始结构可核对坐标。相同文字在不同位置不会合并，不按左右位置确认本人、对话角色或发言归属。文字更正保留原位置；位置更正产生新的对应证据，仅使依赖该片段的记忆过时，其他片段及历史原文保持。安装新处理器不会自动对全部历史图片重跑 OCR。

文件详情显示每步进度。分离失败后，已完成的转写仍保留，自动重试使用持久化检查点；可单独重新分离。完整重做转写、变更模型后的手动重处理会生成新产物。已有完成文件不会因全局设置改变而立即重跑。

单次文件处理调用超时默认为 1 小时，可在既有设置中配置为 1 秒至 1 小时；已有显式数值保留，作为单次调用覆盖值。文件 pipeline 和摘要协调器不设整链总期限，转写与分离分别在实际获准执行后开始计时。本地音频请求通过 `X-Mote-Processing-Timeout-Ms` 把调用预算交给 Worker。受管理 Native/Docker Worker 的独立运行上限仍为 1 小时。自定义 Worker 的 `--timeout` 仍是独立上限，不能被请求头扩大；未携带该请求头的旧客户端沿用其运行时默认值。仅修改中央设置不能扩大旧版或自定义 Worker 的独立上限。实际长音频是否能在配置时间内完成仍需观察，调整超时不改变音频时长上限、模型、原件或说话人确认规则。

原录音永不覆盖。手机删除不会删除中央归档；上传确认只清除 Mote 暂存。日常删除策略与首次 `all` / `new_only` 同步设置见 [文件归档](files.md)。

## 在中央主机启动本地服务

受管理部署入口见 [OCR 与转写方案](ocr-asr-implementation-plan.md)。语音依赖使用独立的 Python **3.11** 环境与 [requirements-audio.txt](../scripts/requirements-audio.txt)，不混用 OCR 或视觉环境。`node scripts/mote.mjs media-runtime --profile dev --role dialogue` 只准备所选角色的运行依赖，不等于安装模型、后台授权或真实推理通过。各平台干净安装仍需独立验证。

四组件属于同一个 `dialogue` 安装角色，目录相对该 profile 的私有 `modelDirectory`：

| 组件 | 模型 ID | 目录 |
| --- | --- | --- |
| ASR | `FunAudioLLM/Fun-ASR-Nano-2512` | `dialogue/asr` |
| VAD | `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` | `dialogue/vad` |
| 匿名分人 | `iic/speech_campplus_sv_zh-cn_16k-common` | `dialogue/speaker` |
| 标点 | `iic/punc_ct-transformer_cn-en-common-vocab471067-large` | `dialogue/punctuation` |

SDK 固定 `funasr==1.4.25`，wheel SHA-256 为 `11ab7bd8c7574a94579b83a9f8fe837af46be6229462da5f3004a04a017cee75`。制品文件、revision、size、SHA 和许可证由 [安装 catalog](../apps/server/src/media-assets.ts) 与 [引擎 manifest](../scripts/mote_funasr.py) 提供，二者必须一致才能接通；当前差异见下文。推理只读已校验的本地文件，不下载权重、不换旧引擎。

当前 worker 的手工调用接口如下，路径由部署者选择；不要把个人目录或密钥写进仓库：

```sh
"$DIALOGUE_PYTHON" scripts/transcription-server.py \
  --model-root "$MODEL_DIRECTORY/dialogue" \
  --backend cpu --threads 4 --timeout 3600 --port 9009
```

Native Apple Silicon 可显式选择 `--backend mps`；当前引擎入口接受 `cpu|mps`，不支持的后端不静默替换。令牌来自私有环境的 `MOTE_MEDIA_WORKER_TOKEN`。服务固定监听 `127.0.0.1`，每次只处理一个录音请求，识别和分人各用可回收子进程；所有端点均需 Bearer，包括 `/health` 和执行事实查询。中央与 worker 需共享可达的 loopback 环境，远程 Central 部署继续要求 TLS 和强令牌。

`POST /transcribe` / `/diarize` 接收 multipart 的 `request`（UTF-8 JSON，最多 32 MiB）和 `audio`（原件，最多 512 MiB）。分人必须携带已经保存的原样检查点。传输复用 offline、处理预算、request ID / scope 和执行事实头；`audio.http` 是独立的自选 octet-stream 接口，不使用这份原生协议。

模型缺失、组件缺失和 worker 未就绪是未开始的阻塞；容量忙是未开始的等待，不消耗实际推理失败预算。执行后的推理失败、超时、输出超限、人数约束不足、已终止取消和响应未知分别保存。断连或重启本身不能证明推理已终止。取消、删除、原件版本改变和后台授权停止后，迟到结果不能发布；已完成转写在非删除情况下保留。

### 当前集成边界

安装 catalog 与引擎使用同一份固定的四组件清单和内容摘要。Central 校验 worker 的完整 identity，并在识别与分人检查点中原样保留推理设置指纹。默认配方的保守消重由公共 processing 装配提供实现，按检查点记录的真实时间精度生成派生稿并保留原始带说话人稿和完整映射；关闭消重直接使用保留的完整记录。生成模型边界下的联合合同验证不代表真实模型安装与识别质量已通过。

部署/Compose、systemd 模板、公共健康与设置页须随对应实现一并核对；不要使用仍携带旧 `--model` / ONNX 参数的服务模板来启动当前 worker。生成模型边界下的成功后段不能替代这些直接生产接缝的验收。

## 分层、导出和人工确认

归档结构：

```text
不可变原件 + 来源/版本/SHA-256
  → 原始未校正转写 + 不可变识别检查点（真实句段/VAD 精度）
  → 原始 diarization + 匿名声纹试听片段
  → 带说话人的未校正记录（可检索、引用、回听）
  → 保守消重派生稿（默认开启；原始带说话人稿与映射保留）
  → 可选所选模型语义分组（只能合并连续同说话人片段）
  → 人工确认的场次关联 / 说话人名称 / 独立校正版
```

单文件导出 `.tar.gz` 保留原始转写 Markdown/JSON、diarization RTTM/JSON/CSV、完整记录 Markdown/CSV、`speaker_samples/` WAV、来源与版本清单。`artifacts/<id>.json` 保留完整产物及历史、原生检查点和输入引用；消重产物另提供 `dialogue.original.*`、`dialogue.derived.json`、`dialogue.cleanup.json`，人工稿提供 `dialogue.corrected.json`，`locations.json` 绑定当前片段。所有条目计入导出大小上限。原件单独下载，不重复放入结果包。

默认 FunASR 归属直接消费同一检查点的句段与 CAM++ assignments，不再将新转写贴到另一套旧分人时间上。自动消重只合并相邻、句级精度、正时长、同一已知簇、所有文字和时间等字段完全相同的重复观察；VAD 粗精度、真实重复、短插话、细微词语差别、未知归属及重叠均保留。它始终是 `dialogue/uncorrected`，不会变成人工 `corrected-dialogue`。关闭消重从保存的原始带说话人稿生成新版本，不从清洗文字猜回原文。

重叠检测当前为 `unknown`，未标记不代表没有重叠；匿名标签也不等于独立人声音轨。当前链路不承诺跨模型逐字、识别质量或时间精度完全一致。

ASR 原始片段允许时间重叠。若某句的词级开始时间晚于下一片段的开始时间，词级展开会产生逆序的派生时间线；此处沿用整句文字与句级时间，明确标记说话人不确定并在产物警告中披露。原始转写、原件和原时间戳保持不变，不排序识别词语、不挪动时间，也不把片段重叠当作已确认的真人同时发言。

语义合并、场次推荐和术语复核属于可选步骤。文件方案可选择兼容 OpenAI Completions 的语言模型服务，或使用中央文件分析模型；本地与远程服务都可选。模型通过现有 Harness 的只读查询工具读取本次证据。未配置可用模型时，该步骤等待配置。自然轮次分组当前每文件最多 200 轮；术语复核每批 200 段，可继续下一批。

日程推荐只在中央已同步日程中查找默认录音文件时间前后 7 天候选（最多 200 条）；API 可明确指定最多 31 天区间。由模型依据内容、文件时间和日程做选择；候选不足时保留不确定性。不会把日程计划写成真实出席证明。关联需用户确认，日程变化后拒绝旧建议。

术语复核只生成精确原文子串的候选；用户选择并可修改替换词后，才生成单独校正版。不接受没有引用、原文不符、重叠或已过期的校正建议。匿名声纹标签的姓名映射也只能由用户填写。

文字校正与处理器重跑共用片段写入逻辑：文字、位置和说话人信息未变的片段保留证据 ID、索引和 Memory，替换的片段同步使对应原始及正式证据的记忆和在途提取失效。校正保留原件和各版转写，继承本场说话人的用户确认。改过文本的片段移除不再匹配的逐词时间对齐，未改片段保留；相同时间戳的片段通过显式次序保持稳定。文档校正保留原始文档位置，不生成音频时间。

确认姓名后，文件证据的 `speakerAttribution` 同时交给 Agent 和 Memory，携带名称、确认来源、确认记录 ID 与时间；原始 `SPEAKER_*` 标签和逐字文本不替换。名称只是用户对本场录音的标注，不证明转写准确，也不自动建立跨录音的身份或确定哪位是用户。修改或撤销某个标签的名称，会使依赖该标签片段的旧记忆、检查点及回答失效，其他标签不受影响；相同名称重复保存不产生新版本。文字校正沿用确认来源，重新进行声学分离后需重新确认。

正式 SourceItem Material 的音频段落使用结构化文本同时保留匿名标签、确认记录与原始转写；未命名的说话人仍保留匿名标签。每段声明对应文件片段的证据依赖。名称更正或撤销在提交事务内使对应正式证据、记忆和在途提取失效，不等待后台重建；期间资料显示待重建，整篇当前读取返回 409，避免继续提供旧姓名。重建保留内容、上下文及来源都未变化的块引用和记忆，历史版本仍可核对。文件片段接口与资料整理器共用确认读取逻辑；普通文件 Memory 仍必须通过已发布资料及其声明的处理依赖准入，不能直接用原始文件 ID 绕过。

## 开发者：真正的 Cordis 插拔

文件处理和查询 Harness 使用同一 `@deepseek-ai/cordis` 框架。文件处理使用中央常驻 Context，避免一次查询结束就销毁文件任务。查询仍由 Harness 执行，工具仅能读上下文。

通过受信任的插件包装配处理贡献；`plugin-dev` 在私有开发 profile 中按 Manifest 安装：

```sh
node scripts/mote.mjs plugin-dev dev --plugin /absolute/my-plugin --once
```

```js
// custom-audio.mjs — 部署者安装的代码，不是从录音或网页输入执行代码
export default {
  name: 'my-file-processor',
  inject: ['moteFileProcessors'],
  apply(ctx) {
    ctx.effect(() => ctx.moteFileProcessors.register({
      id: 'acme.audio', version: '1.0.0', name: '自定义语音服务',
      stage: 'extract', mediaTypes: ['audio/'],
      async process({file, settings, signal, maxAudioMs, readOriginal}) {
        // 在此接云 ASR、本机服务、agent 或 skill runner。
        // readOriginal() 是本次文件流；必须尊重 signal、大小和时长预算。
        // 返回值由中央严格校验，不能自行写中央数据库。
        return {durationMs: 1000, segments: [{startMs: 0, endMs: 1000, text: '实际识别文本'}]};
      },
    }));
  },
};
```

`ctx.effect()` 返回的注销函数随 Cordis Context 释放。处理器 ID 不能重复；版本参与任务指纹。插件模块拥有中央进程代码权限，只能由部署者安装。网页/API 不提供安装可执行模块的入口。

处理器的身份用于注册和选择，流程行为由能力声明决定：

| 声明 | 中央如何使用 |
| --- | --- |
| `localOnly: true` | 处理器在本地执行，只能绑定本地处理服务；产出内容按普通证据供配置的索引、Memory 和查询模型使用。 |
| `allowSummary: false` | 不执行自动摘要。省略时由用户方案决定，使用方案分析模型或中央文件模型。内置多人录音不强制禁用摘要。 |
| `dialogue: true` | 音频提取后组合方案选定的分离器、时间对齐及可选语义分组；不以插件名判断。 |
| `managedModel: 'dialogue'` | 仅在实际使用中央受管理音频服务时，依赖它的模型安装状态和版本。自定义服务管理自己的模型。 |
| `dependencies: {settings, parameters?}` | 声明影响该步骤结果的设置及参数。未声明时保守纳入全部；空数组表示不依赖。 |
| `reuseByContent: true` | 仅用于提取步骤；声明输出只依赖原始字节、MIME 与固定的处理器输入，允许跨记录复用相同指纹的原始提取产物。不得依赖记录身份、标题、用户上下文或人工更正。 |

声明、处理器版本及所选分离器共同进入配置快照和检查点指纹。改变人数只重做相关分离步骤，已证明相同的 ASR 结果可以复用；缺少完整依赖的旧指纹不能证明兼容，会重新提取。插件实现、参数默认值或结果语义改变时须更新版本。

`reuseByContent` 是复用许可，不改变提取结果的指纹；只有部署者确认实现满足上述约束才可开启。内置 `image.http@2` 开启该许可。同一原件、MIME、处理器版本、所声明设置和模型版本全部相同才复用，原始提取与人工更正、说话人确认、摘要分开。新记录获得自己的证据和删除关系；明确要求重新提取会绕过跨记录缓存。

已导入资料的图片附件可由 owner 调用 `POST /api/records/:id/attachments/:attachmentId/processing`，按需进入现有文件处理流程。请求体可声明 `mimeType`；原归档为 `application/octet-stream` 时须显式提供，已有明确 MIME 时不能覆盖为其他类型。服务核对原始资料中的附件声明、留存关联及字节散列，复用原件存储，返回处理记录 ID。安装、升级和重启不会自动为全部历史附件创建处理任务；此入口目前是 owner API，未增加专用 UI 按钮。

附件文字与资料正文组成同一份正式 Material。正文仍使用 `source-body`，每个已选择处理的附件提供 `attachment/<attachmentId>/text` 命名产物，各自报告等待、失败或可用状态；图片几何、原始关联和证据定位保留。消费者只等待其声明的产物；其他附件失败不改变已可用正文或附件的输入指纹。处理记录不重复显示为时间线活动。撤销原始资料或附件关联后，读取和在途结果提交重新验证权限，不能用旧处理结果恢复已撤销证据。

内置多人录音直接支持所选模型的语义分组、摘要与复核，无需加载独立的中央分析插件。转写片段、摘录、正式 Material、Memory 与聚合资料都遵守普通来源授权和证据有效性检查；处理器执行位置不传播为内容权限。来源撤销、删除、过期和用户取消仍在模型排队、读取与结果提交时重新检查。当前录音组合的 ASR 与分离步骤共享方案服务地址；采用不同服务的适配需在插件中实现。

本次移除不提供旧配置、旧插件或历史任务的兼容迁移。模型服务统一在方案服务连接中配置。

扩展接口在 [file-processors.ts](../apps/server/src/file-processors.ts)：

- `extract` 接受原文件，通过注册的输出 parser/projector 投影标准 Transcript；默认 FunASR 同时保留原生识别 envelope。音频 HTTP、UTF-8、图片 HTTP 保留各自通用输出。
- 默认 CAM++ `diarize` 消费保存的原生检查点并返回当前 FunASR envelope，由输出注册表投影标准 Diarization / dialogue。自定义分人插件仍可返回现有 Diarization；声明 `localOnly:true` 时只能绑定本地服务。部署者继续审查自定义可执行代码。
- 中央负责队列、检查点、版本、存储、引用、确认及导出；不能把这些一致性机制交给 prompt。
- 服务的音频/图片选择取 MIME 结构与用户配置，不用关键词判断内容主题。
- 自定义云 HTTP 服务接收原始字节 `POST`，响应 `{durationMs, segments:[{startMs,endMs,text,words?}]}`。支持 Bearer 密钥、`X-Mote-Max-Audio-Ms`，JSON 上限 32 MiB；图片响应 `durationMs=0`。这不是任意厂商 ASR URL 的直接兼容层：不同鉴权/请求协议由自定义 Cordis 插件适配。
- 严格本地服务需返回 `X-Mote-Execution: local`。内置 Python 推理子进程关闭 Python 网络连接并开启模型离线模式，FFmpeg 只允许本地文件协议；这是内置依赖的网络约束，不是对任意不受信任 native 插件的操作系统沙箱。

## 验证

```sh
npm run test:file -w @mote/server -- test/funasr-journey.test.ts
python3 -m unittest discover -s scripts -p 'test_audio_control.py'
npm run check:affected -- --dry-run
```

轻量 journey 使用私有生成 profile、生产 Central / Store / 上传路由、生产 Python HTTP / 子进程 worker 和受控模型边界。直接安装身份与健康接缝、默认消重装配各自设独立断言；后段隔离用例明确标注生成的健康身份投影和显式关闭消重，不能用它们的通过覆盖直接接缝失败。整个命令未通过时必须保留失败和接收方。

真实模型、平台、长录音、质量、UI 和物理设备验收只在明确请求后执行。轻量检查不下载模型或声音，不安装依赖，不占用日常 Central，也不证明发布资格。

### 可核对的本地语音对照

获准执行质量验收后，`scripts/generate-audio-control.py --output /absolute/new-directory` 可用本机已安装的两种 macOS 中文声音，生成八轮对话及台词、时间范围、声音和文件哈希，并记录源码 commit、系统、Python、语速、采样格式和间隔参数。`--gap-ms 0` 去掉额外静音。输出须位于仓库外的全新目录；它不下载声音、不使用私人录音，也不覆盖静音、短插话、重叠、长录音或真人泛化。

把生成 manifest 交给隔离的真实模型验收入口后，`scripts/evaluate-audio-control.py --reference .../reference.json --run ... --output .../quality.json` 只读已关闭、WAL 已检查点化的资料库。评估从持久原始 artifact 取全文，不从已经移往派生稿的当前 chunks 反推原文；原生 FunASR 检查点、分人检查点和标准投影必须相符。报告包括原始 CER、匿名标签的一对一匹配、带说话人的字符错误、人数、未归属、重叠、逐轮漏段和起止偏差、尾段时刻、完整时长、模型/依赖/后端身份及已有执行记录。未知标签不算一个人，多余簇不能合并抵消。

轮次内部可能包含自然静音，标签混淆与未归属指标不等于标准 DER；逐轮位置也不是词级对齐。带说话人的字符错误只使用真实 native assignments，缺该数据时报告不可用。可在独立评估环境准备固定的评估依赖并使用 `--normalize-chinese-script`，同时报告原始与 OpenCC 繁简归一 CER；主带说话人字符指标仍采用 NFKC/casefold，不改写归档文字。

工具内的阈值只用于生成对照的回归边界，不是用户接受的真人 SLO。发布质量验收需先冻结更完整的中文/中英、不同人数、静音、短插话、真实重复、重叠数据集与评分规则，再固定权重、参数、环境和源码版本运行。已有旧引擎或私人实验分数不能算作当前 FunASR 结果；私录复测须另获明确授权，原件与转写始终留在私人目录。

Native Apple Silicon 的干净安装/离线模型/完整交互，Linux 或容器的构建、安装和 CPU/GPU 实际处理，现有 512 MiB 文件上限与 1–1440 分钟配置边界的长录音完整性、取消和资源，以及真实浏览器/设备回听、Memory/Ask 模型质量均仍需对应独立证据。MPS 结果不能替代 Linux，生成 fixture 也不能替代任一平台。未运行项应标为未完成，不据一个成功短录音宣布完整替换验收通过。

## 安装状态与执行状态

模型文件安装完成不等于 Worker 可运行。Native 启动会分别探测 Python 依赖和 `ffmpeg`；缺少 `ffmpeg` 时报告 `media.runtime.ffmpeg_missing`，健康端点继续可用，设置展示缺失的依赖。安装系统程序后，Worker 的 `/health` 会重新检查可发现路径，无需重新下载模型。macOS 使用 `brew install ffmpeg`；部署进程的 `PATH` 必须包含该程序。

归档策略及关闭摘要产生“未安排”的步骤，不属于阻塞故障。文件视图读取当前执行收据；重启后恢复期限结束也不会继续显示旧的等待状态。返回结果未知仍保留防重复执行保护，只有明确的本地“未开始执行”拒绝或所有者确认的重跑才能释放。快照恢复只复用仍有效的临时输入，输入过期时需要按原范围重新同步，不改变长期保留策略。

厂商导出为空时保留导出和音频，显示“采集完成，暂无文字”，不生成空的全文或 Memory。非空但格式不支持会保留导出并显示专门故障；已知上游未就绪才进入有界重试。录音设置中的同步步骤支持完整分页，失败预览包含条目标题。参见[结果与运行依赖 ADR](adr-recording-outcomes-runtime.md)。
