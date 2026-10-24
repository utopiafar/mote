# Mote UI 最终交付 · R19

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
