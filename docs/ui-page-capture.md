# 页面内容采集与规则贡献

`source: ui_page` 表示无图页面观察，使用既有持久队列、批量传输、幂等确认、中央存储、检索与导出，不触发 OCR。`ocrText` 是兼容索引的文字承载字段，内容实际来自无障碍字段。2026-10-10 的 Android 改造见 [ADR](adr-android-page-fields.md)。

## Android 用户流程

先升级中央节点，再升级 Android。旧节点拒收 v2 字段时，记录留在队列，不报告成功。底部导航保留“今天 / 资料 / 问一问 / 本机”。

1. 从“本机 → 按应用配置”选择应用，决定“截图与内容 / 仅应用和时长 / 不记录”。默认范围仍为仅活动；加载规则不扩大范围。
2. 应用详情显示已安装版本、此版本已配置的文章/商品字段，可载入匹配版本的内置规则、配置字段或导入规则 JSON；已配置不代表经过真机验证。高级区域保留规则 JSON，页面模式只显示“只截图”和“页面优先，未取得内容时截图”两个选项。页面模式对所有允许记录内容的应用生效；在应用详情中载入、配置或导入字段也会切换这一全局模式，字段规则仍按应用和版本匹配。
3. 点击“保存并预览”保存配置并查看生成格式预览；保存和普通预览不会开启已暂停的采集。预览不读取个人屏幕，不意味着真实页面已适配。首次在本机点击“开始采集”，审阅保存的 App 范围和同步目标，点击“按此范围开始”才进入权限检查/启动流程；取消继续暂停。权限页提供“返回原配置页面”和“返回本机开始采集”，授权后回本机继续。
4. 在已授权的内容 App 中正常浏览。采样时先提取字段，成功只保存字段；空结果、版本不匹配、必要字段缺失、读取失败才使用现有截图路径。App 页面切换、配置改变、锁屏或暂停会使旧回调失效。
5. 内容先持久保存；是否上传及何时上传由原同步策略决定。节点不是开始本机采集的前置条件。中央资料保留原文与观察时间，支持后续追溯。

新安装的页面模式为 `ui_preferred`，已有显式 `screen_only` 保持只截图。Android 的 `hybrid`、`page_only` 旧值继续可读取，执行同样的字段优先与截图回退，界面显示页面优先，保存此配置页时统一为 `ui_preferred`。选择投屏并保存时同时改为只截图，每次新投屏会话仍需系统授权。隐私拒绝或状态失效不截图回退；页面成功保存后独立记录实测活动时长，字段记录的时长为 0，不重复计时。

## v2 字段规则与上传

规则数组最多 32 条、8 个必要节点条件、64 KiB。App/平台/版本精确匹配，Activity 可进一步限定。`region` 定位内容区域；`repeat` 生成独立商品对象；`repeatParent` 只选择指定父容器的直接卡片。选择器的资源 ID、role、textEquals 为精确 AND 条件；文本只用于明确页面定位，不识别用户意图。`ancestor` 限定字段祖先，`childPath` 使用原平台子索引，隐私过滤不会重新编号。数组第一个有结果的规则生效。

```json
[{"formatVersion":2,"id":"generated.article","version":"1","platform":"android",
  "appId":"dev.example.reader","appVersion":"1.2.3","activity":"dev.example.reader.ArticleActivity",
  "region":{"resourceId":"dev.example.reader:id/article"},
  "fields":{
    "title":{"select":{"resourceId":"dev.example.reader:id/title"},"required":true},
    "author":{"select":{"resourceId":"dev.example.reader:id/author"}},
    "url":{"select":{"resourceId":"dev.example.reader:id/link"}},
    "body":{"select":{"role":"android.widget.TextView"},"ancestor":{"resourceId":"dev.example.reader:id/body"},"required":true}
  },"kind":"article"}]
```

文章必须取得标题和正文，作者/实际链接可选；商品必须取得标题，实际链接/商品 ID 有则保留。多个标量候选无法确定归属时失败，不拼接成伪标题。没有 URL/ID 不凭标题推断身份；不拉取网页、不生成链接、不生成摘要或“未取得结果”句子。

单次读取最多 256 节点、深度上限 32（根节点为 0）、总文字 32000 字符、750ms 软遍历预算；单次 Android IPC 仍可能超过预算。历史微信文章正文节点位于深度 25–27，原 24 深度上限会在正文之前停止，故本轮提高遍历深度；节点、文字、耗时及隐私门槛保持相同。可见长节点保留并分块，不因超过 2000 字符整段丢弃。只读取确认可见且不受遮罩/遮挡的文字；输入、密码、敏感子树不读取。节点树仅供本机映射，不上传。单对象字段传输最多 64 个正文块、每块 32000 字符、全部字段 64000 字符。

新上传的 `metadata.uiPage.version=2` 包含 scope、adapterId/version、App 版本、Activity、status/truncated、observations `{firstAt,lastAt,count}` 和单元素 `objects`。对象字段是 `{kind,title,author?,url?,itemId?,body:[{text}],identity?}`。identity 只能等于实际 URL 或 itemId。`capturedAt` 与 metadata.observedAt 必须等于 observations.lastAt；ocrText 必须等于字段原文拼接。不允许图像、UI 节点、控件坐标或未知字段。多个卡片生成多个不可变记录。

每条观察立即入持久队列。端侧有限缓存只按真实身份、相同标量和确切重叠轻合并，不延迟持久化；失败不消耗缓存。中央按设备/App/类型/身份组织可追溯资料，保留原观察、变化字段和不相连片段。无身份独立保存，正文不做语义改写。中央不将 v2 塞入有损截图摘要。成功只说明可见片段取得字段，资料覆盖仍为 `visible_window`，不宣称全文或用户读完。

中央新接收的 v2 原件与截图复用自动 Memory 接收凭据、配方选择、队列、分批提取和
独立审核。`source-body` 就绪后可处理已采到的可见正文，资料仍标明部分覆盖。
模型可以生成事件观察或精选记忆，也可以经审核得到零候选；接通自动处理不保证每条
页面都生成长期个人事实。原文字段、原观察及按需查询保持独立，不被 Memory 覆盖。

日常事件策略 `mote.daily-event-memory@1` 默认加入独立的截图/页面采集组合。它使用
每条原件独立的 `daily-events` 资料保留普通展示、浏览和行动线索，按天检索时不会被
跨天文章合并挡住；计划、未支付、已支付、完成和未知结果由模型依据证据区分。
文章观点归作者，不由展示推导为用户观点。来源的显式组合覆盖仍优先，详见
[日常事件策略](adr-daily-event-memory.md)。
重复上传、重启、导入恢复和历史组织器重建不新增授权，原有历史资料需显式发起处理。
详见 [自动 Memory ADR](adr-ui-page-automatic-memory.md)。

中央单份组织复用现有 2000 成员/400 万字符预算，读取最近观察直到预算；达到上限标明部分覆盖，全部采集原件仍保留并可独立分页。正文块的细粒度证明最多 32 个引用，其余原始成员仍可追溯；不把有限资料窗口说成完整历史。

## 样本与适配边界

[内置包](../adapters/ui/builtin.json) 是唯一规则源文件；Android 构建复制到 assets，TS 副本由脚本生成。新增微信 8.0.78 文章和淘宝 10.66.22 推荐卡片规则来自历史实验结构，本轮只验证生成 fixture。微信保留可见标题/作者/正文；历史树不暴露文章链接。淘宝规则保留卡片标题，历史树无商品链接/ID；详情页无可见字段时截图。不能将历史规则宣传为当前真机兼容。版本变化需显式适配；没有自动下载和动态脚本运行。

```sh
npm run build -w @mote/shared
node scripts/ui-adapters.mjs generate
node scripts/generate-ui-rule-fixtures.mjs --check
node scripts/generate-ui-structured-fixtures.mjs --check
node scripts/ui-adapters.mjs replay-all /absolute/path/generated-snapshot.json adapters/ui/builtin.json android
```

`structured-conformance.json` 的 45 个生成案例由 TS/Kotlin 共同回放，包含卡片、长正文、深层正文、必要字段、错版本、隐私删节点和原子索引。旧 `conformance.json`/`builtin-coverage.json` 验证 v1 兼容。贡献规则需附版本、结构来源和正常/负例/截断/多对象回放；不提交个人正文、截图或令牌。真实 App 与物理设备验收另行记录，见 [验证矩阵](validation/android-page-fields-2026-10-10.md)。

## Desktop 与旧记录

Desktop 保留原 v1 selected-node 读取与 screen_only/hybrid/ui_preferred/page_only 行为；默认 screen_only，ui_preferred 仍按旧 complete 契约。这次不改变 macOS 权限与采集体验。中央继续读取旧队列的 v1 节点记录，新 Android 只产生 v2 字段记录。原有队列/图片/笔记不重写；输入不公开、Canvas、屏幕外内容不会被恢复。所有原文都是不可信证据，查询 Agent 只有只读工具。
