# ADR: 中心本机 OCR 与语音的一键准备

状态：2026-10-29，已获用户授权，按本轮 UI 定稿实施。

来源为 [三端 UI 决定](design/ui-final-three-clients-2026-10-29.md) 的 H04，以及执行协调对话中用户 `Sentinel_257460f132848191881fe64393bba4c5` 对四项提问的直接回复：“可以就这么搞，然后第四条的自动依赖什么的也都一起做完。”这次批准包含依赖准备、模型下载、启动及失败恢复，不只是更换按钮文案。

## 决定

图片与录音设置提供“一键安装”，服务端负责可观察的准备任务。界面分别报告等待、准备依赖、验证依赖、下载/验证/安装模型、启动、就绪、失败和取消。重复点击复用同一未完成任务。离开页面不终止任务；重新进入后读取同一状态。失败允许重试，下载中取消保留可校验的分段缓存；未校验完的模型不会发布为已安装。取消同步解包时在下一检查点生效，取消完成前不宣称已停止。

只有模型完整且带认证的处理服务健康检查成功，才显示“可使用”，并保留“检查状态”按钮重新读取实际健康状态。安装不改变自动处理同意、设备/来源范围、处理方案、收费模型选择或历史任务重跑授权。准备 API 沿既有 owner 权限边界；collector、MCP 读写凭证不能安装依赖或启动服务。

Native 由 Central 生命周期唯一持有本轮启动的处理进程；开发命令和后台 supervisor 不再另启动第二组进程。环境位于当前模型目录下的 `runtime/`，使用不可变的环境代次及原子 `current.json` 发布。不运行系统包管理器，不改系统 Python、PATH 配置、shell 文件、网络/安全设置或持久凭证。已有代理设置仅供本次子进程使用；模型密钥、其他服务密钥和用户 Python/Pip 配置不传给安装器。运行配置变化会取消当前准备并要求重启；进程退出时只关闭自身创建的 worker。不会杀掉占用同端口的外部服务。

取消安装会回收该安装进程组，包括父进程先退出但仍忽略 TERM 的子进程。语音 worker 退出时也回收自己启动的识别与转码子进程；中断中的执行事实保留未确定状态，不因服务退出伪造成功回执。

Docker 保持现有 sidecar 所有权。其镜像已经提供 Python 和依赖，准备操作只下载固定模型并检查现有 sidecar。网页不重建容器、不操作 Docker daemon、不变更部署。sidecar 不可用时如实失败并提供重试。

Native 自动准备目标为 macOS arm64/x64、Linux glibc arm64/x64。Windows、musl、未知运行方式或自定义外部处理端点不声称可自动安装，保留高级连接入口。此目标表不等于四平台均已运行验收；实际平台记录在验证报告。

## 固定来源与版本

| 项目 | 来源/版本 | 验证 |
| --- | --- | --- |
| 安装器 | [Astral uv 0.13.6](https://github.com/astral-sh/uv/releases/tag/0.13.6) | 四种官方 archive 的字节数与 SHA-256 固定在代码；解包仅取指定 uv 文件，校验后执行 |
| Python | uv 管理的 CPython 3.11，固定构建 `20261021` | [uv Python 管理](https://docs.astral.sh/uv/concepts/python-versions/)，仅 profile 内安装，不注册系统解释器 |
| OCR | PaddleOCR 3.5.0、PaddleX OCR core 3.5.2、ONNX Runtime 1.19.2、Pillow 11.3.0 | 现有固定 requirements；安装后实际 import 与模型加载验证 |
| ASR | faster-whisper 1.2.1、sherpa-onnx 1.13.8 | 现有固定 requirements 与本机服务健康检查 |
| FFmpeg | [imageio-ffmpeg 0.7.0](https://pypi.org/project/imageio-ffmpeg/0.7.0/) 的平台 wheel | 实际执行包内二进制 `-version`；不要求全局安装 FFmpeg |
| 模型 | 既有 PP-OCRv5 mobile、faster-whisper small、Sherpa segmentation/speaker、可选 WeSpeaker | `media-assets.ts` 的固定官方 URL、大小与 SHA-256；一键准备默认官方源 |

可选 WeSpeaker 仍由明确选用此插件的录音使用，安装它不会替换默认说话人方案。此前仅“模型文件下载完毕”不能当成运行时准备成功。既有配置字段 `media.python` 仍供 Docker/自定义部署工具使用；Native 一键准备的解释器由 profile 内已验证的环境代次决定，不覆盖该字段指向的外部解释器。未准备当前环境的 Native profile 需先执行一次准备；启动恢复只检查已发布环境，不在后台隐式联网补依赖。

既有 `mote media-runtime` 命令保留停止目标 profile 和独占锁要求，改为使用同一个准备器和 `current.json`，避免 CLI 安装成功但 Central 找不到环境。其显式 `--python` 选项继续选择基础解释器：不下载另一个 Python，仍在私有代次安装同一固定依赖、验证后发布；解释器选择及实际版本记入同一收据。网页不提供任意解释器或依赖来源输入。后续 Central 启动只探测该已发布环境，不重装、不隐式改变 CLI 选择。

## 取代与保留

取代 Native supervisor 自动 pip 修补和仅下载模型按钮。保留当前 worker 认证、执行回执、未知结果保护、处理权限、原件归档、可选插件与模型完整性校验。不增加旧数据读取器、迁移或双写。旧模型版本仍按当前固定 catalog 判断，旧运行目录不自动删除。

本决定细化 [录音结果与执行就绪](adr-recording-outcomes-runtime.md) 的运行时部分；其资料归属、重试授权及不确定执行规则继续有效。

本轮实际准备、生成素材处理、固定提交截图、平台未测范围与剩余整页差异见[验证报告](https://github.com/utopiafar/mote/blob/9c9a36e25355b1251aedbec2d5da89a63d8926de/docs/validation/ui-final-media-2026-10-29/README.md)。
