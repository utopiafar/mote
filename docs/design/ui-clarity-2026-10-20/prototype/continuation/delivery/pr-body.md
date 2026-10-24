## 为什么继续这次 UI 迭代

原 R15 HTML 仍有来源范围丢失、屏幕范围保存恢复、记忆采用内容不完整和英文残留。继续独立复核后，R17 又暴露了 10 项功能细节缺口，以及飞书工作详情与资料库的 12 / 6 / 0 数量冲突。

本 PR 保留这些历史失败和冻结候选，定稿为 **R19**，只涉及 HTML 设计原型与评估文档。

## 现在的行为

- 资料库、问一问、来源、活动各自职责明确，首屏解释可保存什么及保存后如何查找、提问、核对原文。
- 新建与编辑来源分开；资料浏览延续来源 / 设备范围；屏幕、单来源、全局发送暂停各有独立状态。
- 完整笔记、记忆正文、纠正历史、继续整理采用内容和模拟账号草稿可从常规入口找回。
- 补齐来源内容关系、记忆搜索 / 时间回看、截图分组、当前导入图片方案、采样口径、账号节点与问题上下文预览。
- 统一新控件的中英文与窄屏表现。最后的新首访发现长对话标题越界，R19 仅做该项 CSS 修正。

## 实际验证

- 20 类 / 78 项累计主要语义支持：11 项 R18 直接复查，67 项保留 R17 原证据；不宣称全部分支端到端通过。
- 3 个全新上下文先固定首屏理解，再自主完成任务；到入口分别 1 / 3 / 1 次导航，均完成各自目标。
- 最后完整独立评分 75/100，五维均为 3/4；R19 有独立长标题、历史重开、引用返回与 390px 附录。
- R18：78 个目录入口可达；12 个通用视图、4 个英文设置窄屏视图正常；来源 / 恢复 / 记忆 / 笔记 / 账号定向检查及 23 项设置检查通过。
- R19：12 个最终视图无水平溢出或浏览器错误；对照工具只做版本变化所需的 7 项检查。

所有检查均为合成数据下的 HTML UI。无需用户运行环境，没有真实服务、模型或设备闭环验收。按 docs 原型范围核对渲染、交互和文档，未运行生产应用构建。

## 交付

- [最终 HTML](https://github.com/utopiafar/mote/blob/codex/ui-clarity-15-rounds-20261020/docs/design/ui-clarity-2026-10-20/prototype/dist/mote-ui-final.html)
- [R15 / R19 单文件对照](https://github.com/utopiafar/mote/blob/codex/ui-clarity-15-rounds-20261020/docs/design/ui-clarity-2026-10-20/prototype/continuation/dist/mote-ui-review.html)
- [完整报告](https://github.com/utopiafar/mote/blob/codex/ui-clarity-15-rounds-20261020/docs/design/ui-clarity-2026-10-20/prototype/continuation/final-report.md)
- [78 项功能矩阵](https://github.com/utopiafar/mote/blob/codex/ui-clarity-15-rounds-20261020/docs/design/ui-clarity-2026-10-20/prototype/continuation/reports/independent-feature-matrix-r18.md)

最终文件：530,254 bytes；SHA-256 `8cabb1d2c2914170a5b00dad56a7814bbb21e28fead38ecb59f894658cbcb7bf`。

八项严格门槛保留 **6 项在已评范围内通过、2 项证据部分满足**：所有 P0 条件分支未穷尽，原 R9–R14 及部分后期原件仍缺失。新的证据没有冒充恢复原件。完整截图与较大的原始轨迹在对话下载包提供；PR 保存可读 HTML、报告、脚本、索引及部分 DOM 证据，未上传压缩归档。
