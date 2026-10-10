# Harness / Cordis 升级与回归范围

本页记录当时的验证。2026-10-10 起输出修正上限改为 3 次，当前行为见 [Agent](agent.md#输出校验修正)；以下历史真实模型结果没有按新上限重新测量。

2026-10-02：所有直接使用的 `@deepseek-ai/dsh*` 包从 **0.1.5-rc.2** 固定升级为 **0.2.0-rc.2**，`@deepseek-ai/cordis` 从 **4.0.2** 固定升级为 **4.0.4**。SDK、运行时与插件保持同一 Harness 版本；根工作区显式声明脚本使用的 SDK，避免依赖 npm 隐式提升。Harness 仍是 RC 版本。

## 兼容性与当前功能

| 模块 | 适配与验证重点 |
|---|---|
| 模型配置、目录 | 默认 DeepSeek 基址改为 `/anthropic`；仅旧官方根地址在运行时迁移；自定义网关和其他协议路径保留。官方目录继续用 Bearer `/models`，自定义 Messages 网关使用 `x-api-key`。配置来源、热切换、凭据隔离和错误脱敏纳入服务端测试。 |
| Agent 查询 | DeepSeek 原生 `/v1/messages`、思考签名重放、多轮工具、有效引用、历史对话、缓存计量和 `output_config.effort`。同时覆盖 Chat Completions、Responses、Anthropic Messages、Gemini。 |
| 证据与图片 | 只读工具清单、逐次授权、撤销、宿主预算、材料分页与续读、图片区域 schema、元数据读取、首次像素披露、重复图去重。DeepSeek Files 在网络 I/O 和预算准入前被拒绝，上游整次请求回退为内联图片。 |
| 隐私与传输 | 查询和导入均关闭会话日志、插件清单与 MCP resources；高级参数不能重新打开日志／清单上传，传输层再次移除对应字段。DeepSeek 只允许所选基址的 Messages POST；拒绝重定向、意外目的地和远程文件操作，保留累计响应字节限制。 |
| Memory、日程 | DeepSeek 和 Chat 两套真实 Harness 运行技能、精确批次证据、历史提案比较；验证批次范围和只读权限。服务端另覆盖模型提案、宿主校验、人工确认、撤销及持久状态。 |
| 导入 | 两套协议运行真实 skill/read/write/bash 工具，从一条合成资料生成清单；验证最终格式修复和事件观察。macOS 受限启动器另验证实际 OS 文件及网络边界。 |
| 输出与生命周期 | 两套协议验证截断后仅修复一次、再次截断明确失败、宿主反馈留在同一会话。另覆盖超时、取消、并发 close、清理失败脱敏、请求预算、用量与缓存的独立桶计量。 |
| Cordis 后端与 Web | 验证共享根下兄弟插件的独立销毁、服务撤销、重复 close、页面／插件生命周期及实际文件处理管线；新增两个 logger exporter 分别销毁的回归，覆盖上游修复。项目没有依赖 `fiber.update()` 的旧 Promise 返回值。 |
| 采集端、共享库 | 完整桌面、诊断、本地推理、共享协议与 i18n 单元测试；本次没有新增翻译键。设备捕获仍通过生成 fixtures 验证。 |

## 少量合成样本全流程

1. `npm run test:e2e`：两条生成截图（Mac／Android）和一条显式笔记 → 加密、幂等、图片去重入库 → Material 整理 → 五次 DeepSeek Messages 请求、四次只读工具调用 → 两条有效引用 → 图片读取、活动时长及归档导出／导入往返。
2. `npm run test:media-e2e`：生成的锁屏媒体会话 → 幂等入库 → 真实 Harness + Chat fixture → 按设备和范围统计媒体活动 → 元数据引用 → 归档往返。
3. `node --import tsx scripts/private-import-runtime.ts --self-test`（macOS）：一条生成 YAML → 六次 Messages 请求 → 技能、读写、原生 shell、便携解析器及清单校验。默认网络被拒绝，只放行显式 loopback relay；源码、相邻任务、伪造凭据文件、符号链接越界及其他本地端口均被拒绝。SDK 实际初始化并关闭。只读新增授权限于已编译的 schema 和模块清单。

全部 Provider 回复均是脚本化合成 SSE，真实执行 Harness、Cordis 和 Mote 宿主。这些测试证明接口、授权、状态、工具传输与归档链路，不评估模型的语义判断质量。没有使用个人资料、真实截图或真实模型凭据。

## 本次验证结果

Node 24.15.0，macOS arm64。`npm run check:local` 通过 i18n、库构建、全工作区及脚本类型检查，然后完成以下测试：

| 模块 | 通过 | 跳过 |
|---|---:|---:|
| Desktop | 373 | 0 |
| Server | 1008 | 1 |
| Web | 196 | 0 |
| Agent | 208 | 1 |
| Diagnostics | 5 | 0 |
| Local inference | 13 | 0 |
| Shared | 90 | 0 |
| 发布、媒体 worker、重置及网络代理脚本 | 39 | 0 |
| CLI Client | 4 | 0 |
| 合计 | **1936** | **2** |

中央 runner 的进程、日志预算与信号处理检查另通过。`npm run build:central`、上述两条 E2E 和独立 macOS 受限导入 self-test 均通过。Web 构建保留现有的较大 bundle 提示。

默认 suite 跳过环境开关控制的 Python source-pack macOS 沙箱用例及已安装 Codex 的实机协议用例；macOS Harness 导入的 OS 边界已通过上述独立 self-test 验证。未执行线上模型或物理设备捕获检查。

## 可重复执行

```sh
npm ci
npm run check:local
npm run build:central
npm run test:e2e
npm run test:media-e2e
# macOS 的额外 OS 沙箱 fixture；无线上模型调用
node --import tsx scripts/private-import-runtime.ts --self-test
```

## 收益与后续风险

本次建立新版原生 Messages、图像输入和缓存用量的兼容基础，并修复 Cordis exporter 销毁行为；现有模型选择、宿主授权和人工确认流程继续接受回归。以后接入 Harness 的动态工具、compaction 或持久会话能力仍应独立设计和验证；升级不等于已接入这些产品功能。

仅提供旧 Chat 接口的自定义 DeepSeek 网关需显式选择 `openai-completions`。使用旧 `reasoning_effort` 高级参数的配置需按 Messages 参数调整。没有更改资料库 schema、模型设置文件格式或原始归档内容；回退应用与锁定依赖不需要本次引入的数据迁移。

当前图片使用上游内联回退，避免引入远程 Files 留存；若上游以后移除此回退，需要另做图片传输适配。依赖树扩大，包含可选 LibreOffice 原生包，首次安装成本增加；最小运行 profile 未启用 Office 技能。线上 DeepSeek 的账号权限、模型能力、价格与实际质量，以及物理 Mac／Android 捕获，仍需独立验证。本轮没有执行这些检查。
