# 页面内容采集与规则贡献

页面观察是独立的 `source: ui_page`，与截图 `screen`、状态 `activity` 并列。无图记录使用已有持久队列、批量压缩传输、重试确认、中央存储、文本检索、只读证据工具和导出；不触发 OCR。`ocrText` 是兼容现有索引的正文承载字段，页面详情明确显示其来源不是 OCR。

## 启用

先升级中央节点，再升级采集器。旧中央不认识此来源，会拒收；客户端保留队列，不会误报上传成功。

Android：使用无障碍采集模式并启用屏幕 / 前台采集，在隐私设置中的“页面内容采集”选择模式、填写 JSON 或“载入实验规则”，保存。目标 App 的隐私级别还必须是 `content`；Android 新安装默认仅活动，载入规则不会改变这个默认。投屏模式不支持页面读取，保存时明确拒绝不兼容组合。

macOS：隐私设置中同名区域配置。需要系统辅助功能授权；仅页面模式无需屏幕录制权限。宿主不代为开启目标应用辅助功能、不点击或滚动页面。当前仅支持主屏内完整显示的前台窗口。

| 策略 | 行为 |
|---|---|
| `screen_only` | 默认，继续现有截图，不读取页面正文 |
| `hybrid` | 匹配的页面额外保存文字，继续现有截图策略 |
| `ui_preferred` | 只有规则声明完整且读取未截断时才跳过截图；未支持或部分读取继续截图 |
| `page_only` | 只保存匹配页面；不支持、失败或无文字时无记录，不回退截图 |

隐私规则拒绝不会转成截图绕过。停止采集、锁屏、切换应用、配置变更会使未完成的页面观察失效。掩码相对于主屏，任何相交节点的文字被丢弃；输入框/密码（Android 包括敏感标记节点）整棵子树被跳过，遮挡窗口也过滤。节点无法确认可见范围时不保存文字。

## 规则格式

两端共用 JSON 数组；手机配置导入文件的 `settings.uiPageRules` 是这个数组的 JSON **字符串**，`settings.uiPageMode` 是策略字符串。Mac `config.json` 中 `config.uiPageRules` 则为数组、`config.uiPageMode` 为字符串。通过界面保存会安全应用；手工改配置应先退出应用。规则文件不能含脚本、动作、URL 下载或未知字段。

```json
[
  {
    "id": "my-reader.article",
    "version": "1",
    "platform": "android",
    "appId": "dev.example.reader",
    "activity": "dev.example.reader.ArticleActivity",
    "appVersion": "1.2.3",
    "required": [{"resourceId": "dev.example.reader:id/article"}],
    "select": {"role": "android.widget.TextView"},
    "ancestor": {"resourceId": "dev.example.reader:id/article"},
    "complete": false
  }
]
```

应用和平台必须精确匹配；可选 Activity / 应用版本进一步限制。`required` 全部存在才运行，`select` 属性为 AND，`ancestor` 限定祖先容器。支持 `resourceId`、`role`、`textEquals` 精确值，文本匹配只能用于用户指定的结构 / 页面定位，不作为语义分类。数组按顺序，第一个产生结果的规则生效。相同文字的不同节点保留，不推断作者、消息 ID、阅读状态或任务。

最多 32 条规则、8 个必要节点条件。单次读取最多 256 个节点、24 层、每节点 2000 字符、总文本 32000 字符；超限返回 `partial`，不会把截断结果标记为完整。Mac helper 总进程超时 5 秒，内部遍历预算 1 秒 / AX 消息超时 50ms；Android 遍历预算 750ms（系统单次 IPC 仍可能超过这个软预算），单 worker 防止堆积。不在主线程遍历正文树。沿用原采样间隔；本版不做每个滚动事件触发读取。

`complete:true` 是适配作者的完整性契约，不是模型评分：只有目标字段和负例经过验证才应开启。内置所有规则为 false；因此首次推荐使用 hybrid 验证，再按你的实际页面收紧选择器。规则删除/恢复旧版本即为回退，不自动下载或升级。

## 样本回放与扩展

[内置包](../adapters/ui/builtin.json) 是唯一源文件，Android 构建复制到 assets，TypeScript 的内置副本由脚本生成。当前有微信 WebView、知乎内容页、小红书详情页，以及 Mac 微信/飞书静态文字实验规则。来源、局限和许可判断见[调研](ui-page-research.md)。没有通过实机验证的 App 版本表；不要把这些实验规则宣传为完整聊天/文章解析器。

```sh
npm run build -w @mote/shared
node scripts/ui-adapters.mjs generate
node scripts/ui-adapters.mjs replay /absolute/path/sanitized-snapshot.json adapters/ui/builtin.json android
node --test packages/shared/test/ui-page.test.mjs
```

快照结构见 `packages/shared/src/ui-page.ts`；回放输入是普通 JSON，没有系统对象。`adapters/ui/fixtures/conformance.json` 是完全生成的数据，TS 与 Kotlin 使用同一文件。规则选择后的证据保存在 `metadata.uiPage.nodes`，带节点 ID、位置、角色、资源 ID 和原文字。此版只保存选中节点，不保存未选中的整棵树；不能事后从归档恢复未采集的字段或像素。

贡献规则时提交清单、来源/版本说明、生成或独立脱敏的快照及期望结果，覆盖正常/空/错页/版本变更/截断。Agent 可以根据脱敏样本生成这些文件；运行时仍没有写权限或动作 API。用户可以用任意本地脚本生成规则 JSON。任意 JS 解析函数和在线订阅执行属于后续运行时工作。

## 查看与边界

Mac 和 Android 的采集记录都可选择“页面内容采集”，中央时间线可按同名来源筛选；展开元数据可查看规则与节点证据。只读 Agent 能直接检索正文，必须把它当作不可信材料。观察时长固定为 0，避免与截图/状态重复计时；不表示用户阅读过全文。

本版每次有效采样独立保存，没有跨观察内容对象去重或差分树。旧队列、图片和笔记不迁移、不重写。不要预期精确的存储节省比例；只有成功跳过图片才会减少图像存储与中央 OCR。Canvas、没有公开节点的页面以及系统隐藏的敏感内容不会被恢复。
