# Coding Agent 对话来源

Mac可把用户选择的Codex、Claude Code、Kimi Code、OpenCode本地会话归档到Central。渠道只决定读取格式，不自动把对话当作编码经验。先保留清洁原文，再由模型理解个人经历、需求、决策、工作记录和可复用经验。

## 当前接入链路

客户端使用稳定事件/会话/项目身份提交v2输入。Central先保存私有不可变批次和清单，按source、provider、project和session组织连续会话Material，再索引与按授权处理。ACK只代表归档及工作检查点可靠保存。原始工具事件不直接进模型或全文索引；模型读取发布后的有界正文。

当前schema 7接纳可验证的人类发言和协议确认对用户可见的Agent文字，包括中途解释与最终答复；作者、provider、session、event及可见频道随正文保留。工具正文、内部推理、诊断、宿主提示、内部子Agent日志及可见性或作者未知的内容仍排除。长消息保持完整逻辑正文，按块分页，不因超过单块就整条丢弃。缺片、仅引用和未知时序保持覆盖限制，不伪造全文或顺序。采集器通过Coding的`order: {entry, event}`传递JSONL行字节位置或OpenCode数据库`seq`与同行事件顺序，分块的`part`保持原有含义；Kimi合成文字沿用首个文本片段的位置。同时间戳和迟到上传按原始顺序整理，追加路径用现有Material block locator核对末尾顺序；缺少原始顺序时保留`native_order_unknown`限制，不用正文猜测。

历史原始归档可以显式重新组织；安装或升级不自动重建全部历史，也不补授收费模型权限。每个model-facing正文及派生谱系必须符合当前schema；旧正文不作为失败回退。当前版本和详细发布合同见[资料](materials.md)。


## 协议可见边界

- Codex只允许显式`commentary`、`partial_answer`和`final_answer`文字；继续使用已有明确final频道与完成回执，回执不重复已收录文字。未知phase、reasoning和subagent来源不成为对话。phase定义见[Codex协议](https://github.com/openai/codex/blob/fef47a6769414444b1ce37aa8188b55bf2624f27/codex-rs/protocol/src/models.rs)。
- Claude Code主会话提取公开`text`内容块，包括工具调用前的解释；`end_turn`/`stop_sequence`保留最终答复标记，其余公开text保留为commentary。thinking、redacted_thinking、工具输入/结果、meta、压缩摘要和sidechain不进入对话。类型边界见[Claude流式消息](https://platform.claude.com/docs/en/build-with-claude/streaming)。
- Kimi Code沿已支持的主会话wire读取`content.part`的text，分步合成后发布；已支持的CLI wire同样只合成`ContentPart`的text。工具前解释及成功工具步骤的text是commentary，完成回执确认工具外最终文字；流式delta、think、未确认的失败/中断片段、compaction、系统触发和子Agent不直接进入正文。new_only建立基线时不发布历史缓冲，等新的明确人类回合后再认定作者。主会话origin、步骤绑定和去重使用协议字段，见[Kimi记录与折叠](https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts)、[CLI wire](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/wire/types.py)。
- OpenCode沿已支持的`session_v2`/`session_message`数据库读取主会话。已完成assistant消息中的`text`内容部分可见，工具步骤文字是commentary，stop回复是final；未完成行继续待后续扫描。reasoning、tool部分、system/synthetic及有parent的session继续排除，且不读credential表。形状与显示边界见[OpenCode消息schema](https://github.com/anomalyco/opencode/blob/0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4/packages/schema/src/session-message.ts)、[TextPart显示](https://github.com/anomalyco/opencode/blob/0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4/packages/tui/src/routes/session/message-parts.tsx)。

这些是当前读器边界；未增加其它日志格式、旧数据迁移或自动历史重扫。生成合同回归可用`npm run test:file -w @mote/server -- test/coding-visible.test.ts`复现：真实collector→持久outbox/丢ACK重试→正式Coding recipe→Material与Agent读取，涵盖同时间戳顺序、流式重启、重复、迟到文字和排除边界。

## 统一理解与Memory

后台会话理解是已有授权Memory任务中的一个步骤，不是每次收到事件就调用模型。它读取固定的清洁范围，生成带主体、状态、依据、来源时间、不确定性和精确引文的摘要/工作记录，可选事件和Memory候选。Memory候选走自己的准入与发布，不复制进摘要检索正文。零候选有效；有用工作线索仍可检索。

例如“Agent说修好了”可保留为报告结果，不能变成已验证修复；用户记录第一次给家人用作品的开心可成为个人经历，不必强行编成技术方法。让Agent转写第三方访谈，不代表受访者观点属于用户。讨论项目和来源仓库也可能不同，保留实际projectIdentity与陈述范围。

模型决定语义价值，不用关键词、文件夹名或应用名称分类意图。来源权限、隐私、精确版本和可引用范围由宿主确定。原文更新使依赖失效；只读问答、MCP和Memory遵循同一证据规则，不能回写其他Agent的记忆或配置。

## 主会话与首页建议

Codex创建子会话时，Mote读取桌面端创建成功回执里的子会话ID和主会话回合ID。资料页链接到主会话，可展开该回合在创建前的用户原话。对手动打开的附属会话，Mote读取日志中标明的父会话ID和分出位置，资料页提供当时已存在的用户原话供查阅。配对只发生在同一已选来源。主会话未采集、关系冲突或原文已撤回时，子会话仍可在资料历史中查看。

Codex、Claude Code、Kimi Code和OpenCode的可见发言都保留协议记录的用户或Agent角色、原文范围、记录时间及实际来源。能确认是本人的用户发言显示为“你说”，其余直接用户发言显示为“用户发言”。原文中的引用和Agent报告保留各自的归属。Codex创建回执只用于配对，工具的正文和参数仍不进入整理后的对话。各家内部子Agent日志继续沿用现有的可见边界。

首页建议要有可引用的用户原始请求，以及基于当前证据可准备的交付物或需要用户做的决定。已知子会话缺主会话原话时，只保留历史。旧的未接手Coding建议从首页和通知退下，已接手的任务仍可查看。历史记录可能缺少采集时未保存的创建回执或父ID。遇到这种情况，要从本机重新采集所选日志才能建立关联。

## 配置、隐私与诊断

在Mac来源中显式选择Coding会话范围；只有对应目录与格式被读取，不把整个磁盘当默认来源。当前收集到的附件能力有边界，不承诺导入会话未包含的原文件。账号密钥、CLI凭据、隐藏推理和工具过程不成为个人上下文。

来源页显示接收、整理、索引及Memory工作状态；正文到资料库的同一来源视图阅读，避免第二套会话浏览器。插件卸载阻塞继续处理，保留获准历史；删除和历史重做是独立命令。

扩展实现见[coding-source-plugin.ts](../apps/server/src/coding-source-plugin.ts)、[插件开发](plugin-development.md)、[Material](materials.md)和[Memory](memory.md)。用生成会话验证重复、追加、修订、授权、分页和原文引用；真实第三方版本兼容、个人历史重提取和模型效果分别验收。
