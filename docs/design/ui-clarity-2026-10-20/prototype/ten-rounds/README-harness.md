# 三端 UI 迭代归档工具

## 冻结每一轮

在仓库根目录执行：

```bash
python docs/design/ui-clarity-2026-10-20/prototype/ten-rounds/scripts/build.py --round 20 --changes docs/design/ui-clarity-2026-10-20/prototype/ten-rounds/changes/r20.json
```

轮次仅接受 R20–R29。输入是四个源文件：`src/common.css`、`src/platform.css`、`src/common.js`、`src/platform.js`，以及本轮的修改说明 JSON。源文件一次读取后用于三端构建；冻结副本进入该轮的 `src/`。

构建器使用已确认哈希的 R19 基线，保存 `web.html`、`mac.html`、`android.html`、`changes.json`、可用的评估规则副本和 `manifest.json`。候选包含全部 CSS、JavaScript 和演示数据。已经存在的轮次目录会导致命令拒绝执行，避免覆盖历史中间结果。

默认打开空白资料库。`?state=populated` 可查看已有资料，`?theme=dark` 可查看深色，`?reset=1` 可忽略此前演示状态。每个文件初始平台固定，保存状态与模拟账号的会话键按轮次及平台隔离。

### 源码钩子

- `window.MOTE_ROUND` 和 `window.MOTE_SURFACE` 在基线脚本之前注入。
- 四个扩展文件在基线之后加载；`common.js` 先于 `platform.js`。
- 基线末尾的初始 `render()` 由 `window.initializeMoteIteration()` 接管。该钩子在两层脚本就绪后调用一次，负责安装包装函数并完成首次渲染。
- 没有初始化钩子时，构建器调用原始 `render()`，再调用可用的 `window.enhancePlatformUI()`。
- 平台增强函数应由通用渲染包装器在后续每次渲染后调用。

评估者只在本轮 `evidence/` 和 `reports/` 中添加材料。独立 JSON 的固定位置是 `rounds/rNN/reports/independent-evaluation.json`。每端评估保存候选的 SHA-256，使观察与文件版本对应。

## 生成三端与逐轮查看器

```bash
python docs/design/ui-clarity-2026-10-20/prototype/ten-rounds/scripts/gallery.py --embed-all
```

工具验证全部候选哈希后生成：

- `dist/mote-web-final.html`、`mote-mac-final.html`、`mote-android-final.html`：最后一轮三端原型的逐字节副本。
- `dist/mote-three-platforms.html`：内嵌最后一轮三端原型的单文件查看器。
- `dist/mote-rounds-gallery.html`：轻量逐轮查看器，链接到归档目录里的 30 个候选。
- `dist/mote-rounds-portable.html`：使用 `--embed-all` 时额外生成，内嵌全部轮次，可单文件切换三端候选。
- `dist/gallery-manifest.json`：查看器和最终副本的哈希。

查看器从独立评估 JSON 读取已记录的分数。缺少评估时显示“待记录”。`--allow-partial` 只用于过程中的查看器预览；正式交付默认要求十轮候选全部存在。

## 打包完整交付

```bash
python docs/design/ui-clarity-2026-10-20/prototype/ten-rounds/scripts/package.py
```

打包之前逐一核对 30 个候选、冻结源码及 10 份独立评估的候选哈希，并要求最终报告、索引和查看器存在。压缩包包含每轮候选、源码快照、评估、截图和相关脚本；`artifact-manifest.json` 与 `delivery-checksums.txt` 记录包内文件身份。完成后执行 ZIP CRC 检查并写入 `delivery-result.json`。

下载包供用户保存与离线查看。公开仓库发布可读 HTML、脚本、报告和索引，压缩归档不上传到 GitHub。
