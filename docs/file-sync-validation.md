# 0.0.17 Cordis 与录音处理增量验收

2026-09-16：拉取并合并最新主线后重新验证，以下全部使用生成内容。

- Cordis 插件、文件协议专项 **22 项通过**；包括分离失败保留转写并续跑、注销生命周期、中文原文保留、不确定/重叠标记、加密试听、真实 tar 导出、人工确认及过期建议拒绝、本地完成文件不随默认设置改变而送去云摘要。
- Python 离线处理基础 **4 项通过**：采样 WAV、重叠区间排除、子进程禁止联网、16kHz 单声道转换与原件/时长边界。
- Android **124 项单元测试通过**，隔离 APK 构建通过；模拟器真实链路用时 **12.598 秒**，手机生成内容同步、3 个原件、205 个 Shadow、断点续传、源删除保留、版本变化、仅新增/补归档场景重新通过。
- 真实本地模型：38.532 秒双声线合成录音，Whisper 转写与 pyannote/3D-Speaker 分离得到 2 位匿名说话人、8 个对齐片段、2 份试听。中央完整 HTTP 入库到处理约 23.7 秒（含队列等待）。
- 真实 DeepSeek 再验：手机合成录音 5 段转写、摘要、6 个问答证据引用、8 个记忆提议。未向模型发送个人录音。
- Chrome 桌面/430px 窄屏：配置、匿名姓名确认、2 份样本可播放、导出下载/解包通过，无页面脚本错误或横向溢出。
- 备份恢复后 8 段多人记录、2 份样本及导出可读取，校验和与外键检查通过。
- 中央完整回归 **178 项**、Agent **58 项**、桌面 **37 项**、shared **23 项**通过；workspace 类型检查、中央/网页构建、既有 Harness 与隐私/媒体端到端 fixture 回归通过。

证据在忽略目录 `.mote/processing-validation/`。本轮实际运行的是本地 ASR/说话人模型及云 DeepSeek；可选本地语言模型语义合并、厂商云 ASR 服务、真实 embedding 和物理手机均未做真实模型/设备验收。相关确定性契约、失败边界和无云回退策略有测试覆盖。中文复杂录音、长音频和重叠识别质量尚未验收。

部署与插件接口见 [中央文件处理](file-processing.md)。以下为此前文件归档基线记录与复现方法。

# 文件同步验收记录

日期：2026-09-15。功能与边界见 [使用说明](files.md)，演进方向见 [架构设计](file-sync-design.md)。

## 结论与环境

已通过 Android 模拟器到独立中央节点的真实应用网络链路，并使用真实 ASR 和真实模型密钥验证中央分层处理。用户明确选择本轮先验收模拟器，真机另补。

- Android：`emulator-5554`，隔离应用包 `dev.mote.collector.filefixture`。使用生产 `FileSources`、`FileArchiveQueue` 和 `FileUpload`；测试 DocumentsProvider 仅暴露应用生成的文件。
- 中央：本机 Node 24、SQLite，独立 loopback 端口 57569 和独立数据目录。
- ASR：本机 `faster-whisper 1.2.1`、`tiny.en`，读取实际 WAV 字节，输出实际识别结果。
- 摘要、问答、记忆：已配置的真实 `deepseek-flash`，沿用只读 Harness 工具和引用校验。
- 测试数据全部生成；未读取个人录音、照片或屏幕内容，模型密钥未写入代码或报告。

## 模拟器跨端场景

最新完整仪器测试通过，用时 **9.968 秒**。60 秒文件稳定等待先验证不能提前暂存，再由测试推进持久日志中的稳定时间；这个耗时不包含现实中的 60 秒等待。

| 场景 | 已核验结果 |
| --- | --- |
| 设备上生成文件 | Android TTS 生成约 12.8 秒 WAV；另生成 9 MiB + 3 字节文件及嵌套 UTF-8 文件 |
| 原样上传 | 手机计算 SHA-256，中央独立下载三个原件重算，字节数和散列一致 |
| 分块及网络故障 | 大文件上传两块后，将请求指向不可连接端口；加密暂存不变，恢复后续传剩余块 |
| 认证失败 | 无效令牌上传失败，待确认版本仍保留；换回有效配置后成功 |
| Range 下载 | 跨越 4 MiB 块边界的 HTTP Range 返回字节与原件一致 |
| 清理边界 | 收到有效 ACK 后清除 Mote 暂存，手机生成的原录音和文件仍存在 |
| 修改、删除、恢复 | 原文保留四个版本；来源消失不删除中央原件，恢复后生成新版本 |
| Shadow | 205 个文件跨扫描片和中央分页；正文打开次数为 0，无原件与处理任务 |
| 提供方故障 | 扫描失败不当作来源删除，不生成错误消失事件 |
| 首次只同步新增 | 初始文件仅进基线；后续新文件归档；改为 `all` 后补归档旧文件 |
| 旧协议迁移 | 已有旧版 reference 的来源切换原件归档，接续旧 revision，原件散列正确 |
| 中央遗忘 | 显式删除后，原件读取返回 404；服务端回归另验证重试不能恢复已遗忘内容 |

## 真实模型与中央分层

在相同生产链路上完成两次真实模型验收，最新一轮结果如下：

1. **原件**：三个文件的精确字节与散列通过独立验证。
2. **转写**：录音产生五个带时间戳的片段。可识别 Alice 计划周五下午两点发送蓝色原型、Bob 计划评审电池报告，以及未批准采购。
3. **摘要**：真实模型产物和引用落库，区分计划与完成，不把文中提及的人当作已确认说话人。
4. **检索与问答**：真实 Harness 使用 `search_context` 和 `file_chunks`，读取全部五段，返回六个有效引用（五段转写及原件记录）。
5. **记忆**：生成并保存八条有证据的记忆提议，保留现有提议/发布机制。
6. **网页回听**：真实 Chrome 打开文件详情，音频加载成功；点击摘要引用后，播放器定位到 **2.24 秒**。

真实模型第一次记忆生成暴露了重复引用封装兼容问题：供应商将外层 citationIds 同时放进 JSON answer。已兼容这个精确重复字段，但要求它与外层已验证引用集合一致；每条记忆及行内引用校验仍执行，并增加回归测试。

本轮真实模型配置未启用 embedding 服务。片段向量索引及设备/应用范围过滤通过确定性向量测试，**未执行真实 embedding API 验收**。

## 自动化回归与恢复

- 中央端：**167 项测试通过**，包括 11 项文件归档专项测试。
- Android：**121 项单元测试通过**，包含 6 项文件队列测试；隔离 APK 和仪器测试 APK 构建通过。
- Agent：58 项测试通过；桌面来源同步与管理专项 15 项通过；网页测试和既有全链路 fixture 测试通过。
- npm workspace 类型检查、脚本类型检查及中央/网页构建通过。
- ACK 丢失、会话回收后确认重放、重启保留分块、错误 ACK、字节损坏、配额拒绝、来源隔离、加密字节、删除与处理中任务竞态、配置变更丢弃旧结果均有专项覆盖。
- 离线备份实际执行并恢复读取：校验清单 **9 个文件**通过；三个原件、录音五段转写、两个录音产物和八条记忆均可读取；无外键错误、未完成上传会话或运行中任务。

## 可复现入口

先按项目现有构建说明准备 Node、Android SDK/JDK 和 native 依赖。以下从仓库根目录执行，选择新的测试目录并只运行一个占用 57569 的 fixture 节点。

```sh
npm ci
npm run build:libs
npm run build -w @mote/web
npm run typecheck
npm run test -w @mote/server

# 保持在单独终端运行；默认不接入真实模型。
MOTE_FILE_TEST_DIR=.mote/file-validation/example \
  node --import tsx scripts/file-sync-fixture-server.ts
```

真实模型验收时，启动 fixture 节点前显式增加 `MOTE_FILE_TEST_MODEL_ENV=/absolute/private/mote.env`。脚本只读取该文件的模型字段，不使用原节点的数据目录或收集器。配置文件及生成的 `connection.json` 含凭据，应保持私有。

```sh
cd apps/android
./gradlew -Pmote.testBuildType=fileFixture \
  :app:assembleFileFixture :app:assembleFileFixtureAndroidTest :app:testFileFixtureUnitTest
cd ../..

adb -s emulator-5554 install -r apps/android/app/build/outputs/apk/fileFixture/app-fileFixture.apk
adb -s emulator-5554 install -r apps/android/app/build/outputs/apk/androidTest/fileFixture/app-fileFixture-androidTest.apk
adb -s emulator-5554 reverse tcp:57569 tcp:57569
adb -s emulator-5554 shell 'run-as dev.mote.collector.filefixture sh -c "cat > files/file-fixture.json"' \
  < .mote/file-validation/example/connection.json
adb -s emulator-5554 shell am instrument -w \
  -e class dev.mote.collector.FileSyncInstrumentedTest \
  dev.mote.collector.filefixture.test/androidx.test.runner.AndroidJUnitRunner
adb -s emulator-5554 exec-out run-as dev.mote.collector.filefixture \
  cat files/file-fixture-result.json > .mote/file-validation/example/android-result.json

MOTE_FILE_TEST_DIR=.mote/file-validation/example \
  node --import tsx scripts/verify-file-sync.ts
```

按 [ASR 启动说明](files.md#可选本机-whisper-服务)启动转写服务后，在最后一条命令增加 `--live-model`，并设置 `MOTE_FILE_TEST_ASR` 为其 `/transcribe` 地址。校验脚本启用中央转写和摘要、等待各版本处理完成、检验真实问答及记忆并保存无凭据结果。此选项会实际调用模型、产生用量。

本轮本地证据保存在被 git 忽略的目录，未加入版本控制：

- `.mote/file-validation/network-check/`：最终模拟器、网络恢复及中央下载验证报告。
- `.mote/file-validation/release-check/`：最新真实 ASR/模型完整分层报告。
- `.mote/file-validation/final/ui-file.png`：生成录音的网页回听及引用定位截图。
- `.mote/file-validation/backup-result.json`：恢复校验结果。
- `.mote/file-validation/server-tests.log`、`file-tests.log`、`typecheck.log`：回归结果。

## 未执行的验收

真机按用户决定另补：系统文件选择器授权真实录音目录、厂商后台限制、WorkManager 实际定时唤醒、进程被系统杀死和设备重启恢复，以及中文、多说话人、噪声、长录音与实际编码质量。当前仪器测试直接调用生产扫描和传输代码，不等同于这些系统调度与真机质量验收。

NAS 二进制客户端、按需取得 Shadow 正文、自动播放转码副本属于后续扩展，尚未实现；接口和层级已预留扩展方式。
