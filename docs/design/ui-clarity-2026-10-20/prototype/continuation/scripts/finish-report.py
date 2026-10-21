from pathlib import Path
import json,hashlib,re,datetime

root=Path(__file__).resolve().parent.parent
design=root.parent.parent
assert (root/'reports/independent-review-r19.md').exists(), 'Wait for independent final visual review'
semantic=json.loads((root/'reports/independent-feature-review-r18.json').read_text())
assert semantic['coverage']['units_pass']==78
for label in 'abc':
    assert (root/f'reports/blind-r18-{label}-comparison.md').exists()
final=root/'dist/r19.html'
assert hashlib.sha256(final.read_bytes()).hexdigest()=='8cabb1d2c2914170a5b00dad56a7814bbb21e28fead38ecb59f894658cbcb7bf'
parts={
'FINAL_OUTCOME':'''**本批 HTML UI 方案定稿为 R19。** 已确认的来源范围冲突、功能细项缺口、内容保留与状态问题得到修正；三个全新评估上下文都能说明用途，并在没有路径提示时找到入口、完成各自的代表性目标。最后由首访发现的长对话标题越界，也经过独立有界复核。

累计独立语义矩阵为 **20 类 / 78 项主要用途支持，0 项主要入口缺失、0 项已确认范围冲突**；五维评分为 **75 / 100**。这份结果不等于所有条件分支或真实业务闭环均已执行。严格规程的八项门槛在本报告中归为 **6 项在约定范围内通过、2 项证据部分满足**：未穷尽所有 P0 条件分支，且早期部分历史原件仍缺失。两项限制保留，不改写成全部通过。''',
'INDEPENDENT_RESULTS':'''| 观察 | R17 | R18 累计复核 |
| --- | ---: | ---: |
| 主要归属及下一步可识别 | 78 / 78 | 78 / 78 |
| 主要用户目的支持 | 67 | 78 |
| 部分支持 | 10 | 0 |
| 已确认范围冲突 | 1 | 0 |
| 整项入口缺失 | 0 | 0 |
| 加权评分 | 67.5 / 100 | 75 / 100 |

**R18 的 78 项结论由 11 项直接复查和 67 项 R17 原证据带入组成。** 另外重新执行的 78 个目录按钮证明 R18 入口可达，不能用它替代独立语义判断。R19 保留相同行为代码，仅有最终排版修正；没有把前序行为记录改名成 R19 执行记录。

| 维度 | 权重 | 最后完整独立评分 |
| --- | ---: | ---: |
| Design quality | 20% | 3 / 4 |
| Originality | 10% | 3 / 4 |
| Craft | 15% | 3 / 4 |
| Functionality | 30% | 3 / 4 |
| Clarity | 25% | 3 / 4 |

C1–C7 分别覆盖用途、功能边界、保存与找回、范围与标签、提问核对、来源控制、返回与恢复；均在各自已观察范围内得到支持。A12 仍明确只有一条截图样例，A16 未验证多重冲突记忆，A26 不评价真实检索质量。逐项限制保留在矩阵中。''',
'BLIND_RESULTS':'''三个 agent 使用全新上下文，只先看给定首屏截图，固定回答后才操作 R18；没有读功能清单、实现或其他评审。**首屏用途理解 3 / 3；入口发现 3 / 3 在 5 次导航以内；三条各自限定的 UI 目标都完成。** 这些是独立 agent 评估，不是真人用户研究。

| 评估者 | 自主目标 | 到合理入口的导航 | 实际结果与证据 |
| --- | --- | ---: | --- |
| A | 保存合成决定，离开后凭正文末段关键词找回全文 | 1 | 5 次点击、2 次输入；唯一搜索结果与四段全文一致。[报告](reports/blind-r18-a.md) |
| B | 持续保存新文件夹，随后暂停并确认历史去向 | 3（含进入设置） | 6 次点击、2 个字段；独立来源、暂停、带来源筛选的合理 0 条空态。[报告](reports/blind-r18-b.md) |
| C | 提问、核对引用及原始内容，再回到同一对话 | 1 | 6 次点击、1 次输入；问题、引用与返回保持。发现长标题越界，交 R19 修正。[报告](reports/blind-r18-c.md) |

R19 未改变首屏、导航或这些任务的行为代码，因此保留三份 R18 的真实身份；没有把它们称为三个全新 agent 在 R19 又做了一遍。A 提出的“搜索摘要未展示末段命中词”、B/C 对部分概念边界的疑问保留为非阻断观察，没有抹去。''',
'COMPARISON_RESULTS':'''先固定 R15、R17、R18 三个候选和相同的资料库、来源任务、记忆整理结果画面，以中性标签呈现并轮换顺序；三位首访评估者在完成任务后分别比较。标签映射为 reed=R15、pine=R17、stone=R18，评估时未提供映射。

| 评估者 | 查看顺序 | 实际结论 |
| --- | --- | --- |
| A | R15 → R18 → R17 | 范围与逻辑的综合判断偏好 R18；R15/R17 并列，整体视觉基本并列。[报告](reports/blind-r18-a-comparison.md) |
| B | R18 → R17 → R15 | R18 的来源范围说明更可信；未强排另两版，总体结构和视觉接近。[报告](reports/blind-r18-b-comparison.md) |
| C | R17 → R15 → R18 | 范围表达倾向 R18；首屏用途与大部分视觉并列，R15/R17 少一个筛选更简洁。[报告](reports/blind-r18-c-comparison.md) |

三位均指出 R18 在“此来源 0 份、其他来源各自保留”的解释上更清楚；**没有形成三位一致的全产品总排序，也没有证明 R18 的整体视觉优于另外两版**。静态比较不代替真实点击。比较者已看过 R18 首屏并完成任务，属于有既往暴露的遮名比较。

选择 R18 的功能与结构基础，再采用 R19 的窄排版修正。R19 没有被伪装成参加了这组静态比较；最终的 R15/R19 对照文件是给用户查看的工具，不是三位评估者的原始比较材料。''',
'EVALUATION_CORRECTION_NOTE':'''独立 R18 评估还保留两项过程事件：一次按标签定位失败没有输入新记忆，后续保存旧文曾被误读为数据丢失；核对 raw 后撤回，使用可见输入框重新输入并逐步确认，候选没有因此改动。另一次异常 fullPage 图被排除出视觉判断，以同次 viewport 和新建 390 px 视口的有效截图复核。两者都不被计为产品修复或虚构通过，详见独立报告。''',
'R19_VERIFICATION':'''**R19 单独验证：** 最终 12 个通用视图无横向溢出或浏览器错误；独立评估者实际复核长标题留在栏内、重新打开仍保留完整问题、引用与原始内容往返，见[最终附录](reports/independent-review-r19.md)。对照工具因版本更新只执行 7 项必要检查并通过，见[工具索引](evidence/r19/comparison/comparison-smoke.json)。应用 JavaScript 的相同性由可逆字节差异记录佐证，不当作一次新的用户任务执行。''',
'GATES':'''下表是 root 汇集独立报告、作者场景与新首访后的结论。每项保留自己的证据边界。

| 门槛 | 当前结论 | 依据与边界 |
| --- | --- | --- |
| 首屏理解 | 通过 | R18 三个新上下文均能解释用途与起点；R19 未改变首屏 |
| 核心入口可发现 | 通过 | 三个自然目标在 1 / 3 / 1 次导航内找到入口，无误路 |
| 关键原型旅程完整 | 部分证据满足 | 所执行的保存、导入、问答、来源、权限模拟、暂停、恢复、记忆和账号路径成立；没有穷尽 12 个 P0 功能族的每个条件分支，不把主要语义支持视为全分支执行 |
| 20 类 / 78 单元覆盖 | 通过主要语义范围 | 累计 78 项主要归属、下一步和用户目的支持；分支限制逐项保留 |
| 结构清楚一致 | 在已评范围内通过 | 已确认的来源计数、筛选、暂停与内容冲突消除；上下文快捷入口保持一致职责 |
| 原型关键阻断清零 | 在已执行范围内通过 | 已执行目标无死路；R18 长标题排版问题在 R19 单独修复复查 |
| 分项下限 | 通过 | 五维均 3；没有因单项修补重新提高总分 |
| 证据覆盖 | 部分满足 | 当前矩阵、代表性任务和 R19 修复有原件；原 R9–R14 及部分后期历史原件仍缺失，全部 P0 条件分支也未穷尽 |

六项通过均带明确范围，另外两项不记为 pass。这些边界不要求真实后端或用户环境来补证，也不产生新的授权请求。''',
'DELIVERY_SCOPE':'''### 文件与发布范围

草稿 PR 直接保存最终 HTML、对照工具、冻结候选、功能与评估报告、脚本、可读索引及部分实际 DOM 证据。完整截图、较大的原始操作轨迹和作者检查材料在对话提供的 `mote-ui-final-evidence.zip` 中，按仓库相对路径组织；报告中的截图相对链接可在解压目录查看。没有把压缩归档上传到公开仓库。

本次只更新设计原型与评估文档。应用源代码、真实服务和设备执行不属于这一份 HTML 交付。'''
}
text=(root/'delivery/final-report-template.md').read_text()
for key,value in parts.items():text=text.replace('{{'+key+'}}',value)
assert not re.search(r'\{\{[A-Z_]+\}\}',text)
(root/'final-report.md').write_text(text)
(root/'README.md').write_text('''# Mote UI 最终交付 · R19

直接打开 [mote-ui-final.html](dist/mote-ui-final.html) 查看单文件 HTML 原型；打开 [mote-ui-review.html](dist/mote-ui-review.html) 对照 R15 与 R19。无需 Mote 运行环境，所有交互使用合成演示数据。

- [完整结果与范围](final-report.md)：功能地图、迭代决定、独立评估、验证及门槛。
- [78 项功能矩阵](reports/independent-feature-matrix-r18.md)：11 项 R18 直接复查与 67 项 R17 原证据带入，逐项保留条件限制。
- [独立 R18 复评](reports/independent-review-r18.md)与[最终 R19 排版复核](reports/independent-review-r19.md)。
- [首次访问 A](reports/blind-r18-a.md)、[B](reports/blind-r18-b.md)、[C](reports/blind-r18-c.md)：先固定首屏理解，再无提示选择路径。
- [R18 检查索引](reports/r18-evidence-inventory.json)、[R19 最终视图](evidence/r19/visuals/index.json)。

累计主要语义覆盖 20 类 / 78 项；三位新上下文理解首屏并完成各自目标；最后完整独立评分 75/100。八项严格门槛为 6 项在已评范围内通过、2 项证据部分满足，详见报告；不宣称所有条件分支或真实业务闭环通过。

最终 R19 SHA-256：`8cabb1d2c2914170a5b00dad56a7814bbb21e28fead38ecb59f894658cbcb7bf`。它只比 R18 增加长对话标题的栏内排版 CSS 和版本编号，应用行为代码相同；前序证据保留原版本身份。

完整截图与较大的原始轨迹在对话下载包中，解压后与本目录的相对路径一致。PR 保存可直接审阅的 HTML、报告、脚本与索引。历史 R9–R14 及部分后期原件仍缺失，未伪造恢复。

修改这份原型请从冻结候选和 continuation/scripts 的明确记录开始；旧 prototype/build.mjs 对应较早检查点，不用于覆盖本次最终文件。
''')
(design/'README.md').write_text('''# Mote UI：HTML 迭代与最终交付

当前推荐 **R19**。它承接原 R1–R15 迭代，继续关闭独立评估发现的范围、状态和功能细项问题，最后修正新首访发现的长对话标题越界。

## 直接查看

- [mote-ui-final.html](prototype/dist/mote-ui-final.html)：最终单文件 HTML，浏览器打开即可。
- [mote-ui-review.html](prototype/continuation/dist/mote-ui-review.html)：R15 / R19 可交互对照。
- [最终报告](prototype/continuation/final-report.md)：结果、功能地图、评估、门槛与实际边界。
- [78 项功能矩阵](prototype/continuation/reports/independent-feature-matrix-r18.md)：主要语义覆盖与逐项未测范围。
- [源码功能盘点](feature-inventory.md)与[冻结功能清单](feature-manifest.json)。

## 当前结果

20 类 / 78 项主要用途有可识别的归属与下一步；原 R17 的 10 项部分支持和 1 项范围冲突关闭。三个全新上下文能解释首屏，并在 1 / 3 / 1 次导航内找到各自目标入口、完成 UI 任务。最后完整独立评分为 75/100；R19 的窄排版修复另有独立附录。

严格门槛为 6 项在已评范围内通过、2 项证据部分满足。完整 P0 条件分支没有穷尽，原部分历史原件仍缺失；入口可达、主要语义支持和真实业务成功分别报告。所有状态均为 HTML 模拟，不需要用户运行环境。

## 历史与证据

[原 R15 报告](final-report.md)、[历史材料清单](artifact-availability.json)与[恢复说明](RECOVERY.md)继续保留。R9–R14 与部分后期原件未恢复；新的 R16–R19 和新执行记录另存，不回写原失败为通过。当前交付和证据入口见 [continuation](prototype/continuation/README.md)。

最终文件为 530,254 bytes，SHA-256 `8cabb1d2c2914170a5b00dad56a7814bbb21e28fead38ecb59f894658cbcb7bf`。完整截图及较大 raw 轨迹随对话下载包提供，PR 直接保存可读 HTML、报告、脚本和索引。[草稿 PR #185](https://github.com/utopiafar/mote/pull/185)。
''')
old=design/'final-report.md'
oldtext=old.read_text()
banner='> 历史 R15 报告：以下评分与结论保留当时身份。当前推荐及新证据见 [R19 最终报告](prototype/continuation/final-report.md)。\n\n'
if not oldtext.startswith('> 历史 R15 报告：'):
    oldtext=banner+oldtext.replace('(prototype/dist/mote-ui-final.html)','(prototype/dist/rounds/r15.html)')
    old.write_text(oldtext)
ledger={'scope':'HTML UI candidate revisions; not every candidate had a full independent re-score. Frozen source identities and original failures retained.','final':'r19','candidate_revisions':[json.loads((root/f'reports/r{n}-freeze.json').read_text()) for n in [16,17,18,19]],'semantic_result':{'baseline':'R17','direct_recheck':'R18','units':78,'carried_from_r17':67,'r18_rechecked':11,'weighted_score':75},'fresh_first_look_candidate':'R18','fresh_contexts':3,'entry_navigation_counts':[1,3,1],'final_delta':'R19 CSS-only long-title containment plus revision namespace; separately verified.','gates':{'passed_in_scope':6,'partial_evidence':2},'historical_missing':'R9–R14 candidates and some late original artifacts remain unavailable.'}
(root/'reports/continuation-ledger.json').write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'report':str(root/'final-report.md'),'bytes':len(text.encode()),'gates_passed_in_scope':6,'gates_partial_evidence':2},ensure_ascii=False))
