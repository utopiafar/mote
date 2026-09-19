# 页面采集：实践调研与实现决策

调研日期：2026-09-20。Screenpipe 核对提交 `376f21d2b89eeddc6b3adb8209d52d21cee2e077`，Hammerspoon 核对提交 `23e387e2805a9890066366e0ac96c71b27f0cfd5`。以用户提供的对话为问题背景，重新核对公开文档和源码；未采集真实私人页面。对话中的建议不等于已经验证的事实。

## Screenpipe：采集调度与文字 / 图像分离

检查 [事件采集源码](https://github.com/screenpipe/screenpipe/blob/376f21d2b89eeddc6b3adb8209d52d21cee2e077/crates/screenpipe-engine/src/event_driven_capture.rs) 与 [项目说明](https://github.com/screenpipe/screenpipe/blob/main/README.md)。源码用最短采集间隔、空闲补采、窗口变化与输入事件组成调度，维护文字 hash、最近成功落库时间和节点去重缓存；树读取有 worker timeout，并按应用读取成本退避。事件要与 frame 关联，因此“没变就不插节点”与“观察发生过”不是同一件事。

当前配置已经包含 `disable_screenshots`：开启后跳过视觉变化检查、截图、JPEG 写入与 OCR 回退。这修正了分享对话里“它仍总是保存截图”的描述。默认值仍是 false。默认最短间隔 200ms、空闲采样 30s 属于其实现参数，不能直接当作 Mote 的合理默认值，更不能引用 README 的资源占用数字作为 Mote 性能结论。

**采用**：把无图文本记录接入既有归档，截图策略由宿主决定；明确截断和失败。**本版取舍**：沿用 Mote 用户设置的 5–300 秒采样间隔，单工作线程读取，避免引入高频键盘或点击监听。尚未做自适应退避或内容对象级去重，不声称达到 Screenpipe 的吞吐与资源表现。

## GKD：选择器、订阅、快照与社区适配

核对 [订阅](https://gkd.li/guide/subscription)、[选择器](https://gkd.li/guide/selector)、[查询优化](https://gkd.li/guide/optimize)、[快照审查](https://gkd.li/guide/snapshot)。它把 App 身份、Activity、规则组、选择器和匹配时机放进 JSON5 订阅，支持上下文关系而非只凭文本寻找节点；快照审查把设备现场转换为可供作者离线分析的节点资料。查询优化会利用系统 ID / 文本查询，避免每次遍历整个大树。

它的执行目标主要是 UI 动作；正文提取需要另行设计。不应把“成功定位关闭按钮”当作“完整读取文章”。本版不执行 GKD 动作、不导入其选择器解释器，也不访问公共真实快照。Mote 的选择器是独立实现的有界 JSON 子集：精确 `resourceId`、`role`、`textEquals`，可加祖先条件、页面必要节点、Activity 与应用版本门槛。没有正则表达式、函数调用或动态代码执行。

社区核对版本：[AIsouler/GKD_subscription b5160b4](https://github.com/AIsouler/GKD_subscription/tree/b5160b47f4587c8a25ddad73eb012eae5942df7f)。该仓库已归档，不能假定持续适配最新 App。GitHub license endpoint 没有返回可识别许可，因此不复制规则实现、动作或快照；仅把核对到的应用 / 页面标识当作兼容事实，重新编写 Mote 规则和合成测试。

| 首批 Android 适配 | 社区证据 | Mote 实际提取与边界 |
|---|---|---|
| 微信 WebView | [微信规则](https://github.com/AIsouler/GKD_subscription/blob/b5160b47f4587c8a25ddad73eb012eae5942df7f/src/apps/com.tencent.mm.ts) 中的 `MMWebViewUI` | 仅该 Activity 的 WebView 下公开 View 文字；不是微信聊天数据库，不保证公众号全文；登录输入被过滤 |
| 知乎内容页 | [知乎规则](https://github.com/AIsouler/GKD_subscription/blob/b5160b47f4587c8a25ddad73eb012eae5942df7f/src/apps/com.zhihu.android.ts) 中的 `MixShortContainerActivity`、`view_content` | 该容器下公开 View 文字；不推断作者、回答归属或是否读完 |
| 小红书笔记详情 | [小红书规则](https://github.com/AIsouler/GKD_subscription/blob/b5160b47f4587c8a25ddad73eb012eae5942df7f/src/apps/com.xingin.xhs.ts) 中的 `NoteDetailActivity` | 当前页公开 TextView，可能包含导航与评论；不能宣称正文、作者、图片已完整解析 |

上述适配都标记 `complete:false`，只通过生成样本验证。没有真实 App 版本兼容承诺。匹配不到不会用应用名关键词猜页面。抖音、支付页、Canvas 和游戏未加入预设，因为本轮没有足够的正文节点证据。

## Hammerspoon：AX 包装与脚本能力边界

核对 [hs.axuielement](https://www.hammerspoon.org/docs/hs.axuielement.html)、[observer](https://www.hammerspoon.org/docs/hs.axuielement.observer.html) 和 [原生包装源码](https://github.com/Hammerspoon/hammerspoon/blob/23e387e2805a9890066366e0ac96c71b27f0cfd5/extensions/axuielement/libaxuielement.m)。Lua 模块封装 macOS AX 对象，支持属性、子节点与 observer callback。通知的可用性取决于应用；收到通知不代表所有页面都公开了完整正文。

其通用自动化接口也有写属性和执行动作能力，不能原样交给 Mote 查询 Agent 或第三方解析器。本版复用现有 Swift helper，新增只读命令：前台进程与 focused window 验证、消息超时、节点/深度/文字预算、遮挡过滤。只采集 AXStaticText；不调用 `AXManualAccessibility` 修改目标应用，也不请求隐藏授权。

微信与飞书 macOS 预设是**Mote 编写的通用可见静态文字规则**，不是网上已经完成的聊天解析器。Bundle ID 与 [ATBClone 配方表](https://github.com/aitobox/ATBClone)交叉核对；没有复用该项目的克隆、注入或沙箱修改能力。不同版本 Bundle ID 或 AX 暴露变化可在规则中修改。

## QuickJS 与浏览器 DOM

[QuickJS 官方手册](https://bellard.org/quickjs/quickjs.html)提供 runtime 内存上限、栈上限和执行中断回调。作为未来纯函数解析器运行时可行，但嵌入式引擎不自动等于隔离：还必须限制宿主绑定、模块加载、结果大小以及进程生命周期。为满足“脚本或规则配置”，本版选择规则路线；用户可以用脚本生成 JSON，不在手机、Mac 或中央执行任意下载的 JS。

浏览器 DOM 是未来独立输入，不把 AX 当作 DOM 替代品。本版没有扩展注入或远程页面抓取，也不把未出现在窗口中的整篇文档作为屏幕证据保存。

## 本版验证与尚未证明的内容

跨语言使用同一套合成规则样本，检查正常页面、无正文、错误页面、错误 App、版本变更、截断、相同文字的不同节点。中央验证独立 source、幂等重传、证据还原、检索和隔离。原生测试只用构造的节点。

真实微信 / 知乎 / 小红书 / 飞书的覆盖率、Mac AX 权限后的目标 App 行为、设备耗电及存储节省比例均未实测。`partial` 仅意味着规则取得一些文字，不是内容质量保证；默认 `screen_only`，载入规则不会自动启用。
