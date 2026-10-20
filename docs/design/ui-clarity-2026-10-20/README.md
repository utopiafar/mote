# Mote UI：15 轮 HTML 原型迭代

已完成 **R0 源码重建基线 + R1–R15 共 16 个 HTML 候选**。本次评估产品第一眼理解、功能发现、主次层级、导航、输入、反馈和恢复路径，全部使用演示数据及模拟状态。

## 直接查看

| 交付 | 用途 |
| --- | --- |
| [最终 HTML](prototype/dist/mote-ui-final.html) | 下载后用浏览器打开，直接操作完整演示 |
| [四阶段对照](prototype/dist/mote-ui-comparison.html) | 切换 R0 / R9 / R12 / R15 与查看宽度 |
| [最终报告](final-report.md) | 功能地图、15 轮变化、指标、盲评、候选选择和剩余问题 |
| [20 类功能地图](prototype/evidence/feature-map-review.md) | 每项任务的主要位置及 78 个原目录编号 |
| [R15 独立评审](prototype/evidence/r15/review.json) | 五维评分、证据及问题 |
| [R15 逐项语义复核](prototype/evidence/r15/coverage-review.json) | 78 项分类与具体依据 |
| [R15 门槛判定](prototype/evidence/r15/gate-review.json) | 哪些通过、哪些仍部分完成 |

HTML 包含全部样式、图标、演示数据和交互代码。顶部工具条可切换已有资料/空账号、网页/Mac/Android 布局及浅色/深色。对照页通过隔离 iframe 打开原始候选，切换版本会重新进入演示。

## 已完成的评估

功能分母沿用仓库已有目录：**42 个 core + 36 个 advanced = 78 个唯一单元**，归纳为 20 类用户任务。最终 78 个入口均可达；独立呈现核对为 77 清楚、1 部分、0 错位、0 缺呈现。`clear` 指主要对象和下一步清楚，不代表所有子操作或真实业务均完成。

R15 的 28 条交互场景和 5 份初态检查全部通过所列断言：378 个步骤，其中 200 次操作、178 次断言。独立审阅另行判断目标是否得到充分支持；自然探索的部分完成结论与剩余问题原样保留，详见最终报告。

同一冻结 HTML 另有 [9 条定向补测](prototype/evidence/r15/supplemental/index.json)，85 步，8 条脚本通过、1 条失败：屏幕应用勾选范围在保存及重开后没有保留。登录预览的观察通过不代表账户切换成功；笔记离线演示未提供。补测单列，不并入原固定套件或追改原五维分数。

最终独立评分为 **75/100**，三个遮名候选比较均排序 **R15 ＞ R12 ＞ R9**。八项严格门槛已判定：**4 通过、4 未通过**。推荐 R15 作为这批候选的 UI 方案，原评审结论保留 `refine`，不宣称整体验收通过。

R0 依据源码基线 `2c78ca8d52a7d17fae20962cf68d09a717ffc73a` 的导航、入口、文案和设计色值重建。它并非生产界面捕获，R0 缺呈现统计也不表示原产品没有相应能力。候选全部位于 `prototype/dist/rounds/r00.html` 至 `r15.html`，对应 SHA-256 保存在每轮 candidate 和正式记录中。

## 方法与记录

参考 [Anthropic 的前端生成与独立评估循环](https://www.anthropic.com/engineering/harness-design-long-running-apps)，保留 Design、Originality、Craft、Functionality，增加 Clarity；本项目权重分别为 20%、10%、15%、30%、25%，采用 0–4 分。

生成器修改 HTML；独立知情评估者查看可见状态与执行记录。新上下文评估者先回答首屏问题，再按自然目标自行选路，最后用隐藏轮次、轮换顺序的材料比较保留候选。完成 15 轮与全部门槛通过分别记录。

| 材料 | 内容 |
| --- | --- |
| [功能源码盘点](feature-inventory.md) / [冻结分母](feature-manifest.json) | 来源、编号、20 类映射 |
| [评估规程](plan.md) / [记录 Schema](schema.json) | 角色、刻度、门槛、证据与隔离方式 |
| [正式逐轮记录](rounds/) | R0–R15 分数、范围、交互、盲评和下一步 |
| [各轮原始材料](prototype/evidence/) | 评审、动作、采集及渲染元数据 |
| [最终候选对照](prototype/evidence/final-comparison/) | 遮名材料、轮换顺序、原始排序和映射 |
| [原生落地参考](native-ui-change-plan.md) | HTML 迭代之前的代码盘点，供后续产品实施定位 |

## 证据类型

**jsdom 执行 HTML 的 DOM 事件，WeasyPrint/Poppler 生成静态排版图。** 文件中记录执行步骤、可见内容、候选与快照哈希、尺寸、分页及渲染兼容信息。静态图不等于浏览器截图，分页不证明真实滚动或遮挡；模拟连接、模型、任务和问答不等于真实业务验证。

## 恢复原始证据与复现

为便于浏览仓库，原始 DOM JSON、静态 HTML 和大部分 PNG 按轮归档；每份原始字节都有 SHA-256。候选、评审、actions、正式记录与元数据直接保留。查看报告中原始执行文件的路径前，可先恢复归档。可重建 PDF 另有排除和复现清单。[详细说明](prototype/EVIDENCE-PACKAGING.md)

```sh
python3 docs/design/ui-clarity-2026-10-20/prototype/restore-evidence.py --repository-root . --extract
node docs/design/ui-clarity-2026-10-20/prototype/finalize-rounds.mjs 15 --check
```

单个场景可以直接使用冻结候选和该轮 actions 重放：

```sh
cd docs/design/ui-clarity-2026-10-20/prototype
node capture-dom.mjs --input dist/rounds/r15.html \
  --url 'https://mote-prototype.invalid/?reset=1#/memories' \
  --actions evidence/r15/existing-memory-continue.actions.json \
  --output /tmp/mote-replayed.html
python3 render-evidence.py /tmp/mote-replayed.html \
  --width 1440 --height 1200 --output /tmp/mote-replayed.png
```

执行依赖包括 Node、jsdom 26.1、Ajv 2020，以及 Python、WeasyPrint 70.0、Poppler 和 CJK 字体。归档里的旧候选不要重新 build；当前 `journey-fixtures.json` 已随迭代扩展，不能代替历史 actions。若继续改动，保存为新的候选或明确的 recheck，并保留原评审。

既有草稿：[PR #185](https://github.com/utopiafar/mote/pull/185)。本次修改位于本设计目录。
