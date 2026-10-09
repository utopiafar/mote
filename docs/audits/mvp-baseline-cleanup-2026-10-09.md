# MVP 基线清理与文档核对（2026-10-09）

代码起点：`fa55ef83c9c432f6dc3ffec9d12ef3a3ab70cf77`。所有者已确认按 MVP 清理旧兼容逻辑、测试相关模块并提交合并 PR。当前决策见 [MVP 基线 ADR](../adr-mvp-baseline.md)，当前结构见 [架构](../architecture.md)。

## 范围与核对方式

以全部 Git 跟踪文件为目录清单，覆盖根配置及所有源码、测试、文档、协议 fixture、插件、脚本和发布目录。基线有 1,826 个文件，其中 315 个 Markdown 文件。依赖安装目录、编译产物、用户私有资料目录不属于源码审计范围。没有读取或重置真实资料库，也没有采集个人截图。

核对包括全仓文本及引用检索、当前入口与调用链追踪、持久格式和启动顺序检查、删除文件的引用检查、当前指南与代码比对，以及相关场景回归。目录清单覆盖全仓；不把文本检索称为逐行人工审阅每个文件。

| 目录 | 核对内容与结果 |
| --- | --- |
| 根目录、`AGENTS.md` | npm workspaces、Docker、环境示例、README、依赖锁与许可证说明；删除端侧推理构建/模型入口，保留稳定开发规则 |
| `apps/server/src`、`test` | 启动、存储、图片/文件、来源、Memory、委派和查询；移除旧迁移与 fallback，检查当前默认初始化及真实 HTTP 生命周期 |
| `apps/web` | 配置与处理状态的 API 消费、连接说明及语言目录；说明当前重新配对行为 |
| `apps/desktop` | 格式 3 本机状态、队列、来源同步、原生助手与隐私；删除闲置推理子进程、旧本机文件解释状态和恒为零的处理统计 |
| `apps/android` | Kotlin 设置、配置归档、队列、上传审查及 profile；移除退役模型键清理和无入口视觉审查接口，保持格式 3 |
| `packages/shared` | 当前配置/协议、发布身份、用量及国际化；删去旧 blob 目录配置，同步英文及 Android 目录 |
| `packages/agent` | 模型适配、只读工具、运行时任务说明；区分输入输出上限、计量与已退役每日预算 |
| `packages/diagnostics` | 现行固定事件、有界数值与支持包；没有旧格式转换路径需要移除 |
| `packages/local-inference`、`models` | 没有当前产品入口的 Qwen 实验包、模型清单和提示；整体删除 |
| `scripts` | 构建、下载、备份、恢复、重置、环境与场景脚本；删除退役推理和旧 QueryRuns 工具，当前脚本使用新契约 |
| `protocol`、`adapters` | 当前 wire/Ingress 和 UI adapter fixture；保留严格校验及负面场景 |
| `plugins`、`examples` | 当前扩展责任与声明；删除忽略的 source Memory 配置，保留版本、安装和授权 fence |
| `.github`、`deploy`、Compose、`Dockerfile` | 组件检查、独立发布、部署和模型依赖；删去已不存在的 Qwen 构建/验证步骤 |
| `release`、`licenses`、`THIRD_PARTY_NOTICES.md` | 历史发布证据、公钥及第三方归属；保留历史结果和必要许可证，说明已删除的运行时 |
| `docs` | 当前操作/架构指南、ADR、历史验证；修正现状、补 supersession 标记，历史源码链接固定到原提交 |

## Supersession 清单

| 分类 | 最终处理 |
| --- | --- |
| REMOVE | 每日预算退役/任务复活、图片策略迁移与历史 image_inputs 回填、快照索引修复、Activity/Memory 依赖回填 |
| REMOVE | 自动提取关闭开关的旧水位转换、被忽略的 source `memory` 布尔值、未交接产品的旧 proposal wait 修复 |
| REMOVE | 闭包 QueryRuns、缺 journal 时的回退、重复 runQuery 实现及仅测试旧入口的工具 |
| REMOVE | 旧 blob 目录的创建、统计和 GC；旧端侧文件解释队列及 Qwen 下载、启动和模型包 |
| REMOVE | 旧空 Memory 配方兜底、内置个人/Coding v1 配方与审核、旧 source-item/authored organizer 版本识别；`mote.transcript@1`、`mote.align@1`、`mote.audio-dialogue@1` 双版本分支 |
| CHANGE | Central `backend_epoch` 与 SQLite `user_version` 为 4；非空旧库在安装 schema 前拒绝并保留原文件 |
| CHANGE | 新库直接安装最终 schema、图片 OCR 默认策略及索引 trigger；Memory 私有载荷只读当前明确前缀 |
| CHANGE | `extraction.enabled` 只接受 `true`，source 配置拒绝 `memory`；所有默认媒体输出统一 `mote.transcript@2` |
| KEEP | 原件、版本、身份、幂等 ACK、授权、隐私、删除、保留期限、只读查询工具、独立审核和用量计量 |
| KEEP | 当前中断恢复、租约、取消、超时、晚到提交 fence、成功检查点及 provider cooldown |
| EXCEPTION | 当前格式的队列位置迁移、显式历史处理、图片回填和确定性 organizer 安装重算是现行功能 |
| EXCEPTION | 当前内容加密策略允许 `.plain`/`.aes` 混存与显式解密；不是读取退役密文包装 |
| EXCEPTION | 插件输出/依赖声明、直接手工提取与委派规划均有当前入口；保留各自授权及版本检查 |
| EXCEPTION | MCP 文字/结构化输出、各模型 API 协议、签名更新验证与 PDF.js 官方 Node 分发路径属于当前外部契约 |
| UNKNOWN | 本轮未执行真机、Android instrumentation、真实模型、外部来源账户或 Docker 环境验收 |

## 文档现状

重写架构责任图，修正来源归档与 Material、持久问答/委派、连续自动 Memory、图片 OCR 与独立理解、文件原件位置、内容加密、便携导出和备份恢复。部署、更新、连接、内容存储、处理吞吐、录音配方、README 与文档索引统一引用当前基线。

早期推理、迁移和 proposal 修复设计增加历史/supersession 说明。带日期的审计、发布记录及验收结果保留当时的结论；失效的历史源码链接改为对应 Git 提交，避免把旧设计或旧测试结果当作现状。旧 audit 中依赖某个个人 worktree 的绝对链接改为审计起点的固定源码链接。

## 验证矩阵

所有自动输入均为生成 fixture；模型环路使用本机生成提供方或 stub。

| 检查 | 本轮结果与证明范围 |
| --- | --- |
| `npm ci` | 通过；删除工作区后的锁文件可安装 |
| `npm run check:local` | 通过；国际化、库构建、全部 TypeScript 类型；Desktop 402、Server 1,250、Web 254、Agent 232、Diagnostics 5、Shared 129，另 53 项脚本与 4 项 client 测试及 runner；2 项可选测试跳过 |
| `npm run build` | 通过；Central、Web、Desktop 及原生 Swift 助手构建 |
| 新契约重点回归 | 129 项通过；文件/媒体导入、转写时间、旧组件拒绝、来源发布、证据读取、配方/授权/独立审核和 MVP 启动/备份查询 |
| 更新/环境/依赖工具 | 通过；14 项更新器、依赖检查、真实隔离 Central 进程的 profile/备份/回退，以及本机生成 tunnel 生命周期 |
| Android `testDevelopmentUnitTest assembleDevelopment` | 通过；58 个 JVM suite、264 项测试零失败，DEV APK 构建成功 |
| 生成 HTTP 问答/媒体/隐私端到端 | 通过；问答/媒体往返及 22 项隐私检查，不代表真实模型质量或物理设备行为 |
| Markdown 本地文件链接与 `git diff --check` | 通过；无失效本地文件链接或空白错误 |

新增 MVP 场景直接驱动产品入口：旧 epoch 3 数据库拒绝前后字节一致；新启动在输入到来前具有最终图片策略及投影；当前问答超时/取消不保存晚到结果；HTTP 创建问答后关闭主机，用实际备份脚本复制、恢复并启动，完成一次回答，再次重启不重复。原有失败、撤权、删除、重启、缓存、原件上传与处理回归继续执行，未以删除旧断言替代当前用户行为验证。

## 存储操作边界

本次没有运行真实数据 reset 或跨代转换。Central epoch 3 及更早资料须使用配套旧二进制完成必要导出/备份。新版本选择新空目录或新 profile；只有所有者明确决定放弃目标目录资料时，才使用 `npm run reset:mvp-vault -- --data-dir /absolute/selected-vault --confirm-clear`。旧库、旧二进制和所需密钥应一起保留；新旧 epoch 不能直接互读。

Desktop/Android 本机仍为格式 3；当前队列、原件和凭据不因本次清理自动清空。更早本机格式仍拒绝读取。当前同 epoch 的完整备份恢复、便携 v2 导入和用户选择的队列位置迁移继续支持。真实设备与真实模型须另行授权和单独报告，不能从上述 fixture 结果推断。
