# R20 独立评估

**三端门槛未通过。** 等权总分 **72.50/100**，最低平台 Android **68.75/100**。三端均完成第一条合成笔记的保存、离页搜索、正文核对、限定资料提问、引用及原文返回。Android 取消权限设置被旧提示和底栏遮挡，关闭提示并滚动后恢复；Web 屏幕设置缺少采集执行设备的说明。

## 身份与真实范围

开始 `2026-10-21T04:35:16.155Z`；完成 `2026-10-21T04:39:18.843Z`。Chrome `133.0.6943.16`。视口：Web 1440×1000，Mac 1280×900，Android 390×844。每端操作前独立保存首屏和首次理解，随后依据可见控件操作。评估者已知基线，不能称为新的真人盲测。未读候选实现，未修改候选。候选前后 SHA256 一致。

| 平台 | SHA256 |
| --- | --- |
| Web | `225a723e4f9df6c348f0e72fdc1b7f0d2116e009ea634cd264dd179037333c65` |
| Mac | `0bd4fe3d76af1e189d562c36aa47b7eb5f74458dadd2083d03036f609e7f0e6e` |
| Android | `828b76a01226ae036e7484fcf99cae4482bdb8be3efb3a9c46581ade6d56caa6` |

## 评分

| 平台 | Design15 | Originality5 | Craft10 | Functionality25 | Clarity20 | New-user25 | 加权/100 | 门槛 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| web | 3 | 3 | 3 | 3 | 2 | 3.2 | 71.25 | fail |
| mac | 3 | 3 | 3 | 3 | 3 | 3.4 | 77.50 | pass |
| android | 3 | 3 | 2 | 2 | 3 | 3.4 | 68.75 | fail |

新用户五子项依次为用途、第一步、权限/设置、首次价值/核对、渐进展开：Web **4/4/2/3/3**，Mac **4/4/3/3/3**，Android **4/4/3/3/3**。4 分只用于已观察到的首屏和保存后状态都表达清楚的用途与第一步；未因此把其他维度提高到 4。

Web Clarity=2 的原因是具体的平台责任歧义。Android Craft=2 是动作被覆盖，Functionality=2 是正常取消确实失败并要求额外恢复；权限本身的说明仍足以支持新人子项 3，没有机械地把同一阻碍再次扣到该子项。

## 发现与下一轮优先级

1. **R20-A / major / Android：旧保存提示阻挡取消。** 提示在保存、提问、原文、来源等页面间一直存在。点击设置底部“取消”30秒未成功；点击日志显示提示和底部导航拦截。手动关闭提示并滚动后才取消成功，来源仍显示尚未开启。这是有恢复方法的实质摩擦，未定为 critical。[阻挡画面](../evidence/independent/android/18-cancel-blocked.png) · [动作记录](../evidence/independent/android/actions.json) · [恢复后](../evidence/independent/android/21-setup-cancelled.png)。
2. **R20-B / major / Web：屏幕设置未保留设备边界。** 首屏说由 Mac/Android 采集，设置页却直接显示录屏授权与开始记录，没有当前执行设备。用户可能误解浏览器具有相同本机能力。[设置画面](../evidence/independent/web/16-screen-setup.png)。
3. **R20-C / minor / 三端：限定资料回答没有贴近回答的模拟说明。** 全局条有原型身份，但 Android 自动滚动后它离开视口。建议在所有回答分支附近说明示例、未调用模型。[Android 回答](../evidence/independent/android/09-answer.png) · [Mac 回答](../evidence/independent/mac/09-answer.png)。

## 实际任务与正面证据

每端从“写下第一条记录”开始，写入包含日期、负责人、截止时间与核对词“橙色风筝”的合成笔记。保存后离开编辑页，从主导航进入资料库，按核对词查找并打开，正文完整。接着从该资料提问，回答引用对应新资料；查看原始内容并返回后问题和回答保留。三端均模拟拒绝屏幕权限；Web/Mac 正常取消，Android 经上述恢复取消。最后从资料库打开“记忆”，看到长期信息、依据与原始资料保留的解释。

共记录 Web 20、Mac 20、Android 23 条实际动作/观察记录。每条链接相应 DOM，关键状态保存截图。没有浏览器页面脚本错误。执行成功不替代上述结果判断。

[Web 首次理解](../evidence/independent/web/first-look.json) · [Mac 首次理解](../evidence/independent/mac/first-look.json) · [Android 首次理解](../evidence/independent/android/first-look.json) · [身份与会话记录](../evidence/independent/session.json) · [完整结构化报告](independent-evaluation.json)。

## 限制

只验证 HTML 模拟会话，不验证真实模型答案、后端、OS授权/采集、上传、外部来源、同步与刷新持久化，也没有把有限路径称为20类/78单元完整验收。最初的 Node 哈希变量与全局 Crypto 冲突发生在打开候选之前，已改名并记录，不计为产品问题。Android 的点击超时则有画面和拦截日志支持，计为产品可达性问题。85分仅是目标，本轮报告保持观察所得的实际分数。
