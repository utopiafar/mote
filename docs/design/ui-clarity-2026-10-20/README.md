# Mote UI：HTML 迭代与最终交付

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
