# Mote UI：15 轮 HTML 迭代交付

本次按 HTML UI 范围完成迭代。最终 R15 原型已恢复并保持冻结字节，可直接下载打开。传输中断后部分后期原始材料未恢复，当前可用内容与缺失项明确分列。

## 直接查看

- [mote-ui-final.html](prototype/dist/mote-ui-final.html)：最终自包含 HTML。
- [final-report.md](final-report.md)：功能地图、十五轮改动及评估结果、当前证据限制。
- [artifact-availability.json](artifact-availability.json)：实际可提供的候选和原始评估文件。
- [recovery-review-memo.md](prototype/evidence/recovery-review-memo.md)：原评估者依据本会话结论恢复的备忘录，不能当作丢失原始 JSON。
- [恢复后新检查说明](prototype/evidence/recovery-r15-recheck/README.md)与[索引](prototype/evidence/recovery-r15-recheck/index.json)：对同一 R15 的新执行记录摘要，与历史检查分开。

本次对话另提供 `mote-ui-comparison.html`（恢复后重建的 R0 / R8 / R15 自包含对照）和 `mote-ui-recovered-evidence.zip`（404 个现存原件及恢复后材料）。压缩评估归档向公开仓库的上传被自动审批拒绝，理由是压缩片段的潜在资料披露风险；归档没有挂载到本 PR。原始轨迹及对照页请使用对话提供的下载文件。

## 结果

中断前已冻结的独立评分为 **75/100**，五项均 3/4；严格门槛为 **4 通过 / 4 未通过**。78 项主要呈现为 77 clear、1 partial（英文界面 A36）。三个独立新上下文理解首屏用途，两条自然任务在 1 次、3 次导航内找到入口；原遮名比较均排序 R15 > R12 > R9。后期原始评审和比较包现已缺失，这些结论保留其来源与可核对性限制。

仍有明确 UI 问题：来源专属浏览未延续范围，屏幕应用勾选保存后恢复，旧示例记忆采用内容少一句，英文文案不完整；登录仅提供预览。当前推荐 R15 作为本批方案，原评审决定保留 refine。

## 文件完整性

最终 HTML 为 355392 字节，SHA-256：`65257ad350e155a01bd1e64c3241e812bff98c93fda593be70de2dae17bf32f9`。

当前保有 R0–R8 与 R15 候选，正式早期记录与原始证据的范围以清单为准。R9–R14 及后期原始文件未伪造补回。中断前的报告原文字节保存在 [final-report-original.md](final-report-original.md)，其中“全套原件已归档”的交付描述已不再成立。

HTML 使用演示数据和模拟状态；DOM 事件检查与静态排版图用于 UI 评估，未声明真实服务或设备闭环通过。既有草稿：[PR #185](https://github.com/utopiafar/mote/pull/185)。

## 恢复后实际核对

同一 R15 新执行 4 条主场景和 1 条独立暂停观察，共 43 步、27 次操作、16 次断言。笔记草稿/附件历史、原问题/时间范围恢复成立；屏幕范围保存重开再次失败；账户仅预览的限制得到确认。完整新记录与旧统计分开保存。

## 下载包与材料范围

对话中的 `mote-ui-recovered-evidence.zip` 仅打包当前真实存在的材料，共 404 个文件、5,160,999 字节，SHA-256 为 `0c3848a1e0e6b209f23d5102277e350750f0b2202e8e298299cddacf012da948`。将它解压到一个新的空目录，文件按仓库相对路径排列。根目录当前 README 和最终报告单独提供；PDF 另列为可重建材料。缺失的后期原件不在此包中。[完整交付状态](RECOVERY.md)区分 PR 直接文件、对话下载材料与无法恢复的原件。
