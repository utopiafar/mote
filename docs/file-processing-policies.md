# 中央文件类型策略

在中央网页进入 **资料库 → 文件 → 中央文件处理设置**。

## 用户配置

1. 在“服务连接”中填写服务名称、类型、运行位置、地址和密钥。同一服务可供多个方案复用。远程服务必须显式选择远程 HTTPS；本地服务只允许中央本机的回环地址。录音服务遵循 Mote 的二进制转写协议，不是任意厂商 ASR 地址的直接替换；厂商协议可通过适配服务或 Cordis 插件接入。
2. 在“处理方案”中选择插件、绑定服务，并设置参数。可复制“本地多人录音”，分别建立“两人电话”和“四人访谈”：两个方案使用同一本地服务，各自保存说话人数。语义分组和人工校正建议可选择本地语言模型；不配置时仍可完成转写、分离和时间对齐。
3. 在“类型策略”中将录音、图片、文本、PDF 或精确 MIME 类型绑定到方案。没有合适插件的类型保持“仅归档原件”。本期内置 UTF-8 文本提取、录音接口、本地多人录音、图片文字接口与本地说话人分离；PDF 插件需另行安装。
4. 在“来源覆盖”中选择来源和类型。例如手机录音目录的 `audio/*` 使用“四人访谈”，同目录 `image/*` 仍使用全局图片方案。
5. 保存后，可通过 MIME 类型试算命中规则；文件详情显示实际执行的配置版本、规则、方案和参数，也显示按照当前设置重新处理会选什么。

匹配顺序：来源精确 MIME → 来源类型通配符 → 来源全部类型 → 全局精确 MIME → 全局类型通配符 → 全局默认。相同来源和类型只能有一条规则。规则只匹配用户指定的 MIME 元数据，不根据内容猜测语义或主题。

密钥不会回传网页。留空保留旧密钥；更换服务地址、类型或运行位置时，必须重新填写或明确清除旧密钥。已完成文件记录服务身份快照，服务地址或模型发生变化时，历史分析会等待明确重处理，不会自动转交新服务。

## 保存和重处理

保存影响新文件与未完成任务，不自动重新提取已完成文件。单文件可以在详情中重新提取或重试某一步。已有文件批量重处理分两步：

- 先选择来源和类型预览，查看本批标题、命中规则和方案；每批最多 100 份当前版本原件。预览扫描最多 1,000 份候选，达到上限时提示缩小范围。
- 点击“确认重新处理”后才入队。10 分钟内有效，配置版本或文件任务状态改变后必须重新预览。只处理预览中列出的文件；排除 Shadow、仅归档和活动任务。

重新提取生成新的派生结果，旧校正标为过期，原件继续保留。原件被手机删除不删除中央归档；这里只配置处理策略，采集方式、增量/回填和手机暂存清理由同步配置管理。

本地多人录音不会自动调用云端摘要或云端向量模型。其他方案可选择独立语言模型生成摘要，未选模型时继承中央模型设置。说话人仍匿名，名称、术语与场次需要用户确认。

## 开发者扩展

继续通过部署变量 `MOTE_FILE_PROCESSOR_PLUGINS` 加载可信 Cordis 插件模块。文件处理运行时长期存在，插件用 `ctx.effect()` 注册和注销处理器；网页不安装或执行任意代码。

```ts
ctx.effect(() => ctx.moteFileProcessors.register({
  id: 'example.pdf', name: 'PDF 文本提取', version: '1',
  stage: 'extract', mediaTypes: ['application/pdf'],
  serviceKind: 'file', // 可选：asr / image / file；纯本地代码可省略
  parameters: [
    { key: 'maxPages', label: '最多页数', type: 'number',
      min: 1, max: 500, integer: true, default: 100 },
  ],
  async process(input) {
    // input.parameters: 当前方案的参数；不读取其他方案。
    // input.settings.endpoint / apiKey: 当前方案绑定的服务。
    // input.signal: 取消和超时；readOriginal(): 原件字节流。
    return { durationMs: 0, segments: await extractPdf(input) };
  },
}));
```

参数声明支持 string / number / boolean、枚举、默认值、可空、数值范围和整数。服务端验证参数与类型兼容性，网页按声明生成表单。秘钥放服务，不放 parameters。处理器返回共享 Transcript 契约；非音频使用零时间，代码负责可靠提取，内容理解由模型完成。

兼容原有 `ProcessorInput.settings`；新插件使用 `parameters`。模型服务使用 OpenAI 兼容的 completions 协议，独立于提取服务。本地多人录音保留既有的转写 → 分离 → 对齐 → 可选本地语义分组流程。

## 配置与 API

- `GET /api/file-processing`：脱敏的旧 settings、policy、Cordis 元数据、revision。
- `PUT /api/file-processing`：`{revision, settings, policy}`，乐观并发控制；校验后以私有文件原子写入。
- `POST /api/file-processing/match`：`{sourceId, mimeType}`，只试算已保存规则。
- `POST /api/file-processing/preview`：`{revision, sourceId?, type?, profileId?}`，返回有时限的一次性 token 和范围。
- `POST /api/file-processing/reprocess`：`{token}`，按预览范围入队。
- `GET /api/files/:id`：增加 `processingPolicy.applied/current`；导出 manifest 也包含实际方案快照，无密钥。

策略保存在原 `file-processing.json` 的可选 `policy` 字段，版本为 1。旧配置首次打开时转换为方案预览，保存后启用。未启用 policy 的旧 API 继续工作；启用后，旧客户端仍可改总开关和预算，修改旧策略字段会返回 409，避免悄悄覆盖新版策略。数据库通过可空 `file_jobs.policy_json` 做兼容迁移。

## 验证

`apps/server/test/file-policy.test.ts` 覆盖迁移、参数和密钥隔离、实际 Cordis 调用、规则优先级、混合来源、保存冲突、重处理预览及隐私边界。已有文件同步、分离、审阅与导出测试继续运行。

可用隔离测试中央与生成的 Android 文件执行：

```sh
MOTE_FILE_TEST_DIR=<测试目录> node --import tsx scripts/verify-file-sync.ts --live-model --policy
MOTE_FILE_TEST_DIR=<测试目录> node --import tsx scripts/test-file-dialogue.ts <合成录音.wav> --policy
```

前者需要已生成的模拟器结果和显式真实模型配置；后者需要本地 ASR/分离模型。fixture 测试、真实模型测试、模拟器与真机验证应分别报告。
