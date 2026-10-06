# 中央文件类型策略

在中央网页进入 **设置 → 文件与语音**。

## 用户配置

1. 在“服务连接”中填写服务名称、类型、运行位置、地址和密钥。同一服务可供多个方案复用。远程服务必须显式选择远程 HTTPS；本地服务只允许中央本机的回环地址。录音服务遵循 Mote 的二进制转写协议，不是任意厂商 ASR 地址的直接替换；厂商协议可通过适配服务或 Cordis 插件接入。
2. 在“处理方案”中选择插件、绑定服务，并设置参数。可复制“本地多人录音”，分别建立“两人电话”和“四人访谈”：两个方案使用同一本地转写服务，各自保存说话人数。语义分组、摘要和人工校正建议可选择本地或远程语言模型；未选择独立模型时使用中央文件分析模型。关闭这些可选步骤仍可完成转写、分离和时间对齐。
3. 在“类型策略”中将录音、图片、文本、PDF 或精确 MIME 类型绑定到方案。没有合适插件的类型保持“仅归档原件”。本期内置 UTF-8 文本、PDF/DOCX/XLSX 文档提取、录音接口、本地多人录音、图片文字接口与本地说话人分离。`document.generic` 读取 PDF 文本层、DOCX 段落和 XLSX 单元格，不做扫描件 OCR 或公式重算；无文本层或超限会明确报告覆盖限制。
4. 在“来源覆盖”中选择来源和类型。例如手机录音目录的 `audio/*` 使用“四人访谈”，同目录 `image/*` 仍使用全局图片方案。
5. 保存后，可通过 MIME 类型试算命中规则；文件详情显示实际执行的配置版本、规则、方案和参数，也显示按照当前设置重新处理会选什么。

匹配顺序：来源精确 MIME → 来源类型通配符 → 来源全部类型 → 全局精确 MIME → 全局类型通配符 → 全局默认。相同来源和类型只能有一条规则。规则只匹配用户指定的 MIME 元数据，不根据内容猜测语义或主题。

密钥不会回传网页。留空保留旧密钥；更换服务地址、类型或运行位置时，必须重新填写或明确清除旧密钥。已完成文件记录服务身份快照，服务地址或模型发生变化时，历史分析会等待明确重处理，不会自动转交新服务。

## 保存和重处理

保存影响新文件与未完成任务，不自动重新提取已完成文件。单文件可以在详情中重新提取或重试某一步。已有文件批量重处理分两步：

- 先选择来源和类型预览，查看本批标题、命中规则和方案；每批最多 100 份当前版本原件。预览扫描最多 1,000 份候选，达到上限时提示缩小范围。
- 点击“确认重新处理”后才入队。10 分钟内有效，配置版本或文件任务状态改变后必须重新预览。只处理预览中列出的文件；排除 Shadow、仅归档和活动任务。

重新提取生成新的派生结果，旧校正标为过期，原件继续保留。原件被手机删除不删除中央归档；这里只配置处理策略，采集方式、增量/回填和手机暂存清理由同步配置管理。

本地多人录音的文字正常进入配置的向量索引、Memory 和问答。所有支持摘要的方案都由摘要开关决定是否生成摘要，未选独立模型时继承中央文件模型设置。说话人仍匿名，名称、术语与场次需要用户确认。

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

当前 `ProcessorInput.settings` 提供所选服务的执行配置，`parameters` 提供所选方案参数。独立模型服务使用 OpenAI 兼容的 completions 协议，独立于提取服务；中央文件模型支持其配置的模型协议。本地多人录音保留转写 → 分离 → 对齐 → 可选语义分组流程，执行位置不限制派生文字的模型使用权限。

## 配置与 API

- `GET /api/file-processing`：脱敏的当前执行 settings、必有 policy、Cordis 元数据、revision。
- `PUT /api/file-processing`：`{revision, settings, policy}`，乐观并发控制；校验后以私有文件原子写入。
- `POST /api/file-processing/match`：`{sourceId, mimeType}`，只试算已保存规则。
- `POST /api/file-processing/preview`：`{revision, sourceId?, type?, profileId?}`，返回有时限的一次性 token 和范围。
- `POST /api/file-processing/reprocess`：`{token}`，按预览范围入队。
- `GET /api/files/:id`：包含 `processingPolicy.applied/current` 和 `capabilities`；详情操作按对话、摘要能力展示。导出 manifest 也包含实际方案快照，无密钥。

当前 `file-processing.json` 必须包含 revision、settings 与 version 1 的 policy。新资料库直接建立显式默认方案；缺 policy 的旧文件及不带 policy 的更新请求拒绝。旧 flat selector 不转换成 policy，也不作为任务路由回退。任务执行时保存实际命中方案与配置指纹；中央 epoch 3 直接建立最终 schema。

## 验证

`apps/server/test/file-policy.test.ts` 覆盖旧契约拒绝、当前默认策略、参数和密钥隔离、实际 Cordis 调用、规则优先级、混合来源、保存冲突、重处理预览及隐私边界。已有文件同步、分离、审阅与导出测试继续运行。

可用隔离测试中央与生成的 Android 文件执行：

```sh
MOTE_FILE_TEST_DIR=<测试目录> node --import tsx scripts/verify-file-sync.ts --live-model --policy
MOTE_FILE_TEST_DIR=<测试目录> node --import tsx scripts/test-file-dialogue.ts <合成录音.wav>
```

前者需要已生成的模拟器结果和显式真实模型配置；后者需要本地 ASR/分离模型。fixture 测试、真实模型测试、模拟器与真机验证应分别报告。
