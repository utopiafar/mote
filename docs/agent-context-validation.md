# Agent 上下文与任务架构验证（0.0.43）

## 结构与依据

Mote 保留共享执行引擎（DeepSeek Harness / 本机 Codex App Server）、每次任务的独立会话和宿主控制的持久任务。`packages/agent/src/task-context.ts` 注册问答、洞察、证据批次、日程提取和工作记忆任务的输出与检索能力，并统一装配两套 Runtime 的上下文。任务身份由宿主明确传入，不按用户问题关键词路由。现有行动确认、幂等操作 ID 和 uncertain 回执仍由宿主管理。

这与 [LangChain 的 Skills / Workflow 模式](https://docs.langchain.com/oss/javascript/langchain/multi-agent)及 [Anthropic 的上下文压缩与渐进读取建议](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)一致：按任务控制上下文，先改进工具与压缩，只有需要独立研究时才引入子任务。Codex 接口遵循 [App Server 协议](https://learn.chatgpt.com/docs/app-server)。本次没有新增长期 Agent、外部发送能力或替换现有持久任务数据库；分享对话里的未来业务候选不是本次已实现功能。

## 修复与预算

- 工作摘要通过独立 `taskContext` 传递历史，用户 `question` 仍限制为 20,000 字符。正常摘要批次计入 JSON 转义、旧摘要及条目分隔；单轮过大时按 UTF-16 边界分段处理，所有分段成功才推进覆盖轮次。
- 在线问答在丢弃未摘要历史或截短长回答前触发压缩；后台定时压缩继续保留。同一对话压缩合并执行，删除与源版本变化仍使摘要失效。模型失败会明确失败，不把缺失历史伪装成完整上下文。
- 工作记忆仅暴露 Skill，不提供检索；有明确证据批次的任务仅暴露 evidence 与 Skill。工具注册和宿主授权使用同一配置。普通问答保留完整只读工具能力。
- 检索以 RRF 融合普通记录与文件的词法／向量通道；向量服务失败返回词法结果及 `retrieval.degraded`，空结果也保留降级状态。词法命中定位仅用于选择原文片段，不判断用户意图。
- 发现正文预览 600 字符、派生摘要 400 字符，暴露完整长度和后续偏移。记忆详情返回原文引用列表，必须调用 evidence 后才获得原文引用资格。
- 本轮证据按内容指纹、内容层和已交付范围记录，重复范围不重复保存，版本变化清除旧范围；引用摘录来自已交付片段，不再只取最后一次读取。摘录仍是有界预览，不能独立证明每句话的语义支持关系。
- 宿主输入（系统说明、工具 schema、完整上下文）限制为 180,000 UTF-16 字符；单次文本工具结果 120,000、累计 480,000；任务上下文 80,000。另保留原有字节、调用数和图片独立预算。`contextUsage` 返回各输入组成、累计工具字符数及输出 token 配置。

字符计数不是精确 token 计数，也不是对模型窗口容量的保证；不同模型的窗口与原生 compaction 由 Runtime 管理。本次没有复制一套 Runtime 内部压缩循环。无真实 token 上报时不把字符估算冒充用量。

## 可复现验证

```sh
npm ci --ignore-scripts
npm run build:libs
npm run typecheck
npm test
npm run test:e2e
npm run test:media-e2e
node --import tsx scripts/test-codex-provider-live.ts
node --import tsx scripts/test-agent-context-live.ts
```

真实模型验证使用本机登录的 Codex App Server API，模型为本机目录返回的 `gpt-6-astra`，推理强度 low。全部资料为脚本生成，没有读取或发送个人截图、笔记或生产档案。

实际用例：模型目录与配置覆盖、工具连通性、检索后展开原文并引用；超过 30,000 字符的工作记忆保留禁止云端部署的约束；后续问答仍遵守该拒绝；长记录后部的修订时间与已取消旧稿冲突时，回答 Thursday 16:45 并引用原文。

确定性回归另覆盖压缩失败、单轮超过 60,000 字符、分段中途失败不推进游标、降级空结果、宿主预算、工具最小集合、未读记忆原文引用拒绝、不连续片段和版本切换。Harness 使用真实子进程与合成 Provider 验证契约；本次没有执行 DeepSeek 厂商实网质量评测，也没有物理设备采集测试。这是一组固定场景回归，不是所有问题都无 bug 的证明。

本次本地结果：全工作区 766 项通过，1 项既有 opt-in 测试跳过；最后新增的输出模式兼容性用例连同上下文专项共 7 项通过。TypeScript、前后端构建、i18n 检查和两条端到端链路通过。本机 Codex 最后一轮三例耗时分别为 12.3 秒、16.1 秒、22.2 秒（单次观测，不是性能基准）；连接配置与真实检索引用链路另行通过。
