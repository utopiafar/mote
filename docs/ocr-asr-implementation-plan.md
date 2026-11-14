# 中央 OCR、图片理解与录音转写：方案与实施

方案记录：2026-09-24；公共接线核对：2026-11-14。本文区分已合入模块、尚待装配的领域实现和带日期的历史验收。下面的公共接线与配置说明不代表本轮重新运行过真实模型或目标平台。

## 当前接线范围

当前共享合同包含 `ocr`、`dialogue`、`speaker-wespeaker`、`local-image` 四个安装角色。安装器已固定 InternVL3-14B-4bit 与 FunASR 四组件的制品；独立环境、受管理进程和领域引擎已提供接口。公共配置接受本地图片 endpoint/port，CLI 按角色准备环境和导入权重，媒体资产状态使用准备服务的实际生命周期健康。已安装文件不等于 Worker 就绪，更不等于插件启用。

本地图片可选插件工厂与统一 hosted Plugin Center 已具备接缝；当前默认入库图片服务尚未消费本地适配，默认分发未开放该可选 build 的启用。图片入库适配、Material 纯函数接线、图片专属界面以及语音 Worker/新配方/消重的联合装配仍须对应领域实现合入后接通。不能把模型安装成功或生成合同测试写成默认本地图片路径、新默认语音链路或专项验收已经完成。

## 已确认的产品决定

| 项目 | 确定值 |
|---|---|
| 中央 OCR | 保留现有入库、原件与后台授权；历史图片不因安装或升级自动回扫。 |
| 图片入库理解 | 官方本地识图插件默认关闭；明确启用后该阶段使用 InternVL3-14B-4bit，不因缺模型、忙碌或失败自动回退云端。 |
| 图片后续处理 | Memory 提取、独立复核和 Ask 看原图继续使用各自所选模型，可为云端；不切换主力问答模型。保留后台模型授权与 `allowQueryImages`，不新增图片外发总闸或派生文字档位。 |
| 新语音默认 | 目标为 Fun-ASR-Nano-2512 + fsmn-vad + CAM++ + CT-Punc 的完整替换；原文、匿名说话人、单独重分人、回听、复核、导出、检索、Memory 和 Ask 均在交付范围。当前装配状态见上节。 |
| 后续文本模型 | 摘要、语义分组、复核、Memory、Ask 沿用原有模型设置。默认不启用热词或自动云端文本校正；保守消重默认开启、可关闭，原始转写保留。 |
| 文件与历史 | 默认单个录音 120 分钟，可设 1–1440 分钟；512 MiB 原件上限和单次调用预算仍独立存在。完成历史不自动重跑，显式重试或范围预览/确认沿用现有入口。 |
| 平台 | 本地图片首先面向 Native macOS Apple Silicon + MLX。语音仍需分别验证 Native 与现有 Linux/容器路径；不能把模块完成写成这些平台已通过。 |

完整体验指流程、产物、引用、回听/读图、修订、失败和恢复能力，不承诺不同模型识别文字或质量完全一致。

## 运行架构与状态

上传确认仅代表原件已持久保存。中央负责既有授权、任务检查点、派生版本、索引、只读查询与人工复核；Worker 只处理当前获准的有界字节并返回领域合同。OCR、视觉解读与原图是独立产物；文字解读不能代替像素证据。截图、录音、OCR 和模型输出均是不可信证据，外部效果仍经 Actions 授权。

模型安装继续使用同一 `media.modelDirectory`。固定相对目录为 `ocr`、`dialogue`、`speaker-wespeaker`、`local-image`；FunASR 四组件位于 `dialogue/asr`、`dialogue/vad`、`dialogue/speaker`、`dialogue/punctuation`，不借用 WeSpeaker 资产。FunASR 的文件、revision、size、SHA-256 与来源统一固定在 `scripts/funasr-models.json`，由 `media-assets.ts` 安装器和 `mote_funasr.py` 引擎共同读取。Nano 使用 ModelScope revision `05201c46f1c38592b1567f857c0d56eab3d0d8ef`，`model.pt` 为 2,127,426,538 字节、SHA-256 `81fec8616083c69377f3ceef36aba3655660ee0ca69a5d4a1e9810cd340ca499`。组件 manifest 统一使用模型相对路径、revision、license 和每个必需文件的 size/SHA-256 的规范 JSON 摘要；下载位置和安装根目录不参与组件内容身份。完整安装回执仍校验整个 catalog。旧 HF 权重和混装目录不能当作当前版本就绪，实际模型加载与已安装 SDK 源文件校验继续独立执行。

`GET /api/media-models` 返回当前共享 `MediaModelsView`；`runtimeReady` 来自准备服务，而不是目录存在或旧 ASR 布尔字段。`GET /api/media-preparation` 描述准备阶段与真实 Worker 状态。当前本地图片 Worker 的 `localImage` health 字段与运行时消费者的 `ready` 判据仍需运行时 owner 接通；公共状态会保持不可用，不据安装成功改写为 ready。

Native 运行环境按角色隔离在 `runtime/<role>/current.json` 和对应环境目录；失败准备保留上一成功标记，停止只回收该角色的自有进程。重启仅恢复已准备的 OCR/语音资源，本地图片 Worker 由可选插件启停。Linux 容器不提供 Mac MLX；Compose 的 OCR/语音 sidecar 使用各自解释器。模型卷独立于原件卷，并允许已有执行事实写入。Worker 只监听 loopback，凭据来自私有 profile，安装与推理进程不继承中央模型密钥或第三方 CLI 凭据。

## 模型安装与部署入口

下载/导入先校验全部必需文件的 size/SHA-256，再原子发布当前安装回执。`ready` 只表示该回执及文件完整性可用；缺文件、错大小、同长度错 hash 或非法路径均不能发布成功。现行回执不接受旧模型 marker，没有自动迁移、旧执行器或双写。新模型来源固定到 revision；只有 catalog 明确列出的同内容镜像才能参与来源选择。

`POST /api/media-models/{role}/install` 与 `/cancel` 接受共享的四个角色，不能提供任意模型 URL。本地图片安装组件只调用这组资产入口，安装不会启用插件、启动 VLM、授予后台处理或重算历史。OCR/语音的一键准备沿用 `/api/media-preparation/{role}`；该准备路由的 `local-image` 参数开放仍须媒体路由 owner 接收，当前不应假称此入口已可启动 VLM。

停止选定的 Native profile 后可显式准备一个角色的依赖：

```sh
node scripts/mote.mjs media-runtime --profile dev --role ocr
node scripts/mote.mjs media-runtime --profile dev --role dialogue
node scripts/mote.mjs media-runtime --profile dev --role local-image
```

命令调用现有固定 Python 3.11 环境准备器；`--python` 只选择准备来源。它不安装权重、不启动 Worker，输出保留 `runtimeReady:false`。普通启动不会隐式下载新依赖；依赖与模型准备由明确操作触发。配置 `media` 的目录、endpoint、port 或凭据变化需要重启，文件/图片策略和后台授权仍由各自领域控制，见 [配置参考](server-configuration.md)。

离线导入使用同一安装器校验生成当前回执，不联网补件：

```sh
node scripts/mote.mjs media-import --profile dev --role ocr --from /absolute/path/ocr-bundle
node scripts/mote.mjs media-import --profile dev --role dialogue --from /absolute/path/dialogue-bundle
node scripts/mote.mjs media-import --profile dev --role local-image --from /absolute/path/image-bundle
```

OCR 目录提供 catalog 要求的归档；语音 bundle 保留四组件子目录；图片 bundle 提供固定分片、索引和处理器配置。确切文件清单与 hash 以当前 catalog 为准，不使用历史 Whisper/Sherpa 文件名。Docker profile 的离线导入通过既有无网络容器实现；本轮没有运行 Docker。模型安装与依赖准备均不读取用户图片或录音。

## 验收边界

以下是 2026-09-24 实施时的历史验收记录，不能作为 2026-10-04 清理后重新执行的证明；其中旧任务隔离/恢复用例描述当时存在的迁移行为。当前行为以源码和现行文档为准。

自动化 fixture 验证默认策略、旧任务隔离、模型缺失后恢复、预览确认、原件不变、检查点复用、索引和密钥隐藏。Native macOS arm64 上安装了 pinned Python 依赖，用生成图片通过真实 OCR Worker 识别出 `MOTE OCR TEST 123`；系统合成的中文语音经真实 faster-whisper 得到正确转写，sherpa-onnx 返回一个匿名说话人片段。中央归档 → OCR Worker → 索引，以及音频归档 → ASR Worker → 说话人分离 → 对齐产物的生成素材端到端检查也已通过。当前执行环境没有 Docker 命令，因此 Docker 镜像构建和 Linux amd64 运行需在有 Docker 的 CI 或目标主机验收；物理手机同步与真人录音质量也不由 fixture 测试替代。未经明确同意，不使用真实个人截图或录音做测试。

可进一步执行的发布门槛是 Docker Linux amd64 构建与生成素材端到端验收、Native 重启和依赖更新演练、模型下载中断恢复、长音频 CPU/内存测量，以及用户设备的实际同步验证。尚未执行的项在 PR 中如实标注。

### Native 启动恢复回归验证

以下带日期记录保留原文；旧失败任务恢复已退役，不属于当前启动行为。

2026-09-24：`npm run check:local` 通过。新增测试覆盖依赖首次安装、标记复用和损坏修复、安装失败不写就绪标记、Worker 异常重启与父进程退出清理、等待服务不消耗 OCR 尝试次数，以及旧失败任务恢复与历史任务隔离。

macOS arm64 的临时 Python 3.9.6 环境中，使用实际 pinned 依赖和已下载的 PP-OCRv5 模型运行下列检查：Worker 在模型目录不存在时先启动，原子安装模型后无需重启，成功识别生成图片中的 `MOTE OCR TEST 123`。只使用生成图片和回环 HTTP，未使用真实个人截图；未验证物理设备或 Docker。

```sh
node scripts/test-ocr-runtime.mjs --python /path/to/media-venv/bin/python --model-root /path/to/models/ocr
```
