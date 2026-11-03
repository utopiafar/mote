# 中央功能发现与高级操作旅程

## 范围与证据

新界面沿用中央 Web 的五个工作区和已有功能边界。首次印象研究采用独立 AI 模拟用户的两轮隔离 demo 盲测，另一个代理按功能清单评估；不是真人研究。后续高级功能采用有引导的逐项访问与独立证据审查，分母为 36 个功能单元、156 个控件或状态检查。入口已访问、真实控件动作、生成夹具生命周期、正确禁用、条件不存在、未验证和失败分别记录，不将指南文字或路由计作控件已使用。

测试内容、文件、录音、截图片段、账号和提案均为生成资料。模型和厂商适配器的固定响应只证明状态流及 UI；API 预置的 MCP 配置、加密对象、诊断记录和校正提案分别标记准备方式，不宣称由浏览器生成或真实模型推理。真实 Google / Gmail OAuth、飞书 / 钉钉账号、物理采集与权限、外部 Chatbot 和日历写入、模型语义质量另行验证。

## 必须保留的回归

| 用户旅程 | 核对点 | 持久测试 |
| --- | --- | --- |
| 首次查找来源与高级设置 | 首页、数据源目录及功能指南使用同一术语，16 个目的组和 78 个映射唯一；英文作者文案完整，原文不翻译 | `feature-guide-catalog.test.ts`、`source-catalog.test.ts`、i18n 同步检查 |
| 功能缺失、版本不兼容或撤销 | 链接明确不可用；未确认中央支持时不请求缺失接口；Coding 不可用不隐藏其他处理任务 | `discovery-availability.test.ts`、`coding-receipt-panel.test.ts`、`library-browser.test.ts` |
| 资料库链接及任务返回 | 显式 Library collection 链接到正确类型；不存在类型不跳到另一类；已删除的旧路径回落到默认页；模型设置返回确切任务，外部或无效返回链接不可执行 | `workspace-route.test.ts`、`route-query.test.ts`、`model-start-guide.test.ts` |
| 草稿和浏览历史 | 修改后还原不提示；真实修改继续受保护；同页分类及插件页签改变、移除参数和前进/后退同步；拒绝离开保留当前草稿与分类 | `navigation-drafts.test.ts`、`plugin-center.test.ts` |
| 录音同步独立步骤 | 转写格式失败与音频归档分开，错误对应精确 code，未知原因不推断为网络或权限 | `recordings-settings.test.ts` |
| 录音历史起止日期 | 逐键输入四位年份（如 2011）不改写中间值；轮询保留草稿；保存时按本地时区转换，重新打开仍显示选定日期；空起点及未填完整的终点不能提交，明确清空终点仍支持持续同步 | `recordings-settings.test.ts`、`recording-date-browser.cjs` |
| 长片段继续读取 | 0–4000 → 4000–8000 → 最后一页，显示实际字符范围；旧版本、删除及范围外资料不可展开；支持原文单独续读 | 服务端 `agent-view-pagination.test.ts`，生成数据浏览器回归 |
| 保留运行发现 | 600 条真实后台诊断之后仍可从运行选择器找到已保留模型记录；不重建或扩展保留历史 | 服务端 `agent-view-pagination.test.ts` |

Web 测试位于 `apps/web/test/`，服务端测试位于 `apps/server/test/`。

## 浏览器复查矩阵

正式构建使用隔离中央节点和生成资料复查：中文 / English，320 px / 桌面宽屏，新增数据源、厂商详情及返回、模型设置任务返回、插件同页签链接与历史、Coding 摘要展开及正文去向、长片段下一页、键盘和草稿保护。折叠区域打开后有明确标题、可滚动范围及键盘焦点；统计与技术详情保留计量边界及不完整数据说明。

正确受限的情况保留条件记录：未配置模型时不启动记忆整合；无授权时不假造已连接日历选择；删除版本和部分生命周期没有现成生成状态时不伪造通过；诊断只证明保留内容，空页不证明从未读取。加密迁移和授权展示的 API 准备与 UI 取消、隐藏、撤销等动作分别报告。

PR 检查使用 `npm run check:affected` 覆盖变化组件及其消费者。共享 English 目录变更会选择中央、桌面和 Android；这是构建、类型与单元检查，不能替代物理设备、真实账号或真实模型验证。

录音日期的原生键盘回归单独运行：

```sh
npm run build:central
TZ=Asia/Shanghai node_modules/.bin/electron apps/web/test/recording-date-browser.cjs
TZ=UTC node_modules/.bin/electron apps/web/test/recording-date-browser.cjs
```

此脚本在后台隐藏窗口中，通过 Chromium 原生键盘事件编辑起止年份，使用生成资料和临时中央节点保存范围并重新加载页面；不读取真实厂商账号、不启用录音同步、不调用模型。组件回归另覆盖未改动时间戳的秒数保留及明确清空可选终点。
