# Mote · R30–R34 三端 HTML 评审包

本包保留五轮独立迭代的 15 份完整 HTML、每轮源代码、功能契约、评分规则、独立报告及原始观察证据。原型使用合成数据；没有验证后台服务、原生采集、真实模型、OAuth、日历写入或真实设备配对。

仓库保存冻结原型、源码、独立报告、DOM/动作记录与报告引用的截图；离线 ZIP 另外包含本次留存的全部原始截图。

## 打开方式

1. 解压整个 ZIP，保留目录结构，然后用浏览器打开 [index.html](index.html)。
2. 在页首切换迭代版本、演示内容与平台；“单独打开”进入完整尺寸的页面。切换版本或场景会重置相应演示。
3. 最后一轮也可直接打开：[Web](rounds/r34/web.html) · [Mac](rounds/r34/mac.html) · [Android](rounds/r34/android.html)。每份候选 HTML 自包含，不依赖在线服务。

若浏览器限制本地 iframe，请直接使用上面的独立 HTML。也可在本目录运行 `python -m http.server 8765 --bind 127.0.0.1`，再打开 `http://127.0.0.1:8765/`。Git 分支链接需要联网，原型本身不需要。

## R34 视口预览

这些预览由冻结 R34 的实际可见界面生成，采用固定中文字体，先保存 DOM 再保存视口截图。每张 PNG 旁都有同名 DOM JSON；[预览清单](previews/r34/manifest.json)记录对应候选哈希。

| 平台 | 首次使用 | 导入与资料说明 | 资料库 | 来源 |
|---|---|---|---|---|
| web | [首次使用](previews/r34/web-first-use.png) | [导入说明](previews/r34/web-import-context.png) | [资料库](previews/r34/web-library.png) | [来源](previews/r34/web-sources.png) |
| mac | [首次使用](previews/r34/mac-first-use.png) | [导入说明](previews/r34/mac-import-context.png) | [资料库](previews/r34/mac-library.png) | [来源](previews/r34/mac-sources.png) |
| android | [首次使用](previews/r34/android-first-use.png) | [导入说明](previews/r34/android-import-context.png) | [资料库](previews/r34/android-library.png) | [来源](previews/r34/android-sources.png) |


## 五轮独立结果

下表直接采用各轮已冻结的独立报告。打包脚本只核对文件身份与算术，不重新评分、不改判定。均分上升不等同于功能完整性通过。

| 轮次 | Web | Mac | Android | 均分 / 100 | 独立验收 | 报告 |
|---|---:|---:|---:|---:|---|---|
| R30 | 64.062 | 61.250 | 59.375 | 61.562 | 未通过全部门槛 | [独立报告](rounds/r30/reports/independent-evaluation.md) |
| R31 | 70.000 | 69.062 | 69.062 | 69.375 | 未通过全部门槛 | [独立报告](rounds/r31/reports/independent-evaluation.md) |
| R32 | 71.250 | 71.250 | 72.500 | 71.667 | 未通过全部门槛 | [独立报告](rounds/r32/reports/independent-evaluation.md) |
| R33 | 71.250 | 72.500 | 74.375 | 72.708 | 未通过全部门槛 | [独立报告](rounds/r33/reports/independent-evaluation.md) |
| R34 | 74.375 | 74.375 | 73.438 | 74.063 | 未通过全部门槛 | [独立报告](rounds/r34/reports/independent-evaluation.md) |

**R34 的独立结论：未通过全部验收门槛。** 具体缺口、未验证项与下一步修正见 [R34 报告](rounds/r34/reports/independent-evaluation.md)；详细功能状态见 [功能覆盖表](rounds/r34/reports/feature-coverage.md)。

| R34 平台 | 已验证 | 部分完成 | 缺失 | 未验证 | 不适用 |
|---|---:|---:|---:|---:|---:|
| web | 0 | 23 | 0 | 105 | 60 |
| mac | 0 | 22 | 0 | 152 | 14 |
| android | 0 | 25 | 0 | 159 | 4 |

## 来源、职责与证据

- 具体修改与剩余问题见 [最终报告](final-report.md)。独立首屏观察见 [R34 首屏记录](first-look/r34/first-look.md)，这是 AI 代理观察，不是真人测试。
- [独立功能清单](contract/user-features.md)与[关键旅程](contract/journeys.json)是功能核对依据；目录入口数量不等同于完整功能数量。
- Central 接收、导入和整理资料；Mac 与 Android 只采集各自设备授权范围。浏览器文件夹上传属于一次导入。
- 每轮 `manifest.json` 记录三个候选 HTML 与源代码快照的哈希。`reports/evaluation-freeze.json` 记录独立报告哈希，已有的 `evidence-manifest.json` 记录独立证据哈希。
- R30 没有单独的独立证据哈希清单。本包验证其原有报告冻结哈希，并为复制的原始证据记录交付时哈希；这不构成追溯性的独立证据冻结。
- `delivery-manifest.json` 记录本包文件的 SHA-256。候选、报告和证据均按原字节复制，没有把测试字体或查看器脚本注入冻结 HTML。
- 本地查看器检查在隔离浏览器中阻止外部网络，只在响应内注入固定字体；先保存可见 DOM，再保存视口截图。它属于交付检查，不是独立评分。

## 独立分支与提交

以下身份是各轮评审完成时记录的提交，来自 `work/publication/progress.json`。最后的交付文档提交可以使分支 HEAD 前移，不改变已冻结的候选与报告；这里保留可复现的评审快照。打包脚本不访问远端、不提交、不推送。完整记录和原始发布状态保存在 [round-commits.json](round-commits.json)。

| 轮次 | 分支 | 记录的提交 |
|---|---|---|
| R30 | [codex/mote-ui-r30-20261022](https://github.com/utopiafar/mote/tree/codex/mote-ui-r30-20261022) | [a9bb251b7ba2](https://github.com/utopiafar/mote/commit/a9bb251b7ba2ed486d6509d8bcf7300b4085caac) |
| R31 | [codex/mote-ui-r31-20261022](https://github.com/utopiafar/mote/tree/codex/mote-ui-r31-20261022) | [cebe85055afe](https://github.com/utopiafar/mote/commit/cebe85055afe8cd667979c02b8301e9543fa86b7) |
| R32 | [codex/mote-ui-r32-20261022](https://github.com/utopiafar/mote/tree/codex/mote-ui-r32-20261022) | [8a8409adb309](https://github.com/utopiafar/mote/commit/8a8409adb3096817784c94aa8c4e49260a6e7d06) |
| R33 | [codex/mote-ui-r33-20261022](https://github.com/utopiafar/mote/tree/codex/mote-ui-r33-20261022) | [a10a5d0e677c](https://github.com/utopiafar/mote/commit/a10a5d0e677cc6d8ec4a6c90a4a7e7731bc064a0) |
| R34 | [codex/mote-ui-r34-20261022](https://github.com/utopiafar/mote/tree/codex/mote-ui-r34-20261022) | [960cecb241d4](https://github.com/utopiafar/mote/commit/960cecb241d4853dcf7237626628a4c623c0deab) |

## 目录与复核

- 本评审包的 `rounds/r30` 至 `rounds/r34`：冻结候选、源代码、变更说明、评分规则、独立报告和本次留存的全部原始证据；Git 中的图片范围以上文说明为准。
- `contract/`：独立功能与旅程契约；`baseline/`：构建起点；`scripts/`：可读构建、检查与交付脚本。
- ZIP 与暂存包生成在被 Git 忽略的 `work/delivery-*` 中；不把 ZIP、浏览器运行时、字体缓存或发布 API 分块混入 Git 代码提交。

生成最终包前，应先完成五轮独立报告与发布记录，并刷新查看器：

```sh
python scripts/build-review.py
node scripts/check-viewer.cjs --expect-rounds 30,31,32,33,34
python scripts/build-delivery.py
```

查看器自动检查需要本项目既有的 Playwright、固定 Chrome 与字体运行时；这些测试依赖不包含在评审 ZIP 中。直接打开 HTML 无需这些依赖。
