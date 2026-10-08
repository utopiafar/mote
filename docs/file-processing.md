# 中央文件处理：Cordis 插件与本地多人录音

## 用户配置

新上传录音默认由中央本地转写并分离匿名说话人。模型缺失时先归档、等待安装；旧文件不自动补处理。在网页「设置 → 文件与语音」可关闭处理、调整单文件最长时长（默认 120 分钟，1–1440 分钟），也可按来源或类型修改录音方式。没有每日分钟限额。

- **仅归档原件**：保存原始文件，不读取内容。
- **转写接口**：调用配置的 Mote HTTP 转写接口；可接本地服务，也可接云 ASR 适配器。远端必须显式启用且使用 HTTPS。
- **本地多人录音**：本地 ASR → 本地说话人分离 → 时间对齐 → 未校正记录。选择预期人数（1–16），留空自动识别。转写文字正常进入配置的向量索引、Memory 和问答；摘要与语义分组由方案开关决定，使用所选分析模型。

自动分离的标签是未经确认的声纹簇，不代表已经确认的人数。最多保留 100 个匿名标签和 100,000 个区间；试听片段独立限制为前 16 个标签中有足够独立发言的片段。超过试听额度时保留全部区间并显示限制，不合并、改名或丢弃后续发言。标签过多可能意味着分离效果需要核听；扩大可容纳的输出不等于证明识别准确。默认聚类阈值沿用官方示例，实际适用性需要校准，参见 [sherpa-onnx 示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py)。

不同来源可以覆盖默认方式；精确 MIME 或 `audio/*` 等类型规则由文件策略设置。普通文件图片默认仅归档；截图的中央 OCR 由独立的「中央感知」设置处理。UTF-8 文本内置提取。Shadow 不下载内容、不创建处理任务。

本地 OCR 支持长截图：在 4000 万像素和 64 块上限内分块识别，块之间保留边界重叠，按文字框的图像坐标归并。同样的文字出现在不同位置会保留，不按文本去重。原图不缩写或覆盖；仍受请求 8 MiB 大小上限约束。模型框几何来自 [PaddleX OCR 输出](https://github.com/PaddlePaddle/PaddleX/blob/release/3.5/docs/pipeline_usage/tutorials/ocr_pipelines/OCR.en.md)。

`image.http@2` 的片段可携带 `imageLocation: {width, height, polygon}`：宽高为原图像素尺寸，polygon 为原图坐标系中的文字多边形，分块 OCR 已加回裁切偏移。共享契约接受 3–16 个有限坐标点，尺寸和坐标体积有界；轻微越过图像边缘的模型坐标原样保留，不静默裁剪。没有几何的外部处理器仍可返回纯文字；本地 worker 对缺少位置的输出给出警告，不捏造坐标。

位置随原始产物和文件证据保存，正式资料的结构化正文与定位信息也保留它，供只读模型解释布局。普通阅读视图显示文字，原始结构可核对坐标。相同文字在不同位置不会合并，不按左右位置确认本人、对话角色或发言归属。文字更正保留原位置；位置更正产生新的对应证据，仅使依赖该片段的记忆过时，其他片段及历史原文保持。安装新处理器不会自动对全部历史图片重跑 OCR。

文件详情显示每步进度。分离失败后，已完成的转写仍保留，自动重试使用持久化检查点；可单独重新分离。完整重做转写、变更模型后的手动重处理会生成新产物。已有完成文件不会因全局设置改变而立即重跑。

文件处理超时默认为 10 分钟，可在既有设置中配置为 1 秒至 1 小时；这是整条文件流水线的中央预算，转写与分离不会各获得额外的中央预算。本地音频请求通过 `X-Mote-Processing-Timeout-Ms` 把所配置预算交给 Worker。受管理 Native/Docker Worker 的运行上限为 1 小时，实际请求仍受中央配置和剩余全流程时间限制。自定义 Worker 的 `--timeout` 仍是独立上限，不能被请求头扩大；未携带该请求头的旧客户端沿用其运行时默认值。仅修改中央设置不能扩大旧版或自定义 Worker 的独立上限。实际长音频是否能在配置时间内完成仍需观察，调整超时不改变音频时长上限、模型、原件或说话人确认规则。回归见 [音频处理超时衔接](validation/audio-processing-timeout.md)。

原录音永不覆盖。手机删除不会删除中央归档；上传确认只清除 Mote 暂存。日常删除策略与首次 `all` / `new_only` 同步设置见 [文件归档](files.md)。

## 在中央主机启动本地服务

受管理部署先参见 [OCR 与转写方案](ocr-asr-implementation-plan.md)：Native 启动时自动准备该 profile 的独立运行时（也可用 `node scripts/mote.mjs media-runtime --profile dev` 预装），Docker 镜像已包含运行时，两者均在设置页安装模型。下面的手工启动方式供自定义部署使用。需要 Python 3.9+、FFmpeg 和 CPU 内存。推理用独立进程运行；每次只处理一个请求，退出时回收模型内存。服务只监听 127.0.0.1，中央服务与音频服务应在同一网络命名空间。

```sh
python3 -m venv .mote/audio/venv
.mote/audio/venv/bin/pip install -r scripts/requirements-audio.txt
# 用系统包管理器安装 ffmpeg，例如 apt install ffmpeg / brew install ffmpeg
```

部署时提前下载/导入模型，推理阶段不下载：

1. faster-whisper 格式 ASR 模型目录，例如 `Systran/faster-whisper-small`（多语言）或适合主机性能的更大模型。`tiny.en` 只适合英文链路冒烟测试，不能用来验收中文识别质量。
2. [sherpa-onnx pyannote segmentation 3.0](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models) 中的 `model.onnx`。
3. [3D-Speaker ERes2Net 中文 16k embedding](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) 中的 `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`。

开发验收使用的两个 ONNX 文件 SHA-256：

```text
segmentation: 220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079
3D-Speaker:   1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b
```

模型权重不随应用发布；下载前检查各模型许可证和适用语言。ASR 可通过 `huggingface_hub.snapshot_download` 预取到本机目录；命令在部署阶段执行：

```sh
.mote/audio/venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', local_dir='.mote/audio/models/whisper-small')"
.mote/audio/venv/bin/python scripts/transcription-server.py \
  --model .mote/audio/models/whisper-small \
  --segmentation-model .mote/audio/models/segmentation.onnx \
  --speaker-model .mote/audio/models/3dspeaker.onnx \
  --threads 4 --timeout 600 --port 9009
```

在设置里选择「本地多人录音」，保留 `http://127.0.0.1:9009/transcribe`，保存后点「检测已保存的本地服务」。健康检查确认模型文件/依赖存在；实际可用性以第一次录音处理结果为准。可通过环境变量 `MOTE_TRANSCRIPTION_TOKEN` 配置音频服务令牌，对应网页中的本地服务密钥。不要把密钥写进命令行、模型路径或仓库。

长期部署建议由 systemd / launchd / 容器进程管理器监督。Linux 可复制并调整 [服务模板](../deploy/mote-audio.service)，将模型置于服务用户可读目录，并在升级前停止任务、备份中央数据及模型配置。模型缺失、格式不支持、超时会保留原件和已完成步骤；中央最多自动尝试 4 次，之后手动重试。

实现基于官方 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 时间戳接口和 [sherpa-onnx 离线说话人示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-speaker-diarization.py)。sherpa-onnx 使用 pyannote 分割与 3D-Speaker 声纹向量，不要求启动云端 pyannote 服务。

## 分层、导出和人工确认

归档结构：

```text
不可变原件 + 来源/版本/SHA-256
  → 原始未校正转写（句级、词级时间戳）
  → 原始 diarization + 匿名声纹试听片段
  → 带说话人的未校正记录（可检索、引用、回听）
  → 可选所选模型语义分组（只能合并连续同说话人片段）
  → 人工确认的场次关联 / 说话人名称 / 独立校正版
```

单文件导出 `.tar.gz` 包含：原始转写 Markdown/JSON、diarization RTTM/JSON/CSV、带说话人完整记录 Markdown/CSV、`speaker_samples/` WAV、来源与处理版本清单。有人工确认时另附确认结果和校正版；未校正文件继续保留。原件在中央单独下载，不重复放进处理结果包。

基于时间重叠对齐，不猜真人姓名；低覆盖、说话人冲突和已检测重叠明确标记。当前模型链的重叠检测覆盖未验收，导出中明确注明「未标记不代表没有重叠」。短插话可以独立出现；不润色、不删口语、不替换术语。

ASR 原始片段允许时间重叠。若某句的词级开始时间晚于下一片段的开始时间，词级展开会产生逆序的派生时间线；此处沿用整句文字与句级时间，明确标记说话人不确定并在产物警告中披露。原始转写、原件和原时间戳保持不变，不排序识别词语、不挪动时间，也不把片段重叠当作已确认的真人同时发言。回归见 [重叠 ASR 对齐](validation/audio-overlapping-alignment.md)。

语义合并、场次推荐和术语复核属于可选步骤。文件方案可选择兼容 OpenAI Completions 的语言模型服务，或使用中央文件分析模型；本地与远程服务都可选。模型通过现有 Harness 的只读查询工具读取本次证据。未配置可用模型时，该步骤等待配置。自然轮次分组当前每文件最多 200 轮；术语复核每批 200 段，可继续下一批。

日程推荐只在中央已同步日程中查找默认录音文件时间前后 7 天候选（最多 200 条）；API 可明确指定最多 31 天区间。由模型依据内容、文件时间和日程做选择；候选不足时保留不确定性。不会把日程计划写成真实出席证明。关联需用户确认，日程变化后拒绝旧建议。

术语复核只生成精确原文子串的候选；用户选择并可修改替换词后，才生成单独校正版。不接受没有引用、原文不符、重叠或已过期的校正建议。匿名声纹标签的姓名映射也只能由用户填写。

文字校正与处理器重跑共用片段写入逻辑：文字、位置和说话人信息未变的片段保留证据 ID、索引和 Memory，替换的片段同步使对应原始及正式证据的记忆和在途提取失效。校正保留原件和各版转写，继承本场说话人的用户确认。改过文本的片段移除不再匹配的逐词时间对齐，未改片段保留；相同时间戳的片段通过显式次序保持稳定。文档校正保留原始文档位置，不生成音频时间。

确认姓名后，文件证据的 `speakerAttribution` 同时交给 Agent 和 Memory，携带名称、确认来源、确认记录 ID 与时间；原始 `SPEAKER_*` 标签和逐字文本不替换。名称只是用户对本场录音的标注，不证明转写准确，也不自动建立跨录音的身份或确定哪位是用户。修改或撤销某个标签的名称，会使依赖该标签片段的旧记忆、检查点及回答失效，其他标签不受影响；相同名称重复保存不产生新版本。文字校正沿用确认来源，重新进行声学分离后需重新确认。

正式 SourceItem Material 的音频段落使用结构化文本同时保留匿名标签、确认记录与原始转写；未命名的说话人仍保留匿名标签。每段声明对应文件片段的证据依赖。名称更正或撤销在提交事务内使对应正式证据、记忆和在途提取失效，不等待后台重建；期间资料显示待重建，整篇当前读取返回 409，避免继续提供旧姓名。重建保留内容、上下文及来源都未变化的块引用和记忆，历史版本仍可核对。文件片段接口与资料整理器共用确认读取逻辑；普通文件 Memory 仍必须通过已发布资料及其声明的处理依赖准入，不能直接用原始文件 ID 绕过。

## 开发者：真正的 Cordis 插拔

文件处理和查询 Harness 使用同一 `@deepseek-ai/cordis` 框架。文件处理使用中央常驻 Context，避免一次查询结束就销毁文件任务。查询仍由 Harness 执行，工具仅能读上下文。

通过受信任的部署配置装载模块（重启生效）：

```dotenv
MOTE_FILE_PROCESSOR_PLUGINS=["/opt/mote/plugins/custom-audio.mjs"]
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

- `extract` 处理器接受原文件并返回严格 Transcript；内置音频 HTTP、UTF-8、图片 HTTP。
- `diarize` 处理器返回严格 Diarization；用 `diarizationProcessor` 替换，声明 `localOnly:true` 的分离器只能绑定本地服务。自定义插件仍需由部署者审查代码。
- 中央负责队列、检查点、版本、存储、引用、确认及导出；不能把这些一致性机制交给 prompt。
- 服务的音频/图片选择取 MIME 结构与用户配置，不用关键词判断内容主题。
- 自定义云 HTTP 服务接收原始字节 `POST`，响应 `{durationMs, segments:[{startMs,endMs,text,words?}]}`。支持 Bearer 密钥、`X-Mote-Max-Audio-Ms`，JSON 上限 32 MiB；图片响应 `durationMs=0`。这不是任意厂商 ASR URL 的直接兼容层：不同鉴权/请求协议由自定义 Cordis 插件适配。
- 严格本地服务需返回 `X-Mote-Execution: local`。内置 Python 推理子进程关闭 Python 网络连接并开启模型离线模式，FFmpeg 只允许本地文件协议；这是内置依赖的网络约束，不是对任意不受信任 native 插件的操作系统沙箱。

## 验证

```sh
node --import tsx --test apps/server/test/file-processing.test.ts apps/server/test/files.test.ts
python3 -m unittest discover -s scripts -p test_mote_audio.py
# 启动隔离 fixture 中央 + 本地模型服务后，传入已生成的双人录音：
MOTE_FILE_TEST_DIR=.mote/processing-validation/cross-end \
  MOTE_FILE_TEST_ASR=http://127.0.0.1:9009/transcribe \
  node --import tsx scripts/test-file-dialogue.ts /absolute/generated-dialogue.wav
```

模拟器完整文件同步链路见 [验证记录](file-sync-validation.md)。真实模型、合成 fixture、物理设备验证分开报告。

### 可核对的本地语音对照

`scripts/generate-audio-control.py --output /absolute/new-directory` 使用本机已安装的两种 macOS 中文声音，生成八轮对话及精确台词、时间范围、声音和文件哈希。`--gap-ms 0` 可去掉轮次之间额外加入的静音。它不下载声音，不使用私人录音，也不证明真实访谈准确率。

把生成的 `manifest.json` 交给 `scripts/test-file-journey-live.ts`，再使用 `scripts/evaluate-audio-control.py --reference .../reference.json --run ... --output .../quality.json` 读取已关闭的隔离资料库。评估器报告字符错误率和两个已知声音的一对一匿名标签匹配；轮次内部的未标注部分可能包含自然静音，因此该指标不是标准 DER。可在独立评估环境安装 `scripts/requirements-audio-evaluation.txt` 并加 `--normalize-chinese-script`，同时报告原始 CER 与 OpenCC 繁简归一后的 CER，不改写归档转写。

对照发现，默认连续解码会漏掉完整发言；关闭 VAD 或直接换成默认批量解码均未解决。本地处理器从 v2 起使用 Silero 检测的语音片段分别解码，保留原始时间偏移，每段最多 30 秒、推理批量为 1，片段间不再拼回同一个解码窗口。v3 增加显式能力和依赖契约，不改变该声学算法。500 ms 静音分隔及显式片段接口来自 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)；这是声学处理参数，不是用户意图或 Memory 分类规则。原始模型权重和匿名说话人分离保持不变。空语音保留原时长，越界或过长片段明确失败，避免 SDK 静默只解码前 30 秒。

同一份 129 秒生成录音经过正式文件流程，繁简归一后的 CER 从 25.85% 降到 3.77%，两个匿名标签在已识别语音上无混淆；新流程约 30.8 秒。原始 CER 与完整输出另行保存。该单一对照尚不能替代真实长录音核听。

去掉额外静音后的连续换人对照仍未通过：同一指标由旧解码的 47.92% 降至 26.04%，仍有遗漏，分离产生三个匿名标签。不能把带停顿样例的通过推广到连续交谈；连续换人和真实访谈质量仍是功能验收缺口。
