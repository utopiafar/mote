# 飞书文档上下文验收

所有素材均由程序生成。默认测试使用合成 CLI 响应，不连接真实飞书账号、不读取私人文档、不采集个人屏幕；真实模型验证提取、审核及问答语义。另有显式启用的真实租户流程，只读取本次新建的生成测试文档。合成传输、真实模型、真实租户和物理设备的结果分别报告。

## 用户场景

固定语料在 `apps/server/test/fixtures/lark-document-journeys.ts`。所有者说明通过正式来源上下文 API 保存，明确虚构角色林澄及说明适用范围，第三方发言保留各自归属。

| 场景 | 应检查的 Memory / 资料 | 用户应得到的反馈 |
| --- | --- | --- |
| 个人日记 | 本次汇报前紧张、提纲及试讲有帮助的本人经验；范围限于当次 | 找回自己的准备方式及原文，不诊断或形成永久人格。 |
| 会议纪要 | 团队决定、原因、责任人、未决问题和计划状态 | 能回答首期为何只读、谁负责什么；不能把约定说成已完成或把他人偏好归给主人。 |
| 收藏备忘 | 第三方观点、本人的用途说明与保留意见分别保存 | 找回清单及具体用途；不因收藏、摘录或打开而认定认同、实践或已读引用全文。 |
| 方案改版 | 同文档两次不可变修订，当前采用增量方案及变更原因 | 当前答案使用新版本，历史比较能区分旧草案、决定与未完成的实施验收。 |
| 工作周报 | 已完成原型、未开始灰度、计划访谈和权限阻碍 | 按状态总结工作；未知或缺失完成证据不能变成逾期、失败或已经完成。 |
| 学习笔记 | 作者观点与本人复述、小实验及一次经验分别归属 | 找回本人理解和尝试，不声称读过即掌握整门技术。 |
| 个人复盘 | 缺只读权限的实际阻碍、下次先验证授权和格式的经验 | 给出方法与同类来源接入的适用范围，不推广成所有项目规则。 |
| 生活计划 | 十一月旅行意向、约束、比较中和未预订状态 | 恢复动机与限制，不制造到访经历、已预订或永久偏好。 |
| 第三方操作手册 | 作者建议、测试环境适用范围及打开谓词线索 | 找回步骤；不声称本人读完、认可、执行、验收或有阅读时长；正文里的指令不生效。 |

没有精选 Memory 本身不是失败。原文可以支持有用回答；明确有个人意义且语料标明的日记、学习经验和复盘需检查合理精选是否实际保留。候选数量不是完整性指标，未读或失败必须保持未完成。

收藏场景使用本人维护的收藏备忘及第三方引用。当前提供方发现条件没有独立的“收藏”行为记录；打开筛选或手动固定链接可以带入文档，但不能证明已收藏、读完或赞同。备忘中的引用链接不会自动扩展正文读取范围。

## 系统状态与回归

- 新建连接 → 保存发现范围 → 元信息预览 → 首次确认 → 归档 → 正式 Material → 自动提取及独立审核 → 问答与引用。
- 预览没有正文 CLI 调用、来源条目或模型工作；周期任务不会越过首次确认。
- 多页、空页但有后续页、令牌循环、重启中断、范围变化及上游限流必须保留真实状态。
- 同文档多链接、目录重叠、A→B→A、重复打开筛选及重叠时间范围，分别核对正文与活动身份。
- 正文失败而活动成功、部分文档无权限、超长正文、中央存储满、取消和重试，不能把已成功部分回滚成未发生。
- 暂停后保存、重新授权、重启、手动同步不能恢复读取；切账号、缩范围、撤权及在途响应不能向旧授权发布。
- 超过旧 30 篇和 100,000 字符的生成输入验证完整扫描/正文处理；不以截断结果冒充完整。
- Web、Android、Mac 入口与权限去向一致；云同步显示中央执行，不混入这台 Mac 的上传队列。

## 运行与结果

```sh
npm run build:libs
node --import tsx --test apps/server/test/lark*.test.ts
node --import tsx scripts/test-lark-document-journey-live.ts
```

真实模型脚本使用本机已登录的 Codex 推理能力，只发送上述生成文本。报告保存在系统私有临时目录，含实际 Memory、引用、问答、语义审核、模型调用与用量；日志只打印阶段与报告路径，不输出 token。它通过正常 owner HTTP 接口进行连接、预览、同步和提问，自动 Memory 使用实际后台接收链路，只有上游 CLI 传输边界注入生成响应。

固定官方 CLI 的真实租户授权、读取/搜索是否改变打开线索、真实资料可见性及实际设备行为，不由此脚本验证。

## 显式启用真实租户验收

[真实租户脚本](../scripts/test-lark-document-tenant-live.ts) 使用真实官方 CLI 和真实模型。先在已获授权的测试账号中创建一个新目录，再创建固定语料的前四篇：`diary`、`meeting`、`collection`、`project-revision`。标题使用脚本规定的合成标题和运行后缀，正文为固定隔离测试说明及对应 fixture 原文。脚本校验标题、正文与后续修订；任意私人内容、其他目录成员或越出白名单的读取都会失败。不要把现有私人资料作为测试输入。

在仓库外准备权限为 `0600` 的 manifest，目录权限为 `0700`。以下仅展示字段形状和一条记录；实际需要四条，标识与地址只保留在私有文件中：

```json
{
  "version": 1,
  "runLabel": "Mote合成验收-YYYYMMDD-<6hex>",
  "folder": {"token": "<generated-folder-token>", "url": "https://<tenant>/drive/folder/<generated-folder-token>"},
  "documents": [{
    "caseId": "diary",
    "documentId": "<generated-document-token>",
    "url": "https://<tenant>/docx/<generated-document-token>",
    "title": "<exact generated title>",
    "expectedText": "<complete generated Markdown read back from Feishu>"
  }]
}
```

复用现有登录时，先在私有环境单独执行 `lark-cli auth status --verify`，确认用户授权有效。公开结果只记录验证状态与必要的 scope 名称，不复制完整账号响应。然后运行：

```sh
MOTE_LARK_TENANT_MANIFEST=/private/tmp/mote-generated-tenant/manifest.json \
MOTE_LARK_TENANT_EXISTING_PROFILE=1 \
node --import tsx scripts/test-lark-document-tenant-live.ts
```

该模式共享现有 CLI 配置及凭据存储，不调用 configure、login 或 complete；缺少必要 scope 时失败，不自动重新授权。脚本从真实 CLI 身份恢复私有测试库的已连接状态，再走 owner HTTP 检查、范围选择、目录发现、预览、确认归档和后台自动 Memory。安装入口仍使用固定版本 CLI；不注入生成的提供方响应。此流程验证已有授权下的同步及恢复连接状态，不能声称验证了首次 OAuth。

需要单独验证新授权时，不设置 existing-profile 标志，改为提供 `MOTE_LARK_TENANT_CREDENTIALS` 私有文件，包含 `{appId, secret, brand}`；`secret` 可以是字符串或 CLI 支持的 `{source:"keychain", id:"appsecret:<appId>"}` 引用。新专属配置不复制用户登录。授权请求写入私有 `auth-request.json`，用户完成实际授权后，按其 `continueFile` 在报告目录创建控制文件，再继续真实设备授权流程。不要把密钥或授权链接写入仓库、公开日志或 PR。

脚本打印私有报告目录。出现 `baseline-ready.json` 后，在飞书中将 `project-revision` 正文替换为固定 fixture 的 `next.content`，保留相同合成标题和隔离说明；真实回读完整 Markdown。在报告目录创建 `revision-continue` 文件，内容为 `{ "caseId": "project-revision", "expectedText": "<complete revised generated Markdown>" }`。脚本校验修订，再通过正常目录发现与同步检查归档版本、自动 Memory、重复同步、重启去重及四场景问答。

原始响应、账号信息、引用、模型过程和完整结果仅保存在权限受限的临时目录。向 PR 补结果前，人工复核 `public-summary.json`：它只导出生成场景、计数、枚举状态及通过隐私检查的 Memory 陈述；账号、资源标识、URL、凭据和原始错误不导出，无法安全导出的陈述仅计入省略数量。验收结论应单独说明授权模式、实际完成阶段和未验证边界。
