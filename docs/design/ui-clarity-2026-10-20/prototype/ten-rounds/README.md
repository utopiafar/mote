# Mote：Web、Mac、Android 三端 UI，R20–R29

在冻结 R19 的基础上继续十轮。每轮保存三份独立 HTML、当轮源码、修改原因、评分规则、SHA-256 清单，以及独立评估报告和浏览器证据。历史候选保持原样。

## 打开效果

- [三个最终端并排查看](dist/mote-three-platforms.html)
- [Web 最终原型](dist/mote-web-final.html)
- [Mac 最终原型](dist/mote-mac-final.html)
- [Android 最终原型](dist/mote-android-final.html)
- [逐轮查看器](dist/mote-rounds-gallery.html)
- 全部十轮便携查看器（评审对话附件：`mote-rounds-portable.html`）
- [最终评估报告](final-report.md)
- 精简离线评审包（评审对话附件：`mote-ui-r20-r29-review.zip`）
- 完整证据下载包（评审对话附件：`mote-ui-r20-r29-evidence.zip`）

独立原型和便携查看器均为自包含 HTML，下载后可直接用浏览器打开。逐轮查看器需要与 `rounds/` 保持相对目录关系，完整下载包已经保留此结构。Mac 与 Android 为对应端的 HTML 模拟。默认显示空白资料库；查看器可切换已有资料、浅色与深色，也可重新开始演示。

从“写下第一条记录”开始，可以保存、离开、搜索，再打开原文；从“同步文件夹”或“记录屏幕”开始，可以查看接入范围、权限说明、当前状态与暂停操作。所有内容和处理结果使用演示数据。

## 评估与功能范围

新用户友好度占 25%，包含用途理解、第一步、权限与连接、首次价值与核对、渐进展开五项。其余为设计质量 15%、原创性 5%、完成度 10%、功能性 25%、逻辑清晰 20%。三端分别评分，再等权汇总，并保留最弱端分数。

评估者与实现者分离。每轮先冻结候选，再由独立 agent 查看实际界面、完成代表性任务、保存截图和行动记录。连续评估与全新上下文的首访评估分别标记；这些证据不等同于真人用户研究。

- [冻结评分规则](rubric-independent.md)
- [十轮计划与留存规则](iteration-plan.md)
- [功能与用户旅程基线](context/feature-inventory.md)
- [功能单元清单](context/feature-manifest.json)
- [构建、归档和校验说明](README-harness.md)

本次验证 HTML 的信息层级、功能发现、交互路径和状态解释。原生系统权限、实际采集、真实模型和后台同步由产品实现阶段验证。

产品范围差异：仓库中普通浏览器用户只导入所选文件/文件夹，不读取中央服务器目录；中央/管理路径的目录导入为一次任务，Mac/Android 有本机持续文件来源。R27–R29 的“工作台服务器文件夹持续接收”是 HTML 设计提案，不能视为已有实现；一次导入入口仍保留。详见最终报告第 5 节及 [设计提案与现有能力差异](context/known-proposal-gaps.md)。

## 十轮最终结果

R29 独立评估：Web **81.3**、Mac **87.5**、Android **87.5**，三端等权均分 **85.4**。三端均通过既定关键门槛；Web 分数仍低于 85 分参考目标。功能目录检查三端各 **78/78** 个入口可达，合计 **234/234**，不代表所有功能分支均已完整验收。

[评分与证据汇总](reports/scores-evidence-summary.md) 保留十轮原始分数、763 条连续评估操作记录、607 个被引用的截图文件及 30 份操作前首屏记录。四次全新上下文评估另外留档。最终保留一项 Android 记忆历史关系文案缺字的轻微问题，详见最终报告。

每轮 HTML、冻结源码和独立报告也有对应 Git 提交，见 [round-commits.json](round-commits.json)。公开仓库保存可读文件；两个 ZIP 下载包及自包含便携查看器通过本次对话附件交付。精简包不含截图和追踪，完整包保留全部浏览器证据。

## 每轮原件

| 轮次 | Web | Mac | Android | 修改说明 | 独立评估 |
| --- | --- | --- | --- | --- | --- |
| R20 | [打开](rounds/r20/web.html) | [打开](rounds/r20/mac.html) | [打开](rounds/r20/android.html) | [修改](rounds/r20/changes.json) | [报告](rounds/r20/reports/independent-evaluation.md) |
| R21 | [打开](rounds/r21/web.html) | [打开](rounds/r21/mac.html) | [打开](rounds/r21/android.html) | [修改](rounds/r21/changes.json) | [报告](rounds/r21/reports/independent-evaluation.md) |
| R22 | [打开](rounds/r22/web.html) | [打开](rounds/r22/mac.html) | [打开](rounds/r22/android.html) | [修改](rounds/r22/changes.json) | [报告](rounds/r22/reports/independent-evaluation.md) |
| R23 | [打开](rounds/r23/web.html) | [打开](rounds/r23/mac.html) | [打开](rounds/r23/android.html) | [修改](rounds/r23/changes.json) | [报告](rounds/r23/reports/independent-evaluation.md) |
| R24 | [打开](rounds/r24/web.html) | [打开](rounds/r24/mac.html) | [打开](rounds/r24/android.html) | [修改](rounds/r24/changes.json) | [报告](rounds/r24/reports/independent-evaluation.md) |
| R25 | [打开](rounds/r25/web.html) | [打开](rounds/r25/mac.html) | [打开](rounds/r25/android.html) | [修改](rounds/r25/changes.json) | [报告](rounds/r25/reports/independent-evaluation.md) |
| R26 | [打开](rounds/r26/web.html) | [打开](rounds/r26/mac.html) | [打开](rounds/r26/android.html) | [修改](rounds/r26/changes.json) | [报告](rounds/r26/reports/independent-evaluation.md) |
| R27 | [打开](rounds/r27/web.html) | [打开](rounds/r27/mac.html) | [打开](rounds/r27/android.html) | [修改](rounds/r27/changes.json) | [报告](rounds/r27/reports/independent-evaluation.md) |
| R28 | [打开](rounds/r28/web.html) | [打开](rounds/r28/mac.html) | [打开](rounds/r28/android.html) | [修改](rounds/r28/changes.json) | [报告](rounds/r28/reports/independent-evaluation.md) |
| R29 | [打开](rounds/r29/web.html) | [打开](rounds/r29/mac.html) | [打开](rounds/r29/android.html) | [修改](rounds/r29/changes.json) | [报告](rounds/r29/reports/independent-evaluation.md) |

`manifest.json` 对应当轮 HTML 与源码；评估报告再次记录候选哈希。修复进入下一轮，修复前的失败和评分继续保留。完整截图、可见 DOM、实际行动与追踪文件位于相应轮次及 `reports/` 的独立首访目录。
