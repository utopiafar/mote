# 林照：可重复生成的合成测试数据

这是一套围绕单一虚构 owner 的小型数据包，适合在本地反复验证 Mote 的导入、原件保存、多端接收、录音处理和上下文理解。人物、组织、项目、文本、日期、图片及音频均由固定脚本创作；生成器没有个人 profile、历史导出、截图或聊天日志的输入参数。

林照（Lin Zhao）是虚构的纸湾工作室开发者，在 2025 年 3 月 3 日至 9 日制作“折光书签”。他用 Mac 开发和阅读，用 Android 随手记，在 Central 整理资料，并偶尔让 Agent 代为归档。许舟是同事，宋苒是朋友。故事时区为 `Asia/Shanghai`。这只是测试角色，不是现实用户的化名或脱敏副本。

数据量固定：12 个直接接收事件、8 条日记、4 个录音条目（2 个有逐字稿，2 个成功空结果）、10 次文件版本上传和 16 个评审问题。生成包共 43 个文件（42 项登记资产和 manifest）；图像是程序绘制的几何纸样。默认音频是短测试音或静音；`--speech` 可用本机 macOS 语音合成生成真正可供 ASR 尝试的语音。

## 生成一份数据

从仓库根目录运行，需要 Node 24+、npm 依赖以及已构建的 shared / Agent 库：

```sh
npm ci
npm run build:libs
node apps/server/scripts/persona-fixture.mjs generate \
  --output .mote/fixtures/linzhao-v1
```

目标目录必须不存在。脚本不会覆盖、重置或恢复已有目录。输出默认权限为目录 `0700`、文件 `0600`，即使材料是合成的，也给后续测试凭据和运行报告保留同样的隔离习惯。

文字、图像、ZIP 和默认 PCM 测试音使用固定输入生成。相同依赖和默认参数的两次生成应得到相同的文件哈希。使用 macOS 语音合成时，音频可能随系统语音版本变化；manifest 记录本次实际字节的哈希，不宣称跨系统音频完全相同。

要生成语音版本，选择已经安装的中文 voice；脚本不会下载语音或静默退回测试音：

```sh
say -v '?'
node apps/server/scripts/persona-fixture.mjs generate \
  --output .mote/fixtures/linzhao-v1-speech --speech --voice Tingting
```

`--speech` 只调用本机 `/usr/bin/say`，输入均为固定合成文本。厂商逐字稿中的两个说话人标签仍未经核验；默认使用同一个 TTS voice，不能把它当作多真人说话人识别的正确率样本。空逐字稿配静音，作为成功空结果保留。

## 包里有哪些内容

| 目录或文件 | 内容 | 用途与限制 |
| --- | --- | --- |
| `persona.json` | 虚构角色、关系、设备、时区与来源说明 | 供操作者了解场景；不是一条待提取 Memory |
| `imports/diary-export.zip` | 按日期与时间导出的 Markdown 日记，图片、重复时间、CRLF、emoji、组合字、导出元数据 | 走通用导入，并在说明中提供时区；每条原文和附件都应可追溯 |
| `imports/diary/` | ZIP 中相同的原始成员 | 方便查看；同一测试环境不要把 ZIP 和解压目录分别再导入一遍 |
| `ingest/capture-events.ndjson` | Mac / Android 截图、当前 v3 结构化页面、活动时长，以及三端随手记 | 用正式 HTTP schema 与接收路由回放；不代表操作了真机 |
| `assets/` | PNG、JPEG、WebP 几何纸样 | 包含仅存在于像素中的视觉信息；原图读取不能以 OCR 占位或元数据代替 |
| `connectors/feishu/` | TXT 时间戳逐字稿、元数据、WAV 与空结果 | 本地替换 Provider 边界，使用真实飞书格式解析与录音编排 |
| `connectors/dingtalk/` | 无可核验时间的 JSON 主段落、元数据、WAV 与空结果 | 使用真实钉钉解析器；不把昵称当人物映射，不编造段落音频时间 |
| `files/` | 计划 v1/v2、无日期摘录、不可信日志、CSV、PDF、DOCX、HTML、ICS、Agent 归档记录 | 正式文件上传、版本和原件读回；离线模式只验证保留，不声称 Office/PDF/日历解析或真实 Agent 日志接入已通过 |
| `evaluation/` | 场景矩阵、问题、必须保留和禁止推断的事实、人工评分表 | **答案与评分规则不可导入、上传或提供给待测模型** |
| `manifest.json` | 输入入口、角色、MIME、字节数、SHA-256 与预期结构计数 | 回放前完整校验，拒绝改动、越界路径和指向包外的文件 |

43 个文件是目录成员计数，ZIP 内还包含对应导出成员；它不等于 Central 的最终资料数、Memory 数或测试通过数。

## 第一步：离线回放

这条命令不连接已有 Central，不读取现有 profile，不登录飞书或钉钉，也不会调用模型。它创建一个新 vault，通过当前 HTTP 入口接收数据，并用真实 SQLite、导入器和录音编排完成检查。

SQLite 原生模块须与运行 Node 的 ABI 匹配。若刚切换 Node 版本，可在本机明确运行：

```sh
npm --prefix node_modules/better-sqlite3 run install
node --import tsx apps/server/scripts/persona-fixture.mjs replay \
  --dataset .mote/fixtures/linzhao-v1 \
  --run .mote/fixtures/linzhao-v1-offline
```

省略 `--run` 会使用新建的系统临时目录。指定目录也必须不存在。回放器没有 `--url`、`--profile`、重置或导入旧数据库选项。

离线检查包括：

- 未授权接收被拒绝；当前 capture / note schema 接受生成输入。
- 第一次接收有持久化 ACK；相同 ID 重传得到重复回执，冲突内容被拒绝且不覆盖原文。
- 截图字节、原文和事件时间可通过正式读取接口核对。
- 日记 ZIP 走通用导入；离线模式使用预先构造的模型结果检查预览、明确确认、完整原件哈希、逐条 Unicode 原文、图片关联和 `+08:00` 事件时间。该模式不验证模型能否生成这些结果。
- 文件经分片上传、commit 和原件读回；计划 v2 成为当前 head。
- 飞书和钉钉使用本地 Provider 响应，经过真实格式解析与编排；发现列表故意带重复及下一页，成功空结果与音频备份分别验收。
- 重启后原文仍可读，完成的导入保持原 ID，不重做已成功批次。
- 用量记录证明离线模式没有模型调用。

`report.json` 会区分 `transport: passed` 与 `semanticVerdict: not-tested`。离线成功不能证明语义理解、真机权限、真实云端账号、ASR、说话人识别或重型跨端 E2E 成功。

## 第二步：明确选择本地 Terra

需要检查实际模型时才加 `--live-model`。模型固定为本地 Codex app-server 的 `gpt-6.1-terra`、`high` 推理与 `default` 普通速度；不提供替代模型或提速参数。

```sh
node --import tsx apps/server/scripts/persona-fixture.mjs replay \
  --dataset .mote/fixtures/linzhao-v1-speech \
  --run .mote/fixtures/linzhao-v1-live \
  --live-model --memory \
  --questions current-arrangement,local-midnight,specific-lesson,visual-original,source-scope
```

这会发送合成资料给本机已登录的 Codex 运行时，产生真实模型调用和用量。可以用 `MOTE_CODEX_BIN`、`MOTE_CODEX_HOME` 指定已有可执行文件和文件凭据位置；凭据不会写入数据包或模型 prompt。

`--memory` 只为本轮直接接收的内容与日记显式创建 Memory 任务。它不为整库自动扩权，不启用额外后台模型任务，也不自动批准原本需要 owner 决定的事项。独立审核、评估覆盖和发布状态以真实执行结果为准。`--questions` 每问使用独立请求。文字题与专门的范围隔离题使用严格证据选择；图像题显式采用产品的参考资料入口，保留原图工具，只在本轮隔离合成库中检索。当前严格选择入口不开放普通原图工具，不能把它当成视觉读取入口。找不到对应证据的题目记录为 `not-tested`。已完成的连接器逐字稿会加入对应问题的严格证据范围。尚未处理文件的相关问题记录为 `not-tested`，需要在隔离环境中启用相应处理、核对原文后再选材验收。显式选择 Memory 或视觉题时，回放器仅在本轮新建的实例里启用按需读图，自动 OCR/图像理解仍关闭。

回放器不把预期答案发送给模型，也不用关键词或“模型自评通过”冒充语义评分。模型输出、引用、Memory 回执及真实用量保存在运行报告，语义判定仍标记待人工评审。

### 查看隔离 Central

若需要实际 UI，先构建网页，再加 `--serve`：

```sh
npm run build -w @mote/web
node --import tsx apps/server/scripts/persona-fixture.mjs replay \
  --dataset .mote/fixtures/linzhao-v1 \
  --run .mote/fixtures/linzhao-v1-ui --serve
```

服务只监听 `127.0.0.1` 的随机端口。连接信息在运行目录的 `connection.json`，owner token 在 `owner-token` 文件中；终端只打印位置，不打印 token。通过正常产品入口验证资料库、原件、来源、当前任务、Memory 与问答，结束后 Ctrl-C。没有 `--live-model` 时，模型处于未配置状态；启用该选项的服务允许 owner 在隔离环境里明确发起请求。

这不是标准部署 profile 的替代品。要验证完整启动器或真实采集设备，请使用现有独立 fixture / 设备流程，而非改写这个临时 vault 的配置去连接个人来源。

## 人工语义评审

先看 `evaluation/questions.json` 和 `review.md`，再逐问对照实际输出。每一项分别记 `pass`、`fail` 或 `not-tested`，保留首次输出、支持引用、失败原因与修正后的重试结果。

| 主题 | 关键判断 |
| --- | --- |
| 安排更正 | 读书现行为周六，旧周三取消；独立的装书架事实保留；没有参加证据就不写成已参加 |
| 计划与完成 | 第一版已发送，反馈未知；录音笔仅有计划，不能补写完成、失败或效果 |
| 归属与未知 | 许舟的试读与看展不能转给林照；第三方文章、代整理访谈和匿名标签不能变成 owner 经历 |
| 日期与原件 | 上海午夜记录按本地日归档；原件日期与入库时间分开；无日期摘录保持未知 |
| 图像 | 实际读图和必要的区域；独立 reviewer 也要获得真实图像依据；元数据、占位文字和保存成功不能充当像素证据 |
| 具体经验与感受 | 上传 ACK 的机制、存储取舍和未测边界要准确；两天的疲惫及作品被使用的个人意义不能被随意去重或推断为永久性格 |
| 时间计量 | 只计算明确采集区间；多端分别说明；不能把记录间隔、截图数或阅读内容换算为专注时长 |
| 隐私与授权 | 不可信原件中的指令无执行权；严格范围问答不应偷用别题或整库证据；不测试真实外发消息 |

不要要求固定 Memory 条数、逐字答案或固定主题树。成功空结果、明确配置跳过和真实失败应分别记录。主题组织应由模型从资料理解；不能把本文件的主题表写成运行时关键词分派规则。

## 各端及外部边界怎么补测

| 边界 | 本数据包已提供 | 还需要实际选择的验证 |
| --- | --- | --- |
| Mac / Android | 当前接收协议、截图、结构化内容、应用活动、随手记 | 原生采集器、权限开关、系统后台行为、离线队列和断网恢复 |
| Central Web | 隔离实例与可读原件 | 实际 UI 流程、页面刷新、返回位置；自动 UI 仍按仓库规范后台运行 |
| Agent / Codex | 具体开发经历、代整理内容、严格范围问题、只读上下文 | 真实 MCP 客户端连接、按客户端协议导出的会话接入、外部工具拒绝与撤权 |
| 飞书 / 钉钉 | 本地 Provider 边界替身、真实 TXT/JSON 解析、录音编排 | 第三方 CLI、登录/授权、限流、云端录音发现与下载；不要给个人账号上传假会议 |
| 音频 / 图片 | 真正的图像字节、WAV、可选合成语音及对应原文 | OCR/ASR 实际引擎与结果质量、多人音轨和身份确认；TTS 标签不代表真人人声 |
| 文件 / 日历 | 原件与版本、PDF/DOCX/HTML/CSV/ICS 格式样本 | 各格式实际提取、审核/发布、日历接入；ICS 文件入库不等于真实日历来源已接通 |

使用已有的定向原生/网络/生命周期测试验证对应边界，见 [测试分层](testing.md) 和 [用户旅程](ui-user-journeys.md)。不要为了生成这个数据包自动跑全套 E2E、基准或真机测试。

普通生成契约检查：

```sh
node --import tsx --test apps/server/test/persona-dataset.test.ts
```

需要本机 Python 与 OS 沙箱的完整离线回放单独选择（约数秒，不调用模型）：

```sh
MOTE_PERSONA_REPLAY=1 node --import tsx --test --test-concurrency=1 \
  --test-timeout=120000 apps/server/test/persona-dataset.test.ts
```

普通 CI 不将此跨进程回放当作已执行；它仍检查生成输入与当前实际 schema、Office/PDF 读取器和录音解析器的轻量契约。

## 扩展与共享

固定故事位于 `apps/server/test/fixtures/persona/story.mjs`，字节生成与 manifest 位于同目录的 `assets.mjs`、`dataset.mjs`，独立回放位于 `replay.mjs`。新增场景时先写明确虚构事件、人物与时间，再补问题及禁止推断，最后连接当前实际消费者。

修改故事或入口契约时发布新的 fixture ID，保持旧评审结果与实际使用版本一致。不要读取个人数据后做姓名替换，不保留现实材料的特征句、关系网络、路径或来源 ID。新的失败应抽象为产品行为，再用独立创作的合成事件表达。

Git / PR 只提交生成代码、合成故事、定向回归和文档；生成包、运行数据库、owner token 与模型运行输出留在忽略目录或私有临时目录。需要给别人使用时分享重新生成的方法或仅含合成输入的数据包，不把整个运行目录打包出去。
