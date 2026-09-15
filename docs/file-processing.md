# 中央文件处理：Cordis 插件与本地多人录音

## 用户配置

在网页「资料库 → 文件 → 中央文件处理设置」启用处理，选择录音方式：

- **仅归档原件**：保存原始文件，不读取内容。
- **转写接口**：调用配置的 Mote HTTP 转写接口；可接本地服务，也可接云 ASR 适配器。远端必须显式启用且使用 HTTPS。
- **本地多人录音**：本地 ASR → 本地说话人分离 → 时间对齐 → 未校正记录。选择预期人数（1–16），留空自动识别。不会自动调用中央问答模型、云端摘要或云端向量服务。

不同来源可以覆盖默认方式；精确 MIME 或 `audio/*` 等类型规则通过设置 API 的 `typeProfiles` 配置。图片默认调用独立文字提取接口，未配置则保留原件、等待配置；UTF-8 文本内置提取。Shadow 不下载内容、不创建处理任务。

文件详情显示每步进度。分离失败后，已完成的转写仍保留，自动重试使用持久化检查点；可单独重新分离。完整重做转写、变更模型后的手动重处理会生成新产物。已有完成文件不会因全局设置改变而立即重跑。

原录音永不覆盖。手机删除不会删除中央归档；上传确认只清除 Mote 暂存。日常删除策略与首次 `all` / `new_only` 同步设置见 [文件归档](files.md)。

## 在中央主机启动本地服务

需要 Python 3.9+、FFmpeg 和 CPU 内存。推理用独立进程运行；每次只处理一个请求，退出时回收模型内存。服务只监听 127.0.0.1，中央服务与音频服务应在同一网络命名空间。容器部署可将两个进程放到同一个 Pod/主机网络空间；普通 Compose 跨容器域名不符合严格本地配置。

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
  → 可选本地模型语义分组（只能合并连续同说话人片段）
  → 人工确认的场次关联 / 说话人名称 / 独立校正版
```

单文件导出 `.tar.gz` 包含：原始转写 Markdown/JSON、diarization RTTM/JSON/CSV、带说话人完整记录 Markdown/CSV、`speaker_samples/` WAV、来源与处理版本清单。有人工确认时另附确认结果和校正版；未校正文件继续保留。原件在中央单独下载，不重复放进处理结果包。

基于时间重叠对齐，不猜真人姓名；低覆盖、说话人冲突和已检测重叠明确标记。当前模型链的重叠检测覆盖未验收，导出中明确注明「未标记不代表没有重叠」。短插话可以独立出现；不润色、不删口语、不替换术语。

语义合并、场次推荐和术语复核属于可选步骤。本地模式需要单独配置兼容 OpenAI Completions 的**本地**语言模型地址和名称；通过现有 DeepSeek Harness 的只读查询工具读取本次证据。没有本地语言模型时停止该可选步骤，绝不回退到云端。自然轮次分组当前每文件最多 200 轮；术语复核每批 200 段，可继续下一批。

日程推荐只在中央已同步日程中查找默认录音文件时间前后 7 天候选（最多 200 条）；API 可明确指定最多 31 天区间。由模型依据内容、文件时间和日程做选择；候选不足时保留不确定性。不会把日程计划写成真实出席证明。关联需用户确认，日程变化后拒绝旧建议。

术语复核只生成精确原文子串的候选；用户选择并可修改替换词后，才生成单独校正版。不接受没有引用、原文不符、重叠或已过期的校正建议。匿名声纹标签的姓名映射也只能由用户填写。

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

扩展接口在 [file-processors.ts](../apps/server/src/file-processors.ts)：

- `extract` 处理器接受原文件并返回严格 Transcript；内置音频 HTTP、UTF-8、图片 HTTP。
- `diarize` 处理器返回严格 Diarization；用 `diarizationProcessor` 替换，必须声明 `localOnly:true` 才能用于严格本地录音模式。自定义插件声明的隐私属性需要部署者审查代码。
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
