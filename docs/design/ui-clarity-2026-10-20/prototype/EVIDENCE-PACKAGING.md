# 证据打包与串行同步

此目录的脚本只整理既有 HTML UI 原型材料。评分、盲评原文、DOM JSON、静态 HTML 和 PNG 均保留原始字节；脚本不评价 UI，也不声明真实后端或模型闭环已验证。最终包应在评审、报告和候选全部冻结后生成。

## 本地估算与冻结

在本目录执行。`estimate` 使用临时包计算准确压缩体积、验证归档内每份原始文件哈希，然后删除临时包；不会冻结最终交付，也不会联系 GitHub。

```sh
python3 package-evidence.py estimate --last-round 14 --report evidence/transfer-estimate-through-r14.json
```

收到“冻结最终同步包”后，完成正式记录和指标生成，再把完整交付复制到一个新的目录。`prepare` 不修改源工作树；同名活动包不会被覆盖；冻结期间选中文件或文件清单发生变化会报错。

```sh
node finalize-rounds.mjs 15
node finalize-rounds.mjs 15 --check
node summarize-metrics.mjs 15
python3 package-evidence.py prepare --last-round 15 --output /tmp/mote-ui-final-transfer-r15-20261020
python3 package-evidence.py verify --output /tmp/mote-ui-final-transfer-r15-20261020
```

默认每个文本 tree 批次至多约 1.5 MB；大于此目标的单个完整文件会明确列为 oversized，不截断内容。`--batch-bytes` 可以调整批次目标。工具传输片段每份不超过 24,000 个 Unicode 字符。默认另外保留 R0 首屏、最终桌面和手机首屏的 PNG 普通文件；可用重复的 `--preview-file prototype/evidence/...png` 明确指定。

## 保留内容与恢复

每轮 ZIP 保存该轮的所有原始 `.dom.json`、序列化 `.html` 和 PNG；全局 `preflight/rNN...` 中的同类文件并入 RNN 归档。其他支持材料放在 `support-raw.zip`。默认使用 ZIP_LZMA，适合包含远距离重复文本的原始 DOM；也可以指定 `--compression deflate`。两种格式均逐条保留原始字节和 SHA-256。请使用提供的 Python 恢复脚本，它直接支持 ZIP_LZMA，不依赖系统解压应用。

评分、全量覆盖、盲评、actions、渲染元数据、候选 HTML、脚本和正式轮次记录保留为普通文件。`candidate.html` 始终保留为普通文件。核心交互 HTML、比较 HTML 和报告也是普通文件，可以直接下载；读取它们不要求先恢复 DOM 归档。

生成的 `evidence-index.json` 对应原始路径、原始字节数、SHA-256、Git blob SHA、归档路径和归档条目。ZIP 条目保留仓库相对路径，解压根为仓库根目录。`SHA256SUMS` 可以在恢复后独立核对全部原始文件和 ZIP。归档时间戳和文件顺序固定，不改变归档内文件的原始字节。

```sh
python3 docs/design/ui-clarity-2026-10-20/prototype/restore-evidence.py --repository-root . --verify-only
python3 docs/design/ui-clarity-2026-10-20/prototype/restore-evidence.py --repository-root . --extract
sha256sum -c docs/design/ui-clarity-2026-10-20/prototype/evidence/SHA256SUMS
```

恢复脚本先核对 ZIP 及每个条目的 SHA-256，再写入缺失文件；已有内容不同的文件会报错，不会覆盖。`evidence-exclusions.json` 逐项列出排除项。PDF 只有在对应静态 HTML 的原始哈希可核对时才作为可重建文件排除；其原 PDF 哈希、renderer 元数据路径和具体复现命令仍保留。复现输出位于 `/tmp/mote-reproduced`，保留原 PNG 和原元数据。WeasyPrint 70.0、Poppler 和 CJK 字体要求见 `render-evidence.py`；重建产物不声称与原 PDF 字节相同。

历史 DOM 采集有些 `body` 焦点标签来自 `body.textContent`，其中包含脚本文本。这些历史字节完整保留；该标签不是浏览器的无障碍名称，也不能单独作为键盘焦点、功能清晰或旅程完成的通过证据。索引中的 `capture_metadata_notes` 记录此解释。历史 preflight 移动后仍保留旧绝对输入路径时，复现索引按原始 SHA-256 定位对应快照，原 renderer 元数据保持不变。

## GitHub 串行写入

`upload-evidence.js` 是供 `functions.exec` 运行的工具编排源文件，不是 Node 网络客户端。它使用现有 GitHub connector；不读取凭据，不运行 git 认证，也不修改本地 HEAD。

唯一目标为 `utopiafar/mote` 的 `codex/ui-clarity-15-rounds-20261020` 分支和已有草稿 PR #185。初始化只读检查实际远端 HEAD 与提交 tree。每次调用最多进行一次远端写入：逐个文本 tree、逐个 ZIP/PNG blob、一次二进制挂接 tree、一次 commit、一次带 `expected_sha` 的非强制 ref 更新；最后可更新已有 PR 正文。每个 API 写调用 55 秒未返回就持久记录阻塞并停止队列，不继续发新写入。

初始化选项时，`expected_head` 必须来自最新只读确认。下面的旧值是目前已知 HEAD，正式操作前仍需重新读取。用户已授权的最终分支更新可设置 `allow_ref: true`；这个选项不是新的用户确认流程。PR 正文需使用最终审过的完整范围和进度说明。

```js
store('mote_ui_upload_options', {
  package_dir: '/tmp/mote-ui-final-transfer-r15-20261020',
  expected_head: '73fc85a0a22013d4bf21b9c07b64e0ed00e6beb5',
  last_round: 15,
  allow_ref: true,
  commit_message: 'docs: preserve R0–R15 HTML UI iterations and original evidence'
  // pr_body: 最终审过的草稿 PR 正文，可另行更新。
});
```

下面一次调用只推进一个阶段。`functions.exec` 建议 `yield_time_ms: 1000`；如果返回 cell ID，按工具规则读取结果，并在长调用期间汇报状态。每次正常返回后再次调用，直到 `stage: complete`。不要并行执行这个脚本。

```js
const source = await tools.exec_command({
  cmd: "cat '/workspace/scratch/580b4cdfd36e/mote-ui-work/docs/design/ui-clarity-2026-10-20/prototype/upload-evidence.js'",
  max_output_tokens: 16000
});
if (source.exit_code !== 0) throw new Error(source.output);
await eval('(async () => {\n' + source.output + '\n})()');
```

脚本在包目录保存 `upload-progress.json`，记录全部已确认 blob、累计 tree、commit 和 ref 状态。候选及原始文件的 Git blob SHA 会与最终远端 tree 逐项比对，通过后才创建 commit。分支更新再次读取 HEAD，并使用 `expected_sha`、`force: false`；若出现新提交则停止，检查后基于新树处理，不绕过 lease。

超时意味着对象创建未确认，不意味着对象已创建或未创建。`blocked` 状态不可直接清空后盲重试：先核对工具结果和已知对象，确认如何恢复，再继续。远端 ref 只有在单独读回预期 commit 后才标为 `ref_updated: true`。
