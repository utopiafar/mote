# 正式轮次记录

`finalize-rounds.mjs` 把已经完成的独立评估与冻结候选材料规范化为上一级 `rounds/rXX.json`。脚本不评价 UI，不生成新的分数，不改独立评估原文，也不改 R0/R1。

在此目录执行：

```sh
node finalize-rounds.mjs
node finalize-rounds.mjs 5
node finalize-rounds.mjs 5 --check
```

无参数时处理从 R2 开始连续存在的独立 `review.json`，遇到尚未保存评审的轮次停止。指定轮数时，任何缺失评审会报错。`--check` 只执行验证，并核对已有正式记录与重新规范化结果逐字一致；缺少正式文件时只验证候选结果，输出 `existing_record_matches: null`。全部目标记录生成和验证成功后才写文件；内容未变化的旧记录不重写。

## 输入和验证

每轮读取 `evidence/rXX/candidate.json`、`changes.json`、`journeys.json` 与 `review.json`。独立评估应包含 `status=completed`、候选 SHA-256、评估者身份、五项分数与理由、实际 `evidence_seen` 文件、问题和下一步。分数可以是 `{value, reason, evidence_refs}`；若使用纯数字，理由需写在 `score_reasoning[维度]` 中。

脚本核对冻结 HTML 内容哈希、独立评估哈希、每条 DOM 记录哈希、真实文件及 JSON Pointer、执行结果与场景索引是否一致、78 单元和 20 类的编号及统计、固定权重加权分数，以及 JSON Schema 2020-12。缺失的关键字段会直接报错，便于修正记录格式。

同一个旧证据 ID 同时指布局图和 DOM 时，布局 ID 加 `-layout`，引用展开为两份真实材料。历史候选的证据保留历史候选哈希，不把历史覆盖统计移作当前覆盖。

## 范围与门槛

- 零操作 DOM 只记录为初始状态，不计完成旅程。
- `add-menu` 是菜单呈现检查，五个可见选项不计为五条完成旅程。其他呈现检查可在场景索引中标 `evidence_scope: "presentation_only"`。
- 交互场景保留实际步骤、断言、最终页面和反馈；失败如实保留。
- 五项分数完全来自独立评估。分项下限可由固定标准计算；其余全局通过结论不会由局部场景自动推导。
- 当前候选有 `coverage-review.json` 才填语义已审数量。`coverage.dom.json` 的路由可达统计不代表清楚呈现或可执行。
- 阶段后补的覆盖与盲评作为附加材料记录，不追溯修改原五维评分或评估者原先已看范围。
- 缺少完整证据的全局门槛保持 `not_run`。当前已观察的场景失败、未解决阻断、明确覆盖缺口和盲评发现失败分别保留为相应失败证据。
- R0 是根据源代码重建的 HTML 起点。其目录目标缺口不能解释为生产仓库对应功能未实现。

盲评的 `blind-first.json` 和 `blind-journey.json` 保留原文。可另写 `blind-session.json`，记录 `agent_id`、`fresh_context`、`candidate_sha256`、`candidate_order`、元数据来源及 `execution_evidence`，补充上下文隔离与操作材料。缺少该元数据时，正式记录使用 `null`，不自动声明新上下文。

`normalize-blind.mjs` 适配已保存的盲评报告字段。原文的“部分达成”保留在结论中；由于任务 Schema 没有 `partial`，其正式任务状态记为 `fail`，仅表示整个目标未完整完成。原报告的整体成功、局部失败、恢复和内容质量限定分别保留。没有已知格式的明确结论时不猜测完成状态。

同一候选的额外独立上下文由 `blind-additional-sessions.json` 指明独立的首屏、自然任务和元数据文件。仅首屏且没有执行证据的 session 不生成旅程。指标脚本分别统计每个 session 的累计轨迹，避免把不同评估者的 DOM 混为同一条路径。兼容字段 `totals.blind_sessions` 仍表示有自然任务报告的 session 数，首屏总数与仅首屏数量另列。

## 不同评审格式的明确映射

`normalize-review.mjs` 只在存在 `review-normalization.json` 时适配另一种原始评审格式。sidecar 包含原 `review.json` 的 SHA-256、候选哈希、逐字段映射和决策确认来源。原评审文件、分数与理由保持不变。

R15 明确映射 `completed_informed_independent_review` 到 `completed`；静态图和执行记录的原始 kind 对应 Schema kind。原文件名及 JSON Pointer 引用必须来自评审者列明的证据文件，且指针实际存在。P1 对应 major，P2 对应 minor；原始具体状态保留在说明中。未执行分支保持待验证范围，静态图观察保持 renderer 限定，均不自动制造旅程失败。`scope_limit` 和 `positive` 分别保留为范围限定和已观察优点，不伪造已修复问题。

R15 的 `refine` 来自评审者 `/root/feature_inventory` 明确确认，由主评审线程转达；完整原决策文字及确认来源一并保留，不能从“可交付可审阅原型”推断为 `accept_final`。`highest_value_next_change.acceptance` 的每条原始字符串按原顺序保留为下一步动作。

最终或阶段全局门槛可由独立评估者写入 `gate-review.json`：

```json
{
  "reviewer": "/root/independent_evaluator",
  "candidate_sha256": "冻结候选实际哈希",
  "evidence": [
    {
      "id": "final-comparison",
      "kind": "state_observation",
      "ref": "实际比较结果文件.json",
      "description": "实际审阅内容与范围"
    }
  ],
  "gates": [
    {
      "id": "G-COMPREHENSION",
      "status": "not_run",
      "actual_result": "具体结论与证据范围",
      "evidence_refs": ["final-comparison"]
    }
  ]
}
```

只有明确写出的门槛被规范化；未列出的门槛保留现有证据结论或 `not_run`。

最终门槛报告若使用描述型 evidence kind，可由 `gate-review-normalization.json` 逐项映射到 Schema kind。该 sidecar 绑定原 gate 文件 SHA-256；相对路径严格以原报告声明的目录解析，所有 JSON Pointer 实际核对。原始八项裁定、标准、结果说明、分数冻结限定和决策不变。最终补测中的初态断言检查、实际用户操作、独立探针和累计中间记录分别保留，不把观察次数叠加为旅程数量。
